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
 *   - 期限を超えたら、走っている単位の終了を短い猶予だけ待ってから、ラベル付きコンテナの停止・削除と
 *     ネットワークの削除を行い、後始末の成否を LabTimeoutError.cleanup に入れて投げる。
 * - Docker が無い環境では LabUnavailableError（code=DOCKER_NOT_FOUND）を投げる。呼び出し側は明示エラーで返す。
 * - 排他制御（ラボ操作の直列化）は呼び出し側（routes.ts、lock.ts）が行う。
 *
 * SYN 再送の前提：client コンテナには CLIENT_SYSCTLS（tcp_syn_linear_timeouts=0、tcp_syn_retries=6）を
 * HostConfig.Sysctls で設定する（追加の権限は不要。net.* はネットワーク名前空間ごとの設定）。
 * 実際に効いている値は client-run.sh が証拠「lab-env」として記録し、整合判定はその値から期待を導く。
 */
import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { EvidenceKind } from '../curriculum/schema';
import { LAB_SYN_PREMISE } from '../evidence/parse';

export const LAB_ID = 'n5-tcp';
export const LABEL_LAB = 'cloud-dojo.lab';
export const LABEL_ROLE = 'cloud-dojo.role';
export const LAB_IMAGE = 'cloud-dojo-lab/n5-tcp:0.1';
const LAB_CONTEXT = fileURLToPath(new URL('../../../labs/n5-tcp', import.meta.url));
const NETWORK_NAME = 'cloud-dojo-lab-n5-tcp';
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
  /** 停止・削除が全て成功したか */
  ok: boolean;
  stoppedContainers: number;
  removedContainers: number;
  removedNetworks: number;
  errors: string[];
}

export class LabTimeoutError extends Error {
  readonly code = 'LAB_TIMEOUT';
  /** 期限超過時に行った後始末の結果（後始末をしない操作では null） */
  cleanup: CleanupResult | null = null;
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
class OpBudget {
  private readonly endAt: number;
  aborted = false;
  inflight: Promise<unknown> | null = null;

  constructor(
    readonly operation: string,
    private readonly totalMs: number,
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

  /**
   * 操作全体を時間予算の下で実行する。期限超過（LabTimeoutError）なら、走っている単位の終了を猶予だけ待ち、
   * cleanupOnTimeout のときはラベル付きコンテナの停止・削除まで行って結果を error.cleanup に入れる。
   */
  private async guarded<T>(operation: string, totalMs: number, cleanupOnTimeout: boolean, fn: (b: OpBudget) => Promise<T>): Promise<T> {
    const b = new OpBudget(operation, totalMs);
    try {
      return await fn(b);
    } catch (e) {
      if (e instanceof LabTimeoutError && cleanupOnTimeout) {
        if (b.inflight) await Promise.race([b.inflight.catch(() => undefined), sleep(this.limits.abortGraceMs)]);
        e.cleanup = await this.cleanup();
      }
      throw e;
    }
  }

  /** 期限超過時の後始末：ラベル付きコンテナを停止して削除し、ラベル付きネットワークを削除する */
  async cleanup(): Promise<CleanupResult> {
    const r: CleanupResult = { ok: false, stoppedContainers: 0, removedContainers: 0, removedNetworks: 0, errors: [] };
    const work = (async () => {
      const containers = await this.labContainers();
      for (const c of containers) {
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
          r.errors.push(`remove ${c.Id.slice(0, 12)}: ${(e as Error).message}`);
        }
      }
      for (const n of await this.labNetworks()) {
        try {
          await this.docker.getNetwork(n.Id).remove();
          r.removedNetworks++;
        } catch (e) {
          r.errors.push(`remove network ${n.Name}: ${(e as Error).message}`);
        }
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`後始末が ${this.limits.cleanupMs}ms を超えた`)), this.limits.cleanupMs);
        }),
      ]);
    } catch (e) {
      r.errors.push((e as Error).message);
    } finally {
      clearTimeout(timer);
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

  private containerSpec(role: Role, netName: string, withOptionalSysctl: boolean): Docker.ContainerCreateOptions {
    const sysctls = role === 'client' ? { ...CLIENT_SYSCTLS } : undefined;
    if (sysctls && !withOptionalSysctl) delete sysctls[OPTIONAL_SYSCTL];
    return {
      Image: LAB_IMAGE,
      Cmd: ['sleep', 'infinity'],
      Hostname: role,
      Labels: { [LABEL_LAB]: LAB_ID, [LABEL_ROLE]: role },
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
      const c = await this.docker.createContainer(this.containerSpec(role, netName, true));
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
      const c = await this.docker.createContainer(this.containerSpec(role, netName, false));
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
        await this.docker.createNetwork({ Name: NETWORK_NAME, Driver: 'bridge', Internal: true, Labels: { [LABEL_LAB]: LAB_ID } });
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

  private async doReset(b: OpBudget) {
    await this.ensureDocker(b);
    return b.step('reset', this.limits.resetMs, async () => {
      const containers = await this.labContainers();
      for (const c of containers) {
        b.check();
        await this.docker.getContainer(c.Id).remove({ force: true });
      }
      const networks = await this.labNetworks();
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
