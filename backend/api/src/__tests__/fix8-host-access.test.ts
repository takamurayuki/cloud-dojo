/**
 * 直し回8：
 * - 必須1：空文字列・空白だけのソースを、compose の bind（短い書式・長い書式・driver_opts.device・secrets の file・
 *   実際に Docker に渡す Binds）、既存コンテナの Mounts.Source、Kubernetes の hostPath の3経路すべてで判定不能として拒否する
 *   （既存コンテナでは保護対象にする）。経路ごとの判定が共有関数の結果と一致することを確かめる
 * - 推奨：保護拒否を含む部分成功でも、失敗理由に起動したサービスと失敗したサービスを両方とも載せる
 * Docker が無い環境のため dockerode をスタブに差し替える（直し回7 のスタブと同じ）。キューも差し替える。
 */
import { PassThrough } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mount = { Type: string; Source: string; Destination: string };
type FakeContainer = { Id: string; Name: string; Labels: Record<string, string>; Mounts?: Mount[]; Running: boolean };

const stub = vi.hoisted(() => {
  /** Docker への全ての呼び出し（メソッド名と対象） */
  const log: string[] = [];
  const calls = {
    exec: [] as { id: string; cmd: string[] }[],
    stop: [] as string[],
    start: [] as string[],
    removeContainer: [] as string[],
    removeNetwork: [] as string[],
    createNetwork: [] as string[],
    create: [] as { name: string; networkMode?: string; binds?: string[] }[],
    createVolume: [] as string[],
  };
  const containers: Record<string, FakeContainer> = {};
  const networks: Record<string, { Id: string; Name: string; Labels: Record<string, string> }> = {};
  const behaviour = {
    /** network.inspect を通信エラーにする名前（statusCode の無いエラー） */
    failNetworkInspect: new Set<string>(),
    /** ネットワーク削除を失敗させる ID */
    failNetworkRemove: new Set<string>(),
    /** コンテナ削除を失敗させる ID */
    failContainerRemove: new Set<string>(),
    /** コンテナ作成を失敗させる名前 */
    failCreate: new Set<string>(),
    /** container.inspect を 500 にする名前 */
    failContainerInspect: new Set<string>(),
    /** volume.inspect を 500 にする名前 */
    failVolumeInspect: new Set<string>(),
    /** image.inspect を 500 にする名前 */
    failImageInspect: new Set<string>(),
  };
  const serverError = (what: string) => Object.assign(new Error(`(HTTP code 500) server error - ${what}`), { statusCode: 500 });
  const notFound = (what: string) => Object.assign(new Error(`no such ${what}`), { statusCode: 404 });
  const findContainer = (idOrName: string) => containers[idOrName] ?? Object.values(containers).find((c) => c.Name === idOrName);
  const findNet = (idOrName: string) => networks[idOrName] ?? Object.values(networks).find((n) => n.Name === idOrName);
  const docker = {
    ping: async () => {
      log.push('ping');
      return 'OK';
    },
    getImage: (n: string) => ({
      inspect: async () => {
        log.push(`image.inspect ${n}`);
        if (behaviour.failImageInspect.has(n)) throw serverError(`image ${n}`);
        return { Id: 'img' };
      },
    }),
    getVolume: (n: string) => ({
      inspect: async () => {
        log.push(`volume.inspect ${n}`);
        if (behaviour.failVolumeInspect.has(n)) throw serverError(`volume ${n}`);
        return { Name: n };
      },
    }),
    createVolume: async (o: { Name: string }) => {
      log.push(`createVolume ${o.Name}`);
      calls.createVolume.push(o.Name);
    },
    pull: () => {
      log.push('pull');
    },
    listContainers: async () => {
      log.push('listContainers');
      return Object.values(containers).map((c) => ({
        Id: c.Id,
        Names: [`/${c.Name}`],
        Labels: c.Labels,
        Mounts: c.Mounts ?? [],
        State: c.Running ? 'running' : 'exited',
      }));
    },
    listNetworks: async () => {
      log.push('listNetworks');
      return Object.values(networks);
    },
    getNetwork: (idOrName: string) => ({
      id: idOrName,
      inspect: async () => {
        log.push(`network.inspect ${idOrName}`);
        if (behaviour.failNetworkInspect.has(idOrName)) throw new Error('connect ECONNREFUSED /var/run/docker.sock');
        const n = findNet(idOrName);
        if (!n) throw notFound(`network: ${idOrName}`);
        return { Id: n.Id, Name: n.Name, Labels: n.Labels };
      },
      remove: async () => {
        log.push(`network.remove ${idOrName}`);
        if (behaviour.failNetworkRemove.has(idOrName)) throw Object.assign(new Error('network has active endpoints'), { statusCode: 403 });
        calls.removeNetwork.push(idOrName);
        const n = findNet(idOrName);
        if (n) delete networks[n.Id];
      },
    }),
    createNetwork: async (o: { Name: string; Labels?: Record<string, string> }) => {
      log.push(`createNetwork ${o.Name}`);
      const id = `netid-${o.Name}`;
      networks[id] = { Id: id, Name: o.Name, Labels: o.Labels ?? {} };
      calls.createNetwork.push(o.Name);
      return { id };
    },
    createContainer: async (spec: { name: string; HostConfig?: { NetworkMode?: string; Binds?: string[] } }) => {
      log.push(`createContainer ${spec.name}`);
      if (behaviour.failCreate.has(spec.name)) throw new Error(`create failed: ${spec.name}`);
      calls.create.push({ name: spec.name, networkMode: spec.HostConfig?.NetworkMode, binds: spec.HostConfig?.Binds });
      const id = `cid-${spec.name}`;
      containers[id] = { Id: id, Name: spec.name, Labels: {}, Running: true };
      return {
        id,
        start: async () => undefined,
        inspect: async () => ({ NetworkSettings: { Networks: {} } }),
      };
    },
    getContainer: (idOrName: string) => ({
      id: idOrName,
      inspect: async () => {
        log.push(`container.inspect ${idOrName}`);
        if (behaviour.failContainerInspect.has(idOrName)) throw serverError(`container ${idOrName}`);
        const c = findContainer(idOrName);
        if (!c) throw notFound(`container: ${idOrName}`);
        return { Id: c.Id, Name: `/${c.Name}`, Config: { Labels: c.Labels }, Mounts: c.Mounts, State: { Running: c.Running, ExitCode: 0 } };
      },
      exec: async (o: { Cmd: string[] }) => {
        log.push(`container.exec ${idOrName}`);
        calls.exec.push({ id: idOrName, cmd: o.Cmd });
        return {
          start: async () => {
            const s = new PassThrough();
            setImmediate(() => {
              s.write(Buffer.concat([Buffer.alloc(8), Buffer.from('uid=0(root)')]));
              s.end();
            });
            return s;
          },
          inspect: async () => ({ ExitCode: 0 }),
        };
      },
      remove: async () => {
        log.push(`container.remove ${idOrName}`);
        if (behaviour.failContainerRemove.has(idOrName)) throw Object.assign(new Error('removal in progress'), { statusCode: 409 });
        calls.removeContainer.push(idOrName);
        delete containers[idOrName];
      },
      stop: async () => {
        log.push(`container.stop ${idOrName}`);
        calls.stop.push(idOrName);
      },
      start: async () => {
        log.push(`container.start ${idOrName}`);
        calls.start.push(idOrName);
      },
    }),
  };
  return { log, calls, containers, networks, behaviour, docker };
});

vi.mock('dockerode', () => ({
  default: function FakeDocker() {
    return stub.docker;
  },
}));
const queue = vi.hoisted(() => ({ addComposeUpTask: vi.fn(async () => 'job-1'), addComposeDownTask: vi.fn(async () => 'job-2') }));
vi.mock('../services/queue.js', () => ({ ...queue, addDockerBuildTask: vi.fn(), addDockerRunTask: vi.fn() }));
vi.mock('../services/queue', () => ({ ...queue, addDockerBuildTask: vi.fn(), addDockerRunTask: vi.fn() }));

const { composeService, runComposeUpJob } = await import('../services/compose');
const guard = await import('../services/compose-guard');
const protect = await import('../pilot/lab/protect');
const k8sGuard = await import('../services/k8s-manifest-guard');
const { composeRoutes } = await import('../routes/compose');
const { networkRoutes } = await import('../routes/network');
const { dockerRoutes } = await import('../routes/docker');

let quiet: { mockRestore: () => void }[] = [];
let app: FastifyInstance;
beforeEach(async () => {
  stub.log.length = 0;
  for (const k of Object.keys(stub.calls) as (keyof typeof stub.calls)[]) stub.calls[k].length = 0;
  for (const k of Object.keys(stub.networks)) delete stub.networks[k];
  for (const k of Object.keys(stub.containers)) delete stub.containers[k];
  for (const s of Object.values(stub.behaviour)) s.clear();
  queue.addComposeUpTask.mockClear();
  quiet = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined)];
  app = Fastify();
  await app.register(composeRoutes);
  await app.register(networkRoutes, { prefix: '/api/network' });
  await app.register(dockerRoutes, { prefix: '/api/docker' });
});
afterEach(async () => {
  quiet.forEach((q) => q.mockRestore());
  vi.restoreAllMocks();
  await app.close();
});

const vol = (spec: string) =>
  `version: '3.8'\nservices:\n  attacker:\n    image: docker:cli\n    command: ["docker", "rm", "-f", "PILOT_ID"]\n    volumes:\n      - ${spec}\n`;

/** 受付（route）で 400 になりキューに入らず、Worker 側（runComposeUpJob）でも Docker を一切操作せずに失敗すること */
async function expectRejectedBeforeCreate(yamlText: string, pattern: RegExp) {
  const r = await app.inject({ method: 'POST', url: '/api/compose/up', payload: { composeYaml: yamlText, projectName: 'proj' } });
  expect(r.statusCode, yamlText).toBe(400);
  expect(r.json().code).toBe('COMPOSE_DEFINITION_REJECTED');
  expect(r.json().error).toMatch(pattern);
  expect(queue.addComposeUpTask).not.toHaveBeenCalled();

  stub.log.length = 0;
  await expect(runComposeUpJob(composeService, { composeYaml: yamlText, projectName: 'proj' }), yamlText).rejects.toThrow(
    /Compose up failed: compose 定義にホストを操作できる設定が含まれるため、作成を開始せずに中止しました/,
  );
  expect(stub.log, yamlText).toEqual([]);
  expect(stub.calls.create).toEqual([]);
}

/** cloud-dojo-worker と同じ形（ラベル無し）で、指定のマウントを持つコンテナ */
function addMounted(source: string, id = 'workerid0001', name = 'cloud-dojo-worker') {
  stub.containers[id] = {
    Id: id,
    Name: name,
    Labels: { 'com.docker.compose.service': 'worker' },
    Mounts: [{ Type: 'bind', Source: source, Destination: '/sock' }],
    Running: true,
  };
}

const podWithHostPath = (p: string) => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'attacker' },
  spec: { containers: [{ name: 'c', image: 'docker:cli' }], volumes: [{ name: 's', hostPath: { path: p } }] },
});

/** 3経路それぞれの判定結果（compose の Binds、既存コンテナの Mounts.Source、Kubernetes の hostPath） */
function threeRoutes(source: string) {
  const compose = guard.inspectBinds('attacker', [`${source}:/sock`]).map((v) => v.detail);
  const mount = protect.dockerSocketMountReason([{ Type: 'bind', Source: source, Destination: '/sock' }]);
  let k8s: string | null = null;
  try {
    k8sGuard.assertManifestSafe([podWithHostPath(source)]);
  } catch (e) {
    k8s = (e as Error).message;
  }
  return { compose, mount, k8s };
}


const EMPTYISH = ['', ' ', '   ', '\t', '\u00a0', ' \u3000 '];

describe('直し回8 必須1：空・空白だけのソースは3経路すべてで判定不能として拒否（保護）する', () => {
  it('共有関数・compose の Binds・Mounts.Source・hostPath の判定が一致する（どれも読み飛ばさない）', () => {
    for (const src of EMPTYISH) {
      const label = JSON.stringify(src);
      const shared = guard.dockerSocketReason(src);
      expect(shared, label).toMatch(/判定できない/);
      expect(shared, label).toBe(guard.uninterpretablePathReason(src));
      const r = threeRoutes(src);
      expect(r.compose, label).toEqual([shared]);
      expect(r.mount, label).toContain(shared!);
      expect(r.k8s, label).toContain(shared!);
    }
    // 再レビューの実測例そのもの
    expect(guard.inspectBinds('x', [':/sock'])).toHaveLength(1);
    expect(protect.dockerSocketMountReason([{ Source: '' }])).toMatch(/空のパス/);
    // 通常のマウント（Source が通常のパス）は従来どおり通る
    expect(protect.dockerSocketMountReason([{ Type: 'volume', Source: '/var/lib/docker/volumes/x/_data', Destination: '/data' }])).toBeNull();
  });

  it('compose 定義：短い書式（`:/sock`・空白だけの元）、長い書式の source（type あり／なし）、driver_opts.device、secrets の file の空・空白だけを受付・Worker で拒否する', async () => {
    await expectRejectedBeforeCreate(vol(`":/var/run/docker.sock"`), /空のパス/);
    await expectRejectedBeforeCreate(vol(`"  :/var/run/docker.sock"`), /空白だけのパス/);
    await expectRejectedBeforeCreate(
      `version: '3.8'\nservices:\n  a:\n    image: x\n    volumes:\n      - type: bind\n        source: ''\n        target: /sock\n`,
      /空のパス/,
    );
    await expectRejectedBeforeCreate(
      `version: '3.8'\nservices:\n  a:\n    image: x\n    volumes:\n      - source: '  '\n        target: /sock\n`,
      /空白だけのパス/,
    );
    await expectRejectedBeforeCreate(
      `version: '3.8'\nservices:\n  a:\n    image: x\n    volumes:\n      - v:/x\nvolumes:\n  v:\n    driver_opts:\n      type: none\n      o: bind\n      device: ''\n`,
      /driver_opts\.device.*空のパス/,
    );
    await expectRejectedBeforeCreate(`version: '3.8'\nservices:\n  a:\n    image: x\nsecrets:\n  s:\n    file: ' '\n`, /secrets\.s\.file.*空白だけのパス/);
  });

  it('Mounts.Source が空・空白だけの既存コンテナは、exec・削除・停止・起動の対象にしない（403、操作は inspect だけ）', async () => {
    for (const src of ['', '  ', '\t']) {
      for (const k of Object.keys(stub.containers)) delete stub.containers[k];
      stub.log.length = 0;
      addMounted(src);
      const reqs = [
        { method: 'POST' as const, url: '/api/network/exec', payload: { containerId: 'cloud-dojo-worker', command: 'id' } },
        { method: 'DELETE' as const, url: '/api/docker/containers/cloud-dojo-worker?force=true' },
        { method: 'POST' as const, url: '/api/docker/containers/cloud-dojo-worker/stop' },
        { method: 'POST' as const, url: '/api/docker/containers/cloud-dojo-worker/start' },
      ];
      for (const req of reqs) {
        const r = await app.inject(req);
        expect(r.statusCode, `${JSON.stringify(src)} ${req.url}`).toBe(403);
        expect(r.json().error).toBe('DOCKER_SOCKET_CONTAINER_PROTECTED');
        expect(r.json().message).toMatch(/判定できない/);
      }
      expect(stub.log.every((l) => l.startsWith('container.inspect')), JSON.stringify(src)).toBe(true);
    }
    expect(stub.calls.exec).toEqual([]);
    expect(stub.calls.removeContainer).toEqual([]);
    expect(stub.calls.stop).toEqual([]);
    expect(stub.calls.start).toEqual([]);
  });

  it('tmpfs のように Source が空のマウントを持つ通常のコンテナも保護対象になる（判定不能を許可側に倒さない）', async () => {
    stub.containers['tmpfsid00001'] = {
      Id: 'tmpfsid00001',
      Name: 'ordinary-tmpfs',
      Labels: {},
      Mounts: [{ Type: 'tmpfs', Source: '', Destination: '/run/cache' }],
      Running: true,
    };
    const r = await app.inject({ method: 'POST', url: '/api/docker/containers/ordinary-tmpfs/stop' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('DOCKER_SOCKET_CONTAINER_PROTECTED');
    expect(stub.calls.stop).toEqual([]);
  });

  it('compose up・down：同名の既存コンテナの Mounts.Source が空なら、停止・削除・作成しない（listContainers 経路も同じ）', async () => {
    addMounted('', 'projwebid01', 'proj_web');
    await expect(runComposeUpJob(composeService, { composeYaml: `version: '3.8'\nservices:\n  web:\n    image: nginx\n`, projectName: 'proj' })).rejects.toThrow(
      /を保護するため.*web: .*空のパス/,
    );
    await expect(composeService.composeDown('proj')).rejects.toThrow(/空のパス/);
    expect(stub.calls.stop).toEqual([]);
    expect(stub.calls.removeContainer).toEqual([]);
    expect(stub.calls.create).toEqual([]);
  });
});

describe('直し回8 推奨：保護拒否を含む部分成功でも、起動したサービスと失敗したサービスを両方とも表示する', () => {
  const TWO = `version: '3.8'\nservices:\n  a:\n    image: nginx\n  b:\n    image: redis\n`;

  it('a は起動・b は既存コンテナの保護で中止：失敗理由に保護の理由と「起動したサービス：a／失敗したサービス：b: …」が両方出る', async () => {
    addMounted('/var/run/docker.sock', 'projbid0001', 'proj_b');
    let message = '';
    await runComposeUpJob(composeService, { composeYaml: TWO, projectName: 'proj' }).catch((e: Error) => {
      message = e.message;
    });
    expect(message).toMatch(/^Compose up failed: パイロットのラボ（または Docker ソケットをマウントしたコンテナ）を保護するため、次のサービスの既存コンテナを停止・削除せずに中止しました（b: .*Docker ソケット.*）。/);
    expect(message).toMatch(/。一部のサービスを起動できませんでした（起動したサービス：a／失敗したサービス：b: .*Docker ソケットをマウントしている.*）$/);
    expect(stub.calls.create.map((c) => c.name)).toEqual(['proj_a']);
    expect(stub.calls.stop).toEqual([]);
    expect(stub.calls.removeContainer).toEqual([]);
  });

  it('パイロットのラベルによる保護と、別サービスの作成失敗が混在しても、全サービスの結果を表示する', async () => {
    stub.containers['projbid0002'] = { Id: 'projbid0002', Name: 'proj_b', Labels: { 'cloud-dojo.lab': 'n5-tcp' }, Running: true };
    stub.behaviour.failCreate.add('proj_c');
    const THREE = `${TWO}  c:\n    image: busybox\n`;
    let message = '';
    await runComposeUpJob(composeService, { composeYaml: THREE, projectName: 'proj' }).catch((e: Error) => {
      message = e.message;
    });
    expect(message).toMatch(/を保護するため、次のサービスの既存コンテナを停止・削除せずに中止しました（b: /);
    expect(message).toMatch(/一部のサービスを起動できませんでした（起動したサービス：a／失敗したサービス：b: .*; c: create failed: proj_c）$/);
  });

  it('保護拒否だけで起動したサービスが無い場合は「起動したサービス：なし」と表示する', async () => {
    addMounted('', 'projwebid02', 'proj_web');
    await expect(runComposeUpJob(composeService, { composeYaml: `version: '3.8'\nservices:\n  web:\n    image: nginx\n`, projectName: 'proj' })).rejects.toThrow(
      /を保護するため.*。すべてのサービスを起動できませんでした（起動したサービス：なし／失敗したサービス：web: .*空のパス.*）$/,
    );
  });
});
