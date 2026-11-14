/**
 * 直し回6：
 * - 必須1：ソケットの判定に使うパスと、実際に Docker へ渡すパスを一致させる（`\` を区切りとして扱わない。含むものは判定不能として拒否）
 * - 必須2：Docker ソケットをマウントしたコンテナは、ラベルの有無によらず exec・削除・停止・起動を拒否する
 * - 推奨A：ネットワーク ID の取得失敗（inspect の通信エラー等）をジョブ失敗にする
 * - 推奨B：compose の専用ログに削除手順、/lab/create の残存表示に名前と復旧手順を出す
 * Docker が無い環境のため dockerode をスタブに差し替え、全メソッドの呼び出しを記録する（キューは Redis を使うため差し替える）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  };
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
        return { Id: 'img' };
      },
    }),
    getVolume: (n: string) => ({
      inspect: async () => {
        log.push(`volume.inspect ${n}`);
        return { Name: n };
      },
    }),
    createVolume: async (o: { Name: string }) => {
      log.push(`createVolume ${o.Name}`);
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

describe('直し回6 必須1：`\\` を含むパス経由のソケット別名を拒否し、検査したパスと Docker に渡すパスを一致させる', () => {
  it('実際のファイルシステム上の `<dir>/innocent\\alias`（ソケットへのリンク）を受付・Worker の両方で拒否する（再レビューの再現例）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-fix6-'));
    try {
      // Linux では `\` はファイル名の文字。`<dir>/innocent\alias` は1つのファイル名で、`<dir>/innocent/alias` とは別物
      const alias = `${dir}/innocent\\alias`;
      fs.symlinkSync('/run/docker.sock', alias);
      expect(fs.readlinkSync(alias)).toBe('/run/docker.sock');
      expect(fs.existsSync(`${dir}/innocent`)).toBe(false);
      await expectRejectedBeforeCreate(vol(`${alias}:/sock`), /\\ を含むため、指すものを判定できない/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('再レビューの独立スタブと同じ形（メモリ上のファイルシステムで `/srv/innocent\\alias` → /run/docker.sock）でも拒否する', () => {
    const calls: string[] = [];
    const env: import('../services/compose-guard').SocketCheckEnv = {
      cwd: '/work',
      homedir: '/home/u',
      extraSockets: [],
      realpath: (p) => {
        calls.push(p);
        if (p === '/srv/innocent\\alias') return '/run/docker.sock';
        if (p === '/srv/innocent/alias') return '/srv/innocent/alias'; // 以前の置き換え後のパス（無関係なファイル）
        if (['/', '/srv', '/run', '/run/docker.sock', '/var/run', '/var/run/docker.sock'].includes(p)) return p;
        throw new Error('ENOENT');
      },
      readlink: () => {
        throw new Error('EINVAL');
      },
      stat: () => null,
    };
    expect(guard.dockerSocketReason('/srv/innocent\\alias', env)).toMatch(/\\ を含むため、指すものを判定できない/);
    // 置き換えたパスを調べに行かない（検査対象が Docker に渡す文字列とずれない）
    expect(calls).not.toContain('/srv/innocent/alias');
    // Docker に渡す Binds（planVolumes）と同じ文字列を inspectBinds が調べ、拒否する
    expect(guard.inspectBinds('attacker', ['/srv/innocent\\alias:/sock'], env).map((v) => v.detail)).toEqual([
      expect.stringMatching(/判定できない/),
    ]);
    // Windows のドライブ指定（C:\…）や `\` 区切りの相対パスも、Linux での解釈が定まらないため拒否する
    expect(guard.dockerSocketReason('C:\\Users\\me\\proj', env)).toMatch(/判定できない/);
    expect(guard.dockerSocketReason('.\\data', env)).toMatch(/判定できない/);
  });

  it('長い書式の source、driver_opts.device、secrets の file に `\\` を含む場合も拒否する', async () => {
    await expectRejectedBeforeCreate(
      `version: '3.8'\nservices:\n  a:\n    image: x\n    volumes:\n      - type: bind\n        source: '/srv/innocent\\alias'\n        target: /sock\n`,
      /判定できない/,
    );
    await expectRejectedBeforeCreate(
      `version: '3.8'\nservices:\n  a:\n    image: x\n    volumes:\n      - v:/x\nvolumes:\n  v:\n    driver_opts:\n      type: none\n      o: bind\n      device: '/srv/a\\b'\n`,
      /driver_opts\.device.*判定できない/,
    );
    await expectRejectedBeforeCreate(`version: '3.8'\nservices:\n  a:\n    image: x\nsecrets:\n  s:\n    file: '/srv/a\\b'\n`, /secrets\.s\.file.*判定できない/);
  });

  it('通常の bind は、Docker に渡す Binds の元パスそのものを（置き換えずに）実体の解決に使う', async () => {
    const realpathSpy = vi.spyOn(fs, 'realpathSync');
    const yamlText = `version: '3.8'\nservices:\n  web:\n    image: nginx\n    volumes:\n      - /srv/app/data:/data\n      - ./html:/usr/share/nginx/html:ro\n      - web-data:/var/lib/web\n`;
    const r = await runComposeUpJob(composeService, { composeYaml: yamlText, projectName: 'proj' });
    expect(r.success).toBe(true);
    const binds = stub.calls.create[0].binds ?? [];
    expect(binds).toEqual(['/srv/app/data:/data', './html:/usr/share/nginx/html:ro', 'proj_web-data:/var/lib/web']);
    const inspected = realpathSpy.mock.calls.map((c) => String(c[0]));
    // 渡したホストパス（名前付きボリュームを除く）は、どれも同じ文字列（相対は cwd 基準に解決したもの）で検査されている
    for (const b of binds.filter((x) => x.startsWith('/') || x.startsWith('.'))) {
      const src = b.split(':')[0];
      expect(inspected, src).toContain(path.posix.resolve(process.cwd(), src));
    }
  });
});

const SOCKET_MOUNT: Mount = { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' };

/** リポジトリの docker-compose.yml の cloud-dojo-worker と同じ形（pilot ラベル無し・Docker ソケットをマウント） */
function addWorkerLike(mounts: Mount[] = [SOCKET_MOUNT], id = 'workerid0001', name = 'cloud-dojo-worker') {
  stub.containers[id] = { Id: id, Name: name, Labels: { 'com.docker.compose.service': 'worker' }, Mounts: mounts, Running: true };
}
function addNormal(id = 'normalid0001', name = 'my-app', mounts: Mount[] = []) {
  stub.containers[id] = { Id: id, Name: name, Labels: {}, Mounts: mounts, Running: true };
}

describe('直し回6 必須2：Docker ソケットをマウントしたコンテナは、ラベルが無くても exec・削除・停止・起動を拒否する', () => {
  it('/api/network/exec：ソケットを持つ非ラベルのコンテナ（名前・ID のどちらで指定しても）には実行しない（403）', async () => {
    addWorkerLike();
    for (const containerId of ['cloud-dojo-worker', 'workerid0001']) {
      const r = await app.inject({ method: 'POST', url: '/api/network/exec', payload: { containerId, command: 'id' } });
      expect(r.statusCode, containerId).toBe(403);
      expect(r.json().error).toBe('DOCKER_SOCKET_CONTAINER_PROTECTED');
      expect(r.json().message).toMatch(/Docker ソケットをマウントしている/);
    }
    expect(stub.calls.exec).toEqual([]);
  });

  it('ソケットの別名（/run）・親ディレクトリ（/var/run、/）・名前 docker.sock・`\\` を含む元パスのマウントも同じに拒否する', async () => {
    const variants: Mount[] = [
      { Type: 'bind', Source: '/run/docker.sock', Destination: '/sock' },
      { Type: 'bind', Source: '/var/run', Destination: '/hostrun' },
      { Type: 'bind', Source: '/', Destination: '/host' },
      { Type: 'bind', Source: '/home/u/.docker/run/docker.sock', Destination: '/sock' },
      { Type: 'bind', Source: '/srv/innocent\\alias', Destination: '/sock' },
    ];
    for (const m of variants) {
      for (const k of Object.keys(stub.containers)) delete stub.containers[k];
      addWorkerLike([{ Type: 'volume', Source: '/var/lib/docker/volumes/x/_data', Destination: '/data' }, m]);
      const r = await app.inject({ method: 'POST', url: '/api/network/exec', payload: { containerId: 'cloud-dojo-worker', command: 'id' } });
      expect(r.statusCode, m.Source).toBe(403);
      expect(r.json().error).toBe('DOCKER_SOCKET_CONTAINER_PROTECTED');
    }
    expect(stub.calls.exec).toEqual([]);
  });

  it('/api/docker/containers/:id の削除・停止・起動も拒否し、Docker への操作は inspect だけ', async () => {
    addWorkerLike();
    const reqs = [
      { method: 'DELETE' as const, url: '/api/docker/containers/cloud-dojo-worker?force=true' },
      { method: 'POST' as const, url: '/api/docker/containers/cloud-dojo-worker/stop' },
      { method: 'POST' as const, url: '/api/docker/containers/cloud-dojo-worker/start' },
    ];
    for (const req of reqs) {
      const r = await app.inject(req);
      expect(r.statusCode, req.url).toBe(403);
      expect(r.json().error).toBe('DOCKER_SOCKET_CONTAINER_PROTECTED');
    }
    expect(stub.calls.removeContainer).toEqual([]);
    expect(stub.calls.stop).toEqual([]);
    expect(stub.calls.start).toEqual([]);
    expect(stub.log.every((l) => l.startsWith('container.inspect'))).toBe(true);
  });

  it('通常のコンテナ（ソケット無し・ラベル無し、通常の bind・ボリュームあり）は従来どおり exec・停止・起動・削除できる（確かめた ID で操作）', async () => {
    addNormal('normalid0001', 'my-app', [
      { Type: 'bind', Source: '/srv/app/data', Destination: '/data' },
      { Type: 'volume', Source: '/var/lib/docker/volumes/web/_data', Destination: '/var/lib/web' },
    ]);
    const r = await app.inject({ method: 'POST', url: '/api/network/exec', payload: { containerId: 'my-app', command: 'id' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ exitCode: 0, output: 'uid=0(root)' });
    expect(stub.calls.exec).toEqual([{ id: 'normalid0001', cmd: ['/bin/sh', '-c', 'id'] }]);

    expect((await app.inject({ method: 'POST', url: '/api/docker/containers/my-app/stop' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/docker/containers/my-app/start' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/docker/containers/my-app' })).statusCode).toBe(200);
    expect(stub.calls.stop).toEqual(['normalid0001']);
    expect(stub.calls.start).toEqual(['normalid0001']);
    expect(stub.calls.removeContainer).toEqual(['normalid0001']);

    // Mounts の無い inspect 結果（古い Docker 等）も通常のコンテナとして扱う
    expect(() => protect.assertContainerOperable({ Id: 'x', Labels: {}, Mounts: undefined })).not.toThrow();
  });

  it('pilot ラベルのコンテナは従来どおり PILOT_LAB_PROTECTED で拒否する（ソケットの判定より先）', async () => {
    stub.containers['labid0001'] = { Id: 'labid0001', Name: 'lab-client', Labels: { 'cloud-dojo.lab': 'n5' }, Mounts: [SOCKET_MOUNT], Running: true };
    const r = await app.inject({ method: 'POST', url: '/api/network/exec', payload: { containerId: 'lab-client', command: 'id' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('PILOT_LAB_PROTECTED');
  });

  it('/lab/create：固定名 network-node-<i> がソケットを持つコンテナなら、何も作成・削除せずに 403', async () => {
    addWorkerLike([SOCKET_MOUNT], 'nodeid0001', 'network-node-1');
    const r = await app.inject({ method: 'POST', url: '/api/network/lab/create', payload: { nodeCount: 2 } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('DOCKER_SOCKET_CONTAINER_PROTECTED');
    expect(stub.calls.removeContainer).toEqual([]);
    expect(stub.calls.createNetwork).toEqual([]);
    expect(stub.calls.create).toEqual([]);
  });

  it('compose up：同名の既存コンテナがソケットを持てば停止・削除せずにジョブを失敗にし、compose down も何も削除しない', async () => {
    addWorkerLike([SOCKET_MOUNT], 'projwebid01', 'proj_web');
    const yamlText = `version: '3.8'\nservices:\n  web:\n    image: nginx\n`;
    await expect(runComposeUpJob(composeService, { composeYaml: yamlText, projectName: 'proj' })).rejects.toThrow(
      /Docker ソケットをマウントしたコンテナ）を保護するため.*web: .*Docker ソケットをマウントしている/,
    );
    expect(stub.calls.stop).toEqual([]);
    expect(stub.calls.removeContainer).toEqual([]);
    expect(stub.calls.create).toEqual([]);

    await expect(composeService.composeDown('proj')).rejects.toThrow(/Docker ソケットをマウントしている/);
    expect(stub.calls.stop).toEqual([]);
    expect(stub.calls.removeContainer).toEqual([]);
    expect(stub.calls.removeNetwork).toEqual([]);
  });

  it('compose down：ソケットを持たないプロジェクトのコンテナは従来どおり停止・削除する', async () => {
    addNormal('projwebid02', 'proj_web', [{ Type: 'bind', Source: '/srv/app/data', Destination: '/data' }]);
    await composeService.composeDown('proj');
    expect(stub.calls.stop).toEqual(['projwebid02']);
    expect(stub.calls.removeContainer).toEqual(['projwebid02']);
  });
});

const NET_YAML = `version: '3.8'\nservices:\n  web:\n    image: nginx\nnetworks:\n  app:\n    driver: bridge\n`;

describe('直し回6 推奨A：ネットワーク ID の取得失敗はジョブ失敗にする（作成0回で success にしない）', () => {
  it('network inspect の通信エラーで、コンテナを作成せずにジョブが失敗する', async () => {
    stub.behaviour.failNetworkInspect.add('proj_app');
    await expect(runComposeUpJob(composeService, { composeYaml: NET_YAML, projectName: 'proj' })).rejects.toThrow(
      /Compose up failed: コンテナを作成する前に失敗したため、compose up を中止しました（connect ECONNREFUSED/,
    );
    expect(stub.calls.create).toEqual([]);
    expect(stub.calls.createNetwork).toEqual([]);
  });

  it('session にも失敗が残り、サービスは error になる', async () => {
    stub.behaviour.failNetworkInspect.add('proj_app');
    const session = await composeService.composeUp(NET_YAML, 'proj');
    expect(session.status).toBe('error');
    expect(session.setupFailure).toMatch(/ECONNREFUSED/);
    expect(session.services.web.status).toBe('error');
  });

  it('取得できた場合は従来どおり成功する', async () => {
    const r = await runComposeUpJob(composeService, { composeYaml: NET_YAML, projectName: 'proj' });
    expect(r.success).toBe(true);
    expect(stub.calls.create).toEqual([{ name: 'proj_web', networkMode: 'netid-proj_app', binds: [] }]);
  });
});

describe('直し回6 推奨B：残存の表示に名前と復旧手順を出す', () => {
  it('/lab/create：残存（コンテナ・ネットワーク）の名前・ID・復旧手順を cleanup と画面に出す message・ログに出す', async () => {
    stub.behaviour.failCreate.add('network-node-2');
    stub.behaviour.failContainerRemove.add('cid-network-node-1');
    stub.behaviour.failNetworkRemove.add('netid-lab-network');
    // ログを記録する Fastify（route は fastify.log.error で残存を出す）
    const logged: string[] = [];
    const logApp = Fastify({ logger: { level: 'error', stream: { write: (line: string) => void logged.push(line) } } });
    await logApp.register(networkRoutes, { prefix: '/api/network' });
    const r = await logApp.inject({ method: 'POST', url: '/api/network/lab/create', payload: { nodeCount: 3 } });
    await logApp.close();
    expect(r.statusCode).toBe(500);
    const body = r.json();
    expect(body.cleanup.remaining).toEqual([
      { kind: 'container', name: 'network-node-1', id: 'cid-network-node-1', error: 'removal in progress', recovery: 'docker rm -f cid-network-node-1' },
      { kind: 'network', name: 'lab-network', id: 'netid-lab-network', error: 'network has active endpoints', recovery: 'docker network rm netid-lab-network' },
    ]);
    // 画面（NetworkBasics.tsx）が表示する message に、名前と復旧手順が入る
    expect(body.message).toMatch(/create failed: network-node-2/);
    expect(body.message).toMatch(/コンテナ network-node-1（cid-network-node-1）/);
    expect(body.message).toMatch(/ネットワーク lab-network（netid-lab-network）/);
    expect(body.message).toMatch(/復旧手順：docker rm -f cid-network-node-1 → docker network rm netid-lab-network/);
    expect(body.cleanup.message).toMatch(/復旧手順/);
    expect(logged.some((l) => l.includes('network-node-1') && l.includes('docker network rm netid-lab-network'))).toBe(true);
  });

  it('/lab/create：すべて削除できた場合は残存の文を付けない', async () => {
    stub.behaviour.failCreate.add('network-node-1');
    const r = await app.inject({ method: 'POST', url: '/api/network/lab/create', payload: { nodeCount: 2 } });
    expect(r.statusCode).toBe(500);
    expect(r.json().message).toBe('create failed: network-node-1');
    expect(r.json().cleanup).toEqual({ removed: ['netid-lab-network'], remaining: [] });
  });
});
