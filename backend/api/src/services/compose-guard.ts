/**
 * 直し回5（必須）：compose 定義のうち、ホストを操作できる設定（ホスト脱出経路）を作成前に拒否する。
 *
 * 判定は文字列の見た目ではなく、定義の解析結果に対して行う。
 * - YAML として解析した構造（短い書式・長い書式の volumes、アンカー・マージを展開した後の値）
 * - この API のパーサ（DockerComposeService.parseComposeYAML）が実際に Docker へ渡す bind mount の元パス
 * パスは正規化（..・.・重複スラッシュ・末尾スラッシュ）し、ホスト上で存在する部分はシンボリックリンクを解決した実体で比べる。
 *
 * 拒否するもの：
 * 1. Docker ソケットの bind mount（/var/run/docker.sock・/run/docker.sock・DOCKER_HOST 等のソケット、その別名・リンク・
 *    ハードリンク（同じ inode）、ソケットを含む親ディレクトリ（/、/run、/var/run 等）、名前が docker.sock のもの、
 *    Windows の名前付きパイプ docker_engine）。ボリュームの driver_opts.device、secrets/configs の file も同じに判定する。
 * 2. privileged: true
 * 3. host 名前空間の共有（network_mode・pid・ipc・uts・userns_mode・cgroup が host、または container:<他のコンテナ>）
 * 4. cap_add のうち、下の許可リストに無いもの（ALL・SYS_ADMIN・SYS_MODULE・SYS_RAWIO・DAC_READ_SEARCH 等）
 * 5. devices（ホストのデバイスを直接渡す）
 * それ以外（任意のイメージ・command・名前付きボリューム・通常のホストパス・ポート・環境変数）は従来どおり通す。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';

/**
 * cap_add で許可する権限。Docker の既定の14個（追加しても変化しない）と、学習用途で要るもの
 * （NET_ADMIN：ip/tc netem・iptables、SYS_PTRACE：strace・gdb、IPC_LOCK：mlock を使う DB 等、SYS_NICE：優先度の変更）。
 * これ以外（ALL を含む）は、ホストの制御に直結するか、隔離を弱めるため拒否する。
 */
export const ALLOWED_CAP_ADD: ReadonlySet<string> = new Set([
  // Docker の既定
  'AUDIT_WRITE',
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'FSETID',
  'KILL',
  'MKNOD',
  'NET_BIND_SERVICE',
  'NET_RAW',
  'SETFCAP',
  'SETGID',
  'SETPCAP',
  'SETUID',
  'SYS_CHROOT',
  // 学習用途
  'NET_ADMIN',
  'SYS_PTRACE',
  'IPC_LOCK',
  'SYS_NICE',
]);

/** host 名前空間の共有を判定するキー */
const NAMESPACE_KEYS = ['network_mode', 'pid', 'ipc', 'uts', 'userns_mode', 'cgroup'] as const;

export interface ComposeViolation {
  service?: string;
  field: string;
  detail: string;
}

/** compose 定義がホストを操作できる設定を含む。作成を開始せずに compose up を中止する */
export class ComposeDefinitionRejectedError extends Error {
  readonly code = 'COMPOSE_DEFINITION_REJECTED';
  constructor(readonly violations: ComposeViolation[]) {
    super(
      'compose 定義にホストを操作できる設定が含まれるため、作成を開始せずに中止しました（' +
        violations.map((v) => `${v.service ? `${v.service}.` : ''}${v.field}: ${v.detail}`).join('; ') +
        '）',
    );
    this.name = 'ComposeDefinitionRejectedError';
  }
}

/** 判定の環境（試験で差し替えられるよう分けてある） */
export interface SocketCheckEnv {
  /** 相対パスの基準 */
  cwd: string;
  homedir: string;
  /** Docker ソケットとして扱う追加のパス（DOCKER_HOST・dockerode の socketPath 等） */
  extraSockets: string[];
  realpath: (p: string) => string;
  /** シンボリックリンクの指す先（リンクでなければ例外）。リンク先が存在しない（realpath が失敗する）場合に使う */
  readlink: (p: string) => string;
  stat: (p: string) => { dev: number; ino: number } | null;
}

export function defaultSocketCheckEnv(extraSockets: string[] = []): SocketCheckEnv {
  const extra = [...extraSockets];
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost?.startsWith('unix://')) extra.push(dockerHost.slice('unix://'.length));
  if (process.env.XDG_RUNTIME_DIR) extra.push(path.posix.join(process.env.XDG_RUNTIME_DIR, 'docker.sock'));
  // Docker Desktop（macOS・Linux）のソケット。ホストに存在する場合だけ候補にする（ホームディレクトリ全体を親として拒否しないため）
  for (const p of ['.docker/run/docker.sock', '.docker/desktop/docker.sock']) {
    const full = path.posix.join(os.homedir(), p);
    if (fs.existsSync(full)) extra.push(full);
  }
  return {
    cwd: process.cwd(),
    homedir: os.homedir(),
    extraSockets: extra,
    realpath: (p) => fs.realpathSync(p),
    readlink: (p) => fs.readlinkSync(p),
    stat: (p) => {
      try {
        const s = fs.statSync(p);
        return { dev: s.dev, ino: s.ino };
      } catch {
        return null;
      }
    },
  };
}

const WELL_KNOWN_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'];

/**
 * 直し回7（必須1）：パスとして解釈を一致させられない文字列なら理由を返す（そうでなければ null）。
 * 検査に使う文字列は、実際に Docker・kubelet に渡す文字列そのものとし、検査側だけで書き換える（trim・置き換え等）ことはしない。
 * そのため、検査と実際の利用で解釈が分かれ得るものは、判定不能として拒否する。
 * - 前後の空白（Unicode の空白を含む）：以前は検査側だけ trim していたため、`/srv/alias `（ソケットへのリンク）を
 *   `/srv/alias` として調べ、Docker には空白付きのまま渡していた
 * - `\`：Linux では区切りではなくファイル名の文字（直し回6）
 * - 制御文字（改行・タブ・NUL 等）：表示・ログと実体が食い違い、途中で切り詰められ得る
 * - 空文字列
 */
export function uninterpretablePathReason(raw: string): string | null {
  // 直し回8（必須1）：空文字列・空白だけの文字列は、どの経路（compose の bind の全書式、既存コンテナの Mounts.Source、
  // Kubernetes の hostPath）でも呼び出し側で読み飛ばさず、ここで判定不能として拒否する
  if (raw === '') return '空のパスは指すものを判定できない';
  if (raw.trim() === '') return `${JSON.stringify(raw)} は空白だけのパスのため、指すものを判定できない`;
  if (raw !== raw.trim()) return `${JSON.stringify(raw)} は前後に空白を含むため、指すものを判定できない（検査と実際の利用で解釈が分かれ得る）`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) return `${JSON.stringify(raw)} は制御文字を含むため、指すものを判定できない`;
  if (raw.includes('\\')) return `${raw} は \\ を含むため、指すものを判定できない（Linux では区切りではなくファイル名の文字）`;
  return null;
}

/**
 * 字句上の候補：相対パスの解決・..／.／重複／末尾スラッシュの正規化（カーネルでも同じものを指す範囲の正規化だけ）。
 * 直し回7（必須1）：trim はしない（uninterpretablePathReason が前後の空白を先に拒否する）。
 * `~` は Docker・kubelet では展開されないが、compose の CLI 等が展開するため、元の文字列としての解決に加えて展開した形も
 * 候補にする（候補を増やすだけで、元の文字列の検査を置き換えない）。
 */
function lexicalCandidates(raw: string, env: SocketCheckEnv): string[] {
  const out = [path.posix.resolve(env.cwd, raw)];
  if (raw === '~' || raw.startsWith('~/')) out.push(path.posix.resolve(env.cwd, env.homedir + raw.slice(1)));
  return out;
}

/** /var/run は通常 /run へのシンボリックリンク。ホストで確かめられない場合も同じものとして扱う */
function aliasRun(p: string): string {
  if (p === '/var/run') return '/run';
  if (p.startsWith('/var/run/')) return `/run/${p.slice('/var/run/'.length)}`;
  return p;
}

/**
 * 存在する最長の前方部分のシンボリックリンクを解決し、残りを付け足す。リンク先が存在しない（宙に浮いた）リンクも、
 * リンクの指す先をたどって解決する（API のホストにソケットが無くても、Docker のホストでは存在し得るため）
 */
function realish(p: string, env: SocketCheckEnv, depth = 0): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = env.realpath(cur);
      return rest.length ? path.posix.join(real, ...[...rest].reverse()) : real;
    } catch {
      if (depth < 40) {
        try {
          const link = env.readlink(cur);
          const target = path.posix.resolve(path.posix.dirname(cur), link);
          return realish(rest.length ? path.posix.join(target, ...[...rest].reverse()) : target, env, depth + 1);
        } catch {
          // リンクではない、または存在しない
        }
      }
      if (cur === '/') return p;
      rest.push(path.posix.basename(cur));
      cur = path.posix.dirname(cur);
    }
  }
}

/** a が b と同じか、b の親ディレクトリ（祖先）か */
function sameOrAncestor(a: string, b: string): boolean {
  if (a === b || a === '/') return true;
  return b.startsWith(a.endsWith('/') ? a : `${a}/`);
}

/**
 * ホストパスが Docker ソケット（またはそれを含むディレクトリ）に解決されるなら理由を返す。そうでなければ null。
 */
export function dockerSocketReason(raw: string, env: SocketCheckEnv = defaultSocketCheckEnv()): string | null {
  // Windows の Docker Engine の名前付きパイプ（\\.\pipe\docker_engine 等）。拒否の理由を分かりやすくするためだけの判定で、
  // 通す方向には働かない（パイプの書き方は `\\` を含むので、下の判定不能でも拒否される）
  const slashed = raw.replace(/\\/g, '/').toLowerCase();
  if (/^\/\/[.?]\/pipe\/docker/.test(slashed) || slashed.includes('/pipe/docker_engine')) {
    return `${raw} は Docker Engine の名前付きパイプ`;
  }
  // 直し回6・7（必須1）：解釈を一致させられない文字列（`\`・前後の空白・制御文字等）は判定不能として拒否する。
  // 以後の判定（正規化・realpath・readlink・dev/inode）は、渡す文字列そのものに対して行う
  const uninterpretable = uninterpretablePathReason(raw);
  if (uninterpretable) return uninterpretable;
  const forms = new Set<string>();
  for (const lexical of lexicalCandidates(raw, env)) {
    const real = realish(lexical, env);
    for (const f of [lexical, real, aliasRun(lexical), aliasRun(real)]) forms.add(f);
  }

  const sockets = new Set<string>();
  for (const s of [...WELL_KNOWN_SOCKETS, ...env.extraSockets]) {
    const n = path.posix.resolve(env.cwd, s);
    sockets.add(n);
    sockets.add(aliasRun(n));
    const r = realish(n, env);
    sockets.add(r);
    sockets.add(aliasRun(r));
  }

  for (const f of forms) {
    if (path.posix.basename(f) === 'docker.sock') return `${raw} は Docker ソケット（${f}）`;
    for (const s of sockets) {
      if (f === s) return `${raw} は Docker ソケット（${s}）`;
      if (sameOrAncestor(f, s)) return `${raw}（${f}）は Docker ソケット ${s} を含むディレクトリ`;
    }
  }

  // ハードリンク等：同じ実体（デバイス・inode）
  for (const f of forms) {
    const st = env.stat(f);
    if (!st) continue;
    for (const s of sockets) {
      const ss = env.stat(s);
      if (ss && ss.dev === st.dev && ss.ino === st.ino) return `${raw} は Docker ソケット ${s} と同じ実体`;
    }
  }
  return null;
}

/**
 * compose の短い書式の volumes の元（`src:dst[:mode]`）が bind mount なら元パスを返す（名前付きボリュームは null）。
 * 直し回7（必須1）：spec を trim しない。元の部分に前後の空白・`\`・制御文字があれば、名前付きボリュームとは扱わず
 * そのまま返す（呼び出し側の dockerSocketReason が判定不能として拒否する）。
 */
function shortSyntaxBindSource(spec: string): string | null {
  // Windows のドライブ指定（C:\x:/y）
  const drive = spec.match(/^([A-Za-z]:[\\/][^:]*):/);
  const src = drive ? drive[1] : spec.split(':')[0];
  // 直し回8（必須1）：空・空白だけの元（`:/var/run/docker.sock` 等）も読み飛ばさず返す（呼び出し側が判定不能として拒否する）
  if (uninterpretablePathReason(src)) return src;
  if (src.startsWith('/') || src.startsWith('.') || src.startsWith('~') || drive) return src;
  // 区切りが無い（`- /data` のような匿名ボリューム）は bind ではない
  return null;
}

function isTruthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return ['true', 'yes', 'on', '1'].includes(v.trim().toLowerCase());
  return false;
}

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * YAML として解析した compose 定義を検査する。解析できない（YAML として不正、複数ドキュメント、マッピングでない）場合も、
 * 判定できないため拒否する。
 */
export function inspectComposeDefinition(composeYaml: string, env: SocketCheckEnv = defaultSocketCheckEnv()): ComposeViolation[] {
  let doc: unknown;
  try {
    doc = yaml.load(composeYaml);
  } catch (error) {
    return [{ field: '(定義)', detail: `YAML として解析できないため判定できない（${error instanceof Error ? error.message.split('\n')[0] : String(error)}）` }];
  }
  if (!isRecord(doc)) return [{ field: '(定義)', detail: 'マッピング（キーと値）の形でないため判定できない' }];

  const out: ComposeViolation[] = [];
  const checkPath = (service: string | undefined, field: string, p: unknown) => {
    // 直し回7（必須1）：空白だけの文字列も読み飛ばさず、dockerSocketReason（判定不能として拒否）に渡す
    if (p === undefined || p === null) return;
    if (typeof p !== 'string') {
      out.push({ service, field, detail: '文字列でないため判定できない' });
      return;
    }
    const reason = dockerSocketReason(p, env);
    if (reason) out.push({ service, field, detail: reason });
  };

  const services = doc.services;
  if (services !== undefined && services !== null && !isRecord(services)) {
    out.push({ field: 'services', detail: 'マッピングでないため判定できない' });
  }
  for (const [name, svc] of Object.entries(isRecord(services) ? services : {})) {
    if (!isRecord(svc)) continue;

    for (const vol of asList(svc.volumes)) {
      if (typeof vol === 'string') {
        const src = shortSyntaxBindSource(vol);
        if (src !== null) checkPath(name, 'volumes', src);
      } else if (isRecord(vol)) {
        // 長い書式：type が bind でなくても source がホストパスの形なら判定する（見た目の type で見逃さない）
        const src = vol.source ?? vol.src;
        // 直し回8（必須1）：空・空白だけの source も判定不能として拒否する（shortSyntaxBindSource が '' を返すため null と比べる）
        if (typeof src === 'string') {
          if (vol.type === 'bind' || shortSyntaxBindSource(`${src}:x`) !== null) checkPath(name, 'volumes', src);
        } else if (src !== undefined && src !== null) {
          // 直し回9（必須）：文字列でない source（数値・オブジェクト・配列・真偽値等）は、type によらず判定不能として拒否する
          // （checkPath が「文字列でないため判定できない」を記録する）
          checkPath(name, 'volumes', src);
        } else if (vol.type === 'bind' || vol.type === 'npipe') {
          // 直し回9（必須）：ホストのパスを元に持つ種別で source が欠落・null のものも、元を判定できないため拒否する。
          // volume（匿名ボリューム）・tmpfs 等は source が無いことが正常なので従来どおり通す
          out.push({ service: name, field: 'volumes', detail: `type: ${vol.type} の source が無い（欠落・null）ため、元を判定できない` });
        }
      }
    }

    if (isTruthy(svc.privileged)) out.push({ service: name, field: 'privileged', detail: 'privileged: true はホストの全デバイス・全権限を渡す' });

    for (const key of NAMESPACE_KEYS) {
      const v = svc[key];
      if (typeof v !== 'string') continue;
      const lv = v.trim().toLowerCase();
      if (lv === 'host') out.push({ service: name, field: key, detail: `${key}: host はホストの名前空間を共有する` });
      else if (lv.startsWith('container:')) out.push({ service: name, field: key, detail: `${key}: ${v} は他のコンテナの名前空間を共有する` });
    }

    for (const cap of asList(svc.cap_add)) {
      const c = String(cap).trim().toUpperCase().replace(/^CAP_/, '');
      if (!ALLOWED_CAP_ADD.has(c)) out.push({ service: name, field: 'cap_add', detail: `${String(cap)} は許可していない権限（ホストの制御に直結する）` });
    }

    if (asList(svc.devices).length > 0) out.push({ service: name, field: 'devices', detail: 'ホストのデバイスを直接渡す' });
  }

  // 名前付きボリュームの driver_opts（type: none, o: bind, device: /var/run 等）と secrets/configs の file
  for (const [vname, v] of Object.entries(isRecord(doc.volumes) ? doc.volumes : {})) {
    if (isRecord(v) && isRecord(v.driver_opts)) checkPath(undefined, `volumes.${vname}.driver_opts.device`, v.driver_opts.device);
  }
  for (const top of ['secrets', 'configs'] as const) {
    for (const [k, v] of Object.entries(isRecord(doc[top]) ? doc[top] : {})) {
      if (isRecord(v)) checkPath(undefined, `${top}.${k}.file`, v.file);
    }
  }
  return out;
}

/**
 * この API のパーサの結果から Docker に渡す bind mount の元パスを検査する（YAML の解析と食い違っても、実際に渡すものを判定する）。
 * binds は composeUp が HostConfig.Binds に入れるものと同じ形（`src:dst[:mode]`）。
 */
export function inspectBinds(service: string, binds: string[], env: SocketCheckEnv = defaultSocketCheckEnv()): ComposeViolation[] {
  const out: ComposeViolation[] = [];
  for (const b of binds) {
    // 直し回6（必須1）：Docker（Linux）が Binds を解釈するのと同じく、最初の `:` までを元パスとして調べる。
    // 短い書式の解釈（Windows のドライブ指定を含む）と食い違う場合に備え、両方を調べる。
    // 直し回7（必須1）：元の部分は書き換えずに渡す。解釈を一致させられない文字（前後の空白・`\`・制御文字）を含めば、
    // 名前付きボリュームの形でも判定不能として拒否する
    const sources = new Set<string>();
    // 直し回8（必須1）：空・空白だけの元パスも読み飛ばさない（'' は null と区別して扱う）
    const src = shortSyntaxBindSource(b);
    if (src !== null) sources.add(src);
    const dockerSrc = b.split(':')[0];
    if ((dockerSrc.startsWith('/') || dockerSrc.startsWith('.') || uninterpretablePathReason(dockerSrc))) sources.add(dockerSrc);
    for (const p of sources) {
      const reason = dockerSocketReason(p, env);
      if (reason) out.push({ service, field: 'volumes', detail: reason });
    }
  }
  return out;
}
