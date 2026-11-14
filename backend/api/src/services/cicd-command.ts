/**
 * CI/CD の real 実行で実際に動かしてよいコマンドの判定（直し回4・必須）。
 *
 * 以前は `command.startsWith(safe)` の前方一致で判定し、文字列全体をシェル（child_process.exec）に渡していた。
 * そのため `echo allowed; docker rm -f <ID>` のような連結が許可され、パイロットのラボ保護（ラベル判定）を通らずに
 * コンテナを削除できた。ここでは次の3つで塞ぐ。
 *
 * 1. シェルのメタ文字（; & | ` $ ( ) < > 改行・CR・バックスラッシュ）を1文字でも含むコマンドは、実行せずに拒否する。
 * 2. 残りを単純な規則（空白区切り、'…' と "…" の引用だけ）で引数の配列に分け、許可パターンと**引数の配列全体**で照合する。
 *    前方一致ではないので、`lsof` や `datex` のような別コマンド、`docker --version` の後ろに何か足したものは通らない。
 * 3. 実行は execFile（shell: false）で、コマンドと引数を分けて渡す。シェルを介さないので、引数の中の文字は
 *    展開・連結・リダイレクトされず、ただの文字列としてそのコマンドに渡る。
 *
 * docker で許可するのは `docker --version` の完全一致だけなので、この経路で `docker rm` / `docker stop` 等は実行できない。
 * echo・ls・pwd・date・whoami は他のプログラムを起動しない。
 */

/** 実行に使うプログラムと引数 */
export interface RealCommand {
  file: string;
  args: string[];
}

export type CommandCheck =
  | { kind: 'allowed'; command: RealCommand }
  /** シェルのメタ文字・閉じていない引用を含む。real 実行では実行しない（ステップを失敗させる） */
  | { kind: 'rejected'; reason: string }
  /** 許可パターンに一致しない（従来どおり模擬で扱う） */
  | { kind: 'not-allowed' };

/** real 実行で拒否するシェルのメタ文字（連結・置換・リダイレクト・改行・エスケープ） */
const SHELL_META = /[;&|`$()<>\n\r\\]/;

/** 引数1つの許可条件 */
type ArgRule = (arg: string) => boolean;

interface Pattern {
  file: string;
  /** 固定の引数列（完全一致） */
  fixed?: string[];
  /** 可変の引数を許す場合の条件（全引数がこれを満たすこと） */
  each?: ArgRule;
  /** 可変の引数の最大個数 */
  maxArgs?: number;
}

/** 相対パス（先頭が / でも - でもなく、.. を含まない） */
const relativePath: ArgRule = (a) => a.length > 0 && !a.startsWith('/') && !a.startsWith('-') && !a.split('/').includes('..');
/** ls の短いオプション（-l, -la, -1 など） */
const lsFlag: ArgRule = (a) => /^-[alhAR1tSrF]+$/.test(a);

/**
 * 許可パターン。以前の前方一致リスト
 * （echo / node --version / npm --version / pnpm --version / docker --version / git --version / ls / pwd / date / whoami）
 * を、引数の配列で表したもの。
 */
const PATTERNS: Pattern[] = [
  { file: 'echo', each: () => true, maxArgs: 64 },
  { file: 'node', fixed: ['--version'] },
  { file: 'npm', fixed: ['--version'] },
  { file: 'pnpm', fixed: ['--version'] },
  { file: 'docker', fixed: ['--version'] },
  { file: 'git', fixed: ['--version'] },
  { file: 'ls', each: (a) => lsFlag(a) || relativePath(a), maxArgs: 8 },
  { file: 'pwd', fixed: [] },
  { file: 'date', each: (a) => /^\+[^\s]*$/.test(a), maxArgs: 1 },
  { file: 'whoami', fixed: [] },
];

/**
 * 空白で区切り、'…' と "…" の引用をまとめて1引数にする。
 * 閉じていない引用は null。（メタ文字は呼ぶ前に除いてあるので、$ や ` の展開・エスケープは考えなくてよい）
 */
export function splitArgs(command: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) out.push(cur);
      cur = '';
      inToken = false;
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (quote) return null;
  if (inToken) out.push(cur);
  return out;
}

function matches(p: Pattern, args: string[]): boolean {
  if (p.fixed) return args.length === p.fixed.length && p.fixed.every((a, i) => args[i] === a);
  if (p.each) return args.length <= (p.maxArgs ?? Infinity) && args.every(p.each);
  return args.length === 0;
}

/** 1行のコマンドを判定する */
export function checkRealCommand(command: string): CommandCheck {
  const line = command.trim();
  const meta = line.match(SHELL_META);
  if (meta) {
    const shown = meta[0] === '\n' ? '改行' : meta[0] === '\r' ? 'CR' : meta[0];
    return { kind: 'rejected', reason: `シェルのメタ文字（${shown}）を含むため、real 実行では実行しません` };
  }
  const argv = splitArgs(line);
  if (!argv) return { kind: 'rejected', reason: '引用符が閉じていないため、real 実行では実行しません' };
  if (argv.length === 0) return { kind: 'not-allowed' };
  const [file, ...args] = argv;
  const pattern = PATTERNS.find((p) => p.file === file && matches(p, args));
  return pattern ? { kind: 'allowed', command: { file, args } } : { kind: 'not-allowed' };
}

/**
 * ステップの env のうち、許可したプログラムの探索先や読み込むコードを変えられるものは渡さない
 * （例：PATH を変えると `ls` が別のプログラムになる。NODE_OPTIONS / LD_PRELOAD は任意のコードを読み込ませる）。
 */
const BLOCKED_ENV = /^(PATH|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELL|IFS|GIT_.*|NPM_CONFIG_.*|npm_config_.*|DOCKER_.*)$/;

export function sanitizeStepEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!BLOCKED_ENV.test(k)) out[k] = String(v);
  }
  return out;
}
