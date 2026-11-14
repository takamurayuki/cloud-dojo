/**
 * 直し回13（推奨A）：kubectl apply の後に `kubectl get <kind> <name> -o json` で取得したオブジェクトから、
 * リソース種別ごとに準備完了（ready）かを判定する。
 *
 * - ready：種別ごとの条件を満たした
 * - pending：まだ満たしていない（待てば満たす可能性がある）
 * - failed：失敗が確定した状態（Pod の Failed、Job の Failed 条件、Deployment の ProgressDeadlineExceeded 等）、
 *   または判定に使う構造が欠けている・型が不正な応答（確認できない応答）
 * - unverifiable：この種別には準備完了の判定規則が無い（存在だけ確認できた）。ready とはみなさない
 *
 * 直し回14：
 * - 判定の前に構造を検証する（必須2）。kind の一致・metadata.name（取得した名前との一致）・status オブジェクト・
 *   判定に使う数値項目の型を確かめ、欠落・不正な型は既定値で補わずに failed（確認できない応答）にする。
 *   - API サーバーが必ず返す項目（metadata.generation、spec.replicas、DaemonSet の desiredNumberScheduled 等）が
 *     欠けていれば failed。
 *   - Kubernetes が 0 のときに省略する（omitempty の）レプリカ数は、欠けていても failed にはしないが、
 *     0 と読み替えもしない。「未報告」として ready の根拠にせず、pending（期限切れで失敗）にする。
 *     値があるのに数値（0 以上の整数）でなければ failed。
 * - コントローラ系は Kubernetes の完了条件に合わせて厳密に判定する（必須1）。最新定義の反映
 *   （observedGeneration ≧ generation）、全体・更新済み・利用可能の数がすべて希望数と一致（旧レプリカが残っていない）、
 *   利用不可が 0 または未設定。
 *
 * 直し回15：
 * - 「省略（未報告）」として扱うのはキーが無い（undefined）ときだけ。明示的な null は数値・文字列・オブジェクト・配列・
 *   条件のいずれでも不正な型として failed（確認できない応答）にする（必須1）。
 * - LoadBalancer の ingress は要素ごとに検証する。ip または hostname が空でない文字列の要素が無ければ pending、
 *   要素の構造が不正なら failed（必須2）。
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

const JUDGED = new Set<string>(READINESS_KINDS);

// kubectl get が返す任意の JSON を読む（各値の型は使う箇所で確かめる）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

/** 判定に使う構造が欠けている・型が不正（確認できない応答） */
class MalformedResponse extends Error {}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown): string => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v) ?? String(v));

/**
 * 直し回15：省略（未報告）として扱うのはキーが無い（undefined）ときだけ。明示的な null は不正な型として
 * 確認できない応答にする。途中の階層も同じで、null や非オブジェクトの途中の値は読み飛ばさない。
 */
function get(obj: Obj, path: string): unknown {
  let cur: unknown = obj;
  let at = '';
  for (const key of path.split('.')) {
    if (cur === undefined) return undefined;
    if (!isObj(cur)) throw new MalformedResponse(`${at} がオブジェクトではありません（${show(cur)}）`);
    cur = cur[key];
    at = at ? `${at}.${key}` : key;
  }
  return cur;
}

const nullValue = (path: string) => new MalformedResponse(`${path} が null です（不正な型）`);

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** 必ず返される数値項目：欠落・null・不正な型は確認できない応答 */
function reqCount(obj: Obj, path: string): number {
  const v = get(obj, path);
  if (v === undefined) throw new MalformedResponse(`${path} がありません`);
  if (v === null) throw nullValue(path);
  if (!isCount(v)) throw new MalformedResponse(`${path} が 0 以上の整数ではありません（${show(v)}）`);
  return v;
}

/** 0 のとき省略されうる数値項目：キーが無ければ undefined（未報告）、null・不正な型は確認できない応答 */
function optCount(obj: Obj, path: string): number | undefined {
  const v = get(obj, path);
  if (v === undefined) return undefined;
  if (v === null) throw nullValue(path);
  if (!isCount(v)) throw new MalformedResponse(`${path} が 0 以上の整数ではありません（${show(v)}）`);
  return v;
}

/** 文字列の項目：キーが無ければ undefined、null・文字列以外は確認できない応答 */
function optString(obj: Obj, path: string): string | undefined {
  const v = get(obj, path);
  if (v === undefined) return undefined;
  if (v === null) throw nullValue(path);
  if (typeof v !== 'string') throw new MalformedResponse(`${path} が文字列ではありません（${show(v)}）`);
  return v;
}

/** オブジェクトの項目（必須）：欠落・null・オブジェクト以外は確認できない応答 */
function reqObject(obj: Obj, path: string): Obj {
  const v = get(obj, path);
  if (v === undefined) throw new MalformedResponse(`${path} がありません`);
  if (v === null) throw nullValue(path);
  if (!isObj(v)) throw new MalformedResponse(`${path} がオブジェクトではありません（${show(v)}）`);
  return v;
}

/** オブジェクトの項目（省略可）：キーが無ければ undefined、null・オブジェクト以外は確認できない応答 */
function optObject(obj: Obj, path: string): Obj | undefined {
  const v = get(obj, path);
  if (v === undefined) return undefined;
  if (v === null) throw nullValue(path);
  if (!isObj(v)) throw new MalformedResponse(`${path} がオブジェクトではありません（${show(v)}）`);
  return v;
}

/** 配列の項目（省略可）：キーが無ければ undefined、null・配列以外は確認できない応答 */
function optArray(obj: Obj, path: string): unknown[] | undefined {
  const v = get(obj, path);
  if (v === undefined) return undefined;
  if (v === null) throw nullValue(path);
  if (!Array.isArray(v)) throw new MalformedResponse(`${path} が配列ではありません（${show(v)}）`);
  return v;
}

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

/**
 * status.conditions から type の条件を探す。配列の全要素を検証する：要素がオブジェクトで、type・status が空でない文字列、
 * reason・message はキーがあれば文字列であること（null・不正な型は確認できない応答。読み飛ばさない）
 */
function condition(obj: Obj, type: string): Condition | undefined {
  const conds = optArray(obj, 'status.conditions');
  if (conds === undefined) return undefined;
  let found: Condition | undefined;
  conds.forEach((c, i) => {
    const at = `status.conditions[${i}]`;
    if (c === null) throw nullValue(at);
    if (!isObj(c)) throw new MalformedResponse(`${at} がオブジェクトではありません（${show(c)}）`);
    for (const key of ['type', 'status'] as const) {
      if (c[key] === undefined) throw new MalformedResponse(`${at}.${key} がありません`);
      if (c[key] === null) throw nullValue(`${at}.${key}`);
      if (typeof c[key] !== 'string' || !c[key]) throw new MalformedResponse(`${at}.${key} が空でない文字列ではありません（${show(c[key])}）`);
    }
    for (const key of ['reason', 'message'] as const) {
      if (c[key] === null) throw nullValue(`${at}.${key}`);
      if (c[key] !== undefined && typeof c[key] !== 'string') throw new MalformedResponse(`${at}.${key} が文字列ではありません（${show(c[key])}）`);
    }
    if (found === undefined && c.type === type) found = c as Condition;
  });
  return found;
}

/**
 * LoadBalancer の status.loadBalancer.ingress を検証し、有効な外部アドレス（ip または hostname が空でない文字列）を返す。
 * - 要素の構造が不正（null・オブジェクト以外・ip／hostname が null や文字列以外）：確認できない応答
 * - 構造は正しいが有効なアドレスが無い（[]、[{}]、ip が空文字等）：空配列（未割り当て）
 */
function lbAddresses(o: Obj): string[] {
  optObject(o, 'status.loadBalancer');
  const ingress = optArray(o, 'status.loadBalancer.ingress');
  if (ingress === undefined) return [];
  const addrs: string[] = [];
  ingress.forEach((e, i) => {
    const at = `status.loadBalancer.ingress[${i}]`;
    if (e === null) throw nullValue(at);
    if (!isObj(e)) throw new MalformedResponse(`${at} がオブジェクトではありません（${show(e)}）`);
    let addr: string | undefined;
    for (const key of ['ip', 'hostname'] as const) {
      const v = e[key];
      if (v === undefined) continue;
      if (v === null) throw nullValue(`${at}.${key}`);
      if (typeof v !== 'string') throw new MalformedResponse(`${at}.${key} が文字列ではありません（${show(v)}）`);
      if (v && addr === undefined) addr = v;
    }
    if (addr !== undefined) addrs.push(addr);
  });
  return addrs;
}

const n = (v: number | undefined): string => (v === undefined ? '未報告' : String(v));

/**
 * コントローラ系の共通部分：generation は必須、observedGeneration が無い・遅れていれば pending
 */
function generationLag(obj: Obj): ReadinessJudgement | undefined {
  const gen = reqCount(obj, 'metadata.generation');
  const observed = optCount(obj, 'status.observedGeneration');
  if (observed === undefined || observed < gen) {
    return { state: 'pending', detail: `コントローラが最新の定義を反映していません（generation ${gen}／observedGeneration ${n(observed)}）` };
  }
  return undefined;
}

/** すべての数が報告済みで、希望数と一致するか */
const allEqual = (desired: number, ...counts: (number | undefined)[]) => counts.every((c) => c === desired);
const noneUnavailable = (u: number | undefined) => u === undefined || u === 0;

function judgeKind(kind: string, o: Obj): ReadinessJudgement {
  switch (kind) {
    case 'Deployment': {
      reqObject(o, 'spec');
      const desired = reqCount(o, 'spec.replicas');
      reqCount(o, 'metadata.generation');
      const progressing = condition(o, 'Progressing');
      if (progressing?.reason === 'ProgressDeadlineExceeded') {
        return { state: 'failed', detail: `ロールアウトが期限内に進みませんでした（${progressing.message ?? 'ProgressDeadlineExceeded'}）` };
      }
      const total = optCount(o, 'status.replicas');
      const updated = optCount(o, 'status.updatedReplicas');
      const available = optCount(o, 'status.availableReplicas');
      const unavailable = optCount(o, 'status.unavailableReplicas');
      const lag = generationLag(o);
      if (lag) return lag;
      const detail = `desired ${desired}／total ${n(total)}／updated ${n(updated)}／available ${n(available)}／unavailable ${n(unavailable)}`;
      return allEqual(desired, total, updated, available) && noneUnavailable(unavailable)
        ? { state: 'ready', detail }
        : { state: 'pending', detail };
    }
    case 'StatefulSet': {
      reqObject(o, 'spec');
      const desired = reqCount(o, 'spec.replicas');
      const total = reqCount(o, 'status.replicas');
      const ready = optCount(o, 'status.readyReplicas');
      const updated = optCount(o, 'status.updatedReplicas');
      const available = optCount(o, 'status.availableReplicas');
      const lag = generationLag(o);
      if (lag) return lag;
      const detail = `desired ${desired}／total ${total}／updated ${n(updated)}／ready ${n(ready)}／available ${n(available)}`;
      return allEqual(desired, total, updated, ready, available) ? { state: 'ready', detail } : { state: 'pending', detail };
    }
    case 'ReplicaSet': {
      // ReplicaSet には更新済み（updatedReplicas）・利用不可の数が無い（テンプレートが1つなので旧レプリカの概念が無い）
      reqObject(o, 'spec');
      const desired = reqCount(o, 'spec.replicas');
      const total = reqCount(o, 'status.replicas');
      const ready = optCount(o, 'status.readyReplicas');
      const available = optCount(o, 'status.availableReplicas');
      const lag = generationLag(o);
      if (lag) return lag;
      const detail = `desired ${desired}／total ${total}／ready ${n(ready)}／available ${n(available)}`;
      return allEqual(desired, total, ready, available) ? { state: 'ready', detail } : { state: 'pending', detail };
    }
    case 'DaemonSet': {
      // desiredNumberScheduled・currentNumberScheduled・numberReady・numberMisscheduled は 0 でも省略されない
      const desired = reqCount(o, 'status.desiredNumberScheduled');
      const current = reqCount(o, 'status.currentNumberScheduled');
      reqCount(o, 'status.numberReady');
      reqCount(o, 'status.numberMisscheduled');
      const updated = optCount(o, 'status.updatedNumberScheduled');
      const available = optCount(o, 'status.numberAvailable');
      const unavailable = optCount(o, 'status.numberUnavailable');
      const lag = generationLag(o);
      if (lag) return lag;
      const detail = `desired ${desired}／current ${current}／updated ${n(updated)}／available ${n(available)}／unavailable ${n(unavailable)}`;
      return allEqual(desired, current, updated, available) && noneUnavailable(unavailable)
        ? { state: 'ready', detail }
        : { state: 'pending', detail };
    }
    case 'Pod': {
      const phase = optString(o, 'status.phase');
      const readyCond = condition(o, 'Ready');
      const reason = optString(o, 'status.reason');
      if (phase === 'Failed') return { state: 'failed', detail: `Pod が失敗しました（phase Failed${reason ? `／${reason}` : ''}）` };
      if (phase === 'Succeeded') return { state: 'ready', detail: 'phase Succeeded（正常終了）' };
      if (phase === 'Running' && readyCond?.status === 'True') return { state: 'ready', detail: 'phase Running／Ready True' };
      return { state: 'pending', detail: `phase ${phase ?? 'なし'}／Ready ${readyCond?.status ?? 'なし'}` };
    }
    case 'Job': {
      const failed = condition(o, 'Failed');
      if (failed?.status === 'True') return { state: 'failed', detail: `Job が失敗しました（${failed.reason ?? 'Failed'}${failed.message ? `：${failed.message}` : ''}）` };
      const complete = condition(o, 'Complete');
      const succeeded = optCount(o, 'status.succeeded');
      const active = optCount(o, 'status.active');
      if (complete?.status === 'True') return { state: 'ready', detail: 'Complete True（完了）' };
      return { state: 'pending', detail: `完了していません（succeeded ${n(succeeded)}／active ${n(active)}）` };
    }
    case 'Service': {
      // spec.type は API サーバーが必ず補う。欠けた応答を ClusterIP と読み替えない
      reqObject(o, 'spec');
      const type = optString(o, 'spec.type');
      if (type === undefined) throw new MalformedResponse('spec.type がありません');
      if (type === 'ExternalName') {
        const externalName = optString(o, 'spec.externalName');
        return externalName
          ? { state: 'ready', detail: `ExternalName ${externalName}` }
          : { state: 'failed', detail: 'ExternalName が設定されていません' };
      }
      if (type !== 'ClusterIP' && type !== 'NodePort' && type !== 'LoadBalancer') {
        throw new MalformedResponse(`spec.type が想定外の値です（${show(type)}）`);
      }
      const clusterIP = optString(o, 'spec.clusterIP');
      if (!clusterIP) return { state: 'pending', detail: `${type}：clusterIP がまだ割り当てられていません` };
      if (type === 'LoadBalancer') {
        const addrs = lbAddresses(o);
        return addrs.length > 0
          ? { state: 'ready', detail: `LoadBalancer：外部アドレス割り当て済み（${addrs.join('、')}／clusterIP ${clusterIP}）` }
          : { state: 'pending', detail: `LoadBalancer：外部アドレスがまだ割り当てられていません（clusterIP ${clusterIP}）` };
      }
      // ClusterIP・NodePort はアドレスの割り当てまでを判定する（宛先 Pod の有無＝Endpoints は判定に含めない）
      return { state: 'ready', detail: `${type}：clusterIP ${clusterIP}` };
    }
    case 'PersistentVolumeClaim': {
      const phase = optString(o, 'status.phase');
      if (phase === 'Bound') return { state: 'ready', detail: 'phase Bound' };
      if (phase === 'Lost') return { state: 'failed', detail: 'phase Lost（割り当て先のボリュームを失いました）' };
      return { state: 'pending', detail: `phase ${phase ?? 'なし'}` };
    }
    case 'Namespace': {
      const phase = optString(o, 'status.phase');
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

/**
 * @param kind 適用した種別
 * @param obj `kubectl get -o json` の応答
 * @param name 適用したリソース名（指定すれば metadata.name との一致も確かめる）
 */
export function judgeReadiness(kind: string, obj: unknown, name?: string): ReadinessJudgement {
  const malformed = (reason: string): ReadinessJudgement => ({
    state: 'failed',
    detail: `確認できない応答です（${reason}）。準備完了とはみなしません`,
  });
  if (!isObj(obj)) {
    return { state: 'failed', detail: '取得した内容がオブジェクトではないため、状態を確認できません' };
  }
  if (typeof obj.kind !== 'string' || !obj.kind) return malformed('kind がありません');
  if (obj.kind !== kind) {
    return { state: 'failed', detail: `取得した種別（${obj.kind}）が適用した種別（${kind}）と一致しないため、状態を確認できません` };
  }
  if (!isObj(obj.metadata)) return malformed('metadata がありません');
  if (typeof obj.metadata.name !== 'string' || !obj.metadata.name) return malformed('metadata.name がありません');
  if (name !== undefined && obj.metadata.name !== name) {
    return malformed(`取得した名前（${obj.metadata.name}）が適用したリソース名（${name}）と一致しません`);
  }
  try {
    if (JUDGED.has(kind)) reqObject(obj, 'status');
    return judgeKind(kind, obj);
  } catch (e) {
    if (e instanceof MalformedResponse) return malformed(e.message);
    throw e;
  }
}
