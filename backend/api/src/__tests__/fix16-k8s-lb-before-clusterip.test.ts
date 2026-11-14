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

/** clusterIP の有無を指定できる LoadBalancer の Service（clusterIP が undefined ならキーごと省く） */
const lbService = (loadBalancer: unknown, clusterIP?: string) =>
  JSON.stringify({
    kind: 'Service',
    metadata: { name: 'lb' },
    spec: { type: 'LoadBalancer', ...(clusterIP === undefined ? {} : { clusterIP }) },
    status: loadBalancer === undefined ? {} : { loadBalancer },
  });

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
const svcJudge = (spec: Record<string, unknown>, status: Record<string, unknown>) =>
  judgeReadiness('Service', { kind: 'Service', metadata: { name: 'lb' }, spec, status }, 'lb');

/** clusterIP 無し（キー無し・空文字）の2通り */
const NO_CLUSTER_IP: [string, Record<string, unknown>][] = [
  ['キー無し', {}],
  ['空文字', { clusterIP: '' }],
];
/** 再レビュー15の実測3例を含む不正な構造 */
const MALFORMED: [unknown, RegExp][] = [
  [null, /status\.loadBalancer が null です/],
  ['x', /status\.loadBalancer がオブジェクトではありません/],
  [{ ingress: null }, /status\.loadBalancer\.ingress が null です/],
  [{ ingress: [null] }, /status\.loadBalancer\.ingress\[0\] が null です/],
  [{ ingress: [{ ip: 1 }] }, /status\.loadBalancer\.ingress\[0\]\.ip が文字列ではありません/],
];

beforeEach(() => {
  cp.calls.length = 0;
  cp.gets.clear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('直し回16 必須：LoadBalancer の構造検証を clusterIP の判定より先に行う', () => {
  it('clusterIP 無し＋不正な loadBalancer 構造は pending にせず failed（単体：再レビュー15の3例を含む）', () => {
    for (const [label, spec] of NO_CLUSTER_IP) {
      for (const [lb, reason] of MALFORMED) {
        const r = svcJudge({ type: 'LoadBalancer', ...spec }, { loadBalancer: lb });
        expect(r.state, `${label} ${JSON.stringify(lb)}`).toBe('failed');
        expect(r.detail, `${label} ${JSON.stringify(lb)}`).toMatch(reason);
      }
    }
  });

  for (const [lb, reason] of MALFORMED.filter(([v]) => v === null || JSON.stringify(v).includes('ingress":[')) as [unknown, RegExp][]) {
    it(`clusterIP 無し＋${JSON.stringify(lb)} は取り直さずに即失敗する（apply 経路）`, async () => {
      // 再レビューの再現手順：初回は不正な構造、2回目は正常な応答。初回で失敗し、2回目は取りに行かない
      cp.gets.set('Service/lb', [lbService(lb), lbService({ ingress: [{ ip: '203.0.113.5' }] }, '10.0.0.9')]);
      const { svc, updates } = service();
      await expect(svc.applyManifest(lbManifest, 'demo')).rejects.toThrow(new RegExp(`Service/lb: .*確認できない応答です（.*${reason.source}`));
      expect(gets('Service')).toBe(1);
      const last = lastOf(updates);
      expect(last.status).toBe('error');
      expect(last.verification).toEqual({ ready: [], unverified: [], failed: ['Service/lb'] });
      neverReady(updates);
    });
  }

  it('clusterIP 無し＋正常な構造（アドレス未割り当て）は pending（単体）', () => {
    for (const [label, spec] of NO_CLUSTER_IP) {
      for (const lb of [undefined, {}, { ingress: [] }, { ingress: [{}] }, { ingress: [{ ip: '' }] }]) {
        const r = svcJudge({ type: 'LoadBalancer', ...spec }, lb === undefined ? {} : { loadBalancer: lb });
        expect(r, `${label} ${JSON.stringify(lb)}`).toEqual({ state: 'pending', detail: 'LoadBalancer：clusterIP がまだ割り当てられていません' });
      }
      // 構造が正常でアドレスがあっても、clusterIP が未割り当てなら ready にはしない（従来どおり）
      expect(svcJudge({ type: 'LoadBalancer', ...spec }, { loadBalancer: { ingress: [{ ip: '203.0.113.5' }] } }).state).toBe('pending');
    }
  });

  it('clusterIP 無し＋正常な構造は pending のまま期限切れで失敗する（apply 経路）', async () => {
    cp.gets.set('Service/lb', [lbService({ ingress: [{}] })]);
    const { svc, updates } = service();
    await expect(svc.applyManifest(lbManifest, 'demo')).rejects.toThrow(
      /Service\/lb: 3回確認しても準備完了になりませんでした（LoadBalancer：clusterIP がまだ割り当てられていません/,
    );
    expect(gets('Service')).toBe(3);
    const last = lastOf(updates);
    expect(last.status).toBe('error');
    expect(last.verification).toEqual({ ready: [], unverified: [], failed: ['Service/lb'] });
    neverReady(updates);
  });

  it('clusterIP・外部アドレスの割り当て後に ready になる（apply 経路）', async () => {
    cp.gets.set('Service/lb', [
      lbService({ ingress: [{}] }),
      lbService({ ingress: [{}] }, '10.0.0.9'),
      lbService({ ingress: [{ ip: '203.0.113.5' }] }, '10.0.0.9'),
    ]);
    const { svc } = service();
    const session = await svc.applyManifest(lbManifest, 'demo');
    expect(session.status).toBe('completed');
    expect(session.resources[0]).toMatchObject({ status: 'ready', detail: 'LoadBalancer：外部アドレス割り当て済み（203.0.113.5／clusterIP 10.0.0.9）' });
    expect(gets('Service')).toBe(3);
  });

  it('他タイプの判定は広げない：ClusterIP・NodePort・ExternalName は status.loadBalancer を見ない', () => {
    for (const type of ['ClusterIP', 'NodePort']) {
      // status.loadBalancer を判定に使わないタイプでは、その中身が不正でも従来どおり
      expect(svcJudge({ type, clusterIP: '10.0.0.1' }, { loadBalancer: { ingress: [null] } })).toEqual({ state: 'ready', detail: `${type}：clusterIP 10.0.0.1` });
      expect(svcJudge({ type }, { loadBalancer: { ingress: [null] } }).state).toBe('pending');
    }
    expect(svcJudge({ type: 'ExternalName', externalName: 'db.example.test' }, { loadBalancer: { ingress: [null] } }).state).toBe('ready');
  });
});
