/**
 * 観察証拠（実測形式のテキスト）の解析。実測でもフィクスチャでも同じ解析器を通す。
 * 予測の正解はここで証拠から算出する（条件やシードからは算出しない）。
 */
import type { EvidenceKind } from '../curriculum/schema';

export const LAB_PORT = 8080;
/** ラボの server が応答前に待つ秒数（labs/n5-tcp/server.py と一致させる） */
export const SERVER_DELAY_SEC = 1.5;

export interface TcpPacket {
  t: number;
  src: string;
  srcPort: number;
  dst: string;
  dstPort: number;
  flags: string;
}

const TCPDUMP_LINE = /^(\d+(?:\.\d+)?)\s+IP6?\s+(\S+)\.(\d+)\s+>\s+(\S+)\.(\d+):\s+Flags\s+\[([^\]]*)\]/;

export function parseTcpdump(text: string): TcpPacket[] {
  const packets: TcpPacket[] = [];
  for (const line of text.split('\n')) {
    const m = TCPDUMP_LINE.exec(line.trim());
    if (!m) continue;
    packets.push({ t: Number(m[1]), src: m[2], srcPort: Number(m[3]), dst: m[4], dstPort: Number(m[5]), flags: m[6] });
  }
  return packets;
}

export interface SsRow {
  state: string;
  local: string;
  localPort: number;
  peer: string;
  peerPort: number;
}

function splitHostPort(addr: string): [string, number] {
  const i = addr.lastIndexOf(':');
  const port = addr.slice(i + 1);
  return [addr.slice(0, i), port === '*' ? 0 : Number(port)];
}

/** `ss -tan` の出力（見出し行あり）を解析する */
export function parseSs(text: string): SsRow[] {
  const rows: SsRow[] = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] === 'State' || cols[0] === 'Netid') continue;
    const [local, localPort] = splitHostPort(cols[3]);
    const [peer, peerPort] = splitHostPort(cols[4]);
    if (Number.isNaN(localPort) || Number.isNaN(peerPort)) continue;
    rows.push({ state: cols[0], local, localPort, peer, peerPort });
  }
  return rows;
}

export interface CurlResult {
  timeTotal: number;
  httpCode: string;
  exitCode: number;
}

export function parseCurl(text: string): CurlResult | null {
  const time = /time_total=([\d.]+)/.exec(text);
  const exit = /exit=(\d+)/.exec(text);
  if (!time || !exit) return null;
  const code = /http_code=(\d+)/.exec(text);
  return { timeTotal: Number(time[1]), httpCode: code ? code[1] : '000', exitCode: Number(exit[1]) };
}

/** 証拠から算出した観察結果。キーは単元の予測項目 id と一致する */
export type Observed = Record<string, string>;

export interface ObservationDetail {
  observed: Observed;
  /** 各項目を算出できなかった理由（証拠不足・解析不能） */
  missing: string[];
  synTimes: number[];
  curl: CurlResult | null;
}

/**
 * 証拠一式から観察結果を算出する。
 * @param connectTimeoutSec 試行で curl に渡した --connect-timeout（所要時間の分類に使う既知の入力）
 */
export function observe(evidence: Partial<Record<EvidenceKind, string>>, connectTimeoutSec: number): ObservationDetail {
  const observed: Observed = {};
  const missing: string[] = [];
  let synTimes: number[] = [];

  if (evidence.tcpdump !== undefined) {
    const pkts = parseTcpdump(evidence.tcpdump);
    const syns = pkts.filter((p) => p.dstPort === LAB_PORT && p.flags === 'S');
    synTimes = syns.map((p) => Number((p.t - (syns[0]?.t ?? 0)).toFixed(3)));
    if (syns.length === 0) {
      missing.push('tcpdump: client→server の SYN が記録されていない');
    } else {
      observed.synCount = syns.length >= 5 ? '5+' : String(syns.length);
      const reply = pkts.find((p) => p.srcPort === LAB_PORT && p.t >= syns[0].t);
      observed.synReply = !reply ? 'none' : reply.flags.includes('R') ? 'rst' : reply.flags.includes('S') ? 'syn-ack' : `other:${reply.flags}`;
    }
  } else {
    missing.push('tcpdump: 証拠なし');
  }

  if (evidence['ss-client'] !== undefined) {
    const rows = parseSs(evidence['ss-client']).filter((r) => r.peerPort === LAB_PORT);
    observed.clientState = rows.length === 0 ? 'none' : rows[0].state;
  } else {
    missing.push('ss-client: 証拠なし');
  }

  if (evidence['ss-server'] !== undefined) {
    const rows = parseSs(evidence['ss-server']).filter((r) => r.localPort === LAB_PORT);
    observed.serverState = rows.some((r) => r.state === 'TIME-WAIT') ? 'TIME-WAIT' : rows.some((r) => r.state === 'LISTEN') ? 'LISTEN' : rows.length === 0 ? 'none' : `other:${rows[0].state}`;
  } else {
    missing.push('ss-server: 証拠なし');
  }

  let curl: CurlResult | null = null;
  if (evidence.curl !== undefined) {
    curl = parseCurl(evidence.curl);
    if (!curl) {
      missing.push('curl: 出力を解析できない');
    } else {
      observed.curlResult = curl.exitCode === 0 ? 'connected' : curl.exitCode === 7 ? 'refused' : curl.exitCode === 28 ? 'timeout' : `exit-${curl.exitCode}`;
      if (curl.timeTotal < 0.3) {
        observed.duration = 'immediate';
      } else {
        const dDelay = Math.abs(curl.timeTotal - SERVER_DELAY_SEC);
        const dTimeout = Math.abs(curl.timeTotal - connectTimeoutSec);
        observed.duration = dTimeout < dDelay ? 'connect-timeout' : 'server-delay';
      }
    }
  } else {
    missing.push('curl: 証拠なし');
  }

  return { observed, missing, synTimes, curl };
}

// ---------------------------------------------------------------------------
// SYN 再送の前提（ラボの client の実行環境）
//
// Linux の SYN 再送間隔は sysctl で変わる：
//   - net.ipv4.tcp_syn_linear_timeouts（L）：最初の L 回の再送は初期RTO（1秒）間隔のまま（線形）。
//     その後は初期RTO×2^0, 2^1, … と倍々になる。既定値 4 の場合、間隔は 1,1,1,1,1,2,4…秒。
//     この sysctl が無い（導入前の）カーネルは L=0 と同じ倍々のみの挙動。
//   - net.ipv4.tcp_syn_retries（R）：再送の上限回数（既定 6）。
// ラボは client コンテナで L=0・R=6 を明示設定し（runner.ts の CLIENT_SYSCTLS）、実際の値を証拠
// 「lab-env」として記録する。整合判定は記録された値から導いた期待スケジュールと実測を照合する。
// ---------------------------------------------------------------------------

/** Linux の初期再送タイムアウト（TCP_TIMEOUT_INIT、秒）。カーネル定数 */
export const INITIAL_RTO_SEC = 1;

export interface SynEnv {
  /** net.ipv4.tcp_syn_linear_timeouts の実効値 */
  linearTimeouts: number;
  /** sysctl が存在して値を読めたか（false＝導入前のカーネルで、実効値は 0） */
  linearTimeoutsRecorded: boolean;
  /** net.ipv4.tcp_syn_retries */
  synRetries: number;
  /** uname -r（記録のみ。判定には使わない） */
  osRelease: string | null;
}

/** 教材本文・反事実・フィクスチャが前提とする環境（ラボが client に設定する値） */
export const LAB_SYN_PREMISE = { linearTimeouts: 0, synRetries: 6 } as const;

export const PREMISE_ENV: SynEnv = { ...LAB_SYN_PREMISE, linearTimeoutsRecorded: true, osRelease: null };

/** 証拠「lab-env」（client-run.sh が出力する key=value 行）を解析する */
export function parseLabEnv(text: string): { env: SynEnv | null; problems: string[] } {
  const kv = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*([a-z0-9_.]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) kv.set(m[1], m[2]);
  }
  const problems: string[] = [];
  const lin = kv.get('net.ipv4.tcp_syn_linear_timeouts');
  const ret = kv.get('net.ipv4.tcp_syn_retries');
  let linearTimeouts = 0;
  let linearTimeoutsRecorded = false;
  if (lin === undefined) problems.push('lab-env: net.ipv4.tcp_syn_linear_timeouts の記録が無い');
  else if (lin === 'absent') linearTimeoutsRecorded = false;
  else if (/^\d+$/.test(lin)) {
    linearTimeouts = Number(lin);
    linearTimeoutsRecorded = true;
  } else problems.push(`lab-env: net.ipv4.tcp_syn_linear_timeouts の値を解析できない（${lin}）`);
  let synRetries = 0;
  if (ret === undefined || !/^\d+$/.test(ret)) problems.push(`lab-env: net.ipv4.tcp_syn_retries を解析できない（${ret ?? '記録なし'}）`);
  else synRetries = Number(ret);
  if (problems.length) return { env: null, problems };
  return { env: { linearTimeouts, linearTimeoutsRecorded, synRetries, osRelease: kv.get('kernel.osrelease') ?? null }, problems };
}

/** 設定値から SYN の送信時刻（最初の SYN を 0 秒とする、再送上限まで全て）を導く */
export function synSchedule(env: Pick<SynEnv, 'linearTimeouts' | 'synRetries'>): number[] {
  const times = [0];
  let t = 0;
  for (let i = 0; i < env.synRetries; i++) {
    t += i < env.linearTimeouts ? INITIAL_RTO_SEC : INITIAL_RTO_SEC * 2 ** (i - env.linearTimeouts);
    times.push(t);
  }
  return times;
}

/** 再送上限に達した後、カーネルが接続を諦める時刻（最後の SYN の後にもう1回分待つ） */
export function synGiveUpSec(env: Pick<SynEnv, 'linearTimeouts' | 'synRetries'>): number {
  const r = env.synRetries;
  const last = synSchedule(env).at(-1)!;
  return last + (r < env.linearTimeouts ? INITIAL_RTO_SEC : INITIAL_RTO_SEC * 2 ** (r - env.linearTimeouts));
}

/** タイムアウト境界付近の SYN は送られるかどうかが揺れるため、両方を許容する幅（秒） */
export const SYN_BOUNDARY_MARGIN_SEC = 0.25;

const synCountLabel = (n: number) => (n >= 5 ? '5+' : String(n));

export interface MechanismExpectation {
  /** 項目ごとの許容値（複数あるのはタイムアウト境界の揺れを許容する場合） */
  expected: Record<string, string[]>;
  /** drop のときの期待送信時刻（connect-timeout より前のもの）。open/closed は [0] */
  synSchedule: number[];
  env: SynEnv;
}

/**
 * 単元の内部機構と、記録された実行環境の設定から期待される観察結果（ラボが条件どおりに
 * 構成されたかの整合確認に使う）。正誤判定の正解には使わない。正解は常に observe() の結果。
 */
export function expectedFromMechanism(portState: string, connectTimeoutSec: number, env: SynEnv): MechanismExpectation {
  if (portState === 'open') {
    return { env, synSchedule: [0], expected: { curlResult: ['connected'], synReply: ['syn-ack'], synCount: ['1'], clientState: ['ESTAB'], serverState: ['TIME-WAIT'], duration: ['server-delay'] } };
  }
  if (portState === 'closed') {
    return { env, synSchedule: [0], expected: { curlResult: ['refused'], synReply: ['rst'], synCount: ['1'], clientState: ['none'], serverState: ['none'], duration: ['immediate'] } };
  }
  // drop：記録された設定から送信時刻を導き、connect-timeout より前に送られる回数を数える
  const all = synSchedule(env);
  const sure = all.filter((t) => t < connectTimeoutSec - SYN_BOUNDARY_MARGIN_SEC).length;
  const maybe = all.filter((t) => t < connectTimeoutSec + SYN_BOUNDARY_MARGIN_SEC).length;
  const counts = [...new Set(Array.from({ length: maybe - sure + 1 }, (_, i) => synCountLabel(sure + i)))];
  const expected: Record<string, string[]> = { synReply: ['none'], synCount: counts, clientState: ['SYN-SENT'], serverState: ['LISTEN'] };
  // カーネルが connect-timeout より先に諦める設定では curl の結果・所要時間は別になるので照合しない
  if (synGiveUpSec(env) > connectTimeoutSec + SYN_BOUNDARY_MARGIN_SEC) {
    expected.curlResult = ['timeout'];
    expected.duration = ['connect-timeout'];
  }
  return { env, synSchedule: all.filter((t) => t < connectTimeoutSec + SYN_BOUNDARY_MARGIN_SEC), expected };
}

/** 再送時刻の許容誤差（秒）：0.3 秒か期待時刻の 10% の大きい方 */
export const synTimeTolerance = (expectedSec: number) => Math.max(0.3, expectedSec * 0.1);

/** 期待（記録された設定から導出）と、証拠から算出した観察結果を照合する */
export function checkConsistency(exp: MechanismExpectation, detail: Pick<ObservationDetail, 'observed' | 'synTimes'>): { consistent: boolean; issues: string[] } {
  const issues: string[] = [];
  for (const [k, vs] of Object.entries(exp.expected)) {
    const got = detail.observed[k];
    if (got === undefined || !vs.includes(got)) issues.push(`${k}: 期待 ${vs.join('|')}、観察 ${got ?? '算出不可'}`);
  }
  detail.synTimes.forEach((t, i) => {
    const e = exp.synSchedule[i];
    if (e === undefined) issues.push(`SYN#${i + 1}: 期待スケジュールに無い送信（${t.toFixed(3)} 秒）`);
    else if (Math.abs(t - e) > synTimeTolerance(e)) issues.push(`SYN#${i + 1}: 期待 ${e} 秒、観察 ${t.toFixed(3)} 秒`);
  });
  return { consistent: issues.length === 0, issues };
}

/** 記録された環境が、教材本文・予測問題の前提（LAB_SYN_PREMISE）と一致しているか */
export function envMatchesPremise(env: SynEnv): boolean {
  return env.linearTimeouts === LAB_SYN_PREMISE.linearTimeouts && env.synRetries === LAB_SYN_PREMISE.synRetries;
}

/** lab-env 証拠のテキスト形式（client-run.sh の出力と同じ） */
export function formatLabEnv(env: SynEnv): string {
  return [
    `net.ipv4.tcp_syn_linear_timeouts=${env.linearTimeoutsRecorded ? env.linearTimeouts : 'absent'}`,
    `net.ipv4.tcp_syn_retries=${env.synRetries}`,
    `kernel.osrelease=${env.osRelease ?? 'unknown'}`,
  ].join('\n');
}
