/**
 * 直し回4補足1：/api/k8s/* の入力を Kubernetes の名前の規則で検証する。
 *
 * 以前は namespace・name・kind 等を文字列のまま `kubectl ...` のシェルコマンドに組み立てて exec していたため、
 * `namespace=default; docker rm -f <ID>` のような入力で任意のコマンドが実行でき、同じサーバ上のパイロットのラボを
 * 停止・削除できた。そこで、
 *   1. 入力は Kubernetes の名前として妥当な文字種・形式だけを許可する（シェルのメタ文字・空白・改行は文字種の時点で通らない）
 *   2. 実行は execFile でコマンドと引数を分けて渡す（kubernetes.ts。シェルを介さない）
 * の二重にする。どちらか一方が漏れても、連結・置換・リダイレクトは成立しない。
 *
 * 判定は mock モードでも同じに行う（mock でだけ通る入力を作らない）。
 */
import { assertManifestSafe } from './k8s-manifest-guard';

/** 入力が Kubernetes の名前として妥当でない。ルートは 400 `K8S_INVALID_INPUT` で返す */
export class K8sInputError extends Error {
  readonly code = 'K8S_INVALID_INPUT';
  readonly statusCode = 400;
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`${field} が Kubernetes の名前として妥当ではありません（${reason}）。実行しません`);
    this.name = 'K8sInputError';
  }
}

/** RFC 1123 ラベル（namespace）：英小文字・数字・ハイフン、先頭と末尾は英数字、63文字まで */
const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** RFC 1123 サブドメイン（Pod・Deployment・Service 等のリソース名）：ラベルを `.` でつないだもの、253文字まで */
const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
/**
 * リソースの種類（kind）：`Deployment`・`deployment`・`deployments`・`deploy`・`deployments.apps` 等、
 * kubectl が受け付ける書き方のうち、英字で始まる英数字に、任意で `.グループ`（RFC 1123 サブドメイン）を付けたもの。
 */
const KIND = /^[A-Za-z][A-Za-z0-9]*(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

function check(value: unknown, field: string, re: RegExp, max: number): string {
  if (typeof value !== 'string') throw new K8sInputError(field, '文字列ではない');
  if (value.length === 0) throw new K8sInputError(field, '空');
  if (value.length > max) throw new K8sInputError(field, `${max}文字を超える`);
  if (!re.test(value)) throw new K8sInputError(field, '使えない文字・形式を含む');
  return value;
}

export const validateNamespace = (v: unknown, field = 'namespace') => check(v, field, DNS1123_LABEL, 63);
export const validateResourceName = (v: unknown, field = 'name') => check(v, field, DNS1123_SUBDOMAIN, 253);
export const validateKind = (v: unknown, field = 'kind') => check(v, field, KIND, 253);

/** ログの末尾行数（kubectl logs --tail）：-1（全部）または 0〜100000 の整数 */
export function validateTail(v: unknown, field = 'tail'): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < -1 || v > 100000) {
    throw new K8sInputError(field, '-1 または 0〜100000 の整数ではない');
  }
  return v;
}

/** route の query の tail（文字列）を検証する。未指定は従来どおり 100 */
export function parseTailQuery(v: string | undefined): number {
  if (v === undefined || v === '') return 100;
  if (!/^-?\d+$/.test(v)) throw new K8sInputError('tail', '整数ではない');
  return validateTail(Number(v));
}

/**
 * マニフェストの各リソースの kind・metadata.name（と metadata.namespace があればそれ）を検証する。
 * 実 kubectl では kind/name を `kubectl get` の引数に使うため、適用前に全件を確かめ、1つでも妥当でなければ何も適用しない。
 * 直し回6（必須3）：続けて、ノードを操作できる設定（Docker ソケット等の hostPath、privileged、hostNetwork／hostPID／hostIPC、
 * 許可外の capabilities）を k8s-manifest-guard.ts で検査し、あれば K8sManifestRejectedError を投げる。
 * 受付（routes/kubernetes.ts）と Worker 側（services/kubernetes.ts の applyManifest）の両方がこの関数を使うので、検査は同じになる。
 */
export function validateManifestDocs(docs: Array<{ kind?: unknown; metadata?: { name?: unknown; namespace?: unknown } } | null | undefined>) {
  docs.forEach((doc, i) => {
    if (!doc || !doc.kind) return; // 空のドキュメントは従来どおり読み飛ばす
    validateKind(doc.kind, `manifest[${i}].kind`);
    validateResourceName(doc.metadata?.name, `manifest[${i}].metadata.name`);
    if (doc.metadata?.namespace !== undefined) validateNamespace(doc.metadata.namespace, `manifest[${i}].metadata.namespace`);
  });
  assertManifestSafe(docs);
}
