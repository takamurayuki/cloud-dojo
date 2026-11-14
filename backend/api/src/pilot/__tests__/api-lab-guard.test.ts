/**
 * F3：共有ラボの排他制御と、試行‐証拠の対応（ラボはスタブ）。
 * F4：期限超過の API 応答（後始末の結果を含む）。
 * F1：プロキシ経由（転送ヘッダ付き）で別端末から届いた要求の拒否。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createPilotPlugin } from '../app';
import { getUnit } from '../curriculum';
import { deriveCondition } from '../conditions';
import { fixtureEvidence } from '../evidence/fixtures';
import { observe } from '../evidence/parse';
import { evaluateAttempt } from '../judge';
import { LabLock } from '../lab/lock';
import { LabTimeoutError, type LabRunner } from '../lab/runner';
import { forwardedClients } from '../routes';
import { PilotStore } from '../store';

const unit = getUnit('n5-tcp')!;

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** collect を外から完了させられるスタブ。呼ばれた回数と、呼ばれたことの通知を持つ */
function gatedRunner() {
  const pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const entered: (() => void)[] = [];
  let calls = 0;
  const runner: LabRunner = {
    status: async () => ({ docker: 'available', running: true, nodes: [], network: null }),
    start: async () => ({ docker: 'available', running: true, nodes: [], network: null, elapsedMs: 0 }),
    reset: async () => ({ removedContainers: 0, removedNetworks: 0, elapsedMs: 0 }),
    collect: (c) => {
      calls++;
      entered.splice(0).forEach((f) => f());
      return new Promise((resolve, reject) => {
        pending.push({ resolve: () => resolve(fixtureEvidence(c.portState, Number(c.connectTimeout))), reject });
      });
    },
  };
  return {
    runner,
    calls: () => calls,
    /** 次に collect に入るまで待つ */
    nextEntered: () => new Promise<void>((r) => entered.push(r)),
    finishAll: () => pending.splice(0).forEach((p) => p.resolve()),
    failAll: (e: Error) => pending.splice(0).forEach((p) => p.reject(e)),
  };
}

async function build(lab: LabRunner, store = new PilotStore(':memory:')) {
  app = Fastify();
  const { plugin } = createPilotPlugin({ store, lab, labLock: new LabLock() });
  await app.register(plugin, { prefix: '/api/pilot' });
  return { a: app, store };
}

async function lockedAttempt(a: FastifyInstance, seed: string) {
  const at = (await a.inject({ method: 'POST', url: '/api/pilot/attempts', payload: { unitId: 'n5-tcp', seed } })).json();
  const c = deriveCondition(unit, seed);
  const answers = observe(fixtureEvidence(c.portState, Number(c.connectTimeout)), Number(c.connectTimeout)).observed;
  expect((await a.inject({ method: 'POST', url: `/api/pilot/attempts/${at.id}/prediction`, payload: { answers } })).statusCode).toBe(200);
  return at.id as string;
}

const runReq = (a: FastifyInstance, id: string, mode: 'lab' | 'fixture' = 'lab') => a.inject({ method: 'POST', url: `/api/pilot/attempts/${id}/run`, payload: { mode } });
const evidenceOf = async (a: FastifyInstance, id: string) => (await a.inject({ method: 'GET', url: `/api/pilot/attempts/${id}/evidence` })).json();

describe('共有ラボの排他制御（F3）', () => {
  it('別試行の run が並行すると、片方は 409 LAB_BUSY になり、ラボは1回しか使われない', async () => {
    const g = gatedRunner();
    const { a } = await build(g.runner);
    const id1 = await lockedAttempt(a, 'p1');
    const id2 = await lockedAttempt(a, 'p2');

    const entered = g.nextEntered();
    const first = runReq(a, id1);
    await entered;
    const second = await runReq(a, id2);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'LAB_BUSY', holder: { owner: `run:${id1}` } });
    // 実行中はリセット・起動も 409（他試行のコンテナを消さない）
    expect((await a.inject({ method: 'POST', url: '/api/pilot/lab/reset' })).json().error).toBe('LAB_BUSY');
    expect((await a.inject({ method: 'POST', url: '/api/pilot/lab/start' })).statusCode).toBe(409);
    expect((await a.inject({ method: 'GET', url: '/api/pilot/lab/status' })).json().busy).toMatchObject({ owner: `run:${id1}` });

    g.finishAll();
    const r1 = await first;
    expect(r1.statusCode).toBe(200);
    expect(g.calls()).toBe(1);
    // 409 になった試行は確保が解かれていて、ラボが空けば実行できる
    expect(await evidenceOf(a, id2)).toEqual([]);
    const entered2 = g.nextEntered();
    const retry = runReq(a, id2);
    await entered2;
    g.finishAll();
    expect((await retry).statusCode).toBe(200);
    expect(g.calls()).toBe(2);
    expect((await a.inject({ method: 'POST', url: '/api/pilot/lab/reset' })).statusCode).toBe(200);
  });

  it('同じ試行の二重 run：実行中なら 409 RUN_IN_PROGRESS、実行後は 409 ALREADY_RUN で、証拠は1組だけ', async () => {
    const g = gatedRunner();
    const { a } = await build(g.runner);
    const id = await lockedAttempt(a, 'dup');

    const entered = g.nextEntered();
    const first = runReq(a, id);
    await entered;
    const dup = await runReq(a, id);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('RUN_IN_PROGRESS');
    // フィクスチャ実行でも二重にはできない
    expect((await runReq(a, id, 'fixture')).json().error).toBe('RUN_IN_PROGRESS');
    expect((await a.inject({ method: 'GET', url: `/api/pilot/attempts/${id}` })).json().running).toBe(true);

    g.finishAll();
    expect((await first).statusCode).toBe(200);
    const again = await runReq(a, id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('ALREADY_RUN');
    expect(g.calls()).toBe(1);
    const ev = await evidenceOf(a, id);
    expect(ev.map((e: { kind: string }) => e.kind).sort()).toEqual(['curl', 'lab-env', 'ss-client', 'ss-server', 'tcpdump']);
  });

  it('収集の途中で失敗したら証拠は1件も残らず、確保も解かれて再実行できる', async () => {
    const g = gatedRunner();
    const { a } = await build(g.runner);
    const id = await lockedAttempt(a, 'fail');
    const entered = g.nextEntered();
    const first = runReq(a, id);
    await entered;
    g.failAll(new Error('client の証拠出力に tcpdump が無い'));
    const r = await first;
    expect(r.statusCode).toBe(500);
    expect(r.json().error).toBe('LAB_ERROR');
    expect(await evidenceOf(a, id)).toEqual([]);
    const view = (await a.inject({ method: 'GET', url: `/api/pilot/attempts/${id}` })).json();
    expect(view.running).toBe(false);
    expect(view.evaluation).toBeNull();
    // ラボのロックも解放されている
    expect((await a.inject({ method: 'POST', url: '/api/pilot/lab/reset' })).statusCode).toBe(200);
  });
});

describe('ラボの期限超過（F4）', () => {
  it('collect が期限を超えたら 504 LAB_TIMEOUT で、後始末の結果を返し、証拠は保存しない', async () => {
    const timeout = new LabTimeoutError('collect', 'exec:client-run', 30_000);
    timeout.cleanup = { ok: true, stoppedContainers: 2, removedContainers: 2, removedNetworks: 1, errors: [] };
    const runner: LabRunner = {
      status: async () => ({ docker: 'available', running: false, nodes: [], network: null }),
      start: async () => Promise.reject(Object.assign(new LabTimeoutError('start', 'build', 180_000), { cleanup: { ok: false, stoppedContainers: 0, removedContainers: 0, removedNetworks: 0, errors: ['x'] } })),
      reset: async () => ({ removedContainers: 0, removedNetworks: 0, elapsedMs: 0 }),
      collect: async () => Promise.reject(timeout),
    };
    const { a } = await build(runner);
    const id = await lockedAttempt(a, 'to');
    const r = await runReq(a, id);
    expect(r.statusCode).toBe(504);
    expect(r.json()).toMatchObject({ error: 'LAB_TIMEOUT', operation: 'collect', step: 'exec:client-run', limitMs: 30_000, cleanup: { ok: true, stoppedContainers: 2, removedContainers: 2 } });
    expect(await evidenceOf(a, id)).toEqual([]);
    const s = await a.inject({ method: 'POST', url: '/api/pilot/lab/start' });
    expect(s.statusCode).toBe(504);
    expect(s.json().cleanup.ok).toBe(false);
  });
});

describe('証拠一式の一括保存（F3）', () => {
  it('保存の途中で失敗したら全て取り消す（部分証拠を残さない）', () => {
    const store = new PilotStore(':memory:');
    const at = store.createAttempt('n5-tcp', 'tx', { portState: 'drop', connectTimeout: '5' });
    store.lockPrediction(at.id, {});
    expect(store.claimRun(at.id)).toBe(true);
    expect(store.claimRun(at.id)).toBe(false);
    const texts = fixtureEvidence('drop', 5);
    const recs = Object.entries(texts).map(([k, c]) => store.buildEvidence(at.id, k as keyof typeof texts, 'measured', c));
    const ev = evaluateAttempt(unit, { id: at.id, condition: at.condition, prediction: {} }, recs);
    // 同じ種類を2つ入れて UNIQUE(attempt_id, kind) 違反を途中で起こす
    expect(() => store.saveRunResult(at.id, [...recs, { ...recs[0], id: 'dup' }], ev)).toThrow();
    expect(store.listEvidence(at.id)).toEqual([]);
    expect(store.latestEvaluation(at.id)).toBeNull();
    expect(store.getAttempt(at.id)?.runState).toBe('running');
    store.saveRunResult(at.id, recs, ev);
    expect(store.listEvidence(at.id)).toHaveLength(5);
    expect(store.getAttempt(at.id)?.runState).toBe('done');
    expect(store.claimRun(at.id)).toBe(false);
    store.close();
  });

  it('初版の DB（run_state 列なし）を開いても移行され、起動時に残った「実行中」は解放される', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createRequire } = await import('node:module');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'pilot-mig-'));
    try {
      const path = join(dir, 'old.sqlite');
      const old = new DatabaseSync(path);
      old.exec('CREATE TABLE attempts (id TEXT PRIMARY KEY, unit_id TEXT NOT NULL, seed TEXT NOT NULL, condition_json TEXT NOT NULL, created_at TEXT NOT NULL, prediction_json TEXT, prediction_locked_at TEXT)');
      old.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?)').run('old1', 'n5-tcp', 's', '{"portState":"open","connectTimeout":"2"}', '2026-11-14T00:00:00Z', '{}', '2026-11-14T00:00:01Z');
      old.close();
      const s1 = new PilotStore(path);
      expect(s1.getAttempt('old1')?.runState).toBeNull();
      expect(s1.claimRun('old1')).toBe(true);
      s1.close();
      const s2 = new PilotStore(path);
      expect(s2.getAttempt('old1')?.runState).toBeNull();
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('プロキシ経由の loopback 迂回の拒否（F1）', () => {
  it('転送ヘッダに loopback 以外の接続元があれば、TCP 上は 127.0.0.1 でも 403', async () => {
    const { a } = await build(gatedRunner().runner);
    for (const headers of [
      { 'x-forwarded-for': '192.168.1.20' },
      { 'x-forwarded-for': '127.0.0.1, 10.0.0.5' },
      { 'x-real-ip': '10.0.0.5' },
      { forwarded: 'for=192.0.2.60;proto=http' },
      { forwarded: 'for="[2001:db8::1]:4711"' },
    ]) {
      const r = await a.inject({ method: 'GET', url: '/api/pilot/units', headers });
      expect(r.statusCode, JSON.stringify(headers)).toBe(403);
      expect(r.json().error).toBe('LOOPBACK_ONLY');
    }
  });

  it('同じ端末のブラウザから Vite のプロキシ経由（X-Forwarded-For が loopback）は通る', async () => {
    const { a } = await build(gatedRunner().runner);
    for (const xff of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const r = await a.inject({ method: 'GET', url: '/api/pilot/units', headers: { 'x-forwarded-for': xff } });
      expect(r.statusCode, xff).toBe(200);
    }
  });

  it('転送ヘッダの書式（ポート・角括弧・引用符）から接続元を取り出せる', () => {
    expect(forwardedClients({ 'x-forwarded-for': '203.0.113.1:5555, ::1', forwarded: 'for="[::1]:80", for=198.51.100.2' })).toEqual(['203.0.113.1', '::1', '::1', '198.51.100.2']);
  });
});
