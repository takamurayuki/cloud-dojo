/**
 * 直し回14：Kubernetes の apply 後の準備完了判定を厳密にする。
 * - 必須1：更新途中（利用可能数が旧レプリカ由来）の Deployment 等を ready にしない。期限までに完了しなければ失敗
 * - 必須2：構造が欠けた応答（kind・metadata・status の欠落、数値項目の欠落・不正な型）を既定値で補って ready にしない
 * child_process はスタブに差し替える（実際の kubectl は実行しない）。キューは Redis を使うため差し替える。
 */
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

const manifest = (replicas: number) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: ${replicas}
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: nginx
          image: nginx:1.27
`;

type Status = Record<string, unknown>;
const deployment = (desired: number, status: Status, generation = 2) =>
  JSON.stringify({ kind: 'Deployment', metadata: { name: 'web', generation }, spec: { replicas: desired }, status: { observedGeneration: generation, ...status } });

/** 再レビュー13回目の実測例：旧 Pod が利用可能、新 Pod が未準備（利用可能数が旧レプリカ由来） */
const MID_ROLLOUT = deployment(1, { replicas: 2, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1, unavailableReplicas: 1 });
/** 更新完了：旧レプリカが無く、全体・更新済み・利用可能が希望数と一致 */
const ROLLED_OUT = deployment(1, { replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 });

function service() {
  const svc = new KubernetesService();
  const s = svc as unknown as { useMockMode: boolean; readinessWait: { attempts: number; intervalMs: number } };
  s.useMockMode = false;
  s.readinessWait = { attempts: 3, intervalMs: 0 };
  const updates: Session[] = [];
  svc.on('update', (x: Session) => updates.push(JSON.parse(JSON.stringify(x))));
  return { svc, updates };
}

const deploymentGets = () => cp.calls.filter((a) => a[0] === 'get' && a[1] === 'Deployment').length;
const neverReady = (updates: Session[]) => {
  expect(updates.some((u) => u.status === 'completed')).toBe(false);
  expect(updates.some((u) => u.resources.some((r) => r.status === 'ready'))).toBe(false);
  expect(updates.some((u) => u.resources.some((r) => r.status === 'unverified'))).toBe(false);
};

beforeEach(() => {
  cp.calls.length = 0;
  cp.gets.clear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('直し回14 必須1：更新途中の Deployment を準備完了にしない', () => {
  it('利用可能数が旧レプリカ由来（全体2／更新済み1／利用可能1／利用不可1）の間は pending のまま、期限切れで失敗する', async () => {
    cp.gets.set('Deployment/web', [MID_ROLLOUT]);
    const { svc, updates } = service();
    await expect(svc.applyManifest(manifest(1), 'demo')).rejects.toThrow(
      /Deployment\/web: 3回確認しても準備完了になりませんでした（desired 1／total 2／updated 1／available 1／unavailable 1）/,
    );
    expect(deploymentGets()).toBe(3);
    const last = updates[updates.length - 1];
    expect(last.status).toBe('error');
    expect(last.verification).toEqual({ ready: [], unverified: [], failed: ['Deployment/web'] });
    neverReady(updates);
  });

  it('更新途中から更新完了に進めば ready・completed になる', async () => {
    cp.gets.set('Deployment/web', [MID_ROLLOUT, ROLLED_OUT]);
    const { svc } = service();
    const session = await svc.applyManifest(manifest(1), 'demo');
    expect(session.status).toBe('completed');
    expect(session.resources[0]).toMatchObject({ status: 'ready', detail: 'desired 1／total 1／updated 1／available 1／unavailable 未報告' });
    expect(deploymentGets()).toBe(2);
  });

  it('完了条件の1つでも欠ければ pending（旧レプリカ残り・利用不可あり・更新済み不足・定義未反映）', () => {
    const j = (s: Status, gen?: { generation: number; observed: number }) =>
      judgeReadiness(
        'Deployment',
        { kind: 'Deployment', metadata: { name: 'web', generation: gen?.generation ?? 1 }, spec: { replicas: 2 }, status: { observedGeneration: gen?.observed ?? 1, ...s } },
        'web',
      ).state;
    const done = { replicas: 2, updatedReplicas: 2, availableReplicas: 2 };
    expect(j(done)).toBe('ready');
    expect(j({ ...done, unavailableReplicas: 0 })).toBe('ready');
    expect(j({ ...done, replicas: 3 })).toBe('pending'); // 旧レプリカが残っている
    expect(j({ ...done, unavailableReplicas: 1 })).toBe('pending');
    expect(j({ ...done, updatedReplicas: 1 })).toBe('pending'); // available は旧レプリカ由来
    expect(j({ ...done, availableReplicas: 1 })).toBe('pending');
    expect(j(done, { generation: 3, observed: 2 })).toBe('pending'); // 最新の定義を未反映
    // 0 のとき省略されうる数（omitempty）は、欠けていても 0 と読み替えず ready にしない
    expect(j({ replicas: 2, updatedReplicas: 2 })).toBe('pending');
    expect(j({ updatedReplicas: 2, availableReplicas: 2 })).toBe('pending');
  });

  it('StatefulSet・ReplicaSet・DaemonSet も、全体・更新済み・利用可能が希望数と一致するまで pending', () => {
    const meta = { name: 'x', generation: 1 };
    const sts = (s: Status) => judgeReadiness('StatefulSet', { kind: 'StatefulSet', metadata: meta, spec: { replicas: 2 }, status: { observedGeneration: 1, ...s } }).state;
    const stsDone = { replicas: 2, readyReplicas: 2, updatedReplicas: 2, availableReplicas: 2 };
    expect(sts(stsDone)).toBe('ready');
    expect(sts({ ...stsDone, updatedReplicas: 1 })).toBe('pending'); // ready・available は旧リビジョン由来
    expect(sts({ ...stsDone, replicas: 3 })).toBe('pending');
    expect(sts({ ...stsDone, availableReplicas: 1 })).toBe('pending');

    const rs = (s: Status) => judgeReadiness('ReplicaSet', { kind: 'ReplicaSet', metadata: meta, spec: { replicas: 2 }, status: { observedGeneration: 1, ...s } }).state;
    expect(rs({ replicas: 2, readyReplicas: 2, availableReplicas: 2 })).toBe('ready');
    expect(rs({ replicas: 3, readyReplicas: 2, availableReplicas: 2 })).toBe('pending'); // 縮小途中
    expect(rs({ replicas: 2, readyReplicas: 2, availableReplicas: 1 })).toBe('pending');

    const dsBase = { observedGeneration: 1, desiredNumberScheduled: 3, currentNumberScheduled: 3, numberReady: 3, numberMisscheduled: 0 };
    const ds = (s: Status) => judgeReadiness('DaemonSet', { kind: 'DaemonSet', metadata: meta, spec: {}, status: { ...dsBase, ...s } }).state;
    expect(ds({ updatedNumberScheduled: 3, numberAvailable: 3 })).toBe('ready');
    expect(ds({ updatedNumberScheduled: 2, numberAvailable: 3, numberUnavailable: 1 })).toBe('pending'); // available は旧 Pod 由来
    expect(ds({ updatedNumberScheduled: 2, numberAvailable: 3 })).toBe('pending');
    expect(ds({ updatedNumberScheduled: 3, numberAvailable: 3, numberUnavailable: 1 })).toBe('pending');
    expect(ds({ currentNumberScheduled: 2, updatedNumberScheduled: 3, numberAvailable: 3 })).toBe('pending');
    expect(ds({ observedGeneration: 0, updatedNumberScheduled: 3, numberAvailable: 3 })).toBe('pending');
  });
});

describe('直し回14 必須2：構造が欠けた応答を既定値で準備完了にしない', () => {
  const failsAtOnce = async (body: string, reason: RegExp, replicas = 0) => {
    cp.gets.set('Deployment/web', [body]);
    const { svc, updates } = service();
    await expect(svc.applyManifest(manifest(replicas), 'demo')).rejects.toThrow(reason);
    // 確認できない応答は待っても変わらないものとして、取り直さずに失敗（error）にする
    expect(deploymentGets()).toBe(1);
    const last = updates[updates.length - 1];
    expect(last.status).toBe('error');
    expect(last.resources[0].status).toBe('error');
    expect(last.verification).toEqual({ ready: [], unverified: [], failed: ['Deployment/web'] });
    neverReady(updates);
  };

  it('再レビューの実測例 {"spec":{"replicas":0}}（kind・metadata・status なし）は失敗', async () => {
    await failsAtOnce('{"spec":{"replicas":0}}', /Deployment\/web: 確認できない応答です（kind がありません）/);
  });

  it('metadata・metadata.name の欠落、名前の食い違いは失敗', async () => {
    const full = { spec: { replicas: 0 }, status: { observedGeneration: 1, replicas: 0, updatedReplicas: 0, availableReplicas: 0 } };
    await failsAtOnce(JSON.stringify({ kind: 'Deployment', ...full }), /確認できない応答です（metadata がありません）/);
    cp.calls.length = 0;
    await failsAtOnce(JSON.stringify({ kind: 'Deployment', metadata: { generation: 1 }, ...full }), /確認できない応答です（metadata.name がありません）/);
    cp.calls.length = 0;
    await failsAtOnce(JSON.stringify({ kind: 'Deployment', metadata: { name: 'other', generation: 1 }, ...full }), /取得した名前（other）が適用したリソース名（web）と一致しません/);
  });

  it('status の欠落・オブジェクトでない status は失敗', async () => {
    await failsAtOnce(JSON.stringify({ kind: 'Deployment', metadata: { name: 'web', generation: 1 }, spec: { replicas: 0 } }), /確認できない応答です（status がありません）/);
    cp.calls.length = 0;
    await failsAtOnce(JSON.stringify({ kind: 'Deployment', metadata: { name: 'web', generation: 1 }, spec: { replicas: 0 }, status: 'ok' }), /status がオブジェクトではありません/);
  });

  it('数値項目が文字列・負数・小数なら失敗', async () => {
    await failsAtOnce(deployment(1, { replicas: 1, updatedReplicas: 1, availableReplicas: '1' }), /status.availableReplicas が 0 以上の整数ではありません（"1"）/, 1);
    cp.calls.length = 0;
    await failsAtOnce(deployment(1, { replicas: -1, updatedReplicas: 1, availableReplicas: 1 }), /status.replicas が 0 以上の整数ではありません（-1）/, 1);
    cp.calls.length = 0;
    await failsAtOnce(
      JSON.stringify({ kind: 'Deployment', metadata: { name: 'web', generation: 1 }, spec: { replicas: '1' }, status: { observedGeneration: 1, replicas: 1 } }),
      /spec.replicas が 0 以上の整数ではありません（"1"）/,
      1,
    );
    cp.calls.length = 0;
    await failsAtOnce(deployment(1, { observedGeneration: 1.5, replicas: 1, updatedReplicas: 1, availableReplicas: 1 }), /status.observedGeneration が 0 以上の整数ではありません/, 1);
  });

  it('必ず返される数値項目（spec.replicas・metadata.generation）の欠落は失敗（1 や 0 と補わない）', async () => {
    await failsAtOnce(
      JSON.stringify({ kind: 'Deployment', metadata: { name: 'web', generation: 1 }, spec: {}, status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1 } }),
      /確認できない応答です（spec.replicas がありません）/,
      1,
    );
    cp.calls.length = 0;
    await failsAtOnce(
      JSON.stringify({ kind: 'Deployment', metadata: { name: 'web' }, spec: { replicas: 0 }, status: { replicas: 0, updatedReplicas: 0, availableReplicas: 0 } }),
      /確認できない応答です（metadata.generation がありません）/,
    );
  });

  it('0 のとき省略されうる数（availableReplicas 等）の欠落は ready にせず、期限切れで失敗', async () => {
    cp.gets.set('Deployment/web', [deployment(1, { replicas: 1, updatedReplicas: 1 })]);
    const { svc, updates } = service();
    await expect(svc.applyManifest(manifest(1), 'demo')).rejects.toThrow(/3回確認しても準備完了になりませんでした（desired 1／total 1／updated 1／available 未報告／unavailable 未報告）/);
    neverReady(updates);
  });

  it('正常な 0 レプリカ（spec.replicas=0 が明示され、status の数が揃っている）は ready・completed', async () => {
    cp.gets.set('Deployment/web', [deployment(0, { replicas: 0, updatedReplicas: 0, readyReplicas: 0, availableReplicas: 0 }, 1)]);
    const { svc } = service();
    const session = await svc.applyManifest(manifest(0), 'demo');
    expect(session.status).toBe('completed');
    expect(session.resources[0]).toMatchObject({ status: 'ready', detail: 'desired 0／total 0／updated 0／available 0／unavailable 未報告' });
    expect(session.verification).toEqual({ ready: ['Deployment/web'], unverified: [], failed: [] });
  });

  it('他の判定対象種別も、判定に使う項目の欠落・不正な型を補わずに失敗にする', () => {
    const j = (kind: string, rest: Record<string, unknown>) => judgeReadiness(kind, { kind, metadata: { name: 'x', generation: 1 }, ...rest }, 'x');
    const failed = (kind: string, rest: Record<string, unknown>, reason: RegExp) => {
      const r = j(kind, rest);
      expect(r.state, `${kind} ${JSON.stringify(rest)}`).toBe('failed');
      expect(r.detail).toMatch(reason);
    };
    // status の欠落（判定対象の全種別）
    for (const kind of ['Deployment', 'StatefulSet', 'ReplicaSet', 'DaemonSet', 'Pod', 'Job', 'Service', 'PersistentVolumeClaim', 'Namespace']) {
      failed(kind, { spec: { replicas: 1, type: 'ClusterIP', clusterIP: '10.0.0.1' } }, /status がありません/);
    }
    // StatefulSet・ReplicaSet：status.replicas（0 でも返される）の欠落
    failed('StatefulSet', { spec: { replicas: 0 }, status: { observedGeneration: 1 } }, /status.replicas がありません/);
    failed('ReplicaSet', { spec: { replicas: 0 }, status: { observedGeneration: 1 } }, /status.replicas がありません/);
    // DaemonSet：desiredNumberScheduled 等の欠落・文字列
    failed('DaemonSet', { status: { observedGeneration: 1, currentNumberScheduled: 0, numberReady: 0, numberMisscheduled: 0 } }, /status.desiredNumberScheduled がありません/);
    failed('DaemonSet', { status: { observedGeneration: 1, desiredNumberScheduled: '3', currentNumberScheduled: 3, numberReady: 3, numberMisscheduled: 0 } }, /desiredNumberScheduled が 0 以上の整数ではありません/);
    // Pod・PVC・Namespace：phase が文字列でない、conditions が配列でない
    failed('Pod', { status: { phase: 1 } }, /status.phase が文字列ではありません/);
    failed('Pod', { status: { phase: 'Running', conditions: { Ready: 'True' } } }, /status.conditions が配列ではありません/);
    failed('PersistentVolumeClaim', { status: { phase: ['Bound'] } }, /status.phase が文字列ではありません/);
    failed('Namespace', { status: { phase: true } }, /status.phase が文字列ではありません/);
    // Job：conditions が配列でない、数が文字列
    failed('Job', { status: { conditions: 'Complete' } }, /status.conditions が配列ではありません/);
    failed('Job', { status: { succeeded: '1' } }, /status.succeeded が 0 以上の整数ではありません/);
    // Service：spec・spec.type の欠落（ClusterIP と補わない）、想定外の type、型の不正
    failed('Service', { status: {} }, /spec がありません/);
    failed('Service', { spec: { clusterIP: '10.0.0.1' }, status: {} }, /spec.type がありません/);
    failed('Service', { spec: { type: 'Bogus', clusterIP: '10.0.0.1' }, status: {} }, /spec.type が想定外の値です/);
    failed('Service', { spec: { type: 'ClusterIP', clusterIP: 1 }, status: {} }, /spec.clusterIP が文字列ではありません/);
    failed('Service', { spec: { type: 'LoadBalancer', clusterIP: '10.0.0.1' }, status: { loadBalancer: { ingress: 'x' } } }, /ingress が配列ではありません/);
    // 判定規則の無い種別も、kind・metadata.name が欠けた応答は unverified にせず失敗
    expect(judgeReadiness('ConfigMap', { kind: 'ConfigMap', metadata: { name: 'x' }, data: {} }, 'x').state).toBe('unverifiable');
    expect(judgeReadiness('ConfigMap', { metadata: { name: 'x' }, data: {} }, 'x').state).toBe('failed');
    expect(judgeReadiness('ConfigMap', { kind: 'ConfigMap', data: {} }, 'x').state).toBe('failed');
    expect(judgeReadiness('ConfigMap', { kind: 'ConfigMap', metadata: { name: 'y' } }, 'x').state).toBe('failed');
  });

  it('構造が揃った正常な応答は、他の種別でも従来どおり ready', () => {
    const j = (kind: string, rest: Record<string, unknown>) => judgeReadiness(kind, { kind, metadata: { name: 'x', generation: 1 }, ...rest }, 'x').state;
    expect(j('Pod', { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } })).toBe('ready');
    expect(j('Job', { status: { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] } })).toBe('ready');
    expect(j('Service', { spec: { type: 'NodePort', clusterIP: '10.0.0.1' }, status: { loadBalancer: {} } })).toBe('ready');
    expect(j('PersistentVolumeClaim', { status: { phase: 'Bound' } })).toBe('ready');
    expect(j('Namespace', { status: { phase: 'Active' } })).toBe('ready');
    expect(j('DaemonSet', { status: { observedGeneration: 1, desiredNumberScheduled: 0, currentNumberScheduled: 0, numberReady: 0, numberMisscheduled: 0, updatedNumberScheduled: 0, numberAvailable: 0 } })).toBe('ready');
  });
});
