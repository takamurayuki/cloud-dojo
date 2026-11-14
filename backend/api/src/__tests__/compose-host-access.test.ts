/**
 * 直し回5：compose 定義のホスト脱出経路の拒否（必須）、接続に確かめたネットワーク ID を使うこと（推奨A）、
 * 作成途中で失敗したときのネットワークの後始末・残存の明示（推奨B）。
 * Docker が無い環境のため dockerode をスタブに差し替え、全メソッドの呼び出しを記録する（キューは Redis を使うため差し替える）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => {
  /** Docker への全ての呼び出し（メソッド名と対象） */
  const log: string[] = [];
  const calls = {
    createNetwork: [] as string[],
    removeNetwork: [] as string[],
    create: [] as { name: string; networkMode?: string; binds?: string[] }[],
    removeContainer: [] as string[],
  };
  const networks: Record<string, { Id: string; Name: string; Labels: Record<string, string> }> = {};
  const behaviour = {
    /** createNetwork の直前に、同名の別ネットワークを差し込む（確認後の競合の再現） */
    raceOnCreate: {} as Record<string, { Id: string; Labels: Record<string, string> }>,
    /** ネットワーク削除を失敗させる ID */
    failNetworkRemove: new Set<string>(),
    /** コンテナ作成を失敗させる名前 */
    failCreate: new Set<string>(),
  };
  const notFound = (what: string) => Object.assign(new Error(`no such ${what}`), { statusCode: 404 });
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
      return [];
    },
    listNetworks: async () => {
      log.push('listNetworks');
      return [];
    },
    getNetwork: (idOrName: string) => ({
      id: idOrName,
      inspect: async () => {
        log.push(`network.inspect ${idOrName}`);
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
      const race = behaviour.raceOnCreate[o.Name];
      if (race) networks[race.Id] = { Id: race.Id, Name: o.Name, Labels: race.Labels };
      if (Object.values(networks).some((n) => n.Name === o.Name)) throw Object.assign(new Error('network exists'), { statusCode: 409 });
      const id = `netid-${o.Name}`;
      networks[id] = { Id: id, Name: o.Name, Labels: o.Labels ?? {} };
      calls.createNetwork.push(o.Name);
      return { id };
    },
    createContainer: async (spec: { name: string; HostConfig?: { NetworkMode?: string; Binds?: string[] } }) => {
      log.push(`createContainer ${spec.name}`);
      if (behaviour.failCreate.has(spec.name)) throw new Error(`create failed: ${spec.name}`);
      calls.create.push({ name: spec.name, networkMode: spec.HostConfig?.NetworkMode, binds: spec.HostConfig?.Binds });
      return {
        id: `cid-${spec.name}`,
        start: async () => undefined,
        inspect: async () => ({ NetworkSettings: { Networks: {} } }),
      };
    },
    getContainer: (idOrName: string) => ({
      inspect: async () => {
        log.push(`container.inspect ${idOrName}`);
        // 新規作成したコンテナは起動中とする。それ以外は存在しない
        if (idOrName.startsWith('cid-')) return { Id: idOrName, Config: { Labels: {} }, State: { Running: true, ExitCode: 0 } };
        throw notFound(`container: ${idOrName}`);
      },
      remove: async () => {
        log.push(`container.remove ${idOrName}`);
        calls.removeContainer.push(idOrName);
      },
      stop: async () => {
        log.push(`container.stop ${idOrName}`);
      },
    }),
  };
  return { log, calls, networks, behaviour, docker };
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
const { composeRoutes } = await import('../routes/compose');
const { networkRoutes } = await import('../routes/network');

let quiet: { mockRestore: () => void }[] = [];
let app: FastifyInstance;
beforeEach(async () => {
  stub.log.length = 0;
  for (const k of Object.keys(stub.calls) as (keyof typeof stub.calls)[]) stub.calls[k].length = 0;
  for (const k of Object.keys(stub.networks)) delete stub.networks[k];
  stub.behaviour.raceOnCreate = {};
  stub.behaviour.failNetworkRemove.clear();
  stub.behaviour.failCreate.clear();
  queue.addComposeUpTask.mockClear();
  quiet = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined)];
  app = Fastify();
  await app.register(composeRoutes);
  await app.register(networkRoutes, { prefix: '/api/network' });
});
afterEach(async () => {
  quiet.forEach((q) => q.mockRestore());
  await app.close();
});

const svc = (body: string) => `version: '3.8'\nservices:\n  attacker:\n    image: docker:cli\n    command: ["docker", "rm", "-f", "PILOT_ID"]\n${body}`;
const vol = (spec: string) => svc(`    volumes:\n      - ${spec}\n`);

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
}

describe('直し回5 必須：Docker ソケットの bind mount を拒否し、作成を始めない', () => {
  const socketSpecs = [
    '/var/run/docker.sock:/var/run/docker.sock', // 直接パス（再レビューの再現例）
    '/run/docker.sock:/var/run/docker.sock', // /run の別名
    '/var/run/../run/docker.sock:/sock', // .. を含む
    '/var/run/../../var/run/docker.sock:/sock',
    '/var/run/docker.sock/:/sock', // 末尾スラッシュ
    '/var/./run//docker.sock:/sock', // . と重複スラッシュ
    '//var/run/docker.sock:/sock', // 先頭の重複スラッシュ（Docker Desktop の書き方）
    '"/var/run/docker.sock:/var/run/docker.sock"', // 引用符付き
    '/var/run/docker.sock:/var/run/docker.sock:ro', // 読み取り専用でもソケットは操作できる
    `${'../'.repeat(30)}var/run/docker.sock:/sock`, // 相対パス（.. で / まで上がる）
    '/run:/hostrun', // ソケットを含む親ディレクトリ
    '/var/run:/hostrun',
    '/var:/hostvar',
    '/:/host',
    '/srv/elsewhere/docker.sock:/sock', // 別の場所の docker.sock（rootless 等）
    '//./pipe/docker_engine://./pipe/docker_engine', // Windows の名前付きパイプ
    '\\\\.\\pipe\\docker_engine:\\\\.\\pipe\\docker_engine',
  ];
  for (const spec of socketSpecs) {
    it(`volumes: ${spec}`, async () => {
      await expectRejectedBeforeCreate(vol(spec), /Docker (ソケット|Engine の名前付きパイプ)/);
    });
  }

  it('長い書式（type: bind, source）・フロー書式・アンカーのマージでも拒否する', async () => {
    await expectRejectedBeforeCreate(svc('    volumes:\n      - type: bind\n        source: /run/docker.sock\n        target: /var/run/docker.sock\n'), /Docker ソケット/);
    await expectRejectedBeforeCreate(svc('    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n'), /Docker ソケット/);
    await expectRejectedBeforeCreate(
      `version: '3.8'\nx-common: &common\n  volumes:\n    - /var/run/docker.sock:/var/run/docker.sock\nservices:\n  attacker:\n    <<: *common\n    image: docker:cli\n`,
      /Docker ソケット/,
    );
  });

  it('名前付きボリュームの driver_opts.device、secrets／configs の file でソケットを渡すものも拒否する', async () => {
    await expectRejectedBeforeCreate(
      `${svc('    volumes:\n      - sock:/hostrun\n')}volumes:\n  sock:\n    driver: local\n    driver_opts:\n      type: none\n      o: bind\n      device: /var/run\n`,
      /driver_opts\.device/,
    );
    await expectRejectedBeforeCreate(`${svc('')}secrets:\n  s:\n    file: /var/run/docker.sock\n`, /secrets\.s\.file/);
    await expectRejectedBeforeCreate(`${svc('')}configs:\n  c:\n    file: /run/docker.sock\n`, /configs\.c\.file/);
  });

  it('YAML として解析できない定義は判定できないため拒否する', async () => {
    await expectRejectedBeforeCreate('services:\n  a:\n    image: x\n   volumes: [\n', /YAML として解析できない/);
  });
});

describe('直し回5 必須：パスは見た目でなく実体で判定する（シンボリックリンク・ハードリンク）', () => {
  it('ホスト上のシンボリックリンク（リンク先が存在しない宙に浮いたものを含む）を解決して拒否する', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-guard-'));
    try {
      fs.symlinkSync('/var/run/docker.sock', path.join(dir, 'innocent'));
      fs.symlinkSync('/run', path.join(dir, 'rundir'));
      await expectRejectedBeforeCreate(vol(`${path.join(dir, 'innocent')}:/sock`), /Docker ソケット/);
      await expectRejectedBeforeCreate(vol(`${path.join(dir, 'rundir')}:/hostrun`), /Docker ソケット/);
      await expectRejectedBeforeCreate(vol(`${path.join(dir, 'rundir', 'docker.sock')}:/sock`), /Docker ソケット/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同じ実体（デバイス・inode が同じハードリンク）や、ソケットへ解決されるリンクは、名前に docker.sock を含まなくても拒否する', () => {
    const env: import('../services/compose-guard').SocketCheckEnv = {
      cwd: '/work',
      homedir: '/home/u',
      extraSockets: [],
      realpath: (p) => {
        if (p === '/opt/link-to-sock') return '/run/docker.sock';
        if (p === '/opt' || p === '/opt/hard' || p === '/run/docker.sock' || p === '/' || p === '/run') return p;
        throw new Error('ENOENT');
      },
      readlink: () => {
        throw new Error('EINVAL');
      },
      stat: (p) => (p === '/opt/hard' || p === '/run/docker.sock' ? { dev: 1, ino: 42 } : p === '/opt' ? { dev: 1, ino: 7 } : null),
    };
    expect(guard.dockerSocketReason('/opt/hard', env)).toMatch(/同じ実体/);
    expect(guard.dockerSocketReason('/opt/link-to-sock', env)).toMatch(/Docker ソケット/);
    expect(guard.dockerSocketReason('/opt', env)).toBeNull();
    // DOCKER_HOST 等で指定された別の場所のソケットと、その親ディレクトリ
    const env2 = { ...env, extraSockets: ['/srv/d/engine.socket'] };
    expect(guard.dockerSocketReason('/srv/d/engine.socket', env2)).toMatch(/Docker ソケット/);
    expect(guard.dockerSocketReason('/srv/d', env2)).toMatch(/含むディレクトリ/);
  });
});

describe('直し回5 必須：privileged・host 名前空間・許可外の cap_add・devices を拒否する', () => {
  const cases: [string, RegExp][] = [
    ['    privileged: true\n', /privileged/],
    ['    privileged: "true"\n', /privileged/],
    ['    network_mode: host\n', /network_mode: host/],
    ['    network_mode: "container:cloud-dojo-lab-n5-tcp-abcg1-client"\n', /network_mode: container:/],
    ['    pid: host\n', /pid: host/],
    ['    pid: "container:abc"\n', /pid: container:abc/],
    ['    ipc: host\n', /ipc: host/],
    ['    uts: host\n', /uts: host/],
    ['    userns_mode: host\n', /userns_mode: host/],
    ['    cgroup: host\n', /cgroup: host/],
    ['    cap_add:\n      - ALL\n', /ALL は許可していない権限/],
    ['    cap_add:\n      - SYS_ADMIN\n', /SYS_ADMIN/],
    ['    cap_add: [CAP_SYS_ADMIN]\n', /CAP_SYS_ADMIN/],
    ['    cap_add:\n      - sys_module\n', /sys_module/],
    ['    cap_add:\n      - SYS_RAWIO\n', /SYS_RAWIO/],
    ['    cap_add:\n      - DAC_READ_SEARCH\n', /DAC_READ_SEARCH/],
    ['    cap_add:\n      - NET_ADMIN\n      - SYS_TIME\n', /SYS_TIME/],
    ['    devices:\n      - /dev/sda:/dev/sda\n', /devices/],
  ];
  for (const [body, pattern] of cases) {
    it(body.trim().replace(/\n\s*/g, ' '), async () => {
      await expectRejectedBeforeCreate(svc(body), pattern);
    });
  }

  it('複数の違反はまとめて理由に出す', () => {
    const v = guard.inspectComposeDefinition(svc('    privileged: true\n    pid: host\n    volumes:\n      - /var/run/docker.sock:/s\n'));
    expect(v.map((x) => x.field).sort()).toEqual(['pid', 'privileged', 'volumes']);
  });
});

describe('直し回5 必須：通常の compose 定義は従来どおり作成できる', () => {
  const NORMAL = `version: '3.8'
services:
  web:
    image: nginx:alpine
    ports:
      - "9000:80"
    environment:
      API_URL: http://api:4000
      DOCKER_SOCK_HINT: /var/run/docker.sock
    command: sh -c "sleep infinity"
    volumes:
      - ./html:/usr/share/nginx/html:ro
      - /srv/app/data:/data
      - /var/runner-cache:/cache
      - /home/user/project:/src
      - web-data:/var/lib/web
    cap_add:
      - NET_ADMIN
      - SYS_PTRACE
      - CAP_NET_RAW
    networks:
      - app-network
  db:
    image: postgres:15-alpine
    network_mode: bridge
    ipc: shareable
    privileged: false
    environment:
      POSTGRES_PASSWORD: password
    volumes:
      - db-data:/var/lib/postgresql/data
networks:
  app-network:
    driver: bridge
volumes:
  web-data:
  db-data:
`;

  it('検査は違反なしで、受付は 200（キューに入る）', async () => {
    expect(guard.inspectComposeDefinition(NORMAL)).toEqual([]);
    const r = await app.inject({ method: 'POST', url: '/api/compose/up', payload: { composeYaml: NORMAL, projectName: 'proj' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('queued');
    expect(queue.addComposeUpTask).toHaveBeenCalledWith({ composeYaml: NORMAL, projectName: 'proj' });
  });

  it('Worker 側でも作成でき、イメージ・command・ボリューム・ポートが従来どおりコンテナ設定に入る', async () => {
    const r = await runComposeUpJob(composeService, { composeYaml: NORMAL, projectName: 'proj' });
    expect(r.success).toBe(true);
    expect(stub.calls.create.map((c) => c.name)).toEqual(['proj_web', 'proj_db']);
    expect(stub.calls.create[0].binds).toEqual([
      './html:/usr/share/nginx/html:ro',
      '/srv/app/data:/data',
      '/var/runner-cache:/cache',
      '/home/user/project:/src',
      'proj_web-data:/var/lib/web',
    ]);
    expect(stub.calls.create[1].binds).toEqual(['proj_db-data:/var/lib/postgresql/data']);
  });

  it('画面（DockerCompose.tsx）のテンプレートと同じ形の定義も通る', () => {
    const src = fs.readFileSync(fileURLToPath(new URL('../../../../frontend/src/pages/docker/DockerCompose.tsx', import.meta.url)), 'utf8');
    const templates = [...src.matchAll(/`(version: '3\.8'[\s\S]*?)`/g)].map((m) => m[1]);
    expect(templates.length).toBeGreaterThanOrEqual(5);
    for (const t of templates) expect(guard.inspectComposeDefinition(t), t.slice(0, 80)).toEqual([]);
  });

  it('許可する cap_add は Docker の既定14個と NET_ADMIN・SYS_PTRACE・IPC_LOCK・SYS_NICE だけ', () => {
    expect([...guard.ALLOWED_CAP_ADD].sort()).toEqual(
      [
        'AUDIT_WRITE', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'MKNOD', 'NET_BIND_SERVICE', 'NET_RAW', 'SETFCAP', 'SETGID', 'SETPCAP', 'SETUID', 'SYS_CHROOT',
        'NET_ADMIN', 'SYS_PTRACE', 'IPC_LOCK', 'SYS_NICE',
      ].sort(),
    );
  });
});

const TWO_NET_YAML = `version: '3.8'
services:
  web:
    image: nginx
networks:
  app:
    driver: bridge
  back:
    driver: bridge
`;
const OURS = (project: string, network: string) => ({ 'cloud-dojo': 'compose', 'cloud-dojo.compose.project': project, 'cloud-dojo.compose.network': network });

describe('直し回5 推奨A：接続には確かめた（または作成した）ネットワークの ID を使う', () => {
  it('compose：既存の確認済みネットワークにはその ID で、作成したものは作成時の ID で接続する', async () => {
    stub.networks['verified-app-id'] = { Id: 'verified-app-id', Name: 'proj_app', Labels: OURS('proj', 'app') };
    const r = await runComposeUpJob(composeService, { composeYaml: TWO_NET_YAML, projectName: 'proj' });
    expect(r.success).toBe(true);
    expect(stub.calls.createNetwork).toEqual(['proj_back']);
    expect(stub.calls.create).toEqual([{ name: 'proj_web', networkMode: 'verified-app-id', binds: [] }]);
  });

  it('compose：作成時に 409 で再確認を通ったものも、その確認で得た ID で接続する', async () => {
    stub.behaviour.raceOnCreate['proj_app'] = { Id: 'raced-ours-id', Labels: OURS('proj', 'app') };
    const r = await runComposeUpJob(composeService, { composeYaml: TWO_NET_YAML, projectName: 'proj' });
    expect(r.success).toBe(true);
    expect(stub.calls.create[0].networkMode).toBe('raced-ours-id');
  });

  it('/lab/create：再利用する確認済みネットワーク・作成したネットワークのどちらも ID で接続する（名前では接続しない）', async () => {
    stub.networks['labnet-verified'] = { Id: 'labnet-verified', Name: 'lab-network', Labels: { 'cloud-dojo': 'network-lab' } };
    let r = await app.inject({ method: 'POST', url: '/api/network/lab/create', payload: { nodeCount: 2 } });
    expect(r.statusCode).toBe(200);
    expect(stub.calls.create.map((c) => c.networkMode)).toEqual(['labnet-verified', 'labnet-verified']);

    stub.calls.create.length = 0;
    r = await app.inject({ method: 'POST', url: '/api/network/lab/create', payload: { nodeCount: 2, networkName: 'fresh-net' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().networkId).toBe('netid-fresh-net');
    expect(stub.calls.create.map((c) => c.networkMode)).toEqual(['netid-fresh-net', 'netid-fresh-net']);
  });
});

describe('直し回5 推奨B：作成途中で失敗したら、この回に作成したネットワークを ID で削除し、できなければ残存を明示する', () => {
  it('compose：2つ目の作成中の 409 の再確認で拒否したら、1つ目に作成したネットワークを作成時の ID で削除し、コンテナは作らない', async () => {
    // proj_back は確認の時点では無く、作成時に別用途のネットワークが割り込む
    stub.behaviour.raceOnCreate['proj_back'] = { Id: 'foreign-back', Labels: { 'cloud-dojo': 'network-lab' } };
    const job = runComposeUpJob(composeService, { composeYaml: TWO_NET_YAML, projectName: 'proj' });
    await expect(job).rejects.toThrow(/compose 用と確かめられない.*この回に作成したネットワーク proj_app は削除しました/);
    expect(stub.calls.createNetwork).toEqual(['proj_app']);
    expect(stub.calls.removeNetwork).toEqual(['netid-proj_app']);
    expect(stub.calls.create).toEqual([]);
    // 割り込んだ別のネットワークには触れない
    expect(stub.networks['foreign-back']).toBeDefined();
  });

  it('compose：削除できなければ、ジョブの失敗理由とログに残存（名前・ID・削除手順）を出す', async () => {
    stub.behaviour.raceOnCreate['proj_back'] = { Id: 'foreign-back', Labels: {} };
    stub.behaviour.failNetworkRemove.add('netid-proj_app');
    const errorLog = console.error as unknown as { mock: { calls: unknown[][] } };
    const job = runComposeUpJob(composeService, { composeYaml: TWO_NET_YAML, projectName: 'proj' });
    await expect(job).rejects.toThrow(/proj_app（netid-proj_app） は削除できず残っています（docker network rm netid-proj_app/);
    expect(errorLog.mock.calls.some((c) => String(c[0]).includes('netid-proj_app') && String(c[0]).includes('残っています'))).toBe(true);
    // 直し回6 推奨B：専用ログにも削除手順を出す
    expect(errorLog.mock.calls.some((c) => String(c[0]).includes('proj_app') && String(c[0]).includes('docker network rm netid-proj_app'))).toBe(true);
    expect(stub.calls.create).toEqual([]);
  });

  it('compose：作成前の確認で拒否した場合は、従来どおり何も作成・削除しない', async () => {
    stub.networks['foreign-app'] = { Id: 'foreign-app', Name: 'proj_app', Labels: {} };
    await expect(runComposeUpJob(composeService, { composeYaml: TWO_NET_YAML, projectName: 'proj' })).rejects.toThrow(/確かめられない/);
    expect(stub.calls.createNetwork).toEqual([]);
    expect(stub.calls.removeNetwork).toEqual([]);
    expect(stub.calls.create).toEqual([]);
  });

  it('/lab/create：ネットワーク作成後にコンテナ作成で失敗したら、この要求で作成したコンテナとネットワークを ID で削除する', async () => {
    stub.behaviour.failCreate.add('network-node-2');
    const r = await app.inject({ method: 'POST', url: '/api/network/lab/create', payload: { nodeCount: 3 } });
    expect(r.statusCode).toBe(500);
    expect(r.json().cleanup).toEqual({ removed: ['cid-network-node-1', 'netid-lab-network'], remaining: [] });
    expect(stub.calls.removeContainer).toEqual(['cid-network-node-1']);
    expect(stub.calls.removeNetwork).toEqual(['netid-lab-network']);
  });

  it('/lab/create：削除できなければ応答の cleanup.remaining に残存を出す', async () => {
    stub.behaviour.failCreate.add('network-node-1');
    stub.behaviour.failNetworkRemove.add('netid-lab-network');
    const r = await app.inject({ method: 'POST', url: '/api/network/lab/create', payload: { nodeCount: 2 } });
    expect(r.statusCode).toBe(500);
    // 直し回6 推奨B：残存に名前と復旧手順を加えた（kind・id・error は従来どおり）
    expect(r.json().cleanup.remaining).toEqual([
      { kind: 'network', name: 'lab-network', id: 'netid-lab-network', error: 'network has active endpoints', recovery: 'docker network rm netid-lab-network' },
    ]);
  });

  it('/lab/create：再利用した既存のネットワークは、失敗しても削除しない', async () => {
    stub.networks['labnet-verified'] = { Id: 'labnet-verified', Name: 'lab-network', Labels: { 'cloud-dojo': 'network-lab' } };
    stub.behaviour.failCreate.add('network-node-1');
    const r = await app.inject({ method: 'POST', url: '/api/network/lab/create', payload: { nodeCount: 2 } });
    expect(r.statusCode).toBe(500);
    expect(r.json().cleanup).toBeUndefined();
    expect(stub.calls.removeNetwork).toEqual([]);
  });
});
