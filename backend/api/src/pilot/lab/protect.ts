/**
 * 既存のコンテナ操作 API（/api/network/exec、/api/docker/containers/:id の削除・停止・起動）から
 * パイロットのラボコンテナを守る。
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
    super(`コンテナ ${containerId.slice(0, 12)} はパイロットのラボ（ラベル ${LABEL_LAB}）のため、この API では操作できません`);
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

/** 拒否時の応答本文 */
export function protectedBody(e: PilotLabProtectedError) {
  return { error: e.code, message: e.message };
}
