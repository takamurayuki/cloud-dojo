/**
 * 直し回13（推奨A）：Kubernetes の apply 後の確認（kubectl get）が失敗したら、ready・completed にせず失敗にする。
 * 取得できた status は種別ごとの規則（k8s-readiness.ts）で判定し、規則の無い種別は unverified（存在のみ確認）として明示する。
 * child_process はスタブに差し替える（実際の kubectl は実行しない）。キューは Redis を使うため差し替える。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => {
  const calls: string[][] = [];
  /** `Kind/name` → get への応答の列（先頭から順に使い、最後の1つは繰り返す）。Error は失敗として返す */
  const gets = new Map<string, (string | Error)[]>();
  const run = (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.push(args);
    if (args[0] !== 'get') return Promise.resolve({ stdout: 'applied\n', stderr: '' });
    const key = `${args[1]}/${args[2]}`;
    const seq = gets.get(key);
    if (!seq || seq.length === 0) return Promise.reject(Object.assign(new Error(`Error from server (NotFound): ${key} not found`), { code: 1 }));
    const r = seq.length > 1 ? seq.shift()! : seq[0];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve({ stdout: r, stderr: '' });
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

const MANIFEST = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: nginx
          image: nginx:1.27
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
spec:
  selector: { app: web }
  ports:
    - port: 80
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-conf
data:
  a: b
`;

// 直し回14：Deployment の ready には全体のレプリカ数（status.replicas）も要るので含める（実際の Deployment も返す項目）
const deploy = (available: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: 'Deployment', metadata: { name: 'web', generation: 1 }, spec: { replicas: 2 }, status: { observedGeneration: 1, replicas: 2, updatedReplicas: 2, availableReplicas: available, ...extra } });
const svcReady = JSON.stringify({ kind: 'Service', metadata: { name: 'web-svc' }, spec: { type: 'ClusterIP', clusterIP: '10.96.0.20' }, status: {} });
const cm = JSON.stringify({ kind: 'ConfigMap', metadata: { name: 'web-conf' }, data: { a: 'b' } });

function service() {
  const svc = new KubernetesService();
  const s = svc as unknown as { useMockMode: boolean; readinessWait: { attempts: number; intervalMs: number } };
  s.useMockMode = false;
  s.readinessWait = { attempts: 3, intervalMs: 0 };
  const updates: Session[] = [];
  svc.on('update', (x: Session) => updates.push(JSON.parse(JSON.stringify(x))));
  return { svc, updates };
}

describe('直し回13 推奨A：apply 後の確認失敗を ready・completed にしない', () => {
  beforeEach(() => {
    cp.calls.length = 0;
    cp.gets.clear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('get が失敗：そのリソースは error、セッションは error、applyManifest は失敗し、completed・ready を一度も出さない', async () => {
    cp.gets.set('Deployment/web', [Object.assign(new Error('Unable to connect to the server: dial tcp 127.0.0.1:6443: connect: connection refused'), { code: 1 })]);
    cp.gets.set('Service/web-svc', [svcReady]);
    cp.gets.set('ConfigMap/web-conf', [cm]);
    const { svc, updates } = service();
    await expect(svc.applyManifest(MANIFEST, 'demo')).rejects.toThrow(
      /適用後の確認で準備完了を確認できないリソースがあります（失敗：Deployment\/web: 適用後の状態を確認（kubectl get）できなかったため、準備完了とはみなしません（Unable to connect.*connection refused）／準備完了：Service\/web-svc／判定不能（存在のみ確認）：ConfigMap\/web-conf）/,
    );
    const last = updates[updates.length - 1];
    expect(last.status).toBe('error');
    expect(last.error).toMatch(/Deployment\/web/);
    expect(last.verification).toEqual({ ready: ['Service/web-svc'], unverified: ['ConfigMap/web-conf'], failed: ['Deployment/web'] });
    expect(last.resources.find((r) => r.kind === 'Deployment')).toMatchObject({ status: 'error' });
    expect(updates.some((u) => u.status === 'completed')).toBe(false);
    expect(updates.some((u) => u.resources.some((r) => r.kind === 'Deployment' && r.status === 'ready'))).toBe(false);
    // 失敗した get は取り直さない（失敗をそのまま表面化する）
    expect(cp.calls.filter((a) => a[0] === 'get' && a[1] === 'Deployment')).toHaveLength(1);
  });

  it('get の応答が JSON でない：確認できないとして失敗にする', async () => {
    cp.gets.set('Deployment/web', ['True']);
    cp.gets.set('Service/web-svc', [svcReady]);
    cp.gets.set('ConfigMap/web-conf', [cm]);
    const { svc } = service();
    await expect(svc.applyManifest(MANIFEST, 'demo')).rejects.toThrow(/Deployment\/web: 適用後の状態を確認（kubectl get）できなかったため.*JSON として読めませんでした/);
  });

  it('対象が見つからない（NotFound）も失敗にする', async () => {
    cp.gets.set('Service/web-svc', [svcReady]);
    cp.gets.set('ConfigMap/web-conf', [cm]);
    const { svc } = service();
    await expect(svc.applyManifest(MANIFEST, 'demo')).rejects.toThrow(/Deployment\/web: .*NotFound/);
  });

  it('正常な status：Deployment・Service は ready、ConfigMap は unverified（存在のみ確認）と明示し、セッションは completed', async () => {
    cp.gets.set('Deployment/web', [deploy(2)]);
    cp.gets.set('Service/web-svc', [svcReady]);
    cp.gets.set('ConfigMap/web-conf', [cm]);
    const { svc, updates } = service();
    const session = await svc.applyManifest(MANIFEST, 'demo');
    expect(session.status).toBe('completed');
    expect(session.resources.map((r) => `${r.kind}/${r.name}:${r.status}`)).toEqual(['Deployment/web:ready', 'Service/web-svc:ready', 'ConfigMap/web-conf:unverified']);
    expect(session.resources[2].detail).toBe('存在は確認しましたが、種別 ConfigMap の準備完了は判定できません（ready とはみなしません）');
    expect(session.verification).toEqual({ ready: ['Deployment/web', 'Service/web-svc'], unverified: ['ConfigMap/web-conf'], failed: [] });
    expect(updates[updates.length - 1].status).toBe('completed');
    expect(cp.calls.filter((a) => a[0] === 'get').map((a) => a.slice(1))).toEqual([
      ['Deployment', 'web', '-n', 'demo', '-o', 'json'],
      ['Service', 'web-svc', '-n', 'demo', '-o', 'json'],
      ['ConfigMap', 'web-conf', '-n', 'demo', '-o', 'json'],
    ]);
  });

  it('最初は準備中でも、取り直して準備完了になれば completed（準備中のリソースだけ取り直す）', async () => {
    cp.gets.set('Deployment/web', [deploy(0), deploy(1), deploy(2)]);
    cp.gets.set('Service/web-svc', [svcReady]);
    cp.gets.set('ConfigMap/web-conf', [cm]);
    const { svc } = service();
    const session = await svc.applyManifest(MANIFEST, 'demo');
    expect(session.status).toBe('completed');
    expect(session.resources[0]).toMatchObject({ status: 'ready', detail: 'desired 2／total 2／updated 2／available 2／unavailable 未報告' });
    expect(cp.calls.filter((a) => a[0] === 'get' && a[1] === 'Deployment')).toHaveLength(3);
    expect(cp.calls.filter((a) => a[0] === 'get' && a[1] === 'Service')).toHaveLength(1);
  });

  it('期限（試行回数）までに準備完了にならなければ失敗（ready・completed にしない）', async () => {
    cp.gets.set('Deployment/web', [deploy(1)]);
    cp.gets.set('Service/web-svc', [svcReady]);
    cp.gets.set('ConfigMap/web-conf', [cm]);
    const { svc, updates } = service();
    await expect(svc.applyManifest(MANIFEST, 'demo')).rejects.toThrow(/Deployment\/web: 3回確認しても準備完了になりませんでした（desired 2／total 2／updated 2／available 1／unavailable 未報告）/);
    expect(updates.some((u) => u.status === 'completed')).toBe(false);
  });

  it('失敗が確定した状態（ProgressDeadlineExceeded）は取り直さずに失敗', async () => {
    cp.gets.set('Deployment/web', [deploy(0, { conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: 'ReplicaSet "web-1" has timed out progressing.' }] })]);
    cp.gets.set('Service/web-svc', [svcReady]);
    cp.gets.set('ConfigMap/web-conf', [cm]);
    const { svc } = service();
    await expect(svc.applyManifest(MANIFEST, 'demo')).rejects.toThrow(/ロールアウトが期限内に進みませんでした/);
    expect(cp.calls.filter((a) => a[0] === 'get' && a[1] === 'Deployment')).toHaveLength(1);
  });
});

describe('直し回13 推奨A：種別ごとの準備完了の判定（k8s-readiness.ts）', () => {
  // 直し回14：判定の前に構造（kind・metadata.name・status・数値項目）を検証するので、metadata（name・generation）を補う。
  // コントローラ系は observedGeneration・全体のレプリカ数（status.replicas）等も ready の条件に入ったため、各例に含める。
  const st = (kind: string, obj: Record<string, unknown>) =>
    judgeReadiness(kind, { kind, ...obj, metadata: { name: 'x', generation: 1, ...(obj.metadata as object) } }).state;
  const ds = (s: Record<string, unknown>) => ({ status: { observedGeneration: 1, currentNumberScheduled: 3, numberReady: 3, numberMisscheduled: 0, ...s } });

  it('Deployment：全体・updated・available が desired と一致で ready。observedGeneration の遅れは pending', () => {
    expect(st('Deployment', { spec: { replicas: 3 }, status: { observedGeneration: 1, replicas: 3, updatedReplicas: 3, availableReplicas: 3 } })).toBe('ready');
    expect(st('Deployment', { spec: { replicas: 3 }, status: { observedGeneration: 1, replicas: 3, updatedReplicas: 3, availableReplicas: 2 } })).toBe('pending');
    // 直し回14（必須2）：spec.replicas の省略を 1 と補わない（API サーバーは必ず返す）→ 確認できない応答
    expect(st('Deployment', { spec: {}, status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1 } })).toBe('failed');
    expect(st('Deployment', { metadata: { generation: 2 }, spec: { replicas: 1 }, status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1 } })).toBe('pending');
    // 直し回14（必須2）：数が揃っていない 0 レプリカ（status が空）は ready にしない（observedGeneration 未報告で pending）
    expect(st('Deployment', { spec: { replicas: 0 }, status: {} })).toBe('pending');
  });

  it('StatefulSet・ReplicaSet・DaemonSet', () => {
    expect(st('StatefulSet', { spec: { replicas: 2 }, status: { observedGeneration: 1, replicas: 2, readyReplicas: 2, updatedReplicas: 2, availableReplicas: 2 } })).toBe('ready');
    expect(st('StatefulSet', { spec: { replicas: 2 }, status: { observedGeneration: 1, replicas: 2, readyReplicas: 1, updatedReplicas: 2, availableReplicas: 1 } })).toBe('pending');
    expect(st('ReplicaSet', { spec: { replicas: 2 }, status: { observedGeneration: 1, replicas: 2, readyReplicas: 2, availableReplicas: 2 } })).toBe('ready');
    expect(st('ReplicaSet', { spec: { replicas: 2 }, status: { observedGeneration: 1, replicas: 0 } })).toBe('pending');
    expect(st('DaemonSet', ds({ desiredNumberScheduled: 3, updatedNumberScheduled: 3, numberAvailable: 3 }))).toBe('ready');
    expect(st('DaemonSet', ds({ desiredNumberScheduled: 3, updatedNumberScheduled: 3, numberAvailable: 2 }))).toBe('pending');
    // 直し回14（必須2）：desiredNumberScheduled 等は 0 でも必ず返されるので、空の status は待たずに確認できない応答
    expect(st('DaemonSet', { status: {} })).toBe('failed');
  });

  it('Pod：Running かつ Ready True、または Succeeded で ready。Failed は failed。それ以外は pending', () => {
    expect(st('Pod', { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } })).toBe('ready');
    expect(st('Pod', { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] } })).toBe('pending');
    expect(st('Pod', { status: { phase: 'Pending' } })).toBe('pending');
    expect(st('Pod', { status: { phase: 'Succeeded' } })).toBe('ready');
    expect(st('Pod', { status: { phase: 'Failed' } })).toBe('failed');
  });

  it('Job・Service・PersistentVolumeClaim・Namespace', () => {
    expect(st('Job', { status: { conditions: [{ type: 'Complete', status: 'True' }] } })).toBe('ready');
    expect(st('Job', { status: { conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] } })).toBe('failed');
    expect(st('Job', { status: { active: 1 } })).toBe('pending');
    // 直し回14（必須2）：Service は spec.type（API サーバーが必ず補う）と status を必須にした。type 省略を ClusterIP と補わない
    expect(st('Service', { spec: { type: 'ClusterIP', clusterIP: '10.0.0.1' }, status: {} })).toBe('ready');
    expect(st('Service', { spec: { type: 'ClusterIP', clusterIP: 'None' }, status: {} })).toBe('ready'); // headless
    expect(st('Service', { spec: { type: 'ClusterIP' }, status: {} })).toBe('pending');
    expect(st('Service', { spec: { clusterIP: '10.0.0.1' }, status: {} })).toBe('failed');
    expect(st('Service', { spec: { type: 'LoadBalancer', clusterIP: '10.0.0.1' }, status: { loadBalancer: {} } })).toBe('pending');
    expect(st('Service', { spec: { type: 'LoadBalancer', clusterIP: '10.0.0.1' }, status: { loadBalancer: { ingress: [{ ip: '1.2.3.4' }] } } })).toBe('ready');
    expect(st('Service', { spec: { type: 'ExternalName', externalName: 'example.com' }, status: {} })).toBe('ready');
    expect(st('PersistentVolumeClaim', { status: { phase: 'Bound' } })).toBe('ready');
    expect(st('PersistentVolumeClaim', { status: { phase: 'Pending' } })).toBe('pending');
    expect(st('PersistentVolumeClaim', { status: { phase: 'Lost' } })).toBe('failed');
    expect(st('Namespace', { status: { phase: 'Active' } })).toBe('ready');
    expect(st('Namespace', { status: { phase: 'Terminating' } })).toBe('failed');
  });

  it('規則の無い種別は unverifiable（ready とはみなさない）。種別の食い違い・非オブジェクトは failed', () => {
    for (const kind of ['ConfigMap', 'Secret', 'ServiceAccount', 'Role', 'Ingress', 'MyCustomResource']) {
      expect(st(kind, { status: { conditions: [{ type: 'Ready', status: 'True' }] } }), kind).toBe('unverifiable');
    }
    expect(judgeReadiness('Deployment', { kind: 'Service' }).state).toBe('failed');
    expect(judgeReadiness('Deployment', null).state).toBe('failed');
    expect(judgeReadiness('Deployment', []).state).toBe('failed');
  });
});
