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
import { LabUnavailableError, type LabRunner } from './lab/runner';
import type { AttemptRow, PilotStore } from './store';

export interface PilotDeps {
  store: PilotStore;
  lab: LabRunner;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function dockerMissing(reply: FastifyReply, e: LabUnavailableError) {
  return reply.status(503).send({ error: e.code, message: e.message, hint: 'Docker Desktop（または Docker Engine）を起動してから再試行してください。Docker が無い環境ではフィクスチャ実行（練習用・完了不可）を使えます。' });
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

  // ラボ・試行 API はローカル利用者専用（127.0.0.1 のみ）
  fastify.addHook('onRequest', async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) {
      return reply.status(403).send({ error: 'LOOPBACK_ONLY', message: 'この API は 127.0.0.1 からのみ利用できます' });
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
    if (store.listEvidence(a.id).length > 0) return reply.status(409).send({ error: 'ALREADY_RUN', message: 'この試行は実行済みです。新しい条件で試すには新しい試行を作成してください' });

    const cond = { portState: a.condition.portState, connectTimeout: a.condition.connectTimeout };
    let texts;
    let origin: 'measured' | 'fixture';
    if (body.data.mode === 'fixture') {
      texts = fixtureEvidence(cond.portState, Number(cond.connectTimeout));
      origin = 'fixture';
    } else {
      try {
        texts = await lab.collect(cond);
        origin = 'measured';
      } catch (e) {
        if (e instanceof LabUnavailableError) return dockerMissing(reply, e);
        req.log.error(e);
        return reply.status(500).send({ error: 'LAB_ERROR', message: (e as Error).message });
      }
    }
    for (const [kind, content] of Object.entries(texts)) {
      store.addEvidence(a.id, kind as keyof typeof texts, origin, content);
    }
    const unit = getUnit(a.unitId)!;
    store.saveEvaluation(a.id, evaluateAttempt(unit, { id: a.id, condition: a.condition, prediction: a.prediction! }, store.listEvidence(a.id)));
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
      return reply.status(500).send({ error: 'LAB_ERROR', message: (e as Error).message });
    }
  };
  fastify.get('/lab/status', async (_req, reply) => labCall(reply, () => lab.status()));
  fastify.post('/lab/start', async (_req, reply) => labCall(reply, () => lab.start()));
  fastify.post('/lab/reset', async (_req, reply) => labCall(reply, () => lab.reset()));
}
