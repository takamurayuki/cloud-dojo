/**
 * 直し回12：確認・実行の失敗を成功に読み替えないこと（compose・Docker ビルド）。
 * - 必須：compose up の起動後の最終確認（作成したコンテナの inspect）が失敗したサービスは running とみなさず失敗にし、
 *   ジョブ全体も失敗にする（起動したサービス・失敗したサービスの両方を失敗理由に出す、直し回7以降の形式）。
 * - 推奨A：compose down-volumes でボリュームの削除だけが失敗した場合も、最後の down:progress を error にする。
 * - 推奨C：通常の Docker ビルド後にイメージを inspect できなかった場合は completed にしない。
 * Docker が無い環境のため dockerode をスタブに差し替える（キューは Redis を使うため差し替える）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => {
  const log: string[] = [];
  const behaviour = {
    /** 起動後の最終確認で、作成したコンテナの inspect に返す失敗（ID → エラー） */
    finalInspectError: new Map<string, () => Error>(),
    /** 作成したコンテナの State.Running（既定は true） */
    notRunning: new Set<string>(),
    /** ビルド後の image inspect に返す失敗 */
    builtImageInspectError: null as null | (() => Error),
    /** ボリュームの削除に返す失敗 */
    volumeRemoveError: null as null | (() => Error),
  };
  const downState = {
    containers: [] as { Id: string; Names: string[]; Labels: Record<string, string>; State: string }[],
    networks: [] as { Id: string; Name: string; Labels: Record<string, string> }[],
    volumes: [] as string[],
  };
  const notFound = (what: string) => Object.assign(new Error(`no such ${what}`), { statusCode: 404 });
  const docker = {
    getImage: (n: string) => ({
      inspect: async () => {
        log.push(`image.inspect ${n}`);
        if (n.startsWith('built/') && behaviour.builtImageInspectError) throw behaviour.builtImageInspectError();
        return { Id: `sha256:${n}`, Size: 1234 };
      },
    }),
    getVolume: (n: string) => ({
      inspect: async () => ({ Name: n }),
      remove: async () => {
        log.push(`volume.remove ${n}`);
        if (behaviour.volumeRemoveError) throw behaviour.volumeRemoveError();
      },
    }),
    createVolume: async () => undefined,
    listContainers: async () => downState.containers.map((c) => ({ ...c })),
    listNetworks: async () => downState.networks.map((n) => ({ ...n })),
    listVolumes: async () => ({ Volumes: downState.volumes.map((Name) => ({ Name })) }),
    getNetwork: (id: string) => ({
      remove: async () => {
        log.push(`network.remove ${id}`);
      },
    }),
    createContainer: async (spec: { name: string }) => {
      log.push(`createContainer ${spec.name}`);
      return {
        id: `cid-${spec.name}`,
        start: async () => {
          log.push(`container.start cid-${spec.name}`);
        },
      };
    },
    getContainer: (idOrName: string) => ({
      inspect: async () => {
        log.push(`container.inspect ${idOrName}`);
        if (!idOrName.startsWith('cid-')) throw notFound(`container: ${idOrName}`);
        const e = behaviour.finalInspectError.get(idOrName);
        if (e) throw e();
        return { Id: idOrName, Config: { Labels: {} }, State: { Running: !behaviour.notRunning.has(idOrName), ExitCode: behaviour.notRunning.has(idOrName) ? 1 : 0 } };
      },
      stop: async () => {
        log.push(`container.stop ${idOrName}`);
      },
      remove: async () => {
        log.push(`container.remove ${idOrName}`);
      },
    }),
    buildImage: async () => {
      log.push('buildImage');
      return {};
    },
    modem: {
      followProgress: (_stream: unknown, done: (err: Error | null, res: unknown[]) => void, onProgress: (e: { stream?: string }) => void) => {
        onProgress({ stream: 'Step 1/1 : FROM alpine' });
        onProgress({ stream: ' ---> abc123' });
        setImmediate(() => done(null, []));
      },
    },
  };
  return { log, behaviour, downState, docker };
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
const { DockerService } = await import('../services/docker');

const http = (statusCode: number) => () => Object.assign(new Error(`(HTTP code ${statusCode}) server error - stub`), { statusCode });

const TWO_SERVICES = `version: '3.8'
services:
  web:
    image: nginx:alpine
  db:
    image: postgres:16
`;

let quiet: { mockRestore: () => void }[] = [];
beforeEach(() => {
  stub.log.length = 0;
  stub.behaviour.finalInspectError.clear();
  stub.behaviour.notRunning.clear();
  stub.behaviour.builtImageInspectError = null;
  stub.behaviour.volumeRemoveError = null;
  stub.downState.containers.length = 0;
  stub.downState.networks.length = 0;
  stub.downState.volumes.length = 0;
  quiet = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined)];
});
afterEach(() => {
  quiet.forEach((q) => q.mockRestore());
  vi.restoreAllMocks();
});

describe('直し回12 必須：compose up の最終確認の失敗を成功にしない', () => {
  it('正常時は従来どおり、全サービス running・ジョブ成功', async () => {
    const r = await runComposeUpJob(composeService, { composeYaml: TWO_SERVICES, projectName: 'proj' });
    expect(r.success).toBe(true);
    // 最終確認として、作成した ID の inspect が行われている
    expect(stub.log).toContain('container.inspect cid-proj_web');
    expect(stub.log).toContain('container.inspect cid-proj_db');
  });

  it('作成・起動は成功し、最終 inspect が 500 のサービスは失敗・セッションも error（running とみなさない）', async () => {
    stub.behaviour.finalInspectError.set('cid-proj_web', http(500));
    const session = await composeService.composeUp(TWO_SERVICES, 'proj');
    // 作成・起動自体は行われている（再レビューの実測と同じ条件）
    expect(stub.log).toContain('createContainer proj_web');
    expect(stub.log).toContain('container.start cid-proj_web');
    expect(session.services.web.status).toBe('error');
    expect(session.services.web.error).toMatch(/起動後の状態を確認（inspect）できなかったため、起動したとはみなしません/);
    expect(session.services.web.error).toMatch(/HTTP code 500/);
    expect(session.services.web.error).toMatch(/cid-proj_web/);
    expect(session.services.db.status).toBe('running');
    expect(session.status).toBe('error');
    expect(session.error).toMatch(/起動したサービス：db/);
  });

  it('ジョブ（runComposeUpJob）も失敗し、起動したサービスと失敗したサービスを両方とも出す', async () => {
    stub.behaviour.finalInspectError.set('cid-proj_web', http(500));
    await expect(runComposeUpJob(composeService, { composeYaml: TWO_SERVICES, projectName: 'proj' })).rejects.toThrow(
      /一部のサービスを起動できませんでした（起動したサービス：db／失敗したサービス：web: 起動後の状態を確認（inspect）できなかったため/,
    );
  });

  it('全サービスの最終 inspect が通信エラー（statusCode なし）でも、ジョブは失敗（起動したサービス：なし）', async () => {
    const conn = () => Object.assign(new Error('connect ECONNRESET /var/run/docker.sock'), { code: 'ECONNRESET' });
    stub.behaviour.finalInspectError.set('cid-proj_web', conn);
    stub.behaviour.finalInspectError.set('cid-proj_db', conn);
    await expect(runComposeUpJob(composeService, { composeYaml: TWO_SERVICES, projectName: 'proj' })).rejects.toThrow(
      /すべてのサービスを起動できませんでした（起動したサービス：なし／失敗したサービス：web: .*ECONNRESET.*; db: .*ECONNRESET/,
    );
  });

  it('最終確認で停止が分かったサービスは、従来どおり終了コードつきで失敗', async () => {
    stub.behaviour.notRunning.add('cid-proj_db');
    await expect(runComposeUpJob(composeService, { composeYaml: TWO_SERVICES, projectName: 'proj' })).rejects.toThrow(
      /起動したサービス：web／失敗したサービス：db: Container exited with code 1/,
    );
  });
});

describe('直し回12 推奨A：down-volumes でボリュームの削除だけが失敗したら、最後の進捗を error にする', () => {
  function setupProject() {
    stub.downState.containers.push({ Id: 'web0000000001', Names: ['/proj_web'], Labels: {}, State: 'running' });
    stub.downState.networks.push({ Id: 'net-front', Name: 'proj_front', Labels: {} });
    stub.downState.volumes.push('proj_data', 'other_data');
  }
  function captureProgress() {
    const events: { status: string; message: string }[] = [];
    const on = (e: { status: string; message: string }) => events.push(e);
    composeService.on('down:progress', on);
    return { events, off: () => composeService.off('down:progress', on) };
  }

  it('ネットワークの残存なし・ボリュームの削除が失敗：メソッドは失敗し、最後の down:progress は error（completed で終わらない）', async () => {
    setupProject();
    stub.behaviour.volumeRemoveError = http(409);
    const p = captureProgress();
    try {
      await expect(composeService.composeDownVolumes('proj')).rejects.toThrow(/HTTP code 409/);
    } finally {
      p.off();
    }
    const last = p.events[p.events.length - 1];
    expect(last.status).toBe('error');
    expect(last.message).toMatch(/ボリュームの削除に失敗しました（\(HTTP code 409\)/);
    // コンテナ・ネットワークの削除は済んでいる（down 自体は completed を一度送っている）
    expect(stub.log).toContain('container.remove web0000000001');
    expect(stub.log).toContain('network.remove net-front');
    expect(p.events.map((e) => e.status)).toContain('completed');
    expect(stub.log).toContain('volume.remove proj_data');
    expect(stub.log).not.toContain('volume.remove other_data');
  });

  it('すべて削除できれば、従来どおり最後の down:progress は completed で成功', async () => {
    setupProject();
    const p = captureProgress();
    try {
      const r = await composeService.composeDownVolumes('proj');
      expect(r.removedVolumes).toEqual(['proj_data']);
    } finally {
      p.off();
    }
    expect(p.events[p.events.length - 1].status).toBe('completed');
  });
});

describe('直し回12 推奨C：Docker ビルド後の inspect の失敗を completed にしない', () => {
  it('ビルド後の inspect が 500：buildImage は失敗し、セッションは error（completed にならない）', async () => {
    stub.behaviour.builtImageInspectError = http(500);
    const svc = new DockerService();
    const updates: string[] = [];
    svc.on('update', (s: { status: string }) => updates.push(s.status));
    await expect(svc.buildImage('b1', 'FROM alpine\n', 'built/app', 'v1')).rejects.toThrow(
      /ビルドの処理は終了しましたが、イメージ built\/app:v1 を確認（inspect）できなかったため、完了とはみなしません（\(HTTP code 500\)/,
    );
    const session = svc.getBuildSession('b1');
    expect(session?.status).toBe('error');
    expect(session?.error).toMatch(/完了とはみなしません/);
    expect(session?.imageId).toBeUndefined();
    expect(updates).not.toContain('completed');
    expect(updates[updates.length - 1]).toBe('error');
  });

  it('ビルド後の inspect が成功すれば、従来どおり completed（イメージ ID・サイズつき）', async () => {
    const svc = new DockerService();
    const session = await svc.buildImage('b2', 'FROM alpine\n', 'built/app', 'v1');
    expect(session.status).toBe('completed');
    expect(session.imageId).toBe('sha256:built/app:v1');
    expect(session.imageSize).toBe(1234);
  });
});
