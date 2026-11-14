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
  /** 実行状態：null＝未実行、'running'＝実行中（確保済み）、'done'＝証拠保存済み */
  runState: 'running' | 'done' | null;
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
    // 既存 DB への列追加（初版の DB には run_state が無い）
    const cols = new Set(this.db.prepare('PRAGMA table_info(attempts)').all().map((r) => String(r.name)));
    if (!cols.has('run_state')) this.db.exec('ALTER TABLE attempts ADD COLUMN run_state TEXT');
    if (!cols.has('run_started_at')) this.db.exec('ALTER TABLE attempts ADD COLUMN run_started_at TEXT');
    // パイロットは単一プロセスで DB を使う。起動時に残っている「実行中」は前のプロセスの中断なので解放する
    // （証拠は一括保存のため、中断した試行に部分証拠は残っていない）
    this.db.exec("UPDATE attempts SET run_state = NULL, run_started_at = NULL WHERE run_state = 'running'");
  }

  close() {
    this.db.close();
  }

  createAttempt(unitId: string, seed: string, condition: Record<string, string>): AttemptRow {
    const row: AttemptRow = { id: randomUUID(), unitId, seed, condition, createdAt: now(), prediction: null, predictionLockedAt: null, runState: null };
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

  /**
   * 試行の実行を原子的に確保する（未実行かつ証拠なしのときだけ 'running' にする）。
   * 確保できなければ false（実行中または実行済み）。
   */
  claimRun(id: string): boolean {
    const r = this.db
      .prepare(
        "UPDATE attempts SET run_state = 'running', run_started_at = ? WHERE id = ? AND run_state IS NULL AND prediction_locked_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM evidence WHERE attempt_id = ?)",
      )
      .run(now(), id, id);
    return Number(r.changes) === 1;
  }

  /** 実行が失敗したとき確保を解く（証拠は保存されていないので、同じ試行で再実行できる） */
  releaseRun(id: string) {
    this.db.prepare("UPDATE attempts SET run_state = NULL, run_started_at = NULL WHERE id = ? AND run_state = 'running'").run(id);
  }

  /** 証拠レコードを作る（保存はしない）。判定は保存前にこのレコードで行う */
  buildEvidence(attemptId: string, kind: EvidenceKind, origin: EvidenceOrigin, content: string): StoredEvidence {
    return {
      id: randomUUID(),
      attemptId,
      kind,
      origin,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      collectedAt: now(),
    };
  }

  private insertEvidence(e: StoredEvidence) {
    this.db
      .prepare('INSERT INTO evidence (id, attempt_id, kind, origin, content, sha256, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.id, e.attemptId, e.kind, e.origin, e.content, e.sha256, e.collectedAt);
  }

  addEvidence(attemptId: string, kind: EvidenceKind, origin: EvidenceOrigin, content: string): StoredEvidence {
    const e = this.buildEvidence(attemptId, kind, origin, content);
    this.insertEvidence(e);
    return e;
  }

  /**
   * 実行結果（証拠一式と評価）を1つのトランザクションで保存し、実行状態を 'done' にする。
   * 途中で失敗したら全て取り消す（部分証拠を残さない）。確保（'running'）していない試行には保存しない。
   */
  saveRunResult(attemptId: string, evidence: StoredEvidence[], ev: Evaluation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const done = this.db
        .prepare("UPDATE attempts SET run_state = 'done' WHERE id = ? AND run_state = 'running'")
        .run(attemptId);
      if (Number(done.changes) !== 1) throw new Error(`試行 ${attemptId} は実行中として確保されていない`);
      for (const e of evidence) {
        if (e.attemptId !== attemptId) throw new Error('別試行の証拠は保存できない');
        this.insertEvidence(e);
      }
      this.saveEvaluation(attemptId, ev);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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

function toRunState(v: unknown): AttemptRow['runState'] {
  return v === 'running' ? 'running' : v === 'done' ? 'done' : null;
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
    runState: toRunState(r.run_state),
  };
}
