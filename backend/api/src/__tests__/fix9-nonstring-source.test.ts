/**
 * 直し回9（必須）：文字列でないマウント元を判定不能として扱う。
 * - 既存コンテナの Mounts.Source：bind・npipe・種別不明で Source が文字列でない（欠落・null・数値・オブジェクト等）ものは
 *   判定不能として保護する（exec・削除・停止・起動を 403 で拒否、compose up・down も中止）。
 *   volume・tmpfs・image・cluster は Source の欠落・null を通し、想定外の型（数値・オブジェクト等）は判定不能として保護する。
 * - compose 定義の長い書式：source が文字列でなければ type によらず拒否する。bind・npipe で source が欠落・null のものも拒否する。
 *   volume・tmpfs の source 無しは従来どおり通す。
 * Docker が無い環境のため dockerode をスタブに差し替える（直し回8 のスタブと同じ）。キューも差し替える。
 */
import { PassThrough } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


type Mount = { Type?: unknown; Source?: unknown; Destination?: unknown };
type FakeContainer = { Id: string; Name: string; Labels: Record<string, string>; Mounts?: unknown; Running: boolean };

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

/** cloud-dojo-worker と同じ形（ラベル無し）で、指定の Mounts を持つコンテナ */
function addWithMounts(mounts: unknown, id = 'workerid0001', name = 'cloud-dojo-worker') {
  stub.containers[id] = { Id: id, Name: name, Labels: { 'com.docker.compose.service': 'worker' }, Mounts: mounts, Running: true };
}

const reset = () => {
  for (const k of Object.keys(stub.containers)) delete stub.containers[k];
  stub.log.length = 0;
};

const opRequests = (name: string) => [
  { method: 'POST' as const, url: '/api/network/exec', payload: { containerId: name, command: 'id' } },
  { method: 'DELETE' as const, url: `/api/docker/containers/${name}?force=true` },
  { method: 'POST' as const, url: `/api/docker/containers/${name}/stop` },
  { method: 'POST' as const, url: `/api/docker/containers/${name}/start` },
];

/** 再レビュー8回目の実測と同じ4形（欠落・null・数値・オブジェクト）に、配列・真偽値を加える */
const NON_STRING: { label: string; mount: (type: unknown) => Mount }[] = [
  { label: '欠落', mount: (t) => ({ Type: t, Destination: '/sock' }) },
  { label: 'null', mount: (t) => ({ Type: t, Source: null, Destination: '/sock' }) },
  { label: '数値', mount: (t) => ({ Type: t, Source: 42, Destination: '/sock' }) },
  { label: 'オブジェクト', mount: (t) => ({ Type: t, Source: {}, Destination: '/sock' }) },
  { label: '配列', mount: (t) => ({ Type: t, Source: ['/var/run/docker.sock'], Destination: '/sock' }) },
  { label: '真偽値', mount: (t) => ({ Type: t, Source: true, Destination: '/sock' }) },
];

const compose = (volumeYaml: string) => `version: '3.8'\nservices:\n  a:\n    image: x\n    volumes:\n${volumeYaml}`;

describe('直し回9 必須：文字列でない Mounts.Source を判定不能として保護する（既存コンテナ）', () => {
  it('bind の Source が欠落・null・数値・オブジェクト（＋配列・真偽値）なら、共通保護が DockerSocketContainerProtectedError を投げる', () => {
    for (const c of NON_STRING) {
      const mounts = [c.mount('bind')];
      expect(protect.dockerSocketMountReason(mounts), c.label).toMatch(/判定できない/);
      expect(() => protect.assertContainerOperable({ Id: 'workerid0001', Mounts: mounts }), c.label).toThrow(protect.DockerSocketContainerProtectedError);
    }
  });

  it('bind の Source が欠落・null・数値・オブジェクトの既存コンテナは、exec・削除・停止・起動を 403 で拒否し、操作は inspect だけ', async () => {
    for (const c of NON_STRING) {
      reset();
      addWithMounts([c.mount('bind')]);
      for (const req of opRequests('cloud-dojo-worker')) {
        const r = await app.inject(req);
        expect(r.statusCode, `${c.label} ${req.url}`).toBe(403);
        expect(r.json().error).toBe('DOCKER_SOCKET_CONTAINER_PROTECTED');
        expect(r.json().message).toMatch(/判定できない/);
      }
      expect(stub.log.every((l) => l.startsWith('container.inspect')), c.label).toBe(true);
    }
    expect(stub.calls.exec).toEqual([]);
    expect(stub.calls.removeContainer).toEqual([]);
    expect(stub.calls.stop).toEqual([]);
    expect(stub.calls.start).toEqual([]);
  });

  it('npipe・Type の欠落／null／数値・未知の種別でも、文字列でない Source は判定不能として保護する', () => {
    for (const type of ['npipe', undefined, null, 7, 'future-kind', 'BIND']) {
      for (const c of NON_STRING) {
        expect(protect.dockerSocketMountReason([c.mount(type)]), `${String(type)} ${c.label}`).toMatch(/判定できない/);
      }
    }
  });

  it('volume・tmpfs・image・cluster：Source の欠落・null は通し、数値・オブジェクト等の想定外の型は判定不能として保護する', () => {
    expect([...protect.SOURCELESS_MOUNT_TYPES].sort()).toEqual(['cluster', 'image', 'tmpfs', 'volume']);
    for (const type of protect.SOURCELESS_MOUNT_TYPES) {
      for (const c of NON_STRING) {
        const reason = protect.dockerSocketMountReason([c.mount(type)]);
        if (c.label === '欠落' || c.label === 'null') expect(reason, `${type} ${c.label}`).toBeNull();
        else expect(reason, `${type} ${c.label}`).toMatch(/想定外の型.*判定できない/);
      }
    }
  });

  it('volume・tmpfs の Source が欠落・null の通常のコンテナは操作できる（停止が通る）。数値なら 403', async () => {
    for (const [type, src, expected] of [
      ['tmpfs', undefined, 200],
      ['tmpfs', null, 200],
      ['volume', undefined, 200],
      ['volume', null, 200],
      ['tmpfs', 42, 403],
      ['volume', {}, 403],
    ] as const) {
      reset();
      stub.calls.stop.length = 0;
      const mount: Mount = { Type: type, Destination: '/data' };
      if (src !== undefined) mount.Source = src;
      addWithMounts([mount], 'ordinaryid01', 'ordinary');
      const r = await app.inject({ method: 'POST', url: '/api/docker/containers/ordinary/stop' });
      expect(r.statusCode, `${type} ${String(src)}`).toBe(expected);
      expect(stub.calls.stop, `${type} ${String(src)}`).toEqual(expected === 200 ? ['ordinaryid01'] : []);
    }
  });

  it('直し回8 の扱いは維持：Source が文字列なら種別によらず判定する（tmpfs の空文字列は保護、volume の通常のパスは通す）', () => {
    expect(protect.dockerSocketMountReason([{ Type: 'tmpfs', Source: '', Destination: '/x' }])).toMatch(/判定できない/);
    expect(protect.dockerSocketMountReason([{ Type: 'volume', Source: '/var/run/docker.sock', Destination: '/x' }])).toMatch(/docker\.sock|ソケット/);
    expect(protect.dockerSocketMountReason([{ Type: 'volume', Source: '/var/lib/docker/volumes/v/_data', Destination: '/x' }])).toBeNull();
  });

  it('Mounts が配列でない、または要素がオブジェクトでない場合も判定不能として保護する（Mounts の欠落・null は従来どおり通す）', () => {
    for (const mounts of [{}, 'x', 1, [null], ['/var/run/docker.sock'], [42], [[]]]) {
      expect(protect.dockerSocketMountReason(mounts), JSON.stringify(mounts)).toMatch(/判定できない/);
    }
    expect(protect.dockerSocketMountReason(undefined)).toBeNull();
    expect(protect.dockerSocketMountReason(null)).toBeNull();
    expect(protect.dockerSocketMountReason([])).toBeNull();
  });

  it('compose up・down：同名の既存コンテナの bind の Source が文字列でなければ、停止・削除・作成しない（listContainers 経路も同じ）', async () => {
    for (const c of NON_STRING.slice(0, 4)) {
      reset();
      addWithMounts([c.mount('bind')], 'projwebid01', 'proj_web');
      await expect(
        runComposeUpJob(composeService, { composeYaml: `version: '3.8'\nservices:\n  web:\n    image: nginx\n`, projectName: 'proj' }),
        c.label,
      ).rejects.toThrow(/を保護するため.*web: .*判定できない/);
      await expect(composeService.composeDown('proj'), c.label).rejects.toThrow(/判定できない/);
    }
    expect(stub.calls.stop).toEqual([]);
    expect(stub.calls.removeContainer).toEqual([]);
    expect(stub.calls.create).toEqual([]);
  }, 60_000);
});

describe('直し回9 必須：compose 定義の長い書式で、文字列でない source を判定不能として拒否する', () => {
  it('再レビューの実測例：type: bind, source: 42 は違反になる', () => {
    const v = guard.inspectComposeDefinition(compose(`      - type: bind\n        source: 42\n        target: /sock\n`));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ service: 'a', field: 'volumes' });
    expect(v[0].detail).toMatch(/文字列でないため判定できない/);
  });

  it('source が数値・オブジェクト・配列・真偽値なら、type（bind・volume・tmpfs・なし）によらず受付・Worker で拒否する', async () => {
    const values = ['42', '{ path: /var/run/docker.sock }', '[/var/run/docker.sock]', 'true'];
    for (const type of ['bind', 'volume', 'tmpfs', null]) {
      for (const value of values) {
        const typeLine = type ? `      - type: ${type}\n        source: ${value}\n` : `      - source: ${value}\n`;
        await expectRejectedBeforeCreate(compose(`${typeLine}        target: /sock\n`), /文字列でないため判定できない/);
        queue.addComposeUpTask.mockClear();
      }
    }
  });

  it('src（別名）が文字列でない場合も同じに拒否する', async () => {
    await expectRejectedBeforeCreate(compose(`      - type: bind\n        src: 42\n        target: /sock\n`), /文字列でないため判定できない/);
  });

  it('bind・npipe で source が欠落・null なら拒否する', async () => {
    for (const type of ['bind', 'npipe']) {
      for (const srcLine of ['', `        source: null\n`, `        source: ~\n`]) {
        await expectRejectedBeforeCreate(compose(`      - type: ${type}\n${srcLine}        target: /sock\n`), new RegExp(`type: ${type} の source が無い`));
        queue.addComposeUpTask.mockClear();
      }
    }
  });

  it('volume（匿名）・tmpfs の source 無しは、従来どおり違反にしない（受付はキューに入れる）', async () => {
    for (const volumeYaml of [`      - type: volume\n        target: /data\n`, `      - type: tmpfs\n        target: /run/cache\n`, `      - type: volume\n        source: null\n        target: /data\n`]) {
      expect(guard.inspectComposeDefinition(compose(volumeYaml)), volumeYaml).toEqual([]);
    }
    const r = await app.inject({
      method: 'POST',
      url: '/api/compose/up',
      payload: { composeYaml: compose(`      - type: tmpfs\n        target: /run/cache\n`), projectName: 'proj' },
    });
    expect(r.statusCode).not.toBe(400);
    expect(queue.addComposeUpTask).toHaveBeenCalledTimes(1);
  });
});
