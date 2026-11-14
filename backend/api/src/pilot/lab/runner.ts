/**
 * N5 ラボランナー（dockerode）。
 *
 * 安全境界：
 * - 操作対象はラベル cloud-dojo.lab=n5-tcp が付いたコンテナ／ネットワークだけ。対象はラベルで検索し、
 *   リクエストから受け取った ID や固定名で実行・削除しない（旧 routes/network.ts の方式は使わない）。
 * - ネットワークは Internal（外部への疎通なし）。実行するコマンドはこのファイル内の固定スクリプトのみ。
 * - 時間と取得量に上限を設ける（LabLimits）：
 *   - 操作（start／reset／collect）ごとの全体期限と、その中の各単位（ping・ビルド・起動・リセット・exec）の期限。
 *     単位の期限は「単位の上限」と「全体の残り時間」の短い方。
 *   - exec の出力とビルド進捗の取得量。
 *   - 期限を超えたら、走っている単位の終了を短い猶予だけ待ってから、その操作の世代のコンテナの停止・削除と
 *     ネットワークの削除を行い、後始末の成否を LabTimeoutError.cleanup に入れて投げる。reset（collect 冒頭の
 *     リセットを含む）が片付け対象として一覧した既存のリソース（ID と世代）も、後始末で削除し直す。
 *   - 後始末の最後に、対象にした全リソースが実際に無くなったかを inspect で確かめる。残っている・確かめられない
 *     ものがあれば ok=false（remaining に列挙）とし、「後始末中」の状態を解除しない（成功と誤報しない）。
 * - Docker が無い環境では LabUnavailableError（code=DOCKER_NOT_FOUND）を投げる。呼び出し側は明示エラーで返す。
 * - 排他制御（ラボ操作の直列化）は呼び出し側（routes.ts、lock.ts）が行う。
 *
 * SYN 再送の前提：client コンテナには CLIENT_SYSCTLS（tcp_syn_linear_timeouts=0、tcp_syn_retries=6）を
 * HostConfig.Sysctls で設定する（追加の権限は不要。net.* はネットワーク名前空間ごとの設定）。
 * 実際に効いている値は client-run.sh が証拠「lab-env」として記録し、整合判定はその値から期待を導く。
 */
import Docker from 'dockerode';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { EvidenceKind } from '../curriculum/schema';
import { LAB_SYN_PREMISE } from '../evidence/parse';

export const LAB_ID = 'n5-tcp';
export const LABEL_LAB = 'cloud-dojo.lab';
export const LABEL_ROLE = 'cloud-dojo.role';
/** 実行世代のラベル（期限超過時の後始末の対象を、その操作が作ったリソースに限る） */
export const LABEL_GEN = 'cloud-dojo.gen';
export const LAB_IMAGE = 'cloud-dojo-lab/n5-tcp:0.1';
const LAB_CONTEXT = fileURLToPath(new URL('../../../labs/n5-tcp', import.meta.url));
/** コンテナ・ネットワーク名の接頭辞。実際の名前は `${NAME_PREFIX}-<世代>`（ネットワーク）、`${NAME_PREFIX}-<世代>-<role>`（コンテナ） */
export const NAME_PREFIX = 'cloud-dojo-lab-n5-tcp';

/** プロセスごとの識別子＋連番で世代を採番する（再起動後に前のプロセスの世代と衝突しない） */
const PROCESS_TOKEN = randomBytes(3).toString('hex');
let generationSeq = 0;
export function nextGeneration(): string {
  generationSeq += 1;
  return `${PROCESS_TOKEN}g${generationSeq}`;
}
/** このプロセスが gen より後に採番した世代か（reset の対象を、reset より後の世代へ広げないための判定） */
function isLaterGeneration(candidate: string | undefined, gen: string): boolean {
  if (!candidate) return false;
  const m = /^([0-9a-f]+)g(\d+)$/.exec(candidate);
  const own = /^([0-9a-f]+)g(\d+)$/.exec(gen);
  return Boolean(m && own && m[1] === own[1] && Number(m[2]) > Number(own[2]));
}
const networkName = (gen: string) => `${NAME_PREFIX}-${gen}`;
const containerName = (gen: string, role: string) => `${NAME_PREFIX}-${gen}-${role}`;
const ROLES = ['client', 'server'] as const;
type Role = (typeof ROLES)[number];

/** client コンテナに設定する sysctl（教材の前提 LAB_SYN_PREMISE と同じ値） */
export const CLIENT_SYSCTLS: Record<string, string> = {
  'net.ipv4.tcp_syn_linear_timeouts': String(LAB_SYN_PREMISE.linearTimeouts),
  'net.ipv4.tcp_syn_retries': String(LAB_SYN_PREMISE.synRetries),
};
/** この sysctl が無いカーネル（導入前）では作成・起動が失敗するため、外して作り直す */
const OPTIONAL_SYSCTL = 'net.ipv4.tcp_syn_linear_timeouts';

export interface LabLimits {
  /** Docker への疎通確認 */
  pingMs: number;
  /** イメージのビルド（初回のみ） */
  buildMs: number;
  /** ビルド進捗ストリームの取得量上限 */
  buildProgressMaxBytes: number;
  /** ネットワーク・コンテナの作成と起動（ビルドを除く） */
  startMs: number;
  /** ラベル付きコンテナ・ネットワークの削除 */
  resetMs: number;
  /** ラボ内コマンド1回 */
  execMs: number;
  /** exec の出力の取得量上限 */
  execMaxBytes: number;
  /** status の全体 */
  statusTotalMs: number;
  /** start 操作の全体（ビルドを含む） */
  startTotalMs: number;
  /** reset 操作の全体 */
  resetTotalMs: number;
  /** collect 操作の全体（リセット・起動・ビルド・exec を含む） */
  collectTotalMs: number;
  /** 期限超過時、走っている単位の終了を待つ猶予 */
  abortGraceMs: number;
  /** 期限超過時の後始末（停止・削除）の上限 */
  cleanupMs: number;
}

export const DEFAULT_LAB_LIMITS: LabLimits = {
  pingMs: 5_000,
  buildMs: 180_000,
  buildProgressMaxBytes: 2 * 1024 * 1024,
  startMs: 60_000,
  resetMs: 15_000,
  execMs: 30_000,
  execMaxBytes: 256 * 1024,
  statusTotalMs: 15_000,
  startTotalMs: 260_000,
  resetTotalMs: 20_000,
  collectTotalMs: 360_000,
  abortGraceMs: 5_000,
  cleanupMs: 30_000,
};

export class LabUnavailableError extends Error {
  readonly code = 'DOCKER_NOT_FOUND';
  constructor(detail: string) {
    super(`Docker が見つかりません（Docker Engine に接続できない）: ${detail}`);
    this.name = 'LabUnavailableError';
  }
}

export interface CleanupResult {
  /** 後始末（走っていた単位の終了を含む）が実際に完了し、停止・削除が全て成功したか */
  ok: boolean;
  stoppedContainers: number;
  removedContainers: number;
  removedNetworks: number;
  errors: string[];
  /**
   * 「後始末中」の状態が解除されていない（新しいラボ操作は 409）。期限内に完了していない場合と、完了したが
   * 対象の削除を確認できなかった場合（remaining あり）に付く。削除が全て確認できていれば付かない
   */
  pending?: true;
  /** 削除を確認できなかった（残っている、または確かめられなかった）対象。全て確認できていれば付かない */
  remaining?: string[];
}

/** 期限超過の後始末が続いている間の状態 */
export interface LabCleanupState {
  generation: string;
  operation: string;
  since: string;
  /**
   * 後始末は終わったが、削除を確認できなかった対象（付いているときは待っても解除されない。API プロセスを
   * 再起動したあと run／lab/reset で片付ける。README「後始末中が続く場合」）
   */
  remaining?: string[];
}

export class LabCleanupPendingError extends Error {
  readonly code = 'LAB_CLEANUP_PENDING';
  constructor(readonly state: LabCleanupState) {
    super(`前の操作（${state.operation}）の後始末がまだ終わっていないため、ラボを操作できません`);
    this.name = 'LabCleanupPendingError';
  }
}

export class LabTimeoutError extends Error {
  readonly code = 'LAB_TIMEOUT';
  /** 期限超過時に行った後始末の結果（後始末をしない操作では null）。応答時点の値 */
  cleanup: CleanupResult | null = null;
  /** 後始末が実際に完了したときの結果（応答後も続く場合の追跡用。応答には含めない） */
  cleanupDone: Promise<CleanupResult> | null = null;
  constructor(
    readonly operation: string,
    /** 期限を超えた単位（全体の期限なら '<operation>（全体）'） */
    readonly step: string,
    readonly limitMs: number,
  ) {
    super(`ラボ操作 ${operation} の ${step} が期限 ${limitMs}ms を超えた`);
    this.name = 'LabTimeoutError';
  }
}

export class LabOutputLimitError extends Error {
  readonly code = 'LAB_OUTPUT_LIMIT';
  constructor(what: string, maxBytes: number) {
    super(`${what} の出力が上限 ${maxBytes} バイトを超えたため打ち切った`);
    this.name = 'LabOutputLimitError';
  }
}

export interface LabNode {
  role: string;
  containerId: string;
  state: string;
}

export interface LabStatus {
  docker: 'available';
  running: boolean;
  nodes: LabNode[];
  network: { name: string; internal: boolean } | null;
}

export interface LabRunner {
  /** 期限超過の後始末が続いていればその状態（無ければ null）。続いている間は start／reset／collect を受け付けない */
  cleanupState?(): LabCleanupState | null;
  status(): Promise<LabStatus>;
  start(): Promise<LabStatus & { elapsedMs: number }>;
  reset(): Promise<{ removedContainers: number; removedNetworks: number; elapsedMs: number }>;
  /** 条件を適用して接続試行を行い、証拠テキスト（実測）一式を返す。途中で失敗したら何も返さない */
  collect(condition: { portState: string; connectTimeout: string }): Promise<Record<EvidenceKind, string>>;
}

/** client-run.sh の区切り付き出力を証拠の種類ごとに分ける */
export function splitSections(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current: string | null = null;
  for (const line of output.split('\n')) {
    const m = /^=====(\S+)$/.exec(line);
    if (m) {
      current = m[1];
      out[current] = '';
      continue;
    }
    if (current) out[current] += `${line}\n`;
  }
  return out;
}

/**
 * ビルド進捗（JSON 行のストリーム）を読み切る。取得量が上限を超えたらストリームを破棄して失敗させる。
 * {"error": ...} の行があればビルド失敗とする。
 */
export function consumeBuildStream(stream: NodeJS.ReadableStream, maxBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let partial = '';
    let buildError: string | null = null;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve();
    };
    const scan = (line: string) => {
      if (!line.trim()) return;
      try {
        const j = JSON.parse(line) as { error?: unknown };
        if (j.error) buildError = String(j.error);
      } catch {
        // 進捗以外の行は無視する
      }
    };
    stream.on('data', (chunk: Buffer | string) => {
      if (done) return;
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes > maxBytes) {
        (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        finish(new LabOutputLimitError('ラボイメージのビルド進捗', maxBytes));
        return;
      }
      partial += chunk.toString();
      let i: number;
      while ((i = partial.indexOf('\n')) >= 0) {
        scan(partial.slice(0, i));
        partial = partial.slice(i + 1);
      }
    });
    stream.on('end', () => {
      scan(partial);
      finish(buildError ? new Error(`ラボイメージのビルドに失敗: ${buildError}`) : undefined);
    });
    // end より前に閉じた（切断・破棄）場合はビルド完了とみなさない
    stream.on('close', () => finish(new Error('ラボイメージのビルド進捗が完了前に閉じた')));
    stream.on('error', (e: Error) => finish(e));
  });
}

/**
 * 1つのラボ操作の時間予算。各単位は min(単位の上限, 全体の残り) で打ち切る。
 * 期限を超えたら aborted になり、以降の単位は始めない（走っていた単位は inflight に残る）。
 */
/** reset が片付け対象として一覧したリソース（期限超過の後始末で削除し直し、削除を確かめる） */
interface ResetTargets {
  containers: Array<{ id: string; gen: string | null }>;
  networks: Array<{ id: string; name: string; gen: string | null }>;
}

class OpBudget {
  private readonly endAt: number;
  aborted = false;
  inflight: Promise<unknown> | null = null;
  /** この操作が reset（doReset）を始めたか */
  resetRequested = false;
  /** reset が一覧した片付け対象（一覧が返る前なら null） */
  resetTargets: ResetTargets | null = null;

  constructor(
    readonly operation: string,
    private readonly totalMs: number,
    /** この操作の実行世代（作るリソースに付け、後始末の対象をこれに限る） */
    readonly generation: string,
  ) {
    this.endAt = Date.now() + totalMs;
  }

  /** 期限超過後に次の単位へ進まないための検査 */
  check() {
    if (this.aborted) throw new LabTimeoutError(this.operation, `${this.operation}（全体）`, this.totalMs);
  }

  async step<T>(label: string, unitMs: number, fn: () => Promise<T>, onTimeout?: () => void): Promise<T> {
    this.check();
    const remaining = this.endAt - Date.now();
    if (remaining <= 0) {
      this.aborted = true;
      throw new LabTimeoutError(this.operation, `${this.operation}（全体）`, this.totalMs);
    }
    const byUnit = unitMs <= remaining;
    const limit = byUnit ? unitMs : remaining;
    const work = fn();
    this.inflight = work;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.aborted = true;
        try {
          onTimeout?.();
        } catch {
          // 打ち切り処理の失敗は後始末で拾う
        }
        reject(new LabTimeoutError(this.operation, byUnit ? label : `${this.operation}（全体）`, byUnit ? unitMs : this.totalMs));
      }, limit);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      if (!this.aborted) this.inflight = null;
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const emptyCleanup = (): CleanupResult => ({ ok: false, stoppedContainers: 0, removedContainers: 0, removedNetworks: 0, errors: [] });
const statusOf = (e: unknown) => (e as { statusCode?: number }).statusCode;

/** 後始末で対象にしたリソース（最後に削除を確かめる）。キーは種類と完全 ID */
type Tracked = Map<string, { kind: 'container' | 'network'; id: string; label: string }>;
const track = (t: Tracked | undefined, kind: 'container' | 'network', id: string, label: string) => t?.set(`${kind}:${id}`, { kind, id, label });

const SERVER_APPLY: Record<string, string> = {
  open: 'nohup python3 /lab/server.py >/tmp/server.log 2>&1 & sleep 0.5',
  closed: 'true',
  drop: 'nohup python3 /lab/server.py >/tmp/server.log 2>&1 & sleep 0.5; iptables -A INPUT -p tcp --dport 8080 -j DROP',
};

export class DockerLabRunner implements LabRunner {
  private docker: Docker;
  readonly limits: LabLimits;

  constructor(docker?: Docker, limits: Partial<LabLimits> = {}) {
    this.docker = docker ?? new Docker();
    this.limits = { ...DEFAULT_LAB_LIMITS, ...limits };
  }

  private settling: LabCleanupState | null = null;

  /** 期限超過の後始末が続いていればその状態 */
  cleanupState(): LabCleanupState | null {
    return this.settling ? { ...this.settling } : null;
  }

  private assertNotSettling() {
    if (this.settling) throw new LabCleanupPendingError({ ...this.settling });
  }

  /**
   * 操作全体を時間予算の下で実行する。期限超過（LabTimeoutError）で cleanupOnTimeout のときは、
   * その操作の世代のリソースの後始末を始め、「後始末中」の状態にする。後始末は応答の期限
   * （abortGraceMs＋cleanupMs）を過ぎても続け、実際に完了した時点で状態を解除する。
   * error.cleanup は応答時点の結果（未完了なら ok=false・pending=true）、error.cleanupDone は完了時の結果。
   */
  private async guarded<T>(operation: string, totalMs: number, cleanupOnTimeout: boolean, fn: (b: OpBudget) => Promise<T>): Promise<T> {
    if (cleanupOnTimeout) this.assertNotSettling();
    const b = new OpBudget(operation, totalMs, nextGeneration());
    try {
      return await fn(b);
    } catch (e) {
      if (e instanceof LabTimeoutError && cleanupOnTimeout) {
        const r = emptyCleanup();
        const state: LabCleanupState = { generation: b.generation, operation, since: new Date().toISOString() };
        this.settling = state;
        // 解除は、対象の削除が全て確認できたとき（r.ok）だけ。確認できなければ残りを状態に記録して保持する
        const done = this.settleTimedOut(b, r).then((res) => {
          if (this.settling === state) {
            if (res.ok) this.settling = null;
            else this.settling = { ...state, remaining: res.remaining ?? [...res.errors] };
          }
          if (!res.ok) res.pending = true;
          return res;
        });
        const answered = await Promise.race([done, sleep(this.limits.abortGraceMs + this.limits.cleanupMs).then(() => null)]);
        e.cleanup = answered ?? {
          ...r,
          errors: [...r.errors, `後始末が ${this.limits.abortGraceMs + this.limits.cleanupMs}ms 以内に完了していない（継続中。完了するまで新しいラボ操作は受け付けない）`],
          ok: false,
          pending: true,
        };
        e.cleanupDone = done;
      }
      throw e;
    }
  }

  /**
   * 期限超過した操作の後始末を、実際に完了するまで行う（拒否しない Promise）。
   * 1. 走っていた単位の終了を猶予だけ待つ。2. その世代のリソースを停止・削除する。
   * 3. 走っていた単位の実際の終了を待つ（期限なし）。4. 1 の時点で単位が終わっていなかったなら、
   *    その後に作られた可能性があるため、同じ世代のリソースをもう一度片付ける。
   * 5. 操作が reset を始めていたら、reset が一覧した既存のリソース（ID と世代を記録したもの）を削除する。
   *    一覧が返らないまま終わった場合は、対象を確定できないので失敗として記録する（対象は広げない）。
   * 6. 対象にした全リソースが無くなったことを inspect で確かめる。残り・未確認は remaining に入れ、ok=false。
   */
  private async settleTimedOut(b: OpBudget, r: CleanupResult): Promise<CleanupResult> {
    const tracked: Tracked = new Map();
    let inflightDone = !b.inflight;
    const inflight = b.inflight
      ? b.inflight.then(
          () => undefined,
          () => undefined,
        ).then(() => {
          inflightDone = true;
        })
      : Promise.resolve();
    await Promise.race([inflight, sleep(this.limits.abortGraceMs)]);
    const settledBeforeFirstPass = inflightDone;
    await this.cleanupGeneration(b.generation, r, tracked);
    await inflight;
    if (!settledBeforeFirstPass) await this.cleanupGeneration(b.generation, r, tracked);
    if (b.resetRequested) {
      if (b.resetTargets) await this.removeResetTargets(b.resetTargets, r, tracked);
      else r.errors.push('reset の片付け対象（既存のラボ）を一覧する前に打ち切られたため、既存のラボを削除できたか確認できない');
    }
    const remaining = await this.confirmRemoved(tracked);
    if (remaining.length > 0) r.remaining = remaining;
    r.ok = r.errors.length === 0 && remaining.length === 0;
    return r;
  }

  /**
   * reset が一覧した既存のリソースを、記録した ID で削除する。削除の前に inspect し、ラボのラベルと
   * 記録した世代が一致するものだけを対象にする（既に無いものは成功）。
   */
  private async removeResetTargets(t: ResetTargets, r: CleanupResult, tracked: Tracked) {
    for (const c of t.containers) {
      const label = `container ${c.id.slice(0, 12)}（reset 対象、世代 ${c.gen ?? '-'}）`;
      try {
        const info = await this.docker.getContainer(c.id).inspect();
        const labels = info.Config?.Labels ?? {};
        if (labels[LABEL_LAB] !== LAB_ID || (labels[LABEL_GEN] ?? null) !== c.gen) continue; // 記録した対象ではない
      } catch (e) {
        if (statusOf(e) === 404) continue; // 既に無い
        r.errors.push(`inspect ${label}: ${(e as Error).message}`);
        track(tracked, 'container', c.id, label);
        continue;
      }
      track(tracked, 'container', c.id, label);
      try {
        await this.docker.getContainer(c.id).remove({ force: true });
        r.removedContainers++;
      } catch (e) {
        if (statusOf(e) !== 404) r.errors.push(`remove ${label}: ${(e as Error).message}`);
      }
    }
    for (const n of t.networks) {
      const label = `network ${n.name}（reset 対象、世代 ${n.gen ?? '-'}）`;
      try {
        const info = (await this.docker.getNetwork(n.id).inspect()) as { Labels?: Record<string, string> };
        const labels = info.Labels ?? {};
        if (labels[LABEL_LAB] !== LAB_ID || (labels[LABEL_GEN] ?? null) !== n.gen) continue;
      } catch (e) {
        if (statusOf(e) === 404) continue;
        r.errors.push(`inspect ${label}: ${(e as Error).message}`);
        track(tracked, 'network', n.id, label);
        continue;
      }
      track(tracked, 'network', n.id, label);
      try {
        await this.docker.getNetwork(n.id).remove();
        r.removedNetworks++;
      } catch (e) {
        if (statusOf(e) !== 404) r.errors.push(`remove ${label}: ${(e as Error).message}`);
      }
    }
  }

  /** 対象にした各リソースを inspect し、404（無い）にならないもの（残っている・確かめられない）を返す */
  private async confirmRemoved(tracked: Tracked): Promise<string[]> {
    const left: string[] = [];
    for (const t of tracked.values()) {
      try {
        if (t.kind === 'container') await this.docker.getContainer(t.id).inspect();
        else await this.docker.getNetwork(t.id).inspect();
        left.push(`${t.label}：残っている`);
      } catch (e) {
        if (statusOf(e) !== 404) left.push(`${t.label}：削除を確認できない（${(e as Error).message}）`);
      }
    }
    return left;
  }

  /**
   * 指定した世代のコンテナを停止・削除し、その世代のネットワークを削除する（結果は r に足す。拒否しない）。
   * 一覧は世代ラベルで絞り込み、さらに各要素のラベルと名前の接頭辞を確かめる（一覧が他の世代を含んでも触れない）。
   * ネットワークの一覧は、コンテナの処理が終わってから取得するが、同じ検査を通すので別世代のものは対象にならない。
   */
  async cleanupGeneration(gen: string, r: CleanupResult = emptyCleanup(), tracked?: Tracked): Promise<CleanupResult> {
    const filters = { label: [`${LABEL_LAB}=${LAB_ID}`, `${LABEL_GEN}=${gen}`] };
    const cPrefix = `/${containerName(gen, '')}`;
    try {
      const containers = (await this.docker.listContainers({ all: true, filters })).filter(
        (c) => c.Labels?.[LABEL_LAB] === LAB_ID && c.Labels?.[LABEL_GEN] === gen && (c.Names ?? []).some((n) => n.startsWith(cPrefix)),
      );
      for (const c of containers) {
        track(tracked, 'container', c.Id, `container ${c.Id.slice(0, 12)}（世代 ${gen}）`);
        const handle = this.docker.getContainer(c.Id);
        try {
          if (c.State === 'running') {
            await handle.stop({ t: 1 });
          }
          r.stoppedContainers++;
        } catch (e) {
          // 304（既に停止）は成功扱い
          if ((e as { statusCode?: number }).statusCode === 304) r.stoppedContainers++;
          else r.errors.push(`stop ${c.Id.slice(0, 12)}: ${(e as Error).message}`);
        }
        try {
          await handle.remove({ force: true });
          r.removedContainers++;
        } catch (e) {
          if ((e as { statusCode?: number }).statusCode === 404) continue; // 既に無い
          r.errors.push(`remove ${c.Id.slice(0, 12)}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      r.errors.push(`list containers: ${(e as Error).message}`);
    }
    try {
      const networks = (await this.docker.listNetworks({ filters })).filter(
        (n) => n.Labels?.[LABEL_LAB] === LAB_ID && n.Labels?.[LABEL_GEN] === gen && n.Name === networkName(gen),
      );
      for (const n of networks) {
        track(tracked, 'network', n.Id, `network ${n.Name}（世代 ${gen}）`);
        try {
          await this.docker.getNetwork(n.Id).remove();
          r.removedNetworks++;
        } catch (e) {
          if ((e as { statusCode?: number }).statusCode === 404) continue;
          r.errors.push(`remove network ${n.Name}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      r.errors.push(`list networks: ${(e as Error).message}`);
    }
    r.ok = r.errors.length === 0;
    return r;
  }

  private async ensureDocker(b: OpBudget) {
    try {
      await b.step('ping', this.limits.pingMs, () => this.docker.ping());
    } catch (e) {
      if (e instanceof LabTimeoutError) {
        // ping 自体が応答しない＝Docker に接続できない。全体期限の超過はそのまま投げて後始末させる
        if (e.step === 'ping') throw new LabUnavailableError(`ping が ${this.limits.pingMs}ms 以内に応答しない`);
        throw e;
      }
      const err = e as NodeJS.ErrnoException;
      throw new LabUnavailableError(err.code ?? err.message);
    }
  }

  private async labContainers() {
    return this.docker.listContainers({ all: true, filters: { label: [`${LABEL_LAB}=${LAB_ID}`] } });
  }

  private async labNetworks() {
    return this.docker.listNetworks({ filters: { label: [`${LABEL_LAB}=${LAB_ID}`] } });
  }

  private async node(role: Role) {
    const list = await this.docker.listContainers({ filters: { label: [`${LABEL_LAB}=${LAB_ID}`, `${LABEL_ROLE}=${role}`] } });
    if (list.length !== 1) throw new Error(`ラボの ${role} ノードが起動していない（該当 ${list.length} 件）`);
    return this.docker.getContainer(list[0].Id);
  }

  private async readStatus(): Promise<LabStatus> {
    const containers = await this.labContainers();
    const networks = await this.labNetworks();
    const nodes = containers.map((c) => ({ role: c.Labels[LABEL_ROLE] ?? '?', containerId: c.Id.slice(0, 12), state: c.State }));
    return {
      docker: 'available',
      running: ROLES.every((r) => nodes.some((n) => n.role === r && n.state === 'running')),
      nodes,
      network: networks[0] ? { name: networks[0].Name, internal: Boolean(networks[0].Internal) } : null,
    };
  }

  async status(): Promise<LabStatus> {
    // 読み取りのみ。期限超過でも後始末はしない
    return this.guarded('status', this.limits.statusTotalMs, false, async (b) => {
      await this.ensureDocker(b);
      return b.step('status', this.limits.statusTotalMs, () => this.readStatus());
    });
  }

  private async ensureImage(b: OpBudget) {
    const present = await b.step('image-inspect', this.limits.pingMs, async () => {
      try {
        await this.docker.getImage(LAB_IMAGE).inspect();
        return true;
      } catch {
        return false;
      }
    });
    if (present) return;
    // 未ビルドならリポジトリ内の Dockerfile からビルドする（ビルド時のみ外部取得が発生する）
    let stream: NodeJS.ReadableStream | null = null;
    await b.step(
      'build',
      this.limits.buildMs,
      async () => {
        stream = await this.docker.buildImage(
          { context: LAB_CONTEXT, src: ['Dockerfile', 'server.py', 'client-run.sh'] },
          { t: LAB_IMAGE, labels: { [LABEL_LAB]: LAB_ID } },
        );
        if (b.aborted) (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        await consumeBuildStream(stream, this.limits.buildProgressMaxBytes);
      },
      // 期限超過：進捗ストリームを切る（Docker はクライアント切断でビルドを中止する）
      () => (stream as (NodeJS.ReadableStream & { destroy?: () => void }) | null)?.destroy?.(),
    );
  }

  private containerSpec(role: Role, netName: string, withOptionalSysctl: boolean, gen: string, attempt = 0): Docker.ContainerCreateOptions {
    const sysctls = role === 'client' ? { ...CLIENT_SYSCTLS } : undefined;
    if (sysctls && !withOptionalSysctl) delete sysctls[OPTIONAL_SYSCTL];
    return {
      // 名前は世代入り（作り直しでは名前の衝突を避けるため末尾に番号を足す）
      name: attempt === 0 ? containerName(gen, role) : `${containerName(gen, role)}-${attempt}`,
      Image: LAB_IMAGE,
      Cmd: ['sleep', 'infinity'],
      Hostname: role,
      Labels: { [LABEL_LAB]: LAB_ID, [LABEL_ROLE]: role, [LABEL_GEN]: gen },
      HostConfig: {
        NetworkMode: netName,
        CapAdd: ['NET_ADMIN', 'NET_RAW'],
        Memory: 128 * 1024 * 1024,
        PidsLimit: 128,
        ...(sysctls ? { Sysctls: sysctls } : {}),
      },
      NetworkingConfig: { EndpointsConfig: { [netName]: { Aliases: [role] } } },
    };
  }

  private async createAndStart(b: OpBudget, role: Role, netName: string) {
    try {
      b.check();
      const c = await this.docker.createContainer(this.containerSpec(role, netName, true, b.generation));
      try {
        b.check();
        await c.start();
      } catch (e) {
        await c.remove({ force: true }).catch(() => undefined);
        throw e;
      }
    } catch (e) {
      // tcp_syn_linear_timeouts が無いカーネル：その設定だけ外して作り直す（lab-env には absent と記録される）
      // （エラー文は "net.ipv4.tcp_syn_linear_timeouts" 形式と "/proc/sys/net/ipv4/tcp_syn_linear_timeouts" 形式がある）
      if (role !== 'client' || !String((e as Error).message).includes(OPTIONAL_SYSCTL.split('.').at(-1)!)) throw e;
      b.check();
      const c = await this.docker.createContainer(this.containerSpec(role, netName, false, b.generation, 1));
      b.check();
      await c.start();
    }
  }

  private async doStart(b: OpBudget) {
    await this.ensureDocker(b);
    await this.ensureImage(b);
    await b.step('start', this.limits.startMs, async () => {
      let net = (await this.labNetworks())[0];
      if (!net) {
        b.check();
        await this.docker.createNetwork({
          Name: networkName(b.generation),
          Driver: 'bridge',
          Internal: true,
          Labels: { [LABEL_LAB]: LAB_ID, [LABEL_GEN]: b.generation },
        });
        net = (await this.labNetworks())[0];
      }
      const existing = await this.labContainers();
      for (const role of ROLES) {
        b.check();
        const found = existing.find((c) => c.Labels[LABEL_ROLE] === role);
        if (found) {
          if (found.State !== 'running') await this.docker.getContainer(found.Id).start();
          continue;
        }
        await this.createAndStart(b, role, net.Name);
      }
    });
    return b.step('status', this.limits.startMs, () => this.readStatus());
  }

  /**
   * ラベル付きのラボ全体を削除する。片付け対象（コンテナ・ネットワークの ID と世代）は、削除を始める前に
   * まとめて一覧して b.resetTargets に記録する（期限超過したら後始末がこの記録で削除し直し、削除を確かめる）。
   * このプロセスで reset より後に採番された世代のものは対象にしない。
   */
  private async doReset(b: OpBudget) {
    b.resetRequested = true;
    await this.ensureDocker(b);
    return b.step('reset', this.limits.resetMs, async () => {
      const notLater = (labels: Record<string, string> | undefined) => !isLaterGeneration(labels?.[LABEL_GEN], b.generation);
      const containers = (await this.labContainers()).filter((c) => c.Labels?.[LABEL_LAB] === LAB_ID && notLater(c.Labels));
      const networks = (await this.labNetworks()).filter((n) => n.Labels?.[LABEL_LAB] === LAB_ID && notLater(n.Labels));
      b.resetTargets = {
        containers: containers.map((c) => ({ id: c.Id, gen: c.Labels?.[LABEL_GEN] ?? null })),
        networks: networks.map((n) => ({ id: n.Id, name: n.Name, gen: n.Labels?.[LABEL_GEN] ?? null })),
      };
      for (const c of containers) {
        b.check();
        await this.docker.getContainer(c.Id).remove({ force: true });
      }
      for (const n of networks) {
        b.check();
        await this.docker.getNetwork(n.Id).remove();
      }
      return { removedContainers: containers.length, removedNetworks: networks.length };
    });
  }

  async start() {
    const t0 = Date.now();
    return this.guarded('start', this.limits.startTotalMs, true, async (b) => ({ ...(await this.doStart(b)), elapsedMs: Date.now() - t0 }));
  }

  async reset() {
    const t0 = Date.now();
    return this.guarded('reset', this.limits.resetTotalMs, true, async (b) => ({ ...(await this.doReset(b)), elapsedMs: Date.now() - t0 }));
  }

  private async exec(b: OpBudget, label: string, container: Docker.Container, cmd: string[]): Promise<{ exitCode: number; output: string }> {
    let stream: NodeJS.ReadWriteStream | null = null;
    const max = this.limits.execMaxBytes;
    return b.step(
      `exec:${label}`,
      this.limits.execMs,
      async () => {
        const ex = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
        const s = await ex.start({ hijack: true, stdin: false });
        stream = s;
        if (b.aborted) s.destroy();
        const sink = new PassThrough();
        let output = '';
        sink.on('data', (chunk: Buffer) => {
          if (output.length < max) output += chunk.toString('utf8');
        });
        this.docker.modem.demuxStream(s, sink, sink);
        await new Promise<void>((resolve, reject) => {
          s.on('end', () => resolve());
          s.on('close', () => resolve());
          s.on('error', (e) => reject(e));
        });
        const info = await ex.inspect();
        return { exitCode: info.ExitCode ?? -1, output: output.slice(0, max) };
      },
      // 期限超過：ストリームを切る。コンテナ内のプロセスは後始末（コンテナの停止・削除）で確実に止める
      () => (stream as (NodeJS.ReadWriteStream & { destroy?: () => void }) | null)?.destroy?.(),
    );
  }

  async collect(condition: { portState: string; connectTimeout: string }): Promise<Record<EvidenceKind, string>> {
    const apply = SERVER_APPLY[condition.portState];
    if (!apply) throw new Error(`未知の portState: ${condition.portState}`);
    if (!/^\d+$/.test(condition.connectTimeout)) throw new Error(`不正な connectTimeout: ${condition.connectTimeout}`);

    return this.guarded('collect', this.limits.collectTotalMs, true, async (b) => {
      // 前の試行の TIME_WAIT 等が残らないよう、試行ごとにラボを作り直す
      await this.doReset(b);
      await this.doStart(b);
      const server = await b.step('lookup', this.limits.startMs, () => this.node('server'));
      const client = await b.step('lookup', this.limits.startMs, () => this.node('client'));

      const applied = await this.exec(b, 'server-apply', server, ['sh', '-c', apply]);
      if (applied.exitCode !== 0) throw new Error(`server への条件適用に失敗: ${applied.output}`);

      const run = await this.exec(b, 'client-run', client, ['/lab/client-run.sh', condition.connectTimeout]);
      const sections = splitSections(run.output);
      const ssServer = await this.exec(b, 'ss-server', server, ['ss', '-tan']);

      for (const k of ['lab-env', 'tcpdump', 'ss-client', 'curl']) {
        if (sections[k] === undefined) throw new Error(`client の証拠出力に ${k} が無い: ${run.output.slice(0, 500)}`);
      }
      // 全て揃ってから一式を返す（保存は呼び出し側が一括で行う）
      return {
        'lab-env': sections['lab-env'],
        tcpdump: sections.tcpdump,
        'ss-client': sections['ss-client'],
        'ss-server': ssServer.output,
        curl: sections.curl,
      };
    });
  }
}
