/**
 * 直し回6（必須3）：Kubernetes の apply で、ノード（ホスト）を操作できる設定を含むマニフェストを拒否する。
 *
 * 以前の検証（k8s-args.ts の validateManifestDocs）は kind・名前・namespace だけで、`hostPath: /var/run/docker.sock`・
 * `privileged: true`・`hostPID: true` を含む Pod がそのまま kubectl apply に渡っていた。同じ Docker を使うノードで動けば、
 * compose で塞いだのと同じ種類の迂回（ソケット経由でラボを含むホストのコンテナを操作する）になる。
 *
 * 拒否するもの（compose の検査 services/compose-guard.ts と同じ基準）：
 * 1. hostPath.path が Docker ソケット、またはそれを含む親ディレクトリ（dockerSocketReason と同じ判定。/、/run、/var/run、
 *    名前 docker.sock、`\` を含むパス等）
 * 2. securityContext.privileged が真
 * 3. hostNetwork・hostPID・hostIPC が真
 * 4. securityContext.capabilities.add のうち、compose と同じ許可リスト（ALLOWED_CAP_ADD）に無いもの
 *
 * 対象：Pod 本体、Deployment・StatefulSet・DaemonSet・ReplicaSet・Job・ReplicationController・PodTemplate の Pod テンプレート、
 * CronJob の jobTemplate、List の items。種類ごとの場所を列挙するのではなく、ドキュメント全体をたどって上のキーを探す
 * （未知の種類や CRD の中の Pod テンプレート、PersistentVolume の hostPath も同じに拒否される）。
 * 真偽値は、kubectl の YAML（YAML 1.1）で真になる書き方（true・yes・on・y の大文字小文字）も真として扱う
 * （js-yaml は YAML 1.2 のため `yes` を文字列として読む。見た目の差で通さない）。
 *
 * 通常のマニフェスト（通常の volume（emptyDir・configMap・secret・PVC、ソケットと無関係な hostPath）、env、ポート、
 * resources、privileged: false、許可リスト内の capabilities 等）は従来どおり通る。
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

/** 1つのドキュメントを全体にわたってたどり、違反を集める */
function inspectDoc(root: unknown, docIndex: number): K8sManifestViolation[] {
  const out: K8sManifestViolation[] = [];
  const seen = new Set<object>();
  const add = (path: string, detail: string) => out.push({ doc: docIndex, path, detail });

  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > 64 || typeof node !== 'object' || node === null) return;
    if (seen.has(node)) return; // アンカーで共有された同じ値は1度だけ見る
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    const obj = node as Record<string, unknown>;
    const at = (k: string) => (path ? `${path}.${k}` : k);

    for (const key of HOST_NAMESPACE_KEYS) {
      if (key in obj && isTruthy(obj[key])) add(at(key), `${key}: true はノードの名前空間を共有する`);
    }

    if (isRecord(obj.hostPath)) {
      const p = obj.hostPath.path;
      if (typeof p === 'string' && p.trim()) {
        const reason = dockerSocketReason(p);
        if (reason) add(at('hostPath.path'), reason);
      } else if (p !== undefined) {
        add(at('hostPath.path'), '文字列でないため判定できない');
      }
    }

    if (isRecord(obj.securityContext)) {
      const sc = obj.securityContext;
      if (isTruthy(sc.privileged)) add(at('securityContext.privileged'), 'privileged: true はノードの全デバイス・全権限を渡す');
      if (isRecord(sc.capabilities)) {
        const caps = sc.capabilities.add;
        for (const cap of Array.isArray(caps) ? caps : caps === undefined || caps === null ? [] : [caps]) {
          const c = String(cap).trim().toUpperCase().replace(/^CAP_/, '');
          if (!ALLOWED_CAP_ADD.has(c)) add(at('securityContext.capabilities.add'), `${String(cap)} は許可していない権限（ホストの制御に直結する）`);
        }
      }
    }

    for (const [k, v] of Object.entries(obj)) walk(v, at(k), depth + 1);
  };

  walk(root, '', 0);
  return out;
}

/** マニフェストの全ドキュメントを検査し、違反があれば K8sManifestRejectedError を投げる（何も適用しない） */
export function assertManifestSafe(docs: readonly unknown[]): void {
  const violations = docs.flatMap((d, i) => inspectDoc(d, i));
  if (violations.length > 0) throw new K8sManifestRejectedError(violations);
}
