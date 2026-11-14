/**
 * 直し回13（推奨A）：kubectl apply の後に `kubectl get <kind> <name> -o json` で取得したオブジェクトから、
 * リソース種別ごとに準備完了（ready）かを判定する。
 *
 * - ready：種別ごとの条件を満たした
 * - pending：まだ満たしていない（待てば満たす可能性がある）
 * - failed：失敗が確定した状態（Pod の Failed、Job の Failed 条件、Deployment の ProgressDeadlineExceeded 等）
 * - unverifiable：この種別には準備完了の判定規則が無い（存在だけ確認できた）。ready とはみなさない
 */

export type ReadinessState = 'ready' | 'pending' | 'failed' | 'unverifiable';

export interface ReadinessJudgement {
  state: ReadinessState;
  detail: string;
}

/** 準備完了を判定できる種別（これ以外は unverifiable） */
export const READINESS_KINDS = [
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'Pod',
  'Job',
  'Service',
  'PersistentVolumeClaim',
  'Namespace',
] as const;

// kubectl get が返す任意の JSON を読む（各値の型は使う箇所で確かめる）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function condition(obj: Obj, type: string): Obj | undefined {
  const conds = obj?.status?.conditions;
  if (!Array.isArray(conds)) return undefined;
  return conds.find((c) => c && typeof c === 'object' && c.type === type);
}

/** コントローラが最新の spec をまだ見ていなければ pending を返す */
function generationLag(obj: Obj): ReadinessJudgement | undefined {
  const gen = obj?.metadata?.generation;
  const observed = obj?.status?.observedGeneration;
  if (typeof gen === 'number' && (typeof observed !== 'number' || observed < gen)) {
    return { state: 'pending', detail: `コントローラが最新の定義を反映していません（generation ${gen}／observedGeneration ${observed ?? 'なし'}）` };
  }
  return undefined;
}

function replicas(obj: Obj): number {
  const r = obj?.spec?.replicas;
  return typeof r === 'number' && Number.isFinite(r) ? r : 1;
}

export function judgeReadiness(kind: string, obj: unknown): ReadinessJudgement {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { state: 'failed', detail: '取得した内容がオブジェクトではないため、状態を確認できません' };
  }
  const o = obj as Obj;
  if (typeof o.kind === 'string' && o.kind !== kind) {
    return { state: 'failed', detail: `取得した種別（${o.kind}）が適用した種別（${kind}）と一致しないため、状態を確認できません` };
  }

  switch (kind) {
    case 'Deployment': {
      const progressing = condition(o, 'Progressing');
      if (progressing?.reason === 'ProgressDeadlineExceeded') {
        return { state: 'failed', detail: `ロールアウトが期限内に進みませんでした（${progressing.message ?? 'ProgressDeadlineExceeded'}）` };
      }
      const lag = generationLag(o);
      if (lag) return lag;
      const desired = replicas(o);
      const updated = num(o.status?.updatedReplicas);
      const available = num(o.status?.availableReplicas);
      const detail = `desired ${desired}／updated ${updated}／available ${available}`;
      return updated >= desired && available >= desired ? { state: 'ready', detail } : { state: 'pending', detail };
    }
    case 'StatefulSet': {
      const lag = generationLag(o);
      if (lag) return lag;
      const desired = replicas(o);
      const ready = num(o.status?.readyReplicas);
      const updated = num(o.status?.updatedReplicas);
      const detail = `desired ${desired}／updated ${updated}／ready ${ready}`;
      return ready >= desired && updated >= desired ? { state: 'ready', detail } : { state: 'pending', detail };
    }
    case 'ReplicaSet': {
      const lag = generationLag(o);
      if (lag) return lag;
      const desired = replicas(o);
      const available = num(o.status?.availableReplicas);
      const detail = `desired ${desired}／available ${available}`;
      return available >= desired ? { state: 'ready', detail } : { state: 'pending', detail };
    }
    case 'DaemonSet': {
      const lag = generationLag(o);
      if (lag) return lag;
      if (typeof o.status?.desiredNumberScheduled !== 'number') {
        return { state: 'pending', detail: '配置先ノード数（desiredNumberScheduled）がまだ決まっていません' };
      }
      const desired = num(o.status.desiredNumberScheduled);
      const updated = num(o.status.updatedNumberScheduled);
      const available = num(o.status.numberAvailable);
      const detail = `desired ${desired}／updated ${updated}／available ${available}`;
      return updated >= desired && available >= desired ? { state: 'ready', detail } : { state: 'pending', detail };
    }
    case 'Pod': {
      const phase = o.status?.phase;
      if (phase === 'Failed') return { state: 'failed', detail: `Pod が失敗しました（phase Failed${o.status?.reason ? `／${o.status.reason}` : ''}）` };
      if (phase === 'Succeeded') return { state: 'ready', detail: 'phase Succeeded（正常終了）' };
      const readyCond = condition(o, 'Ready');
      if (phase === 'Running' && readyCond?.status === 'True') return { state: 'ready', detail: 'phase Running／Ready True' };
      return { state: 'pending', detail: `phase ${phase ?? 'なし'}／Ready ${readyCond?.status ?? 'なし'}` };
    }
    case 'Job': {
      const failed = condition(o, 'Failed');
      if (failed?.status === 'True') return { state: 'failed', detail: `Job が失敗しました（${failed.reason ?? 'Failed'}${failed.message ? `：${failed.message}` : ''}）` };
      const complete = condition(o, 'Complete');
      if (complete?.status === 'True') return { state: 'ready', detail: 'Complete True（完了）' };
      return { state: 'pending', detail: `完了していません（succeeded ${num(o.status?.succeeded)}／active ${num(o.status?.active)}）` };
    }
    case 'Service': {
      const type = o.spec?.type ?? 'ClusterIP';
      if (type === 'ExternalName') {
        return typeof o.spec?.externalName === 'string' && o.spec.externalName
          ? { state: 'ready', detail: `ExternalName ${o.spec.externalName}` }
          : { state: 'failed', detail: 'ExternalName が設定されていません' };
      }
      const clusterIP = o.spec?.clusterIP;
      if (typeof clusterIP !== 'string' || !clusterIP) return { state: 'pending', detail: `${type}：clusterIP がまだ割り当てられていません` };
      if (type === 'LoadBalancer') {
        const ingress = o.status?.loadBalancer?.ingress;
        return Array.isArray(ingress) && ingress.length > 0
          ? { state: 'ready', detail: `LoadBalancer：外部アドレス割り当て済み（clusterIP ${clusterIP}）` }
          : { state: 'pending', detail: `LoadBalancer：外部アドレスがまだ割り当てられていません（clusterIP ${clusterIP}）` };
      }
      // ClusterIP・NodePort はアドレスの割り当てまでを判定する（宛先 Pod の有無＝Endpoints は判定に含めない）
      return { state: 'ready', detail: `${type}：clusterIP ${clusterIP}` };
    }
    case 'PersistentVolumeClaim': {
      const phase = o.status?.phase;
      if (phase === 'Bound') return { state: 'ready', detail: 'phase Bound' };
      if (phase === 'Lost') return { state: 'failed', detail: 'phase Lost（割り当て先のボリュームを失いました）' };
      return { state: 'pending', detail: `phase ${phase ?? 'なし'}` };
    }
    case 'Namespace': {
      const phase = o.status?.phase;
      if (phase === 'Active') return { state: 'ready', detail: 'phase Active' };
      if (phase === 'Terminating') return { state: 'failed', detail: 'phase Terminating（削除中）' };
      return { state: 'pending', detail: `phase ${phase ?? 'なし'}` };
    }
    default:
      return {
        state: 'unverifiable',
        detail: `存在は確認しましたが、種別 ${kind} の準備完了は判定できません（ready とはみなしません）`,
      };
  }
}
