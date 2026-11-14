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

/**
 * 単元の内部機構から期待される観察結果（ラボが条件どおりに構成されたかの整合確認に使う）。
 * 正誤判定の正解には使わない。正解は常に observe() の結果。
 */
export function expectedFromMechanism(portState: string, connectTimeoutSec: number): Observed {
  if (portState === 'open') {
    return { curlResult: 'connected', synReply: 'syn-ack', synCount: '1', clientState: 'ESTAB', serverState: 'TIME-WAIT', duration: 'server-delay' };
  }
  if (portState === 'closed') {
    return { curlResult: 'refused', synReply: 'rst', synCount: '1', clientState: 'none', serverState: 'none', duration: 'immediate' };
  }
  // drop：Linux の SYN 再送は初期RTO 1秒で倍々（0,1,3,7,15,31,63 秒）。タイムアウトより前に送られる回数
  const sendTimes = [0, 1, 3, 7, 15, 31, 63];
  const n = sendTimes.filter((t) => t < connectTimeoutSec).length;
  return { curlResult: 'timeout', synReply: 'none', synCount: n >= 5 ? '5+' : String(n), clientState: 'SYN-SENT', serverState: 'LISTEN', duration: 'connect-timeout' };
}
