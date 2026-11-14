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
 * 持つものは拒否する（加えて、下の直し回6 必須2 のとおり Docker ソケットを保有するコンテナも拒否する）。
 *
 * 直し回6（必須2）：Docker ソケットをマウントしているコンテナ（例：リポジトリの docker-compose.yml の cloud-dojo-worker）は、
 * ラベルの有無によらず、実行（exec）・削除・停止・起動を拒否する（DockerSocketContainerProtectedError、403）。
 * そのコンテナの中からソケットへ HTTP を送れば、ラボを含むホストの全コンテナを操作できる（踏み台になる）ため。
 * 判定は inspect（一覧の場合は listContainers）の Mounts の Source に対して行い、基準は compose 定義の検査
 * （services/compose-guard.ts の dockerSocketReason：既知のソケット・別名・リンク・ハードリンク・親ディレクトリ・
 * 名前 docker.sock・名前付きパイプ・`\` を含むパス）と同じにする。ソケットを持たない通常のコンテナの扱いは変わらない。
 * 直し回7（必須1）：Source は書き換えずに（trim 等をせずに）共有関数 dockerSocketReason へ渡す。前後の空白・`\`・制御文字を
 * 含む Source は判定不能として、ソケットを保有するものと同じに保護する。
 * 直し回8（必須1）：空文字列・空白だけの Source も読み飛ばさず、判定不能として同じに保護する（compose の bind・
 * Kubernetes の hostPath と同じ規則）。そのため、Source が空のマウント（tmpfs 等）を持つ通常のコンテナも、
 * この API からは実行・削除・停止・起動できない（判定不能を許可側に倒さない）。
 *
 * 名前で指定された場合、inspect の後に同じ名前が別のコンテナに付け替えられても対象がずれないよう、
 * 以後の操作は inspect で確かめた完全な ID に対して行う（resolveUnprotectedContainer の戻り値を使う）。
 */
import type Docker from 'dockerode';
import { dockerSocketReason } from '../../services/compose-guard';
import { LABEL_LAB } from './runner';

export class PilotLabProtectedError extends Error {
  readonly code: string = 'PILOT_LAB_PROTECTED';
  readonly statusCode = 403;
  constructor(
    readonly containerId: string,
    message?: string,
  ) {
    super(message ?? `${containerId.slice(0, 12)} はパイロットのラボ（ラベル ${LABEL_LAB}）のため、この API では操作できません`);
    this.name = 'PilotLabProtectedError';
  }
}

/**
 * Docker ソケットをマウントしているコンテナ（直し回6 必須2）。PilotLabProtectedError の一種として扱い、
 * 既存の拒否の経路（403・compose のジョブ失敗）にそのまま乗せる
 */
export class DockerSocketContainerProtectedError extends PilotLabProtectedError {
  override readonly code: string = 'DOCKER_SOCKET_CONTAINER_PROTECTED';
  constructor(
    containerId: string,
    readonly reason: string,
  ) {
    super(
      containerId,
      `${containerId.slice(0, 12)} は Docker ソケットをマウントしている（${reason}）ため、この API では実行・削除・停止・起動できません`,
    );
    this.name = 'DockerSocketContainerProtectedError';
  }
}

/** inspect・listContainers の Mounts の要素（必要な項目だけ） */
export interface MountLike {
  Type?: string;
  Source?: string;
  Destination?: string;
}

/** Mounts のうち Docker ソケット（compose の検査と同じ基準）を元に持つものがあれば理由を返す。無ければ null */
export function dockerSocketMountReason(mounts: MountLike[] | null | undefined): string | null {
  for (const m of mounts ?? []) {
    // 直し回8（必須1）：空文字列・空白だけの Source も読み飛ばさず共有関数に渡す（判定不能として保護対象にする。
    // tmpfs 等の Source が空のマウントを持つコンテナも、この API からは操作できなくなる）
    if (typeof m?.Source !== 'string') continue;
    const reason = dockerSocketReason(m.Source);
    if (reason) return `${m.Source} → ${m.Destination ?? '?'}: ${reason}`;
  }
  return null;
}

/**
 * 操作してよいコンテナかを確かめる。パイロットのラボ（ラベル）なら PilotLabProtectedError、Docker ソケットを
 * マウントしていれば DockerSocketContainerProtectedError を投げる。info は inspect または listContainers の要素
 */
export function assertContainerOperable(info: { Id: string; Labels?: Record<string, string> | null; Mounts?: MountLike[] | null }): void {
  if (isPilotLabLabels(info.Labels)) throw new PilotLabProtectedError(info.Id);
  const reason = dockerSocketMountReason(info.Mounts);
  if (reason) throw new DockerSocketContainerProtectedError(info.Id, reason);
}

/** ラベル cloud-dojo.lab を持つか（値は問わない） */
export function isPilotLabLabels(labels: Record<string, string> | null | undefined): boolean {
  return Boolean(labels && Object.prototype.hasOwnProperty.call(labels, LABEL_LAB));
}

/**
 * ID または名前で指定されたコンテナを inspect し、パイロットのラボコンテナなら PilotLabProtectedError を、
 * Docker ソケットをマウントしていれば DockerSocketContainerProtectedError を投げる（直し回6 必須2）。
 * それ以外は、確かめた完全な ID のハンドルを返す（inspect の失敗はそのまま投げる。存在しない等は従来どおりのエラーになる）。
 */
export async function resolveUnprotectedContainer(docker: Docker, idOrName: string): Promise<Docker.Container> {
  const info = await docker.getContainer(idOrName).inspect();
  assertContainerOperable({ Id: info.Id, Labels: info.Config?.Labels, Mounts: info.Mounts as MountLike[] | undefined });
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
