/**
 * 試行・証拠・評価・振り返りの保存（SQLite、Node 標準の node:sqlite を使用。追加のネイティブ依存なし）。
 * 単元データ（git管理）とは別に、試行記録・観察証拠・評価を別テーブルで保持する。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { EvidenceKind } from './curriculum/schema';
import type { Evaluation, EvidenceOrigin, EvidenceRecord, Reflection } from './judge';

export interface AttemptRow {
  id: string;
  unitId: string;
  seed: string;
  condition: Record<string, string>;
  createdAt: string;
  prediction: Record<string, string> | null;
  predictionLockedAt: string | null;
}

export interface StoredEvidence extends EvidenceRecord {
  sha256: string;
  collectedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  seed TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  prediction_json TEXT,
  prediction_locked_at TEXT
);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  kind TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('measured','fixture')),
  content TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  UNIQUE (attempt_id, kind)
);
CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  created_at TEXT NOT NULL,
  prediction_correct INTEGER NOT NULL,
  evidence_origin TEXT NOT NULL,
  evidence_eligible INTEGER NOT NULL,
  result_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reflections (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  reflection_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

// node:sqlite は Vite（vitest）の組込みモジュール一覧に無く静的 import が解決できないため、require で読む
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const now = () => new Date().toISOString();

export class PilotStore {
  private db: DatabaseSyncType;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  createAttempt(unitId: string, seed: string, condition: Record<string, string>): AttemptRow {
    const row: AttemptRow = { id: randomUUID(), unitId, seed, condition, createdAt: now(), prediction: null, predictionLockedAt: null };
    this.db
      .prepare('INSERT INTO attempts (id, unit_id, seed, condition_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, unitId, seed, JSON.stringify(condition), row.createdAt);
    return row;
  }

  getAttempt(id: string): AttemptRow | null {
    const r = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id);
    return r ? toAttempt(r) : null;
  }

  listAttempts(unitId: string): AttemptRow[] {
    return this.db.prepare('SELECT * FROM attempts WHERE unit_id = ? ORDER BY created_at').all(unitId).map(toAttempt);
  }

  /** 予測を記録してロックする。既にロック済みなら false（上書きしない） */
  lockPrediction(id: string, prediction: Record<string, string>): boolean {
    const r = this.db
      .prepare('UPDATE attempts SET prediction_json = ?, prediction_locked_at = ? WHERE id = ? AND prediction_locked_at IS NULL')
      .run(JSON.stringify(prediction), now(), id);
    return Number(r.changes) === 1;
  }

  addEvidence(attemptId: string, kind: EvidenceKind, origin: EvidenceOrigin, content: string): StoredEvidence {
    const e: StoredEvidence = {
      id: randomUUID(),
      attemptId,
      kind,
      origin,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      collectedAt: now(),
    };
    this.db
      .prepare('INSERT INTO evidence (id, attempt_id, kind, origin, content, sha256, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.id, attemptId, kind, origin, content, e.sha256, e.collectedAt);
    return e;
  }

  listEvidence(attemptId: string): StoredEvidence[] {
    return this.db
      .prepare('SELECT * FROM evidence WHERE attempt_id = ? ORDER BY kind')
      .all(attemptId)
      .map((r) => ({
        id: String(r.id),
        attemptId: String(r.attempt_id),
        kind: String(r.kind) as EvidenceKind,
        origin: String(r.origin) as EvidenceOrigin,
        content: String(r.content),
        sha256: String(r.sha256),
        collectedAt: String(r.collected_at),
      }));
  }

  saveEvaluation(attemptId: string, ev: Evaluation) {
    this.db
      .prepare('INSERT INTO evaluations (id, attempt_id, created_at, prediction_correct, evidence_origin, evidence_eligible, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), attemptId, now(), ev.predictionCorrect ? 1 : 0, ev.evidenceOrigin, ev.evidenceEligible ? 1 : 0, JSON.stringify(ev));
  }

  latestEvaluation(attemptId: string): Evaluation | null {
    const r = this.db.prepare('SELECT result_json FROM evaluations WHERE attempt_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(attemptId);
    return r ? (JSON.parse(String(r.result_json)) as Evaluation) : null;
  }

  saveReflection(attemptId: string, reflection: Reflection) {
    this.db
      .prepare('INSERT INTO reflections (attempt_id, reflection_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET reflection_json = excluded.reflection_json, updated_at = excluded.updated_at')
      .run(attemptId, JSON.stringify(reflection), now());
  }

  getReflection(attemptId: string): Reflection | null {
    const r = this.db.prepare('SELECT reflection_json FROM reflections WHERE attempt_id = ?').get(attemptId);
    return r ? (JSON.parse(String(r.reflection_json)) as Reflection) : null;
  }
}

function toAttempt(r: Record<string, unknown>): AttemptRow {
  return {
    id: String(r.id),
    unitId: String(r.unit_id),
    seed: String(r.seed),
    condition: JSON.parse(String(r.condition_json)),
    createdAt: String(r.created_at),
    prediction: r.prediction_json ? JSON.parse(String(r.prediction_json)) : null,
    predictionLockedAt: r.prediction_locked_at ? String(r.prediction_locked_at) : null,
  };
}
