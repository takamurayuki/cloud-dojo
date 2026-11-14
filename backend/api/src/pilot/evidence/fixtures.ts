/**
 * フィクスチャ証拠：実測と同じ形式（tcpdump -nn -tt / ss -tan / curl -w）のテキストを生成する。
 * Docker が無い環境での練習表示と、判定ロジックの自動テストに使う。
 * フィクスチャ由来の証拠は origin='fixture' として保存され、単元の完了条件を満たさない。
 */
import type { EvidenceKind } from '../curriculum/schema';
import { LAB_PORT, SERVER_DELAY_SEC } from './parse';

const CLIENT = '172.30.0.2';
const SERVER = '172.30.0.3';
const BASE_T = 1794643200;

function pkt(t: number, from: 'c' | 's', sport: number, flags: string, rest: string): string {
  const [src, sp, dst, dp] = from === 'c' ? [CLIENT, sport, SERVER, LAB_PORT] : [SERVER, LAB_PORT, CLIENT, sport];
  return `${(BASE_T + t).toFixed(6)} IP ${src}.${sp} > ${dst}.${dp}: Flags [${flags}], ${rest}`;
}

const SS_HEADER = 'State      Recv-Q Send-Q   Local Address:Port    Peer Address:Port Process';

function ssRow(state: string, local: string, peer: string, sendQ = 0): string {
  return `${state.padEnd(10)} 0      ${String(sendQ).padEnd(8)} ${local.padStart(19)} ${peer.padStart(20)}`;
}

export function fixtureEvidence(portState: string, connectTimeoutSec: number): Record<EvidenceKind, string> {
  const sport = 45678;
  const synOpts = 'options [mss 1460,sackOK,TS val 1000 ecr 0,nop,wscale 7], length 0';
  if (portState === 'open') {
    const d = SERVER_DELAY_SEC;
    return {
      tcpdump: [
        pkt(0.0001, 'c', sport, 'S', `seq 1047265311, win 64240, ${synOpts}`),
        pkt(0.00015, 's', sport, 'S.', 'seq 3307811520, ack 1047265312, win 65160, options [mss 1460,sackOK,TS val 2000 ecr 1000,nop,wscale 7], length 0'),
        pkt(0.00017, 'c', sport, '.', 'ack 1, win 502, options [nop,nop,TS val 1000 ecr 2000], length 0'),
        pkt(0.0002, 'c', sport, 'P.', 'seq 1:78, ack 1, win 502, options [nop,nop,TS val 1000 ecr 2000], length 77: HTTP: GET / HTTP/1.1'),
        pkt(0.00021, 's', sport, '.', 'ack 78, win 509, options [nop,nop,TS val 2000 ecr 1000], length 0'),
        pkt(d + 0.002, 's', sport, 'P.', 'seq 1:157, ack 78, win 509, options [nop,nop,TS val 3500 ecr 1000], length 156: HTTP: HTTP/1.0 200 OK'),
        pkt(d + 0.0021, 's', sport, 'F.', 'seq 157, ack 78, win 509, options [nop,nop,TS val 3500 ecr 1000], length 0'),
        pkt(d + 0.0022, 'c', sport, '.', 'ack 157, win 501, options [nop,nop,TS val 2500 ecr 3500], length 0'),
        pkt(d + 0.0025, 'c', sport, 'F.', 'seq 78, ack 158, win 501, options [nop,nop,TS val 2500 ecr 3500], length 0'),
        pkt(d + 0.0026, 's', sport, '.', 'ack 79, win 509, options [nop,nop,TS val 3500 ecr 2500], length 0'),
        '',
        '10 packets captured',
      ].join('\n'),
      'ss-client': [SS_HEADER, ssRow('ESTAB', `${CLIENT}:${sport}`, `${SERVER}:${LAB_PORT}`)].join('\n'),
      'ss-server': [
        SS_HEADER,
        ssRow('LISTEN', `0.0.0.0:${LAB_PORT}`, '0.0.0.0:*', 5),
        ssRow('TIME-WAIT', `${SERVER}:${LAB_PORT}`, `${CLIENT}:${sport}`),
      ].join('\n'),
      curl: `time_total=${(d + 0.0031).toFixed(6)} http_code=200\nexit=0`,
    };
  }
  if (portState === 'closed') {
    return {
      tcpdump: [
        pkt(0.0001, 'c', sport, 'S', `seq 1047265311, win 64240, ${synOpts}`),
        pkt(0.00013, 's', sport, 'R.', 'seq 0, ack 1047265312, win 0, length 0'),
        '',
        '2 packets captured',
      ].join('\n'),
      'ss-client': SS_HEADER,
      'ss-server': SS_HEADER,
      curl: `time_total=0.000912 http_code=000\nexit=7\ncurl: (7) Failed to connect to server port ${LAB_PORT} after 0 ms: Couldn't connect to server`,
    };
  }
  // drop
  const sendTimes = [0, 1, 3, 7, 15, 31, 63].filter((t) => t < connectTimeoutSec);
  const lines = sendTimes.map((t, i) => pkt(t + 0.0001 + i * 0.00002, 'c', sport, 'S', `seq 1047265311, win 64240, ${synOpts}`));
  return {
    tcpdump: [...lines, '', `${lines.length} packets captured`].join('\n'),
    'ss-client': [SS_HEADER, ssRow('SYN-SENT', `${CLIENT}:${sport}`, `${SERVER}:${LAB_PORT}`, 1)].join('\n'),
    'ss-server': [SS_HEADER, ssRow('LISTEN', `0.0.0.0:${LAB_PORT}`, '0.0.0.0:*', 5)].join('\n'),
    curl: `time_total=${(connectTimeoutSec + 0.0012).toFixed(6)} http_code=000\nexit=28\ncurl: (28) Failed to connect to server port ${LAB_PORT} after ${connectTimeoutSec * 1000} ms: Timeout was reached`,
  };
}
