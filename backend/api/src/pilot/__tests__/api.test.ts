import Fastify, { type FastifyInstance } from 'fastify';
import type Docker from 'dockerode';
import { afterEach, describe, expect, it } from 'vitest';
import { createPilotPlugin } from '../app';
import { getUnit } from '../curriculum';
import { deriveCondition } from '../conditions';
import { fixtureEvidence } from '../evidence/fixtures';
import { observe } from '../evidence/parse';
import { DockerLabRunner, type LabRunner } from '../lab/runner';
import { PilotStore } from '../store';

const unit = getUnit('n5-tcp')!;

/** Docker が無い環境：実際の DockerLabRunner に、ping が ENOENT で失敗する Docker クライアントを渡す */
function noDockerRunner(): LabRunner {
  const fake = {
    ping: () => Promise.reject(Object.assign(new Error('connect ENOENT /var/run/docker.sock'), { code: 'ENOENT' })),
  } as unknown as Docker;
  return new DockerLabRunner(fake);
}

/** 実測ラボの代わりに、実測形式の証拠テキストを返すスタブ（API 経路の検証用） */
function stubMeasuredRunner(): LabRunner {
  return {
    status: async () => ({ docker: 'available', running: true, nodes: [], network: null }),
    start: async () => ({ docker: 'available', running: true, nodes: [], network: null, elapsedMs: 0 }),
    reset: async () => ({ removedContainers: 0, removedNetworks: 0, elapsedMs: 0 }),
    collect: async (c) => fixtureEvidence(c.portState, Number(c.connectTimeout)),
  };
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function build(lab: LabRunner) {
  app = Fastify();
  const { plugin } = createPilotPlugin({ store: new PilotStore(':memory:'), lab });
  await app.register(plugin, { prefix: '/api/pilot' });
  return app;
}

function seedFor(portState: string): string {
  for (let i = 0; i < 10_000; i++) if (deriveCondition(unit, `t${i}`).portState === portState) return `t${i}`;
  throw new Error('no seed');
}

function correctAnswers(condition: { value: string; paramId: string }[]) {
  const c = Object.fromEntries(condition.map((x) => [x.paramId, x.value]));
  return observe(fixtureEvidence(c.portState, Number(c.connectTimeout)), Number(c.connectTimeout)).observed;
}

const reflection = {
  causalText: 'SYN に対して server のカーネルが RST を返したので connect が即座に失敗した（tcpdump の [R.]）',
  causalChecks: Object.fromEntries(unit.causalExplanation.rubric.map((r) => [r.id, true])),
  counterfactuals: Object.fromEntries(
    unit.counterfactuals.map((cf) => [cf.id, { text: 'REJECT なら RST が返り再送されずに即座に失敗する。DROP は待たせる。', checks: Object.fromEntries(cf.rubric.map((r) => [r.id, true])) }]),
  ),
};

describe('予測ロック', () => {
  it('予測提出前は実行・証拠取得・判定・振り返りが 403、提出後は可能', async () => {
    const a = await build(noDockerRunner());
    const created = await a.inject({ method: 'POST', url: '/api/pilot/attempts', payload: { unitId: 'n5-tcp', seed: 'lock-test' } });
    expect(created.statusCode).toBe(201);
    const attempt = created.json();
    expect(attempt.predictionLocked).toBe(false);
    expect(attempt.evaluation).toBeNull();

    for (const [method, url, payload] of [
      ['POST', `/api/pilot/attempts/${attempt.id}/run`, { mode: 'fixture' }],
      ['GET', `/api/pilot/attempts/${attempt.id}/evidence`, undefined],
      ['POST', `/api/pilot/attempts/${attempt.id}/evaluate`, undefined],
      ['PUT', `/api/pilot/attempts/${attempt.id}/reflection`, reflection],
    ] as const) {
      const r = await a.inject({ method, url, payload });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error).toBe('PREDICTION_NOT_LOCKED');
    }

    const bad = await a.inject({ method: 'POST', url: `/api/pilot/attempts/${attempt.id}/prediction`, payload: { answers: { curlResult: 'connected' } } });
    expect(bad.statusCode).toBe(400);

    const lock = await a.inject({ method: 'POST', url: `/api/pilot/attempts/${attempt.id}/prediction`, payload: { answers: correctAnswers(attempt.condition) } });
    expect(lock.statusCode).toBe(200);
    expect(lock.json().predictionLocked).toBe(true);

    const again = await a.inject({ method: 'POST', url: `/api/pilot/attempts/${attempt.id}/prediction`, payload: { answers: correctAnswers(attempt.condition) } });
    expect(again.statusCode).toBe(409);

    const ev = await a.inject({ method: 'GET', url: `/api/pilot/attempts/${attempt.id}/evidence` });
    expect(ev.statusCode).toBe(200);
    expect(ev.json()).toEqual([]);

    const run = await a.inject({ method: 'POST', url: `/api/pilot/attempts/${attempt.id}/run`, payload: { mode: 'fixture' } });
    expect(run.statusCode).toBe(200);
  });
});

describe('Docker 未検出', () => {
  it('ラボ API は DOCKER_NOT_FOUND を 503 で返し、アプリは動き続ける', async () => {
    const a = await build(noDockerRunner());
    for (const [method, url] of [
      ['GET', '/api/pilot/lab/status'],
      ['POST', '/api/pilot/lab/start'],
      ['POST', '/api/pilot/lab/reset'],
    ] as const) {
      const r = await a.inject({ method, url });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toBe('DOCKER_NOT_FOUND');
    }
    const created = (await a.inject({ method: 'POST', url: '/api/pilot/attempts', payload: { unitId: 'n5-tcp' } })).json();
    await a.inject({ method: 'POST', url: `/api/pilot/attempts/${created.id}/prediction`, payload: { answers: correctAnswers(created.condition) } });
    const run = await a.inject({ method: 'POST', url: `/api/pilot/attempts/${created.id}/run`, payload: { mode: 'lab' } });
    expect(run.statusCode).toBe(503);
    expect(run.json().error).toBe('DOCKER_NOT_FOUND');
    // 証拠は保存されていない
    expect((await a.inject({ method: 'GET', url: `/api/pilot/attempts/${created.id}/evidence` })).json()).toEqual([]);
    expect((await a.inject({ method: 'GET', url: '/api/pilot/units/n5-tcp' })).statusCode).toBe(200);
  });
});

describe('API 経路の完了判定', () => {
  it('フィクスチャ実行は正解でも未完了、実測（スタブ）2条件で単元完了', async () => {
    // フィクスチャ
    const a = await build(stubMeasuredRunner());
    const fx = (await a.inject({ method: 'POST', url: '/api/pilot/attempts', payload: { unitId: 'n5-tcp', seed: seedFor('closed') } })).json();
    await a.inject({ method: 'POST', url: `/api/pilot/attempts/${fx.id}/prediction`, payload: { answers: correctAnswers(fx.condition) } });
    const fxRun = (await a.inject({ method: 'POST', url: `/api/pilot/attempts/${fx.id}/run`, payload: { mode: 'fixture' } })).json();
    expect(fxRun.evidence.every((e: { origin: string }) => e.origin === 'fixture')).toBe(true);
    expect(fxRun.evaluation.predictionCorrect).toBe(true);
    await a.inject({ method: 'PUT', url: `/api/pilot/attempts/${fx.id}/reflection`, payload: reflection });
    const fxView = (await a.inject({ method: 'GET', url: `/api/pilot/attempts/${fx.id}` })).json();
    expect(fxView.completion.completed).toBe(false);
    expect(fxView.completion.blockers).toContain('fixture-evidence');

    // 再実行は不可
    expect((await a.inject({ method: 'POST', url: `/api/pilot/attempts/${fx.id}/run`, payload: { mode: 'lab' } })).statusCode).toBe(409);

    // 実測（スタブ）：closed と drop の2条件
    for (const ps of ['closed', 'drop']) {
      const m = (await a.inject({ method: 'POST', url: '/api/pilot/attempts', payload: { unitId: 'n5-tcp', seed: seedFor(ps) } })).json();
      await a.inject({ method: 'POST', url: `/api/pilot/attempts/${m.id}/prediction`, payload: { answers: correctAnswers(m.condition) } });
      expect((await a.inject({ method: 'PUT', url: `/api/pilot/attempts/${m.id}/reflection`, payload: reflection })).statusCode).toBe(409);
      const run = (await a.inject({ method: 'POST', url: `/api/pilot/attempts/${m.id}/run`, payload: { mode: 'lab' } })).json();
      expect(run.evaluation.evidenceOrigin).toBe('measured');
      const st = (await a.inject({ method: 'GET', url: '/api/pilot/units/n5-tcp/status' })).json();
      if (ps === 'closed') expect(st.completed).toBe(false);
      const done = (await a.inject({ method: 'PUT', url: `/api/pilot/attempts/${m.id}/reflection`, payload: reflection })).json();
      expect(done.completion).toEqual({ completed: true, blockers: [] });
    }
    const status = (await a.inject({ method: 'GET', url: '/api/pilot/units/n5-tcp/status' })).json();
    expect(status).toMatchObject({ attempts: 3, completed: true, passedConditions: ['closed', 'drop'] });
  });

  it('127.0.0.1 以外からのリクエストは 403', async () => {
    const a = await build(noDockerRunner());
    const r = await a.inject({ method: 'GET', url: '/api/pilot/units', remoteAddress: '192.168.1.20' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('LOOPBACK_ONLY');
  });
});

describe('SQLite 保存', () => {
  it('ファイル DB に試行・証拠・評価が残り、再オープン後も読める', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'pilot-'));
    try {
      const path = join(dir, 'p.sqlite');
      const s1 = new PilotStore(path);
      const at = s1.createAttempt('n5-tcp', 'x', { portState: 'open', connectTimeout: '2' });
      expect(s1.lockPrediction(at.id, { curlResult: 'connected' })).toBe(true);
      expect(s1.lockPrediction(at.id, { curlResult: 'refused' })).toBe(false);
      s1.addEvidence(at.id, 'curl', 'measured', 'time_total=1.5 http_code=200\nexit=0');
      s1.close();
      const s2 = new PilotStore(path);
      expect(s2.getAttempt(at.id)?.prediction).toEqual({ curlResult: 'connected' });
      expect(s2.listEvidence(at.id)[0]).toMatchObject({ kind: 'curl', origin: 'measured' });
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
