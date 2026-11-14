/**
 * 直し回10（必須）：/api/network の存在確認は 404 だけを「存在しない」とし、それ以外の失敗（500・通信エラー等）を
 * 不存在に読み替えない。
 * - POST /lab/create：作成前の inspect（既存の network-node-<i>・ネットワーク・イメージ）が 404 以外で失敗したら、
 *   何も作成・削除・pull せずに中止する。保護対象（パイロットのラベル・Docker ソケット）の拒否は従来どおり。
 * - POST /lab/create：作り直しのための既存ノードの削除失敗も、404 以外は読み飛ばさずに中止する。
 * - DELETE /lab/cleanup：削除の失敗（404 以外）を読み飛ばさず、残存として名前・ID・復旧手順を出す。
 * Docker が無い環境のため dockerode をスタブに差し替え、変更を伴う呼び出しをすべて記録する。
 */
import { PassThrough } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeContainer = {
  Id: string;
  Name: string;
  Labels: Record<string, string>;
  Mounts?: { Type: string; Source: string; Destination: string }[];
};

const stub = vi.hoisted(() => {
  /** 変更を伴う呼び出し（削除・作成・起動・pull） */
  const mutations: string[] = [];
  /** 全ての呼び出し */
  const log: string[] = [];
  const containers: Record<string, FakeContainer> = {};
  const networks: Record<string, { Id: string; Name: string; Labels: Record<string, string> }> = {};
  const behaviour = {
    /** container.inspect を失敗させる名前・ID → statusCode（undefined は statusCode の無い通信エラー） */
    containerInspect: new Map<string, number | undefined>(),
    /** network.inspect を失敗させる名前・ID → statusCode */
    networkInspect: new Map<string, number | undefined>(),
    /** image.inspect の失敗（null なら成功） */
    imageInspect: { status: null as null | number | 'conn' },
    /** container.remove を失敗させる ID → statusCode */
    containerRemove: new Map<string, number>(),
    /** network.remove を失敗させる ID → statusCode */
    networkRemove: new Map<string, number>(),
  };
  const fail = (status: number | undefined, what: string) =>
    status === undefined
      ? new Error(`connect ECONNREFUSED /var/run/docker.sock (${what})`)
      : Object.assign(new Error(`${what}: HTTP ${status}`), { statusCode: status });
  const notFound = (what: string) => Object.assign(new Error(`no such ${what}`), { statusCode: 404 });
  const findContainer = (idOrName: string) => containers[idOrName] ?? Object.values(containers).find((c) => c.Name === idOrName);
  const findNet = (idOrName: string) => networks[idOrName] ?? Object.values(networks).find((n) => n.Name === idOrName);
  const matches = (labels: Record<string, string>, filters?: { label?: string[] }) =>
    (filters?.label ?? []).every((f) => {
      const [k, v] = f.split('=');
      return labels[k] === v;
    });
  const docker = {
    ping: async () => 'OK',
    modem: {
      followProgress: (_stream: unknown, done: (err: unknown, res: unknown) => void) => done(null, []),
    },
    pull: (image: string, cb: (err: unknown, stream: unknown) => void) => {
      log.push(`pull ${image}`);
      mutations.push(`pull ${image}`);
      cb(null, {});
    },
    getImage: (n: string) => ({
      inspect: async () => {
        log.push(`image.inspect ${n}`);
        const s = behaviour.imageInspect.status;
        if (s === null) return { Id: 'img' };
        throw fail(s === 'conn' ? undefined : s, `image ${n}`);
      },
    }),
    listContainers: async ({ filters }: { filters?: { label?: string[] } } = {}) => {
      log.push('listContainers');
      return Object.values(containers)
        .filter((c) => matches(c.Labels, filters))
        .map((c) => ({ Id: c.Id, Names: [`/${c.Name}`], Labels: c.Labels, Mounts: c.Mounts ?? [], State: 'running' }));
    },
    listNetworks: async ({ filters }: { filters?: { label?: string[] } } = {}) => {
      log.push('listNetworks');
      return Object.values(networks).filter((n) => matches(n.Labels, filters));
    },
    getNetwork: (idOrName: string) => ({
      id: idOrName,
      inspect: async () => {
        log.push(`network.inspect ${idOrName}`);
        if (behaviour.networkInspect.has(idOrName)) throw fail(behaviour.networkInspect.get(idOrName), `network ${idOrName}`);
        const n = findNet(idOrName);
        if (!n) throw notFound(`network: ${idOrName}`);
        return { Id: n.Id, Name: n.Name, Labels: n.Labels };
      },
      remove: async () => {
        log.push(`network.remove ${idOrName}`);
        mutations.push(`network.remove ${idOrName}`);
        if (behaviour.networkRemove.has(idOrName)) throw fail(behaviour.networkRemove.get(idOrName), `network remove ${idOrName}`);
        const n = findNet(idOrName);
        if (n) delete networks[n.Id];
      },
    }),
    createNetwork: async (o: { Name: string; Labels?: Record<string, string> }) => {
      mutations.push(`createNetwork ${o.Name}`);
      const id = `netid-${o.Name}`;
      networks[id] = { Id: id, Name: o.Name, Labels: o.Labels ?? {} };
      return { id };
    },
    createContainer: async (spec: { name: string; Labels?: Record<string, string> }) => {
      mutations.push(`createContainer ${spec.name}`);
      const id = `cid-${spec.name}`;
      containers[id] = { Id: id, Name: spec.name, Labels: spec.Labels ?? {} };
      return {
        id,
        start: async () => {
          mutations.push(`start ${id}`);
        },
        inspect: async () => ({ NetworkSettings: { Networks: {} } }),
      };
    },
    getContainer: (idOrName: string) => ({
      id: idOrName,
      inspect: async () => {
        log.push(`container.inspect ${idOrName}`);
        if (behaviour.containerInspect.has(idOrName)) throw fail(behaviour.containerInspect.get(idOrName), `container ${idOrName}`);
        const c = findContainer(idOrName);
        if (!c) throw notFound(`container: ${idOrName}`);
        return { Id: c.Id, Name: `/${c.Name}`, Config: { Labels: c.Labels }, Mounts: c.Mounts, State: { Running: true } };
      },
      exec: async () => {
        mutations.push(`exec ${idOrName}`);
        return {
          start: async () => {
            const s = new PassThrough();
            setImmediate(() => s.end(Buffer.concat([Buffer.alloc(8), Buffer.from('ok')])));
            return s;
          },
          inspect: async () => ({ ExitCode: 0 }),
        };
      },
      remove: async () => {
        log.push(`container.remove ${idOrName}`);
        mutations.push(`container.remove ${idOrName}`);
        if (behaviour.containerRemove.has(idOrName)) throw fail(behaviour.containerRemove.get(idOrName), `container remove ${idOrName}`);
        delete containers[idOrName];
      },
    }),
  };
  return { mutations, log, containers, networks, behaviour, docker };
});

vi.mock('dockerode', () => ({
  default: function FakeDocker() {
    return stub.docker;
  },
}));
vi.mock('../services/queue.js', () => ({ addDockerBuildTask: vi.fn(), addDockerRunTask: vi.fn() }));
vi.mock('../services/queue', () => ({ addDockerBuildTask: vi.fn(), addDockerRunTask: vi.fn() }));

const { networkRoutes } = await import('../routes/network');

const LAB = { 'cloud-dojo': 'network-lab' };
const addContainer = (c: FakeContainer) => (stub.containers[c.Id] = c);
const addNetwork = (id: string, name: string, labels: Record<string, string>) => (stub.networks[id] = { Id: id, Name: name, Labels: labels });

let quiet: { mockRestore: () => void }[] = [];
let app: FastifyInstance;
beforeEach(async () => {
  stub.mutations.length = 0;
  stub.log.length = 0;
  for (const k of Object.keys(stub.containers)) delete stub.containers[k];
  for (const k of Object.keys(stub.networks)) delete stub.networks[k];
  stub.behaviour.containerInspect.clear();
  stub.behaviour.networkInspect.clear();
  stub.behaviour.containerRemove.clear();
  stub.behaviour.networkRemove.clear();
  stub.behaviour.imageInspect.status = null;
  quiet = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined)];
  app = Fastify();
  await app.register(networkRoutes, { prefix: '/api/network' });
});
afterEach(async () => {
  await app.close();
  for (const q of quiet) q.mockRestore();
});

const create = (nodeCount = 2, networkName?: string) =>
  app.inject({ method: 'POST', url: '/api/network/lab/create', payload: networkName ? { nodeCount, networkName } : { nodeCount } });

describe('直し回10 必須：/lab/create の作成前 inspect は 404 だけを不存在とする', () => {
  it('2台目の inspect が 500：確認済みの1台目も削除せず、ネットワーク・コンテナの作成も pull もせずに 500 LAB_PRECHECK_FAILED', async () => {
    // 再レビューの指摘例：node 1 の確認は成功し、node 2 の inspect が 500
    addContainer({ Id: 'oldnode00001', Name: 'network-node-1', Labels: LAB });
    stub.behaviour.containerInspect.set('network-node-2', 500);
    const r = await create(3);
    expect(r.statusCode).toBe(500);
    expect(r.json().error).toBe('LAB_PRECHECK_FAILED');
    expect(r.json().message).toMatch(/network-node-2 の存在確認（inspect）に失敗/);
    expect(r.json().message).toMatch(/HTTP 500/);
    expect(stub.mutations).toEqual([]);
    // 失敗した時点で中止し、3台目以降・ネットワーク・イメージの確認にも進まない
    expect(stub.log).toEqual(['container.inspect network-node-1', 'container.inspect network-node-2']);
    // 後始末の対象も無い（変更を始めていない）
    expect(r.json().cleanup).toBeUndefined();
  });

  it('1台目の inspect が 500、通信エラー（statusCode 無し）、503 のいずれでも何も変更しない', async () => {
    for (const status of [500, undefined, 503]) {
      stub.mutations.length = 0;
      stub.behaviour.containerInspect.clear();
      stub.behaviour.containerInspect.set('network-node-1', status);
      const r = await create(2);
      expect(r.statusCode).toBe(500);
      expect(r.json().error).toBe('LAB_PRECHECK_FAILED');
      expect(stub.mutations).toEqual([]);
    }
  });

  it('inspect が 404 なら従来どおり「存在しない」として進む（既存の1台目は確かめた ID で削除し、全台を作成する）', async () => {
    addContainer({ Id: 'oldnode00001', Name: 'network-node-1', Labels: LAB });
    const r = await create(2);
    expect(r.statusCode).toBe(200);
    expect(r.json().containers.map((c: { name: string }) => c.name)).toEqual(['network-node-1', 'network-node-2']);
    expect(stub.mutations).toEqual([
      'createNetwork lab-network',
      'container.remove oldnode00001',
      'createContainer network-node-1',
      'start cid-network-node-1',
      'createContainer network-node-2',
      'start cid-network-node-2',
    ]);
  });

  it('保護例外は従来どおり：パイロットのラベルを持つ同名コンテナは 403 で、何も変更しない', async () => {
    addContainer({ Id: 'pilotlab0001', Name: 'network-node-1', Labels: { ...LAB, 'cloud-dojo.lab': 'n5' } });
    const r = await create(2);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('PILOT_LAB_PROTECTED');
    expect(stub.mutations).toEqual([]);
  });

  it('保護例外は従来どおり：Docker ソケットをマウントした同名コンテナは 403 で、何も変更しない', async () => {
    addContainer({
      Id: 'socknode0001',
      Name: 'network-node-2',
      Labels: {},
      Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }],
    });
    const r = await create(2);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('DOCKER_SOCKET_CONTAINER_PROTECTED');
    expect(stub.mutations).toEqual([]);
  });

  it('保護対象が先にあれば、後ろのノードの inspect が 500 でも 403（保護の拒否を優先し、何も変更しない）', async () => {
    addContainer({ Id: 'pilotlab0001', Name: 'network-node-1', Labels: { 'cloud-dojo.lab': 'n5' } });
    stub.behaviour.containerInspect.set('network-node-2', 500);
    const r = await create(2);
    expect(r.statusCode).toBe(403);
    expect(stub.mutations).toEqual([]);
  });

  it('同名ネットワークの inspect が 500：何も変更せずに 500（従来から 404 以外は伝播。回帰の固定）', async () => {
    stub.behaviour.networkInspect.set('lab-network', 500);
    const r = await create(2);
    expect(r.statusCode).toBe(500);
    expect(stub.mutations).toEqual([]);
  });

  it('イメージの inspect が 500・通信エラー：pull も作成もせずに 500 LAB_PRECHECK_FAILED', async () => {
    for (const status of [500, 'conn'] as const) {
      stub.mutations.length = 0;
      stub.behaviour.imageInspect.status = status;
      const r = await create(2);
      expect(r.statusCode).toBe(500);
      expect(r.json().error).toBe('LAB_PRECHECK_FAILED');
      expect(r.json().message).toMatch(/イメージ alpine:latest の存在確認/);
      expect(stub.mutations).toEqual([]);
    }
  });

  it('イメージの inspect が 404 なら従来どおり pull してから作成する', async () => {
    stub.behaviour.imageInspect.status = 404;
    const r = await create(2);
    expect(r.statusCode).toBe(200);
    expect(stub.mutations[0]).toBe('pull alpine:latest');
    expect(stub.mutations).toContain('createContainer network-node-2');
  });
});

describe('直し回10（同じ原則）：作り直しのための既存ノードの削除失敗を読み飛ばさない', () => {
  it('既存の network-node-1 の削除が 500：そのノードを作成せずに中止し、この要求で作成したネットワークを後始末する', async () => {
    addContainer({ Id: 'oldnode00001', Name: 'network-node-1', Labels: LAB });
    stub.behaviour.containerRemove.set('oldnode00001', 500);
    const r = await create(2);
    expect(r.statusCode).toBe(500);
    expect(r.json().message).toMatch(/container remove oldnode00001: HTTP 500/);
    expect(stub.mutations).not.toContain('createContainer network-node-1');
    expect(stub.mutations).not.toContain('createContainer network-node-2');
    expect(r.json().cleanup).toEqual({ removed: ['netid-lab-network'], remaining: [] });
  });

  it('既存ノードの削除が 404（確認後に消えた）なら従来どおり進む', async () => {
    addContainer({ Id: 'oldnode00001', Name: 'network-node-1', Labels: LAB });
    stub.behaviour.containerRemove.set('oldnode00001', 404);
    const r = await create(2);
    expect(r.statusCode).toBe(200);
    expect(stub.mutations).toContain('createContainer network-node-1');
    expect(stub.mutations).toContain('createContainer network-node-2');
  });
});

describe('直し回10（同じ原則）：/lab/cleanup は削除の失敗を読み飛ばさず残存として出す', () => {
  const seed = () => {
    addContainer({ Id: 'labnode00001', Name: 'network-node-1', Labels: LAB });
    addContainer({ Id: 'labnode00002', Name: 'network-node-2', Labels: LAB });
    addNetwork('labnet0001', 'lab-network', LAB);
  };

  it('すべて削除できれば従来どおり 200', async () => {
    seed();
    const r = await app.inject({ method: 'DELETE', url: '/api/network/lab/cleanup' });
    expect(r.statusCode).toBe(200);
    expect(r.json().message).toBe('Network lab cleaned up successfully');
    expect(stub.mutations.sort()).toEqual(['container.remove labnode00001', 'container.remove labnode00002', 'network.remove labnet0001']);
  });

  it('ネットワークの削除が失敗（使用中 403）：成功とは返さず 500 で、名前・ID・復旧手順を残存として出す', async () => {
    seed();
    stub.behaviour.networkRemove.set('labnet0001', 403);
    const r = await app.inject({ method: 'DELETE', url: '/api/network/lab/cleanup' });
    expect(r.statusCode).toBe(500);
    const body = r.json();
    expect(body.cleanup.remaining).toEqual([
      {
        kind: 'network',
        name: 'lab-network',
        id: 'labnet0001',
        error: 'network remove labnet0001: HTTP 403',
        recovery: 'docker network rm labnet0001',
      },
    ]);
    expect(body.cleanup.removed.sort()).toEqual(['labnode00001', 'labnode00002']);
    expect(body.message).toMatch(/ネットワークラボの次のものを削除できず、残っています：ネットワーク lab-network（labnet0001）/);
    expect(body.message).toMatch(/復旧手順：docker network rm labnet0001/);
  });

  it('コンテナの削除が 500：他の対象の削除は試み、そのコンテナを残存として出す', async () => {
    seed();
    stub.behaviour.containerRemove.set('labnode00002', 500);
    const r = await app.inject({ method: 'DELETE', url: '/api/network/lab/cleanup' });
    expect(r.statusCode).toBe(500);
    expect(r.json().cleanup.remaining.map((x: { kind: string; name: string; id: string; recovery: string }) => [x.kind, x.name, x.id, x.recovery])).toEqual([
      ['container', 'network-node-2', 'labnode00002', 'docker rm -f labnode00002'],
    ]);
    expect(r.json().cleanup.removed.sort()).toEqual(['labnet0001', 'labnode00001']);
  });

  it('削除が 404（確認後に消えた）は削除済みとして扱い 200', async () => {
    seed();
    stub.behaviour.containerRemove.set('labnode00001', 404);
    stub.behaviour.networkRemove.set('labnet0001', 404);
    const r = await app.inject({ method: 'DELETE', url: '/api/network/lab/cleanup' });
    expect(r.statusCode).toBe(200);
  });

  it('対象の inspect が 500：何も削除せずに 500（従来から 404 以外は伝播。回帰の固定）', async () => {
    seed();
    stub.behaviour.containerInspect.set('labnode00002', 500);
    const r = await app.inject({ method: 'DELETE', url: '/api/network/lab/cleanup' });
    expect(r.statusCode).toBe(500);
    expect(stub.mutations).toEqual([]);
  });

  it('対象の inspect が 404（一覧の後に消えた）は従来どおり読み飛ばして残りを削除する', async () => {
    seed();
    stub.behaviour.containerInspect.set('labnode00002', 404);
    const r = await app.inject({ method: 'DELETE', url: '/api/network/lab/cleanup' });
    expect(r.statusCode).toBe(200);
    expect(stub.mutations.sort()).toEqual(['container.remove labnode00001', 'network.remove labnet0001']);
  });
});
