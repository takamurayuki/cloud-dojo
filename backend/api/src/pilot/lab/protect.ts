/**
 * 既存のコンテナ・ネットワーク操作 API からパイロットのラボ（ラベル cloud-dojo.lab）を守る。
 * 適用先：/api/network/exec、/api/network/lab/create（固定名の既存コンテナ削除）、DELETE /api/network/lab/cleanup、
 * /api/docker/containers/:id の削除・停止・起動、compose（up の同名コンテナ削除、down のコンテナ・ネットワーク削除）。
 * /lab/create の既存ネットワーク再利用（routes/network.ts の resolveReusableLabNetwork）。
 * compose up の既存ネットワークへの接続（services/compose.ts の resolveComposeNetwork）。
 * CI/CD の real 実行はシェルを介さない完全一致の許可パターンに限る（services/cicd-command.ts）ので、docker の操作には届かない。
 * /api/k8s/* は入力を Kubernetes の名前の規則で検証し、kubectl をシェルを介さずに起動する（services/k8s-args.ts）ので、
 * 別のコマンド（docker 等）は起動できない。
 *
 * 通常サーバはパイロットと既存 API を同じプロセスに登録するため、既存 API が任意のコンテナ ID を受け取ると、
 * パイロットの排他（lock.ts）を通らずにラボのコンテナで sysctl を変えたり証拠ファイルを書き換えたり、
 * 実行中のラボを止めたりできてしまう。そこで、操作の前にコンテナを inspect し、ラベル cloud-dojo.lab を
 * 持つものは拒否する。判定はラベルだけで行うので、ラベルの無い通常のコンテナの扱いは変わらない。
 *
 * 名前で指定された場合、inspect の後に同じ名前が別のコンテナに付け替えられても対象がずれないよう、
 * 以後の操作は inspect で確かめた完全な ID に対して行う（resolveUnprotectedContainer の戻り値を使う）。
 */
import type Docker from 'dockerode';
import { LABEL_LAB } from './runner';

export class PilotLabProtectedError extends Error {
  readonly code = 'PILOT_LAB_PROTECTED';
  readonly statusCode = 403;
  constructor(readonly containerId: string) {
    super(`${containerId.slice(0, 12)} はパイロットのラボ（ラベル ${LABEL_LAB}）のため、この API では操作できません`);
    this.name = 'PilotLabProtectedError';
  }
}

/** ラベル cloud-dojo.lab を持つか（値は問わない） */
export function isPilotLabLabels(labels: Record<string, string> | null | undefined): boolean {
  return Boolean(labels && Object.prototype.hasOwnProperty.call(labels, LABEL_LAB));
}

/**
 * ID または名前で指定されたコンテナを inspect し、パイロットのラボコンテナなら PilotLabProtectedError を投げる。
 * それ以外は、確かめた完全な ID のハンドルを返す（inspect の失敗はそのまま投げる。存在しない等は従来どおりのエラーになる）。
 */
export async function resolveUnprotectedContainer(docker: Docker, idOrName: string): Promise<Docker.Container> {
  const info = await docker.getContainer(idOrName).inspect();
  if (isPilotLabLabels(info.Config?.Labels)) throw new PilotLabProtectedError(info.Id);
  return docker.getContainer(info.Id);
}

/**
 * ID または名前で指定されたネットワークを inspect し、ラベル cloud-dojo.lab を持てば PilotLabProtectedError を投げる。
 * それ以外は、確かめた完全な ID のハンドルを返す（inspect の失敗はそのまま投げる）。
 */
export async function resolveUnprotectedNetwork(docker: Docker, idOrName: string): Promise<Docker.Network> {
  const info = (await docker.getNetwork(idOrName).inspect()) as { Id: string; Labels?: Record<string, string> | null };
  if (isPilotLabLabels(info.Labels)) throw new PilotLabProtectedError(info.Id);
  return docker.getNetwork(info.Id);
}

/** inspect の失敗が「存在しない」（404）か */
export const isNotFound = (e: unknown) => (e as { statusCode?: number } | null)?.statusCode === 404;

/** 拒否時の応答本文 */
export function protectedBody(e: PilotLabProtectedError) {
  return { error: e.code, message: e.message };
}
