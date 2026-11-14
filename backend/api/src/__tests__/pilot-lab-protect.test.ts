/**
 * 直し回2（必須B）・直し回3（必須2）：既存のコンテナ・ネットワーク操作 API からパイロットのラボ（ラベル cloud-dojo.lab）を守る。
 * 対象：POST /api/network/exec、DELETE /api/docker/containers/:id、POST /api/docker/containers/:id/stop・start、
 * POST /api/network/lab/create（固定名の既存コンテナ削除）、DELETE /api/network/lab/cleanup（一括削除）、compose の down。
 * Docker が無い環境のため dockerode をスタブに差し替える（キューは Redis を使うため差し替える）。
 * スタブの inspect は実際の Docker と同じく、完全 ID・名前・一意な ID の接頭辞（短縮 ID）で解決する。
 */
import { PassThrough } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => {
  const calls = {
    exec: [] as string[],
    remove: [] as string[],
    stop: [] as string[],
    start: [] as string[],
    removeNetwork: [] as string[],
    createNetwork: [] as string[],
    create: [] as string[],
    /** 直し回4補足2：createNetwork に渡したラベル（ネットワーク名ごと） */
    createNetworkLabels: [] as { name: string; labels?: Record<string, string> }[],
    /** 直し回4補足2：createContainer に渡した NetworkMode（コンテナ名ごと） */
    networkMode: [] as { name: string; mode?: string }[],
  };
  const containers: Record<string, { Id: string; Name: string; Labels: Record<string, string>; State?: string }> = {};
  const networks: Record<string, { Id: string; Name: string; Labels: Record<string, string> }> = {};
  const byPrefix = <T extends { Id: string }>(all: T[], key: string) => {
    const hits = all.filter((x) => x.Id.startsWith(key));
    return hits.length === 1 ? hits[0] : undefined;
  };
  const find = (idOrName: string) =>
    containers[idOrName] ?? Object.values(containers).find((c) => c.Name === `/${idOrName}`) ?? byPrefix(Object.values(containers), idOrName);
  const findNet = (idOrName: string) =>
    networks[idOrName] ?? Object.values(networks).find((n) => n.Name === idOrName) ?? byPrefix(Object.values(networks), idOrName);
  const matches = (labels: Record<string, string>, filters?: { label?: string[] }) =>
    (filters?.label ?? []).every((f) => {
      const [k, v] = f.split('=');
      return labels[k] === v;
    });
  const notFound = (what: string) => Object.assign(new Error(`no such ${what}`), { statusCode: 404 });
  const docker = {
    ping: async () => 'OK',
    getImage: () => ({ inspect: async () => ({ Id: 'img' }) }),
    listContainers: async ({ filters }: { filters?: { label?: string[] } } = {}) =>
      Object.values(containers)
        .filter((c) => matches(c.Labels, filters))
        .map((c) => ({ Id: c.Id, Names: [c.Name], Labels: c.Labels, State: c.State ?? 'running' })),
    listNetworks: async ({ filters }: { filters?: { label?: string[] } } = {}) =>
      Object.values(networks)
        .filter((n) => matches(n.Labels, filters))
        .map((n) => ({ Id: n.Id, Name: n.Name, Labels: n.Labels })),
    getNetwork: (idOrName: string) => ({
      id: idOrName,
      inspect: async () => {
        const n = findNet(idOrName);
        if (!n) throw notFound(`network: ${idOrName}`);
        return { Id: n.Id, Name: n.Name, Labels: n.Labels };
      },
      remove: async () => {
        calls.removeNetwork.push(idOrName);
      },
    }),
    createNetwork: async (o: { Name: string; Labels?: Record<string, string> }) => {
      // 実際の Docker と同じく、同名のネットワークがあれば 409
      if (Object.values(networks).some((n) => n.Name === o.Name)) throw Object.assign(new Error('network exists'), { statusCode: 409 });
      calls.createNetwork.push(o.Name);
      calls.createNetworkLabels.push({ name: o.Name, labels: o.Labels });
      return { id: `net-${o.Name}` };
    },
    createContainer: async (spec: { name: string; HostConfig?: { NetworkMode?: string } }) => {
      calls.create.push(spec.name);
      calls.networkMode.push({ name: spec.name, mode: spec.HostConfig?.NetworkMode });
      return {
        id: `new-${spec.name}`,
        start: async () => undefined,
        inspect: async () => ({ NetworkSettings: { Networks: {} } }),
      };
    },
    getContainer: (idOrName: string) => ({
      inspect: async () => {
        const c = find(idOrName);
        if (!c) throw notFound(`container: ${idOrName}`);
        return { Id: c.Id, Name: c.Name, Config: { Labels: c.Labels }, State: { Running: (c.State ?? 'running') === 'running' } };
      },
      exec: async () => {
        calls.exec.push(idOrName);
        return {
          start: async () => {
            const s = new PassThrough();
            setImmediate(() => s.end(Buffer.concat([Buffer.alloc(8), Buffer.from('hello')])));
            return s;
          },
          inspect: async () => ({ ExitCode: 0 }),
        };
      },
      remove: async () => {
        calls.remove.push(idOrName);
      },
      stop: async () => {
        calls.stop.push(idOrName);
      },
      start: async () => {
        calls.start.push(idOrName);
      },
    }),
  };
  return { calls, containers, networks, docker };
});

vi.mock('dockerode', () => ({
  default: function FakeDocker() {
    return stub.docker;
  },
}));
vi.mock('../services/queue.js', () => ({ addDockerBuildTask: vi.fn(), addDockerRunTask: vi.fn() }));

const { networkRoutes } = await import('../routes/network');
const { dockerRoutes } = await import('../routes/docker');

let app: FastifyInstance;
beforeEach(async () => {
  for (const k of Object.keys(stub.calls) as (keyof typeof stub.calls)[]) stub.calls[k].length = 0;
  for (const k of Object.keys(stub.containers)) delete stub.containers[k];
  for (const k of Object.keys(stub.networks)) delete stub.networks[k];
  stub.containers['labc0ffee0001'] = {
    Id: 'labc0ffee0001',
    Name: '/cloud-dojo-lab-n5-tcp-abcg1-client',
    Labels: { 'cloud-dojo.lab': 'n5-tcp', 'cloud-dojo.role': 'client', 'cloud-dojo.gen': 'abcg1' },
  };
  stub.containers['plain0000001'] = { Id: 'plain0000001', Name: '/my-app', Labels: { 'cloud-dojo': 'network-lab' } };
  app = Fastify();
  await app.register(networkRoutes, { prefix: '/api/network' });
  await app.register(dockerRoutes, { prefix: '/api/docker' });
});
afterEach(async () => {
  await app.close();
});

describe('既存 API からのパイロットのラボコンテナへの操作を拒否する', () => {
  it('/api/network/exec：ラボコンテナは ID でも名前でも 403、exec は呼ばれない', async () => {
    for (const containerId of ['labc0ffee0001', 'cloud-dojo-lab-n5-tcp-abcg1-client']) {
      const r = await app.inject({ method: 'POST', url: '/api/network/exec', payload: { containerId, command: 'sysctl -w net.ipv4.tcp_syn_retries=1' } });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('PILOT_LAB_PROTECTED');
    }
    expect(stub.calls.exec).toHaveLength(0);
  });

  it('/api/network/exec：ラベルの無い通常のコンテナは従来どおり実行できる（確かめた ID で実行する）', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/network/exec', payload: { containerId: 'my-app', command: 'hostname' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ exitCode: 0, output: 'hello' });
    expect(stub.calls.exec).toEqual(['plain0000001']);
  });

  it('/api/docker/containers/:id の削除・停止・起動：ラボコンテナは 403、操作は呼ばれない', async () => {
    const reqs = [
      { method: 'DELETE' as const, url: '/api/docker/containers/labc0ffee0001?force=true' },
      { method: 'POST' as const, url: '/api/docker/containers/labc0ffee0001/stop' },
      { method: 'POST' as const, url: '/api/docker/containers/cloud-dojo-lab-n5-tcp-abcg1-client/start' },
    ];
    for (const q of reqs) {
      const r = await app.inject(q);
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('PILOT_LAB_PROTECTED');
    }
    expect(stub.calls.remove).toHaveLength(0);
    expect(stub.calls.stop).toHaveLength(0);
    expect(stub.calls.start).toHaveLength(0);
  });

  it('/api/docker/containers/:id の削除・停止・起動：通常のコンテナは従来どおり', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/docker/containers/plain0000001/stop' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/docker/containers/plain0000001/start' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/docker/containers/my-app' })).statusCode).toBe(200);
    expect(stub.calls).toMatchObject({ stop: ['plain0000001'], start: ['plain0000001'], remove: ['plain0000001'] });
  });

  it('存在しないコンテナは従来どおりのエラー（500）で、403 にはならない', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/docker/containers/nope' });
    expect(r.statusCode).toBe(500);
  });
});

/** 両方のラベル（既存のネットワークラボ cloud-dojo=network-lab とパイロットの cloud-dojo.lab）を併せ持つコンテナ */
function addDualLabelled(id = 'dual0000000001', name = '/network-node-1') {
  stub.containers[id] = { Id: id, Name: name, Labels: { 'cloud-dojo': 'network-lab', 'cloud-dojo.lab': 'n5-tcp', 'cloud-dojo.gen': 'abcg1' } };
}

describe('直し回3：既存 network API の削除経路（一括 cleanup・固定名削除）もラベルで拒否する', () => {
  it('DELETE /api/network/lab/cleanup：両ラベルを併せ持つコンテナがあれば 403 で、通常のコンテナも含め何も削除しない', async () => {
    addDualLabelled();
    stub.networks['labnet0001'] = { Id: 'labnet0001', Name: 'lab-network', Labels: { 'cloud-dojo': 'network-lab' } };
    const r = await app.inject({ method: 'DELETE', url: '/api/network/lab/cleanup' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('PILOT_LAB_PROTECTED');
    expect(stub.calls.remove).toHaveLength(0);
    expect(stub.calls.removeNetwork).toHaveLength(0);
  });

  it('DELETE /api/network/lab/cleanup：両ラベルを併せ持つネットワークがあれば 403 で、何も削除しない', async () => {
    stub.networks['dualnet0001'] = { Id: 'dualnet0001', Name: 'lab-network', Labels: { 'cloud-dojo': 'network-lab', 'cloud-dojo.lab': 'n5-tcp' } };
    const r = await app.inject({ method: 'DELETE', url: '/api/network/lab/cleanup' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('PILOT_LAB_PROTECTED');
    expect(stub.calls.remove).toHaveLength(0);
    expect(stub.calls.removeNetwork).toHaveLength(0);
  });

  it('DELETE /api/network/lab/cleanup：パイロットのラベルが無ければ従来どおり network-lab のものだけ削除する', async () => {
    stub.networks['labnet0001'] = { Id: 'labnet0001', Name: 'lab-network', Labels: { 'cloud-dojo': 'network-lab' } };
    const r = await app.inject({ method: 'DELETE', url: '/api/network/lab/cleanup' });
    expect(r.statusCode).toBe(200);
    // ラボコンテナ labc0ffee0001 は network-lab ラベルを持たないので対象外。plain0000001 だけ削除する
    expect(stub.calls.remove).toEqual(['plain0000001']);
    expect(stub.calls.removeNetwork).toEqual(['labnet0001']);
  });

  it('POST /api/network/lab/create：固定名 network-node-<i> が両ラベルを併せ持つコンテナなら 403 で、何も作成・削除しない', async () => {
    addDualLabelled('dual0000000002', '/network-node-2');
    const r = await app.inject({ method: 'POST', url: '/api/network/lab/create', payload: { nodeCount: 3 } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('PILOT_LAB_PROTECTED');
    expect(stub.calls.remove).toHaveLength(0);
    expect(stub.calls.createNetwork).toHaveLength(0);
    expect(stub.calls.create).toHaveLength(0);
  });

  it('POST /api/network/lab/create：パイロットのラベルが無い同名コンテナは従来どおり（確かめた ID で）削除して作り直す', async () => {
    stub.containers['oldnode00001'] = { Id: 'oldnode00001', Name: '/network-node-1', Labels: { 'cloud-dojo': 'network-lab' } };
    const r = await app.inject({ method: 'POST', url: '/api/network/lab/create', payload: { nodeCount: 2 } });
    expect(r.statusCode).toBe(200);
    expect(stub.calls.remove).toEqual(['oldnode00001']);
    expect(stub.calls.create).toEqual(['network-node-1', 'network-node-2']);
  });
});

describe('直し回3：短縮 ID・名前での指定でもラボを保護する', () => {
  it('exec・削除・停止・起動：短縮 ID と名前のどちらでも 403、操作は呼ばれない', async () => {
    const targets = ['labc0ff', 'labc0ffee', 'cloud-dojo-lab-n5-tcp-abcg1-client'];
    for (const t of targets) {
      const reqs = [
        { method: 'POST' as const, url: '/api/network/exec', payload: { containerId: t, command: 'true' } },
        { method: 'DELETE' as const, url: `/api/docker/containers/${t}?force=true` },
        { method: 'POST' as const, url: `/api/docker/containers/${t}/stop` },
        { method: 'POST' as const, url: `/api/docker/containers/${t}/start` },
      ];
      for (const q of reqs) {
        const r = await app.inject(q);
        expect(r.statusCode, `${q.method} ${q.url}`).toBe(403);
        expect(r.json().error).toBe('PILOT_LAB_PROTECTED');
      }
    }
    expect(stub.calls).toMatchObject({ exec: [], remove: [], stop: [], start: [] });
  });

  it('通常のコンテナは短縮 ID でも従来どおりで、操作は確かめた完全な ID に対して行う', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/docker/containers/plain00/stop' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/network/exec', payload: { containerId: 'plain00', command: 'hostname' } })).statusCode).toBe(200);
    expect(stub.calls.stop).toEqual(['plain0000001']);
    expect(stub.calls.exec).toEqual(['plain0000001']);
  });

  it('一括 cleanup・固定名削除：両ラベルのコンテナは、名前で選ばれても ID で選ばれても拒否する（名前の付け替え後も ID で判定）', async () => {
    // 固定名 network-node-1 がラボコンテナに付いている（名前の再割当を想定）
    addDualLabelled('dual0000000003', '/network-node-1');
    expect((await app.inject({ method: 'POST', url: '/api/network/lab/create', payload: { nodeCount: 2 } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/network/lab/cleanup' })).statusCode).toBe(403);
    expect(stub.calls.remove).toHaveLength(0);
  });
});

describe('直し回3：compose の削除経路もラベルで拒否する', () => {
  it('compose down：プロジェクト名の接頭辞に当たるコンテナがパイロットのラベルを持てば、何も停止・削除せずに失敗する', async () => {
    const { composeService } = await import('../services/compose');
    stub.containers['dual0000000004'] = { Id: 'dual0000000004', Name: '/proj_web', Labels: { 'cloud-dojo.lab': 'n5-tcp' } };
    stub.containers['plainproj0001'] = { Id: 'plainproj0001', Name: '/proj_db', Labels: {} };
    const silence = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(composeService.composeDown('proj')).rejects.toThrow(/パイロットのラボ/);
    silence.mockRestore();
    expect(stub.calls.stop).toHaveLength(0);
    expect(stub.calls.remove).toHaveLength(0);
    expect(stub.calls.removeNetwork).toHaveLength(0);
  });

  it('compose down：パイロットのラベルを持つネットワークがあれば失敗し、何も削除しない', async () => {
    const { composeService } = await import('../services/compose');
    stub.containers['plainproj0001'] = { Id: 'plainproj0001', Name: '/proj_db', Labels: {} };
    stub.networks['dualnet0002'] = { Id: 'dualnet0002', Name: 'proj_default', Labels: { 'cloud-dojo.lab': 'n5-tcp' } };
    const silence = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(composeService.composeDown('proj')).rejects.toThrow(/パイロットのラボ/);
    silence.mockRestore();
    expect(stub.calls.remove).toHaveLength(0);
    expect(stub.calls.removeNetwork).toHaveLength(0);
  });

  it('compose down：パイロットのラベルが無ければ従来どおり停止・削除する', async () => {
    const { composeService } = await import('../services/compose');
    stub.containers['plainproj0001'] = { Id: 'plainproj0001', Name: '/proj_db', Labels: {} };
    stub.networks['projnet0001'] = { Id: 'projnet0001', Name: 'proj_default', Labels: {} };
    const silence = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await composeService.composeDown('proj');
    silence.mockRestore();
    expect(stub.calls.stop).toEqual(['plainproj0001']);
    expect(stub.calls.remove).toEqual(['plainproj0001']);
    expect(stub.calls.removeNetwork).toEqual(['projnet0001']);
  });
});

const COMPOSE_YAML = `version: '3.8'
services:
  web:
    image: nginx
  db:
    image: postgres
`;

describe('直し回4（推奨A）：compose up の保護拒否をジョブ失敗にする', () => {
  it('同名の既存コンテナがパイロットのラボなら、停止・削除せず、ジョブ（runComposeUpJob）は失敗する', async () => {
    const { composeService, runComposeUpJob } = await import('../services/compose');
    stub.containers['dual0000000005'] = { Id: 'dual0000000005', Name: '/proj_web', Labels: { 'cloud-dojo.lab': 'n5-tcp' } };
    const silence = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined)];
    const progress: number[] = [];
    await expect(runComposeUpJob(composeService, { composeYaml: COMPOSE_YAML, projectName: 'proj' }, (p) => void progress.push(p))).rejects.toThrow(
      /Compose up failed: .*パイロットのラボ.*web/,
    );
    silence.forEach((s) => s.mockRestore());
    expect(stub.calls.stop).toHaveLength(0);
    expect(stub.calls.remove).toHaveLength(0);
    // 保護対象のサービスは作り直さない。他のサービス（db）は従来どおり起動する
    expect(stub.calls.create).toEqual(['proj_db']);
    expect(progress).not.toContain(100);
  });

  it('パイロットのラベルが無ければ従来どおり既存コンテナを削除して起動し、ジョブは success:true', async () => {
    const { composeService, runComposeUpJob } = await import('../services/compose');
    stub.containers['plainweb0001'] = { Id: 'plainweb0001', Name: '/proj_web', Labels: {} };
    const silence = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined)];
    const r = await runComposeUpJob(composeService, { composeYaml: COMPOSE_YAML, projectName: 'proj' });
    silence.forEach((s) => s.mockRestore());
    expect(r.success).toBe(true);
    expect(stub.calls.stop).toEqual(['plainweb0001']);
    expect(stub.calls.remove).toEqual(['plainweb0001']);
    expect(stub.calls.create).toEqual(['proj_web', 'proj_db']);
  });
});

describe('直し回4（推奨B）：/lab/create は既存の同名ネットワークをラベルで確かめてから再利用する', () => {
  const create = (networkName = 'lab-network') =>
    app.inject({ method: 'POST', url: '/api/network/lab/create', payload: { nodeCount: 2, networkName } });

  it('ラボ用のラベル（cloud-dojo=network-lab）が無い同名ネットワークには接続せず 409、何も作成・削除しない', async () => {
    stub.networks['othernet0001'] = { Id: 'othernet0001', Name: 'lab-network', Labels: { app: 'something-else' } };
    stub.containers['oldnode00001'] = { Id: 'oldnode00001', Name: '/network-node-1', Labels: { 'cloud-dojo': 'network-lab' } };
    const r = await create();
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('LAB_NETWORK_UNVERIFIED');
    expect(stub.calls.createNetwork).toHaveLength(0);
    expect(stub.calls.create).toHaveLength(0);
    expect(stub.calls.remove).toHaveLength(0);
  });

  it('パイロットのラベルを持つ同名ネットワークには接続せず 403、何も作成・削除しない', async () => {
    stub.networks['dualnet0003'] = { Id: 'dualnet0003', Name: 'lab-network', Labels: { 'cloud-dojo': 'network-lab', 'cloud-dojo.lab': 'n5-tcp' } };
    const r = await create();
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('PILOT_LAB_PROTECTED');
    expect(stub.calls.createNetwork).toHaveLength(0);
    expect(stub.calls.create).toHaveLength(0);
  });

  it('ID の接頭辞で別名のネットワークに解決された場合（名前が一致しない）も接続しない', async () => {
    stub.networks['labnetwork-xyz'] = { Id: 'labnetwork-xyz', Name: 'unrelated', Labels: { 'cloud-dojo': 'network-lab' } };
    const r = await create('labnetwork');
    expect(r.statusCode).toBe(409);
    expect(stub.calls.create).toHaveLength(0);
  });

  it('ラボ用の同名ネットワークは従来どおり再利用し（作り直さない）、確かめた ID を返す', async () => {
    stub.networks['labnet0009'] = { Id: 'labnet0009', Name: 'lab-network', Labels: { 'cloud-dojo': 'network-lab' } };
    const r = await create();
    expect(r.statusCode).toBe(200);
    expect(r.json().networkId).toBe('labnet0009');
    expect(stub.calls.createNetwork).toHaveLength(0);
    expect(stub.calls.create).toEqual(['network-node-1', 'network-node-2']);
  });

  it('同名ネットワークが無ければ従来どおり作成する', async () => {
    const r = await create();
    expect(r.statusCode).toBe(200);
    expect(stub.calls.createNetwork).toEqual(['lab-network']);
    expect(r.json().networkId).toBe('net-lab-network');
  });
});

const COMPOSE_NET_YAML = `version: '3.8'
services:
  web:
    image: nginx
  db:
    image: postgres
networks:
  app:
    driver: bridge
`;

describe('直し回4補足2：compose up は既存の同名ネットワークをラベルで確かめてから接続する', () => {
  const up = async () => {
    const { composeService, runComposeUpJob } = await import('../services/compose');
    const quiet = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined)];
    try {
      return await runComposeUpJob(composeService, { composeYaml: COMPOSE_NET_YAML, projectName: 'proj' }).then(
        (r) => ({ ok: true as const, r }),
        (e: Error) => ({ ok: false as const, e }),
      );
    } finally {
      quiet.forEach((q) => q.mockRestore());
    }
  };
  /** 拒否したときは、ネットワーク・コンテナを何も作成・停止・削除していない */
  const expectNothingTouched = () => {
    expect(stub.calls.createNetwork).toHaveLength(0);
    expect(stub.calls.create).toHaveLength(0);
    expect(stub.calls.stop).toHaveLength(0);
    expect(stub.calls.remove).toHaveLength(0);
    expect(stub.calls.removeNetwork).toHaveLength(0);
  };

  it('ラボ用でない既存ネットワーク（ネットワークラボ cloud-dojo=network-lab）には接続せず、ジョブは失敗する', async () => {
    stub.networks['labnet0101'] = { Id: 'labnet0101', Name: 'proj_app', Labels: { 'cloud-dojo': 'network-lab' } };
    stub.containers['plainweb0101'] = { Id: 'plainweb0101', Name: '/proj_web', Labels: {} };
    const res = await up();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.e.message).toMatch(/Compose up failed: 既存のネットワーク proj_app は compose 用と確かめられない.*cloud-dojo=network-lab/);
    expectNothingTouched();
  });

  it('ラベルの無い既存ネットワーク・別プロジェクトのラベルのネットワークにも接続しない', async () => {
    const cases: Record<string, string>[] = [{}, { app: 'something-else' }, { 'cloud-dojo': 'compose', 'cloud-dojo.compose.project': 'other', 'cloud-dojo.compose.network': 'app' }, { 'com.docker.compose.project': 'other', 'com.docker.compose.network': 'app' }];
    for (const labels of cases) {
      for (const k of Object.keys(stub.networks)) delete stub.networks[k];
      stub.networks['net0102'] = { Id: 'net0102', Name: 'proj_app', Labels: labels };
      const res = await up();
      expect(res.ok, JSON.stringify(labels)).toBe(false);
      if (!res.ok) expect(res.e.message).toMatch(/compose 用と確かめられない/);
    }
    expectNothingTouched();
  });

  it('パイロットのラベルを持つ既存ネットワークには接続せず、ジョブは失敗する', async () => {
    stub.networks['pilotnet0103'] = {
      Id: 'pilotnet0103',
      Name: 'proj_app',
      Labels: { 'cloud-dojo': 'compose', 'cloud-dojo.compose.project': 'proj', 'cloud-dojo.compose.network': 'app', 'cloud-dojo.lab': 'n5-tcp' },
    };
    const res = await up();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.e.message).toMatch(/パイロットのラボ/);
    expectNothingTouched();
  });

  it('ID の接頭辞で別名のネットワークに解決された場合（名前が一致しない）も接続しない', async () => {
    stub.networks['proj_app-zzz'] = { Id: 'proj_app-zzz', Name: 'unrelated', Labels: { 'cloud-dojo': 'compose', 'cloud-dojo.compose.project': 'proj', 'cloud-dojo.compose.network': 'app' } };
    const res = await up();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.e.message).toMatch(/名前が一致しない/);
    expectNothingTouched();
  });

  it('この API が作った同じプロジェクトのネットワークは、作り直さずに接続する', async () => {
    stub.networks['ours0104'] = { Id: 'ours0104', Name: 'proj_app', Labels: { 'cloud-dojo': 'compose', 'cloud-dojo.compose.project': 'proj', 'cloud-dojo.compose.network': 'app' } };
    const res = await up();
    expect(res.ok).toBe(true);
    expect(stub.calls.createNetwork).toHaveLength(0);
    // 直し回5 推奨A：接続は確かめたネットワークの ID で行う（以前は名前 proj_app）
    expect(stub.calls.networkMode).toEqual([
      { name: 'proj_web', mode: 'ours0104' },
      { name: 'proj_db', mode: 'ours0104' },
    ]);
  });

  it('Docker Compose が作った同じプロジェクトのネットワーク（com.docker.compose.*）にも従来どおり接続する', async () => {
    stub.networks['dc0105'] = { Id: 'dc0105', Name: 'proj_app', Labels: { 'com.docker.compose.project': 'proj', 'com.docker.compose.network': 'app' } };
    const res = await up();
    expect(res.ok).toBe(true);
    expect(stub.calls.createNetwork).toHaveLength(0);
    expect(stub.calls.create).toEqual(['proj_web', 'proj_db']);
  });

  it('同名のネットワークが無ければ、compose のラベルを付けて作成し、そこへ接続する', async () => {
    const res = await up();
    expect(res.ok).toBe(true);
    expect(stub.calls.createNetworkLabels).toEqual([
      { name: 'proj_app', labels: { 'cloud-dojo': 'compose', 'cloud-dojo.compose.project': 'proj', 'cloud-dojo.compose.network': 'app' } },
    ]);
    // 直し回5 推奨A：接続は作成したネットワークの ID で行う（以前は名前 proj_app。スタブの作成は ID net-<名前> を返す）
    expect(stub.calls.networkMode.map((m) => m.mode)).toEqual(['net-proj_app', 'net-proj_app']);
  });
});
