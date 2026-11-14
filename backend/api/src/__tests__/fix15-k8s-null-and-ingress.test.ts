import { beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => {
  const calls: string[][] = [];
  /** `Kind/name` → get への応答の列（先頭から順に使い、最後の1つは繰り返す） */
  const gets = new Map<string, string[]>();
  const run = (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.push(args);
    if (args[0] !== 'get') return Promise.resolve({ stdout: 'applied\n', stderr: '' });
    const key = `${args[1]}/${args[2]}`;
    const seq = gets.get(key);
    if (!seq || seq.length === 0) return Promise.reject(Object.assign(new Error(`Error from server (NotFound): ${key} not found`), { code: 1 }));
    const r = seq.length > 1 ? seq.shift()! : seq[0];
    return Promise.resolve({ stdout: r, stderr: '' });
  };
  const execFile = (_file: string, args: string[], _opts: unknown, cb: (e: unknown, o: string, s: string) => void) => {
    run(args).then(
      (r) => cb(null, r.stdout, r.stderr),
      (e) => cb(e, '', ''),
    );
  };
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), { value: (_file: string, args: string[]) => run(args) });
  const exec = () => {
    throw new Error('exec must not be used');
  };
  return { calls, gets, execFile, exec };
});
vi.mock('child_process', () => ({ exec: cp.exec, execFile: cp.execFile, default: { exec: cp.exec, execFile: cp.execFile } }));
vi.mock('../services/queue', () => ({ addK8sDeployTask: vi.fn(async () => 'job-1') }));

const { KubernetesService } = await import('../services/kubernetes');
const { judgeReadiness } = await import('../services/k8s-readiness');
type Session = import('../services/kubernetes').K8sDeploySession;

const deployManifest = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: nginx
          image: nginx:1.27
`;
const lbManifest = `apiVersion: v1
kind: Service
metadata:
  name: lb
spec:
  type: LoadBalancer
  selector: { app: web }
  ports:
    - port: 80
      targetPort: 80
`;

type Status = Record<string, unknown>;
/** 更新完了の Deployment（desired 1・generation=observedGeneration=1） */
const deployment = (status: Status = {}) =>
  JSON.stringify({
    kind: 'Deployment',
    metadata: { name: 'web', generation: 1 },
    spec: { replicas: 1 },
    status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1, ...status },
  });
const lbService = (loadBalancer: unknown) =>
  JSON.stringify({ kind: 'Service', metadata: { name: 'lb' }, spec: { type: 'LoadBalancer', clusterIP: '10.0.0.9' }, status: { loadBalancer } });

function service() {
  const svc = new KubernetesService();
  const s = svc as unknown as { useMockMode: boolean; readinessWait: { attempts: number; intervalMs: number } };
  s.useMockMode = false;
  s.readinessWait = { attempts: 3, intervalMs: 0 };
  const updates: Session[] = [];
  svc.on('update', (x: Session) => updates.push(JSON.parse(JSON.stringify(x))));
  return { svc, updates };
}

const gets = (kind: string) => cp.calls.filter((a) => a[0] === 'get' && a[1] === kind).length;
const neverReady = (updates: Session[]) => {
  expect(updates.some((u) => u.status === 'completed')).toBe(false);
  expect(updates.some((u) => u.resources.some((r) => r.status === 'ready'))).toBe(false);
  expect(updates.some((u) => u.resources.some((r) => r.status === 'unverified'))).toBe(false);
};
const lastOf = (updates: Session[]) => updates[updates.length - 1];

/** 判定の単体：metadata を補った応答で judgeReadiness を呼ぶ */
const judge = (kind: string, rest: Record<string, unknown>) =>
  judgeReadiness(kind, { kind, metadata: { name: 'x', generation: 1 }, ...rest }, 'x');
const expectFailed = (kind: string, rest: Record<string, unknown>, reason: RegExp) => {
  const r = judge(kind, rest);
  expect(r.state, `${kind} ${JSON.stringify(rest)}`).toBe('failed');
  expect(r.detail, `${kind} ${JSON.stringify(rest)}`).toMatch(reason);
};

beforeEach(() => {
  cp.calls.length = 0;
  cp.gets.clear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('直し回15 必須1：明示的な null を省略（未報告）として扱わない', () => {
  it('再レビューの実測例（unavailableReplicas: null の Deployment）は ready にならず、取り直さずに失敗する', async () => {
    cp.gets.set('Deployment/web', [deployment({ unavailableReplicas: null })]);
    const { svc, updates } = service();
    await expect(svc.applyManifest(deployManifest, 'demo')).rejects.toThrow(
      /Deployment\/web: .*確認できない応答です（status\.unavailableReplicas が null です（不正な型））/,
    );
    expect(gets('Deployment')).toBe(1);
    const last = lastOf(updates);
    expect(last.status).toBe('error');
    expect(last.verification).toEqual({ ready: [], unverified: [], failed: ['Deployment/web'] });
    neverReady(updates);
  });

  it('対照：unavailableReplicas のキーが無い・0 なら従来どおり ready', async () => {
    cp.gets.set('Deployment/web', [deployment()]);
    const { svc } = service();
    const session = await svc.applyManifest(deployManifest, 'demo');
    expect(session.status).toBe('completed');
    expect(judgeReadiness('Deployment', JSON.parse(deployment({ unavailableReplicas: 0 })), 'web').state).toBe('ready');
  });

  it('数値項目の null：必須・省略可のどちらも失敗（0 や未報告と読み替えない）', () => {
    const base = { spec: { replicas: 1 }, status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1 } };
    // Deployment の判定に使う数（omitempty の数・observedGeneration）。readyReplicas は Deployment の判定に使わないので対象外
    for (const key of ['replicas', 'updatedReplicas', 'availableReplicas', 'unavailableReplicas', 'observedGeneration']) {
      expectFailed('Deployment', { ...base, status: { ...base.status, [key]: null } }, new RegExp(`status\\.${key} が null です`));
    }
    expectFailed('Deployment', { ...base, spec: { replicas: null } }, /spec\.replicas が null です/);
    expectFailed('Deployment', { ...base, metadata: { name: 'x', generation: null } }, /metadata\.generation が null です/);
    // DaemonSet の numberUnavailable（再レビューで同じ経路と指摘）と必須の数
    const ds = { observedGeneration: 1, desiredNumberScheduled: 1, currentNumberScheduled: 1, numberReady: 1, numberMisscheduled: 0, updatedNumberScheduled: 1, numberAvailable: 1 };
    expect(judge('DaemonSet', { status: ds }).state).toBe('ready');
    for (const key of ['numberUnavailable', 'numberAvailable', 'updatedNumberScheduled', 'desiredNumberScheduled', 'numberMisscheduled']) {
      expectFailed('DaemonSet', { status: { ...ds, [key]: null } }, new RegExp(`status\\.${key} が null です`));
    }
    // StatefulSet・ReplicaSet・Job
    const sts = { observedGeneration: 1, replicas: 1, readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 };
    expectFailed('StatefulSet', { spec: { replicas: 1 }, status: { ...sts, availableReplicas: null } }, /status\.availableReplicas が null です/);
    expectFailed('ReplicaSet', { spec: { replicas: 1 }, status: { observedGeneration: 1, replicas: 1, readyReplicas: null, availableReplicas: 1 } }, /status\.readyReplicas が null です/);
    expectFailed('Job', { status: { active: null, conditions: [{ type: 'Complete', status: 'True' }] } }, /status\.active が null です/);
  });

  it('文字列項目の null も失敗する（phase・reason・spec.type・clusterIP・externalName）', () => {
    expectFailed('Pod', { status: { phase: null } }, /status\.phase が null です/);
    expectFailed('Pod', { status: { phase: 'Failed', reason: null } }, /status\.reason が null です/);
    expectFailed('PersistentVolumeClaim', { status: { phase: null } }, /status\.phase が null です/);
    expectFailed('Namespace', { status: { phase: null } }, /status\.phase が null です/);
    expectFailed('Service', { spec: { type: null, clusterIP: '10.0.0.1' }, status: {} }, /spec\.type が null です/);
    expectFailed('Service', { spec: { type: 'ClusterIP', clusterIP: null }, status: {} }, /spec\.clusterIP が null です/);
    expectFailed('Service', { spec: { type: 'ExternalName', externalName: null }, status: {} }, /spec\.externalName が null です/);
    // 対照：キーが無い phase は従来どおり pending（未報告）
    expect(judge('Pod', { status: {} }).state).toBe('pending');
    expect(judge('Namespace', { status: {} }).state).toBe('pending');
  });

  it('条件の null も失敗する（conditions 自体・要素・type／status／reason／message）', () => {
    expectFailed('Pod', { status: { phase: 'Running', conditions: null } }, /status\.conditions が null です/);
    expectFailed('Pod', { status: { phase: 'Running', conditions: [null, { type: 'Ready', status: 'True' }] } }, /status\.conditions\[0\] が null です/);
    expectFailed('Pod', { status: { phase: 'Running', conditions: [{ type: 'Ready', status: null }] } }, /status\.conditions\[0\]\.status が null です/);
    expectFailed('Pod', { status: { phase: 'Running', conditions: [{ type: null, status: 'True' }] } }, /status\.conditions\[0\]\.type が null です/);
    expectFailed('Job', { status: { conditions: [{ type: 'Failed', status: 'True', reason: null }] } }, /status\.conditions\[0\]\.reason が null です/);
    expectFailed('Job', { status: { conditions: [{ type: 'Complete', status: 'True', message: null }] } }, /status\.conditions\[0\]\.message が null です/);
    expectFailed('Deployment', { spec: { replicas: 1 }, status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1, conditions: [{ type: 'Progressing', status: 'True', reason: null }] } }, /status\.conditions\[0\]\.reason が null です/);
    // 文字列・数値の要素、type／status の欠落も読み飛ばさない
    expectFailed('Job', { status: { conditions: ['Complete'] } }, /status\.conditions\[0\] がオブジェクトではありません/);
    expectFailed('Job', { status: { conditions: [{ type: 'Complete' }] } }, /status\.conditions\[0\]\.status がありません/);
    expectFailed('Pod', { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 1 }] } }, /status\.conditions\[0\]\.status が空でない文字列ではありません/);
    // 対照：正しい条件は従来どおり
    expect(judge('Pod', { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }).state).toBe('ready');
    expect(judge('Job', { status: { conditions: [{ type: 'Complete', status: 'True', reason: 'Done', message: 'ok' }] } }).state).toBe('ready');
  });

  it('オブジェクト項目の null（spec・status・status.loadBalancer）も失敗する', () => {
    expectFailed('Deployment', { spec: null, status: {} }, /spec が null です/);
    expectFailed('Pod', { status: null }, /status が null です/);
    expectFailed('Service', { spec: { type: 'LoadBalancer', clusterIP: '10.0.0.1' }, status: { loadBalancer: null } }, /status\.loadBalancer が null です/);
    expectFailed('Service', { spec: { type: 'LoadBalancer', clusterIP: '10.0.0.1' }, status: { loadBalancer: { ingress: null } } }, /status\.loadBalancer\.ingress が null です/);
  });
});

describe('直し回15 必須2：LoadBalancer の ingress 要素を検証する', () => {
  const lb = (loadBalancer: unknown) => judge('Service', { spec: { type: 'LoadBalancer', clusterIP: '10.0.0.9' }, status: { loadBalancer } });

  it('ingress: [{}] は割り当て済みにならず pending のまま、期限切れで失敗する（apply 経路）', async () => {
    cp.gets.set('Service/lb', [lbService({ ingress: [{}] })]);
    const { svc, updates } = service();
    await expect(svc.applyManifest(lbManifest, 'demo')).rejects.toThrow(
      /Service\/lb: 3回確認しても準備完了になりませんでした（LoadBalancer：外部アドレスがまだ割り当てられていません/,
    );
    expect(gets('Service')).toBe(3);
    expect(lastOf(updates).status).toBe('error');
    expect(lastOf(updates).verification).toEqual({ ready: [], unverified: [], failed: ['Service/lb'] });
    neverReady(updates);
  });

  it('ingress: [null] は確認できない応答として、取り直さずに失敗する（apply 経路）', async () => {
    cp.gets.set('Service/lb', [lbService({ ingress: [null] })]);
    const { svc, updates } = service();
    await expect(svc.applyManifest(lbManifest, 'demo')).rejects.toThrow(/Service\/lb: .*status\.loadBalancer\.ingress\[0\] が null です/);
    expect(gets('Service')).toBe(1);
    expect(lastOf(updates).status).toBe('error');
    neverReady(updates);
  });

  it('有効な ip／hostname を持つ要素で ready になる（apply 経路と単体）', async () => {
    cp.gets.set('Service/lb', [lbService({ ingress: [{}] }), lbService({ ingress: [{ hostname: 'lb.example.test' }] })]);
    const { svc } = service();
    const session = await svc.applyManifest(lbManifest, 'demo');
    expect(session.status).toBe('completed');
    expect(session.resources[0]).toMatchObject({ status: 'ready', detail: 'LoadBalancer：外部アドレス割り当て済み（lb.example.test／clusterIP 10.0.0.9）' });
    expect(gets('Service')).toBe(2);
    expect(lb({ ingress: [{ ip: '203.0.113.5' }] })).toEqual({ state: 'ready', detail: 'LoadBalancer：外部アドレス割り当て済み（203.0.113.5／clusterIP 10.0.0.9）' });
    expect(lb({ ingress: [{ ip: '203.0.113.5', hostname: 'a.test', ports: [{ port: 80, protocol: 'TCP' }] }] }).state).toBe('ready');
    expect(lb({ ingress: [{}, { ip: '203.0.113.6' }] }).state).toBe('ready'); // 有効な要素が1つあれば割り当て済み
  });

  it('有効なアドレスが無い（[]・[{}]・空文字・ingress なし）は pending', () => {
    for (const v of [{}, { ingress: [] }, { ingress: [{}] }, { ingress: [{ ip: '' }] }, { ingress: [{ hostname: '' }] }, { ingress: [{ ip: '', hostname: '' }] }, { ingress: [{ ports: [] }] }]) {
      expect(lb(v).state, JSON.stringify(v)).toBe('pending');
    }
    expect(judge('Service', { spec: { type: 'LoadBalancer', clusterIP: '10.0.0.9' }, status: {} }).state).toBe('pending');
  });

  it('要素の構造が不正（null・文字列・数値・配列・ip／hostname が null や文字列以外）は failed', () => {
    const cases: [unknown, RegExp][] = [
      [[null], /ingress\[0\] が null です/],
      [['203.0.113.5'], /ingress\[0\] がオブジェクトではありません/],
      [[1], /ingress\[0\] がオブジェクトではありません/],
      [[['203.0.113.5']], /ingress\[0\] がオブジェクトではありません/],
      [[{ ip: null }], /ingress\[0\]\.ip が null です/],
      [[{ hostname: null }], /ingress\[0\]\.hostname が null です/],
      [[{ ip: 1 }], /ingress\[0\]\.ip が文字列ではありません/],
      [[{ hostname: ['a.test'] }], /ingress\[0\]\.hostname が文字列ではありません/],
      [[{ ip: '203.0.113.5', hostname: null }], /ingress\[0\]\.hostname が null です/],
      // 有効な要素があっても、不正な要素を含む応答は確認できない応答として失敗
      [[{ ip: '203.0.113.5' }, null], /ingress\[1\] が null です/],
    ];
    for (const [ingress, reason] of cases) {
      const r = lb({ ingress });
      expect(r.state, JSON.stringify(ingress)).toBe('failed');
      expect(r.detail, JSON.stringify(ingress)).toMatch(reason);
    }
  });
});
