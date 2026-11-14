/**
 * パイロット（N5）の試行・判定・ラボ API。prefix は呼び出し側で /api/pilot を付ける。
 *
 * 学習ループの順序を API で強制する：
 *   予測提出（ロック）前は 実行（/run）・証拠取得（/evidence）・判定（/evaluate）が 403。
 *   説明・反事実（/reflection）は判定（観察）後でないと 409。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getUnit, listUnits } from './curriculum';
import { deriveCondition, describeCondition, newSeed } from './conditions';
import { fixtureEvidence } from './evidence/fixtures';
import { attemptCompletion, evaluateAttempt, unitCompletion, type Reflection } from './judge';
import { LabLock, sharedLabLock } from './lab/lock';
import { LabTimeoutError, LabUnavailableError, type LabRunner } from './lab/runner';
import type { AttemptRow, PilotStore } from './store';

export interface PilotDeps {
  store: PilotStore;
  lab: LabRunner;
  /** ラボ操作の排他区間（既定はプロセス共有の sharedLabLock） */
  labLock?: LabLock;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLoopback = (ip: string) => LOOPBACK.has(ip) || /^127\.\d+\.\d+\.\d+$/.test(ip) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(ip);

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

function dockerMissing(reply: FastifyReply, e: LabUnavailableError) {
  return reply.status(503).send({ error: e.code, message: e.message, hint: 'Docker Desktop（または Docker Engine）を起動してから再試行してください。Docker が無い環境ではフィクスチャ実行（練習用・完了不可）を使えます。' });
}

function labTimedOut(reply: FastifyReply, e: LabTimeoutError) {
  return reply.status(504).send({
    error: e.code,
    message: e.message,
    operation: e.operation,
    step: e.step,
    limitMs: e.limitMs,
    // 期限超過時に行ったラボの停止・削除の結果（成否と内訳）
    cleanup: e.cleanup,
  });
}

function labBusy(reply: FastifyReply, lock: LabLock) {
  return reply.status(409).send({ error: 'LAB_BUSY', message: 'ラボは別の操作で使用中です。終わってから再試行してください', holder: lock.current() });
}

const createAttemptBody = z.object({ unitId: z.string(), seed: z.string().min(1).max(64).optional() });
const predictionBody = z.object({ answers: z.record(z.string(), z.string()) });
const runBody = z.object({ mode: z.enum(['lab', 'fixture']) });
const reflectionBody = z.object({
  causalText: z.string().max(10_000),
  causalChecks: z.record(z.string(), z.boolean()),
  counterfactuals: z.record(z.string(), z.object({ text: z.string().max(10_000), checks: z.record(z.string(), z.boolean()) })),
});

export async function pilotRoutes(fastify: FastifyInstance, opts: PilotDeps) {
  const { store, lab } = opts;
  const labLock = opts.labLock ?? sharedLabLock;

  // ラボ・試行 API はローカル利用者専用（127.0.0.1 のみ）。
  // 接続元が loopback でも、プロキシの転送ヘッダに loopback 以外の元の接続元があれば拒否する
  // （別端末 → Vite 開発サーバのプロキシ → API という迂回を塞ぐ。trustProxy は使わないので req.ip は TCP の接続元）
  fastify.addHook('onRequest', async (req, reply) => {
    const forwarded = forwardedClients(req.headers);
    if (!isLoopback(req.ip) || forwarded.some((ip) => !isLoopback(ip))) {
      return reply.status(403).send({ error: 'LOOPBACK_ONLY', message: 'この API は 127.0.0.1 からのみ利用できます（プロキシ経由で別端末から届いた要求も拒否します）' });
    }
  });

  function view(attempt: AttemptRow) {
    const unit = getUnit(attempt.unitId)!;
    const locked = attempt.predictionLockedAt !== null;
    const evidence = locked ? store.listEvidence(attempt.id) : [];
    const evaluation = locked ? store.latestEvaluation(attempt.id) : null;
    const reflection = store.getReflection(attempt.id);
    const completion = attemptCompletion(unit, evaluation, reflection);
    const stage = !locked ? 'predict' : evidence.length === 0 ? 'execute' : !reflection ? 'explain' : 'counterfactual';
    return {
      id: attempt.id,
      unitId: attempt.unitId,
      seed: attempt.seed,
      createdAt: attempt.createdAt,
      condition: describeCondition(unit, attempt.condition),
      stage,
      predictionLocked: locked,
      predictionLockedAt: attempt.predictionLockedAt,
      prediction: attempt.prediction,
      running: attempt.runState === 'running',
      evidence: evidence.map((e) => ({ kind: e.kind, origin: e.origin, sha256: e.sha256, collectedAt: e.collectedAt })),
      evaluation,
      reflection,
      completion,
    };
  }

  function loadAttempt(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const a = store.getAttempt(req.params.id);
    if (!a) {
      reply.status(404).send({ error: 'ATTEMPT_NOT_FOUND' });
      return null;
    }
    return a;
  }

  function requireLocked(a: AttemptRow, reply: FastifyReply) {
    if (a.predictionLockedAt === null) {
      reply.status(403).send({ error: 'PREDICTION_NOT_LOCKED', message: '予測を提出するまで実行・観察はできません' });
      return false;
    }
    return true;
  }

  // ---- 単元 ----
  fastify.get('/units', async () => listUnits().map((u) => ({ id: u.id, code: u.code, domain: u.domain, title: u.title, summary: u.summary })));

  fastify.get<{ Params: { unitId: string } }>('/units/:unitId', async (req, reply) => {
    const unit = getUnit(req.params.unitId);
    if (!unit) return reply.status(404).send({ error: 'UNIT_NOT_FOUND' });
    return unit;
  });

  fastify.get<{ Params: { unitId: string } }>('/units/:unitId/status', async (req, reply) => {
    const unit = getUnit(req.params.unitId);
    if (!unit) return reply.status(404).send({ error: 'UNIT_NOT_FOUND' });
    const attempts = store.listAttempts(unit.id).map((a) => ({
      id: a.id,
      condition: a.condition,
      completion: attemptCompletion(unit, a.predictionLockedAt ? store.latestEvaluation(a.id) : null, store.getReflection(a.id)),
    }));
    return { unitId: unit.id, attempts: attempts.length, ...unitCompletion(attempts) };
  });

  // ---- 試行 ----
  fastify.post('/attempts', async (req, reply) => {
    const body = createAttemptBody.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'BAD_REQUEST', issues: body.error.issues });
    const unit = getUnit(body.data.unitId);
    if (!unit) return reply.status(404).send({ error: 'UNIT_NOT_FOUND' });
    const seed = body.data.seed ?? newSeed();
    const attempt = store.createAttempt(unit.id, seed, deriveCondition(unit, seed));
    return reply.status(201).send(view(attempt));
  });

  fastify.get<{ Params: { id: string } }>('/attempts/:id', async (req, reply) => {
    const a = loadAttempt(req, reply);
    if (!a) return;
    return view(a);
  });

  fastify.post<{ Params: { id: string } }>('/attempts/:id/prediction', async (req, reply) => {
    const a = loadAttempt(req, reply);
    if (!a) return;
    if (a.predictionLockedAt) return reply.status(409).send({ error: 'PREDICTION_ALREADY_LOCKED' });
    const body = predictionBody.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'BAD_REQUEST', issues: body.error.issues });
    const unit = getUnit(a.unitId)!;
    const errors: string[] = [];
    const answers: Record<string, string> = {};
    for (const f of unit.prediction.fields) {
      const v = body.data.answers[f.id];
      if (v === undefined) errors.push(`${f.id}: 未回答`);
      else if (!f.options.some((o) => o.value === v)) errors.push(`${f.id}: 選択肢に無い値 ${v}`);
      else answers[f.id] = v;
    }
    if (errors.length) return reply.status(400).send({ error: 'INVALID_PREDICTION', details: errors });
    if (!store.lockPrediction(a.id, answers)) return reply.status(409).send({ error: 'PREDICTION_ALREADY_LOCKED' });
    return view(store.getAttempt(a.id)!);
  });

  fastify.post<{ Params: { id: string } }>('/attempts/:id/run', async (req, reply) => {
    const a = loadAttempt(req, reply);
    if (!a) return;
    if (!requireLocked(a, reply)) return;
    const body = runBody.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'BAD_REQUEST', issues: body.error.issues });

    // 試行の実行を原子的に確保する（同じ試行の二重 run は、実行中でも実行済みでも 409）
    if (!store.claimRun(a.id)) {
      const current = store.getAttempt(a.id);
      if (current?.runState === 'running') return reply.status(409).send({ error: 'RUN_IN_PROGRESS', message: 'この試行は実行中です' });
      return reply.status(409).send({ error: 'ALREADY_RUN', message: 'この試行は実行済みです。新しい条件で試すには新しい試行を作成してください' });
    }

    const cond = { portState: a.condition.portState, connectTimeout: a.condition.connectTimeout };
    let texts: Awaited<ReturnType<LabRunner['collect']>>;
    let origin: 'measured' | 'fixture';
    if (body.data.mode === 'fixture') {
      texts = fixtureEvidence(cond.portState, Number(cond.connectTimeout));
      origin = 'fixture';
    } else {
      // ラボ操作全体（リセット・起動・条件適用・接続・証拠収集）を単一の排他区間で行う
      const release = labLock.tryAcquire(`run:${a.id}`);
      if (!release) {
        store.releaseRun(a.id);
        return labBusy(reply, labLock);
      }
      try {
        texts = await lab.collect(cond);
        origin = 'measured';
      } catch (e) {
        store.releaseRun(a.id);
        if (e instanceof LabUnavailableError) return dockerMissing(reply, e);
        req.log.error(e);
        if (e instanceof LabTimeoutError) return labTimedOut(reply, e);
        return reply.status(500).send({ error: 'LAB_ERROR', message: (e as Error).message });
      } finally {
        release();
      }
    }

    // 証拠一式は収集が完了してから、評価と一緒に1トランザクションで保存する
    try {
      const records = Object.entries(texts).map(([kind, content]) => store.buildEvidence(a.id, kind as keyof typeof texts, origin, content));
      const unit = getUnit(a.unitId)!;
      const evaluation = evaluateAttempt(unit, { id: a.id, condition: a.condition, prediction: a.prediction! }, records);
      store.saveRunResult(a.id, records, evaluation);
    } catch (e) {
      store.releaseRun(a.id);
      req.log.error(e);
      return reply.status(500).send({ error: 'SAVE_FAILED', message: (e as Error).message });
    }
    return view(store.getAttempt(a.id)!);
  });

  fastify.get<{ Params: { id: string } }>('/attempts/:id/evidence', async (req, reply) => {
    const a = loadAttempt(req, reply);
    if (!a) return;
    if (!requireLocked(a, reply)) return;
    return store.listEvidence(a.id);
  });

  fastify.post<{ Params: { id: string } }>('/attempts/:id/evaluate', async (req, reply) => {
    const a = loadAttempt(req, reply);
    if (!a) return;
    if (!requireLocked(a, reply)) return;
    const unit = getUnit(a.unitId)!;
    const ev = evaluateAttempt(unit, { id: a.id, condition: a.condition, prediction: a.prediction! }, store.listEvidence(a.id));
    store.saveEvaluation(a.id, ev);
    return ev;
  });

  fastify.put<{ Params: { id: string } }>('/attempts/:id/reflection', async (req, reply) => {
    const a = loadAttempt(req, reply);
    if (!a) return;
    if (!requireLocked(a, reply)) return;
    if (store.listEvidence(a.id).length === 0) return reply.status(409).send({ error: 'NOT_OBSERVED_YET', message: '説明・反事実は実行して観察した後に記録します' });
    const body = reflectionBody.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'BAD_REQUEST', issues: body.error.issues });
    store.saveReflection(a.id, body.data as Reflection);
    return view(store.getAttempt(a.id)!);
  });

  // ---- ラボ ----
  const labCall = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof LabUnavailableError) return dockerMissing(reply, e);
      if (e instanceof LabTimeoutError) return labTimedOut(reply, e);
      return reply.status(500).send({ error: 'LAB_ERROR', message: (e as Error).message });
    }
  };
  /** ラボを変更する操作は排他区間で行う。使用中なら 409 LAB_BUSY */
  const exclusiveLabCall = async (owner: string, reply: FastifyReply, fn: () => Promise<unknown>) => {
    const release = labLock.tryAcquire(owner);
    if (!release) return labBusy(reply, labLock);
    try {
      return await labCall(reply, fn);
    } finally {
      release();
    }
  };
  // status は読み取りのみなので排他しない（使用中なら保持者も返す）
  fastify.get('/lab/status', async (_req, reply) => labCall(reply, async () => ({ ...(await lab.status()), busy: labLock.current() })));
  fastify.post('/lab/start', async (_req, reply) => exclusiveLabCall('lab/start', reply, () => lab.start()));
  fastify.post('/lab/reset', async (_req, reply) => exclusiveLabCall('lab/reset', reply, () => lab.reset()));
}
