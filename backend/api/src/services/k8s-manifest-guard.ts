/**
 * 直し回6（必須3）：Kubernetes の apply で、ノード（ホスト）を操作できる設定を含むマニフェストを拒否する。
 *
 * 以前の検証（k8s-args.ts の validateManifestDocs）は kind・名前・namespace だけで、`hostPath: /var/run/docker.sock`・
 * `privileged: true`・`hostPID: true` を含む Pod がそのまま kubectl apply に渡っていた。同じ Docker を使うノードで動けば、
 * compose で塞いだのと同じ種類の迂回（ソケット経由でラボを含むホストのコンテナを操作する）になる。
 *
 * 拒否するもの（compose の検査 services/compose-guard.ts と同じ基準）：
 * 1. volumes[].hostPath.path が Docker ソケット、またはそれを含む親ディレクトリ（compose・既存コンテナの Mounts と同じ
 *    共有関数 dockerSocketReason で判定。/、/run、/var/run、名前 docker.sock、`\`・前後の空白・制御文字を含むパス、空・空白だけのパス等）
 * 2. コンテナの securityContext.privileged が真
 * 3. Pod の hostNetwork・hostPID・hostIPC が真
 * 4. コンテナの securityContext.capabilities.add のうち、compose と同じ許可リスト（ALLOWED_CAP_ADD）に無いもの
 *
 * 直し回7（必須2）：検査は構造上の位置で行う。以前はドキュメント全体をたどってキー名を探したため、ConfigMap の
 * `data: { hostNetwork: "on" }` のような通常のデータまで拒否していた。危険な指定を探すのは、次の PodSpec の中だけ：
 * - Pod：spec
 * - Deployment・StatefulSet・DaemonSet・ReplicaSet・Job・ReplicationController：spec.template.spec
 * - PodTemplate：template.spec
 * - CronJob：spec.jobTemplate.spec.template.spec
 * - List（kind が List または …List）：items[] の各要素を、上と同じ規則で1つのドキュメントとして検査する
 * PodSpec の中で見るのは、containers・initContainers・ephemeralContainers の各 securityContext、hostNetwork／hostPID／hostIPC、
 * volumes[].hostPath.path だけ。加えて、PersistentVolume の spec.hostPath.path（PVC 経由で Pod にソケットを渡せるため）も見る。
 * ConfigMap・Secret 等の data・stringData、annotations・labels、env の値等は検査しない。
 * 上の種類以外（CRD 等）は、spec.template.spec・spec.jobTemplate.spec.template.spec に containers の配列を持つときだけ、
 * PodSpec として同じに検査する（Pod テンプレートを持つ一般的な形。データ領域ではないため誤検出にならない）。
 *
 * 直し回8（必須2）：List の入れ子は MAX_LIST_DEPTH（8）段までを検査する。それより深い要素は、中身によらず「検査不能」として
 * 違反に記録し、マニフェスト全体を拒否する（以前は記録せずに読み飛ばしたため、9重以上の List に包んだ危険な Pod が通っていた。
 * kubectl は入れ子の List を段数の上限なく展開する）。危険な指定を含まない深い List も同じに拒否する。
 *
 * 真偽値は、kubectl の YAML（YAML 1.1）で真になる書き方（true・yes・on・y の大文字小文字）も真として扱う
 * （js-yaml は YAML 1.2 のため `yes` を文字列として読む。見た目の差で通さない）。
 *
 * 通常のマニフェスト（通常の volume（emptyDir・configMap・secret・PVC、ソケットと無関係な hostPath）、env、ポート、
 * resources、privileged: false、許可リスト内の capabilities、任意のキー・値の ConfigMap 等）は従来どおり通る。
 */
import { ALLOWED_CAP_ADD, dockerSocketReason } from './compose-guard';

export interface K8sManifestViolation {
  /** 何番目のドキュメントか */
  doc: number;
  /** 見つかった場所（例：spec.template.spec.volumes[0].hostPath.path） */
  path: string;
  detail: string;
}

/** マニフェストにノードを操作できる設定が含まれる。ルートは 400 `K8S_MANIFEST_REJECTED` で返し、何も適用しない */
export class K8sManifestRejectedError extends Error {
  readonly code = 'K8S_MANIFEST_REJECTED';
  readonly statusCode = 400;
  constructor(readonly violations: K8sManifestViolation[]) {
    super(
      'マニフェストにノード（ホスト）を操作できる設定が含まれるため、適用しません（' +
        violations.map((v) => `manifest[${v.doc}].${v.path}: ${v.detail}`).join('; ') +
        '）',
    );
    this.name = 'K8sManifestRejectedError';
  }
}

/** kubectl（YAML 1.1）で真になる値 */
function isTruthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return ['true', 'yes', 'on', 'y', '1'].includes(v.trim().toLowerCase());
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const HOST_NAMESPACE_KEYS = ['hostNetwork', 'hostPID', 'hostIPC'] as const;
const CONTAINER_LISTS = ['containers', 'initContainers', 'ephemeralContainers'] as const;

/** 対象の種類と、PodSpec の位置（報告・テスト用に公開する） */
export const POD_SPEC_LOCATIONS: Readonly<Record<string, readonly string[]>> = {
  Pod: ['spec'],
  Deployment: ['spec', 'template', 'spec'],
  StatefulSet: ['spec', 'template', 'spec'],
  DaemonSet: ['spec', 'template', 'spec'],
  ReplicaSet: ['spec', 'template', 'spec'],
  Job: ['spec', 'template', 'spec'],
  ReplicationController: ['spec', 'template', 'spec'],
  PodTemplate: ['template', 'spec'],
  CronJob: ['spec', 'jobTemplate', 'spec', 'template', 'spec'],
};
/** 上以外の種類（CRD 等）で、containers の配列があれば PodSpec とみなす位置 */
const GENERIC_POD_SPEC_LOCATIONS: readonly (readonly string[])[] = [
  ['spec', 'template', 'spec'],
  ['spec', 'jobTemplate', 'spec', 'template', 'spec'],
];

function getAt(root: unknown, keys: readonly string[]): unknown {
  let cur: unknown = root;
  for (const k of keys) {
    if (!isRecord(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** PodSpec 1つを検査する（at は PodSpec の位置。例：spec.template.spec） */
function inspectPodSpec(podSpec: unknown, at: string, add: (path: string, detail: string) => void): void {
  if (!isRecord(podSpec)) return;
  for (const key of HOST_NAMESPACE_KEYS) {
    if (key in podSpec && isTruthy(podSpec[key])) add(`${at}.${key}`, `${key}: true はノードの名前空間を共有する`);
  }
  asArray(podSpec.volumes).forEach((vol, i) => {
    if (isRecord(vol)) inspectHostPath(vol.hostPath, `${at}.volumes[${i}].hostPath.path`, add);
  });
  for (const list of CONTAINER_LISTS) {
    asArray(podSpec[list]).forEach((c, i) => {
      if (!isRecord(c) || !isRecord(c.securityContext)) return;
      const sc = c.securityContext;
      const scAt = `${at}.${list}[${i}].securityContext`;
      if (isTruthy(sc.privileged)) add(`${scAt}.privileged`, 'privileged: true はノードの全デバイス・全権限を渡す');
      if (isRecord(sc.capabilities)) {
        const caps = sc.capabilities.add;
        for (const cap of Array.isArray(caps) ? caps : caps === undefined || caps === null ? [] : [caps]) {
          const name = String(cap).trim().toUpperCase().replace(/^CAP_/, '');
          if (!ALLOWED_CAP_ADD.has(name)) add(`${scAt}.capabilities.add`, `${String(cap)} は許可していない権限（ホストの制御に直結する）`);
        }
      }
    });
  }
}

/** hostPath の path を、compose・既存コンテナの Mounts と同じ共有関数 dockerSocketReason で判定する */
function inspectHostPath(hostPath: unknown, at: string, add: (path: string, detail: string) => void): void {
  if (hostPath === undefined || hostPath === null) return;
  if (!isRecord(hostPath)) {
    add(at, 'hostPath がマッピングでないため判定できない');
    return;
  }
  const p = hostPath.path;
  if (typeof p !== 'string') {
    add(at, '文字列でないため判定できない');
    return;
  }
  // 直し回7（必須1）：trim 等で書き換えず、kubelet に渡る文字列そのものを判定する（空白付き・空も判定不能として拒否）
  const reason = dockerSocketReason(p);
  if (reason) add(at, reason);
}

/**
 * List の入れ子を検査する段数の上限（直し回8 必須2）。最上位のドキュメントを 0 段とし、List の items[] の要素を 1 段深いとする。
 * 上限ちょうど（8 重の List の中の要素）までは検査し、それより深い要素は検査不能として拒否する
 */
export const MAX_LIST_DEPTH = 8;

/** 1つのドキュメント（リソース）を、種類ごとの構造上の位置で検査する */
function inspectResource(doc: unknown, prefix: string, docIndex: number, out: K8sManifestViolation[], depth = 0): void {
  const add = (p: string, detail: string) => out.push({ doc: docIndex, path: prefix ? `${prefix}.${p}` : p, detail });
  // 直し回8（必須2）：上限を超えた位置は、中身を見ずに検査不能として拒否する（超過を通過にしない）
  if (depth > MAX_LIST_DEPTH) {
    out.push({ doc: docIndex, path: prefix || '(root)', detail: `List の入れ子が ${MAX_LIST_DEPTH} 段を超えるため検査できない（検査不能として拒否する）` });
    return;
  }
  if (!isRecord(doc)) return;
  const kind = typeof doc.kind === 'string' ? doc.kind : '';

  if (kind === 'List' || (kind.endsWith('List') && Array.isArray(doc.items))) {
    asArray(doc.items).forEach((item, i) => inspectResource(item, `${prefix ? `${prefix}.` : ''}items[${i}]`, docIndex, out, depth + 1));
    return;
  }
  if (kind === 'PersistentVolume') {
    inspectHostPath(getAt(doc, ['spec', 'hostPath']), 'spec.hostPath.path', add);
    return;
  }
  const known = POD_SPEC_LOCATIONS[kind];
  if (known) {
    inspectPodSpec(getAt(doc, known), known.join('.'), add);
    return;
  }
  for (const loc of GENERIC_POD_SPEC_LOCATIONS) {
    const podSpec = getAt(doc, loc);
    if (isRecord(podSpec) && Array.isArray(podSpec.containers)) inspectPodSpec(podSpec, loc.join('.'), add);
  }
}

/** 1つのドキュメントの違反を集める */
function inspectDoc(root: unknown, docIndex: number): K8sManifestViolation[] {
  const out: K8sManifestViolation[] = [];
  inspectResource(root, '', docIndex, out);
  return out;
}

/** マニフェストの全ドキュメントを検査し、違反があれば K8sManifestRejectedError を投げる（何も適用しない） */
export function assertManifestSafe(docs: readonly unknown[]): void {
  const violations = docs.flatMap((d, i) => inspectDoc(d, i));
  if (violations.length > 0) throw new K8sManifestRejectedError(violations);
}
