/**
 * 直し回7：
 * - 必須1：パスの同一性判定を共有関数（compose-guard.ts の dockerSocketReason）に集約し、検査に使う文字列＝実際に渡す文字列とする。
 *   前後の空白・`\`・制御文字を含むなど解釈を一致させられないものは、compose の bind・既存コンテナの Mounts.Source・
 *   Kubernetes の hostPath の3経路すべてで判定不能として拒否（または保護対象）になる。trim 等の検査側だけの書き換えはしない
 * - 推奨A：compose の存在確認 inspect は 404 だけを「存在しない」とし、それ以外の失敗とサービス個別の失敗をジョブ失敗にする
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

const { composeService, runComposeUpJob, assertComposeDefinitionSafe } = await import('../services/compose');
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

describe('直し回7 必須1：検査に使う文字列＝実際に渡す文字列。解釈を一致させられないものは3経路すべてで拒否する', () => {
  it('実際のファイルシステム上の `<dir>/alias `（末尾空白付き、ソケットへのリンク）を受付・Worker の両方で拒否し、trim した別パスを調べない（再レビューの再現例）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-fix7-'));
    try {
      const alias = `${dir}/alias `;
      fs.symlinkSync('/run/docker.sock', alias);
      // 空白無しの `<dir>/alias` は存在しない（以前はこちらを調べて通していた）
      expect(fs.existsSync(`${dir}/alias`)).toBe(false);
      const realpathSpy = vi.spyOn(fs, 'realpathSync');
      await expectRejectedBeforeCreate(vol(`${alias}:/sock`), /前後に空白を含むため、指すものを判定できない/);
      // 検査側だけの書き換え（trim）をしない：空白を落とした別パスの実体を調べに行かない
      expect(realpathSpy.mock.calls.map((c) => String(c[0]))).not.toContain(`${dir}/alias`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('前後空白・`\\`・制御文字・空白だけのソースは、compose の bind・Mounts.Source・hostPath の3経路すべてで同じ共有関数により拒否される', () => {
    const inputs = [
      '/srv/alias ', // 末尾の空白
      ' /var/run/docker.sock', // 先頭の空白
      '/run/docker.sock\t', // 末尾のタブ
      '/srv/alias\u00a0', // 末尾の Unicode 空白（NBSP）
      '/srv/innocent\\alias', // バックスラッシュ
      '/srv/a\nb', // 改行（制御文字）
      '/srv/a\u0000b', // NUL
    ];
    for (const src of inputs) {
      const r = threeRoutes(src);
      expect(r.compose, JSON.stringify(src)).toEqual([expect.stringMatching(/判定できない/)]);
      expect(r.mount, JSON.stringify(src)).toMatch(/判定できない/);
      expect(r.k8s, JSON.stringify(src)).toMatch(/判定できない/);
      // 3経路とも同じ共有関数の結果そのもの
      const shared = guard.dockerSocketReason(src);
      expect(shared).toBe(guard.uninterpretablePathReason(src));
      expect(r.compose[0]).toBe(shared);
      expect(r.mount).toContain(shared!);
      expect(r.k8s).toContain(shared!);
    }
    // 空白だけ・空の hostPath も読み飛ばさず判定不能
    expect(threeRoutes('   ').k8s).toMatch(/判定できない/);
    expect(() => k8sGuard.assertManifestSafe([podWithHostPath('')])).toThrow(/判定できない/);
  });

  it('直し回5・6の実体判定（別名・相対・..・リンク・親ディレクトリ・名前 docker.sock）は3経路で維持される', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-fix7-'));
    try {
      fs.symlinkSync('/run/docker.sock', `${dir}/link`);
      fs.symlinkSync('/var/run', `${dir}/runlink`);
      const rel = path.posix.relative(process.cwd(), '/var/run/docker.sock');
      for (const src of ['/var/run/docker.sock', '/run/docker.sock', '//var/run/docker.sock', '/var/run/../run/docker.sock', '/var/run', '/run/', '/', `${dir}/link`, `${dir}/runlink`, `${dir}/runlink/docker.sock`, '/srv/x/docker.sock', rel]) {
        const r = threeRoutes(src);
        expect(r.compose.length, src).toBe(1);
        expect(r.compose[0], src).toMatch(/Docker ソケット/);
        expect(r.mount, src).toMatch(/Docker ソケット/);
        expect(r.k8s, src).toMatch(/Docker ソケット/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('YAML の構造側（短い書式の引用付き先頭空白、長い書式の source、driver_opts.device、secrets の file）でも前後空白を拒否する', async () => {
    await expectRejectedBeforeCreate(vol(`" /var/run/docker.sock:/sock"`), /前後に空白を含む/);
    await expectRejectedBeforeCreate(
      `version: '3.8'\nservices:\n  a:\n    image: x\n    volumes:\n      - type: bind\n        source: '/srv/alias '\n        target: /sock\n`,
      /前後に空白を含む/,
    );
    // type を書かない長い書式でも、source の前後空白は名前付きボリュームとして見逃さない
    await expectRejectedBeforeCreate(
      `version: '3.8'\nservices:\n  a:\n    image: x\n    volumes:\n      - source: ' /var/run/docker.sock'\n        target: /sock\n`,
      /前後に空白を含む/,
    );
    await expectRejectedBeforeCreate(
      `version: '3.8'\nservices:\n  a:\n    image: x\n    volumes:\n      - v:/x\nvolumes:\n  v:\n    driver_opts:\n      type: none\n      o: bind\n      device: '/var/run '\n`,
      /driver_opts\.device.*前後に空白を含む/,
    );
    await expectRejectedBeforeCreate(`version: '3.8'\nservices:\n  a:\n    image: x\nsecrets:\n  s:\n    file: '/srv/s '\n`, /secrets\.s\.file.*前後に空白を含む/);
  });

  it('Mounts.Source が前後空白・`\\` を含む既存コンテナは、exec・削除・停止・起動の対象にしない（403、操作は inspect だけ）', async () => {
    for (const src of ['/srv/alias ', ' /var/run/docker.sock', '/srv/innocent\\alias', '/run/docker.sock\n']) {
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

  it('compose up・down：同名の既存コンテナの Mounts.Source が末尾空白付きなら、停止・削除しない', async () => {
    addMounted('/srv/alias ', 'projwebid01', 'proj_web');
    await expect(runComposeUpJob(composeService, { composeYaml: `version: '3.8'\nservices:\n  web:\n    image: nginx\n`, projectName: 'proj' })).rejects.toThrow(
      /を保護するため.*web: .*前後に空白を含む/,
    );
    await expect(composeService.composeDown('proj')).rejects.toThrow(/前後に空白を含む/);
    expect(stub.calls.stop).toEqual([]);
    expect(stub.calls.removeContainer).toEqual([]);
    expect(stub.calls.create).toEqual([]);
  });

  it('通常の bind（途中に空白を含む名前・相対・名前付きボリューム）は従来どおり通り、Docker に渡す文字列そのもので検査される', async () => {
    const realpathSpy = vi.spyOn(fs, 'realpathSync');
    const yamlText = `version: '3.8'\nservices:\n  web:\n    image: nginx\n    volumes:\n      - /srv/my data:/data\n      - ./html:/usr/share/nginx/html:ro\n      - web-data:/var/lib/web\n`;
    expect(() => assertComposeDefinitionSafe(yamlText, composeService.parseComposeYAML(yamlText), 'proj')).not.toThrow();
    const r = await runComposeUpJob(composeService, { composeYaml: yamlText, projectName: 'proj' });
    expect(r.success).toBe(true);
    const binds = stub.calls.create[0].binds ?? [];
    expect(binds).toEqual(['/srv/my data:/data', './html:/usr/share/nginx/html:ro', 'proj_web-data:/var/lib/web']);
    const inspected = realpathSpy.mock.calls.map((c) => String(c[0]));
    expect(inspected).toContain('/srv/my data');
    expect(inspected).toContain(path.posix.resolve(process.cwd(), './html'));
    // 通常のコンテナの Mounts、通常の hostPath も通る
    expect(protect.dockerSocketMountReason([{ Type: 'bind', Source: '/srv/my data', Destination: '/data' }])).toBeNull();
    expect(() => k8sGuard.assertManifestSafe([podWithHostPath('/var/log/my app')])).not.toThrow();
  });
});

describe('直し回7 推奨A：存在確認の inspect は 404 だけを「存在しない」とし、それ以外の失敗とサービス個別の失敗をジョブ失敗にする', () => {
  const TWO = `version: '3.8'\nservices:\n  a:\n    image: nginx\n  b:\n    image: redis\n`;

  it('既存コンテナの inspect が 500 なら、そのサービスは作成・停止・削除せず、ジョブが失敗する', async () => {
    stub.behaviour.failContainerInspect.add('proj_web');
    await expect(runComposeUpJob(composeService, { composeYaml: `version: '3.8'\nservices:\n  web:\n    image: nginx\n`, projectName: 'proj' })).rejects.toThrow(
      /Compose up failed: すべてのサービスを起動できませんでした（起動したサービス：なし／失敗したサービス：web: 既存コンテナ proj_web の確認（inspect）に失敗したため、作成しません（\(HTTP code 500\)/,
    );
    expect(stub.calls.create).toEqual([]);
    expect(stub.calls.stop).toEqual([]);
    expect(stub.calls.removeContainer).toEqual([]);
  });

  it('既存コンテナが無い（404）場合は従来どおり作成して成功する', async () => {
    const r = await runComposeUpJob(composeService, { composeYaml: `version: '3.8'\nservices:\n  web:\n    image: nginx\n`, projectName: 'proj' });
    expect(r.success).toBe(true);
    expect(stub.calls.create.map((c) => c.name)).toEqual(['proj_web']);
  });

  it('ボリューム・イメージの inspect の 404 以外の失敗も、作成せずにジョブ失敗にする（ボリュームは作成しない）', async () => {
    stub.behaviour.failVolumeInspect.add('proj_data');
    await expect(
      runComposeUpJob(composeService, { composeYaml: `version: '3.8'\nservices:\n  web:\n    image: nginx\n    volumes:\n      - data:/data\n`, projectName: 'proj' }),
    ).rejects.toThrow(/失敗したサービス：web: ボリューム proj_data の確認（inspect）に失敗しました/);
    expect(stub.calls.createVolume).toEqual([]);
    expect(stub.calls.create).toEqual([]);

    stub.behaviour.failImageInspect.add('nginx');
    await expect(runComposeUpJob(composeService, { composeYaml: `version: '3.8'\nservices:\n  web:\n    image: nginx\n`, projectName: 'proj' })).rejects.toThrow(
      /失敗したサービス：web: イメージ nginx の確認（inspect）に失敗しました/,
    );
    expect(stub.calls.create).toEqual([]);
    expect(stub.log).not.toContain('pull');
  });

  it('部分成功：一部のサービスの作成失敗はジョブ成功に化けず、起動したサービスと失敗したサービスを両方とも明示する', async () => {
    stub.behaviour.failCreate.add('proj_b');
    let message = '';
    await runComposeUpJob(composeService, { composeYaml: TWO, projectName: 'proj' }).catch((e: Error) => {
      message = e.message;
    });
    expect(message).toMatch(/^Compose up failed: 一部のサービスを起動できませんでした（起動したサービス：a／失敗したサービス：b: create failed: proj_b）$/);
    expect(stub.calls.create.map((c) => c.name)).toEqual(['proj_a']);
    const session = [...(composeService as unknown as { sessions: Map<string, import('../services/compose').ComposeSession> }).sessions.values()].pop()!;
    expect(session.status).toBe('error');
    expect(session.error).toMatch(/b: create failed: proj_b（起動したサービス：a）/);
  });

  it('全サービスの失敗もジョブ失敗にする（起動したサービス：なし）', async () => {
    stub.behaviour.failCreate.add('proj_a');
    stub.behaviour.failCreate.add('proj_b');
    await expect(runComposeUpJob(composeService, { composeYaml: TWO, projectName: 'proj' })).rejects.toThrow(
      /すべてのサービスを起動できませんでした（起動したサービス：なし／失敗したサービス：a: create failed: proj_a; b: create failed: proj_b）/,
    );
  });
});
