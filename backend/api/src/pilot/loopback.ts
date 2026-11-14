/**
 * 接続元の loopback 制限（decision.md §5：API は 127.0.0.1 のみ）。
 *
 * 判定は TCP の実際の接続元（req.ip。trustProxy は使わない）で行う。転送ヘッダで接続元を loopback に
 * 見せかけることはできない（ヘッダは「拒否する理由」にだけ使い、「許可する理由」には使わない）。
 * そのうえで、接続元が loopback でも、プロキシの転送ヘッダ（X-Forwarded-For・X-Real-IP・Forwarded）に
 * loopback 以外の元の接続元があれば拒否する（別端末 → Vite 開発サーバのプロキシ → API という迂回を塞ぐ）。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopback = (ip: string | undefined): boolean =>
  typeof ip === 'string' && (LOOPBACK.has(ip) || /^127\.\d+\.\d+\.\d+$/.test(ip) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(ip));

/** 転送ヘッダの1要素（"[::1]:1234"・"1.2.3.4:5678"・'"::1"' など）からアドレスだけを取り出す */
function stripAddr(raw: string): string {
  let v = raw.trim().replace(/^"|"$/g, '');
  if (v.startsWith('[')) return v.slice(1, v.indexOf(']') > 0 ? v.indexOf(']') : undefined);
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(':'));
  return v;
}

/**
 * プロキシが付けた転送ヘッダ（X-Forwarded-For・X-Real-IP・Forwarded）に記録された元の接続元。
 * Vite の開発サーバ等のプロキシ経由で届いた要求は TCP 上は loopback に見えるため、元の接続元も検査する。
 */
export function forwardedClients(headers: Record<string, string | string[] | undefined>): string[] {
  const all = (h: string | string[] | undefined) => (h === undefined ? [] : Array.isArray(h) ? h : [h]);
  const out: string[] = [];
  for (const v of all(headers['x-forwarded-for'])) out.push(...v.split(',').map(stripAddr).filter(Boolean));
  for (const v of all(headers['x-real-ip'])) out.push(stripAddr(v));
  for (const v of all(headers.forwarded)) {
    for (const m of v.matchAll(/for=("[^"]*"|[^;,\s]+)/gi)) out.push(stripAddr(m[1]));
  }
  return out;
}

/** 要求が loopback 以外から届いたか（実際の接続元、または転送ヘッダの元の接続元のどれかが loopback 以外） */
export function isNonLocalRequest(req: FastifyRequest): boolean {
  return !isLoopback(req.socket?.remoteAddress ?? req.ip) || !isLoopback(req.ip) || forwardedClients(req.headers).some((ip) => !isLoopback(ip));
}

export const LOOPBACK_ONLY_BODY = {
  error: 'LOOPBACK_ONLY',
  message: 'この API は 127.0.0.1 からのみ利用できます（プロキシ経由で別端末から届いた要求も拒否します）',
} as const;

/** onRequest フック。loopback 以外からの要求を 403 LOOPBACK_ONLY で止める */
export async function loopbackOnlyHook(req: FastifyRequest, reply: FastifyReply) {
  if (isNonLocalRequest(req)) return reply.status(403).send(LOOPBACK_ONLY_BODY);
}
