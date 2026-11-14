/**
 * テスト用の Docker クライアントのスタブ（Docker が無い環境のため）。lab-runner.test.ts と
 * cleanup-generation.test.ts で共用する。
 *
 * - listContainers／listNetworks はラベルの filters で絞り込む（実際の Docker と同じ）。
 * - holdLists()：以後の一覧取得を保留し、releaseLists() で解除する。解除後は filters を無視して
 *   その時点の全件を返す（遅れて返った一覧が別世代のリソースを含む、という最悪の場合を作る）。
 * - holdCreate：createContainer を保留し、releaseCreate() で解除するとその時点で作成される。
 */
import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import { fixtureEvidence } from '../evidence/fixtures';

export interface FakeContainer {
  Id: string;
  Names: string[];
  Labels: Record<string, string>;
  State: string;
  spec: Docker.ContainerCreateOptions;
}

export interface FakeNetwork {
  Id: string;
  Name: string;
  Internal: boolean;
  Labels: Record<string, string>;
}

export interface FakeOpts {
  /** この exec（コマンド先頭）で応答が返らない */
  hangExec?: string;
  /** createContainer が返らない */
  hangCreate?: boolean;
  /** createContainer を releaseCreate() まで保留する */
  holdCreate?: boolean;
  /** createNetwork を releaseCreate() まで保留する */
  holdCreateNetwork?: boolean;
  /** remove が失敗する */
  removeFails?: boolean;
  /** start 時に投げるエラー（spec を見て決める） */
  startError?: (spec: Docker.ContainerCreateOptions) => Error | null;
  /** exec の開始時に呼ぶ（コマンドを渡す）。保留の開始時点をテストで決めるため */
  onExec?: (cmd: string[]) => void;
}

const never = () => new Promise<never>(() => undefined);

export function fakeDocker(opts: FakeOpts = {}) {
  const calls = {
    stop: [] as string[],
    remove: [] as string[],
    removeNetwork: [] as string[],
    created: [] as Docker.ContainerCreateOptions[],
    execStreamsDestroyed: 0,
    /** 保留された一覧取得に渡された filters */
    heldListFilters: [] as Array<{ label?: string[] } | undefined>,
  };
  const containers = new Map<string, FakeContainer>();
  const networks = new Map<string, FakeNetwork>();
  let seq = 0;
  let listGate: { promise: Promise<void>; release: () => void } | null = null;
  let unfiltered = false;
  const createWaiters: Array<() => void> = [];
  const matches = (labels: Record<string, string>, filters?: { label?: string[] }) =>
    (filters?.label ?? []).every((f) => {
      const [k, v] = f.split('=');
      return labels[k] === v;
    });
  const evidence = fixtureEvidence('drop', 5);
  const outputFor = (cmd: string[]) => {
    if (cmd[0] === '/lab/client-run.sh') {
      return ['=====lab-env', evidence['lab-env'], '=====tcpdump', evidence.tcpdump, '=====ss-client', evidence['ss-client'], '=====curl', evidence.curl, ''].join('\n');
    }
    if (cmd[0] === 'ss') return evidence['ss-server'];
    return '';
  };
  const handle = (id: string) => ({
    id,
    start: async () => {
      const c = containers.get(id)!;
      const err = opts.startError?.(c.spec);
      if (err) throw err;
      c.State = 'running';
    },
    stop: async () => {
      calls.stop.push(id);
      const c = containers.get(id);
      if (c) c.State = 'exited';
    },
    remove: async () => {
      calls.remove.push(id);
      if (opts.removeFails) throw new Error('remove failed (stub)');
      containers.delete(id);
    },
    inspect: async () => {
      const c = containers.get(id) ?? [...containers.values()].find((x) => x.Names.includes(`/${id}`));
      if (!c) throw Object.assign(new Error(`no such container: ${id}`), { statusCode: 404 });
      return { Id: c.Id, Name: c.Names[0], Config: { Labels: c.Labels } };
    },
    exec: async ({ Cmd }: { Cmd: string[] }) => ({
      start: async () => {
        opts.onExec?.(Cmd);
        const s = new PassThrough();
        s.on('close', () => {
          if (!s.writableEnded) calls.execStreamsDestroyed++;
        });
        if (opts.hangExec !== Cmd[0]) setImmediate(() => s.end(outputFor(Cmd)));
        return s;
      },
      inspect: async () => ({ ExitCode: 0 }),
    }),
  });
  const held = async <T>(filters: { label?: string[] } | undefined, all: () => T[], filtered: () => T[]): Promise<T[]> => {
    if (!listGate) return unfiltered ? all() : filtered();
    calls.heldListFilters.push(filters);
    await listGate.promise;
    return all();
  };
  const create = (spec: Docker.ContainerCreateOptions) => {
    const Id = `c${++seq}`;
    containers.set(Id, { Id, Names: spec.name ? [`/${spec.name}`] : [], Labels: spec.Labels as Record<string, string>, State: 'created', spec });
    calls.created.push(spec);
    return handle(Id);
  };
  const docker = {
    ping: async () => 'OK',
    getImage: () => ({ inspect: async () => ({ Id: 'img' }) }),
    buildImage: async () => {
      throw new Error('not expected');
    },
    listNetworks: async ({ filters }: { filters?: { label?: string[] } } = {}) =>
      held(
        filters,
        () => [...networks.values()],
        () => [...networks.values()].filter((n) => matches(n.Labels, filters)),
      ),
    createNetwork: async (o: { Name: string; Internal: boolean; Labels: Record<string, string> }) => {
      if (opts.holdCreateNetwork) await new Promise<void>((r) => createWaiters.push(r));
      const Id = `net${++seq}`;
      networks.set(Id, { Id, Name: o.Name, Internal: o.Internal, Labels: o.Labels });
      return { id: Id };
    },
    listContainers: async ({ all, filters }: { all?: boolean; filters?: { label?: string[] } } = {}) =>
      held(
        filters,
        () => [...containers.values()],
        () => [...containers.values()].filter((c) => matches(c.Labels, filters) && (all || c.State === 'running')),
      ),
    createContainer: async (spec: Docker.ContainerCreateOptions) => {
      if (opts.hangCreate) return never();
      if (opts.holdCreate) {
        await new Promise<void>((r) => createWaiters.push(r));
      }
      return create(spec);
    },
    getContainer: (id: string) => handle(id),
    getNetwork: (id: string) => ({
      inspect: async () => {
        const n = networks.get(id);
        if (!n) throw Object.assign(new Error(`no such network: ${id}`), { statusCode: 404 });
        return { Id: n.Id, Name: n.Name, Labels: n.Labels };
      },
      remove: async () => {
        calls.removeNetwork.push(id);
        networks.delete(id);
      },
    }),
    modem: { demuxStream: (s: PassThrough, out: PassThrough) => s.pipe(out) },
  };
  return {
    docker: docker as unknown as Docker,
    calls,
    containers,
    networks,
    /** 以後の一覧取得を保留する */
    holdLists() {
      let release!: () => void;
      const promise = new Promise<void>((r) => (release = r));
      listGate = { promise, release };
    },
    /** 保留を解除する（保留中だった一覧は filters を無視した全件を返す） */
    releaseLists() {
      const g = listGate;
      listGate = null;
      g?.release();
    },
    /** true にすると一覧が filters を無視して全件を返す（絞り込みを当てにしない検査のため） */
    setUnfiltered(v: boolean) {
      unfiltered = v;
    },
    /** 保留中の createContainer／createNetwork を解除する */
    releaseCreate() {
      for (const r of createWaiters.splice(0)) r();
    },
    /** 別のプロセス・後続の試行が作ったリソースを足す（直接注入） */
    addContainer(c: Omit<FakeContainer, 'spec'>) {
      containers.set(c.Id, { ...c, spec: {} });
    },
    addNetwork(n: FakeNetwork) {
      networks.set(n.Id, n);
    },
  };
}
