/**
 * 判定器。構造化予測は証拠から算出した観察結果と自動照合し、決定的に判定する。
 * 因果説明・反事実はルーブリックの自己照合を記録し、完了条件に使う（AI判定は無い）。
 *
 * 完了フラグは判定結果（予測の正誤）と分離している：
 *   - predictionCorrect … 証拠の由来（実測／フィクスチャ）を問わず算出する
 *   - completionEligible … 実測証拠・必須証拠・整合・正解・振り返りが揃ったときだけ true
 */
import type { EvidenceKind, Unit } from './curriculum/schema';
import { expectedFromMechanism, observe, type Observed } from './evidence/parse';

export type EvidenceOrigin = 'measured' | 'fixture';

export interface EvidenceRecord {
  id: string;
  attemptId: string;
  kind: EvidenceKind;
  origin: EvidenceOrigin;
  content: string;
}

export interface FieldResult {
  fieldId: string;
  label: string;
  predicted: string;
  actual: string | null;
  correct: boolean;
}

export interface Evaluation {
  predictionCorrect: boolean;
  fields: FieldResult[];
  observed: Observed;
  synTimes: number[];
  evidenceOrigin: EvidenceOrigin | 'mixed' | 'none';
  /** 証拠が条件どおりのラボ構成と整合しているか（ラボ構成不良の検出） */
  evidenceConsistent: boolean;
  missing: string[];
  /** 証拠側の完了要件（振り返りは含まない）を満たしているか */
  evidenceEligible: boolean;
  blockers: string[];
}

export function evaluateAttempt(
  unit: Unit,
  attempt: { id: string; condition: Record<string, string>; prediction: Record<string, string> },
  evidence: EvidenceRecord[],
): Evaluation {
  const blockers: string[] = [];

  // 別試行の証拠は使わない
  const own = evidence.filter((e) => e.attemptId === attempt.id);
  if (own.length !== evidence.length) blockers.push('evidence-from-other-attempt');

  const byKind: Partial<Record<EvidenceKind, string>> = {};
  for (const e of own) byKind[e.kind] = e.content;

  const timeout = Number(attempt.condition.connectTimeout);
  const detail = observe(byKind, timeout);

  const fields: FieldResult[] = unit.prediction.fields.map((f) => {
    const actual = detail.observed[f.id] ?? null;
    const predicted = attempt.prediction[f.id];
    return { fieldId: f.id, label: f.label, predicted, actual, correct: actual !== null && predicted === actual };
  });
  const predictionCorrect = fields.every((f) => f.correct);

  const origins = new Set(own.map((e) => e.origin));
  const evidenceOrigin: Evaluation['evidenceOrigin'] = origins.size === 0 ? 'none' : origins.size > 1 ? 'mixed' : [...origins][0];

  const expected = expectedFromMechanism(attempt.condition.portState, timeout);
  const evidenceConsistent = Object.entries(expected).every(([k, v]) => detail.observed[k] === v);

  if (own.length === 0) blockers.push('no-evidence');
  for (const k of unit.requiredEvidence) {
    if (!own.some((e) => e.kind === k)) blockers.push(`missing-evidence:${k}`);
  }
  if (evidenceOrigin !== 'measured' && evidenceOrigin !== 'none') blockers.push('fixture-evidence');
  if (own.length > 0 && !evidenceConsistent) blockers.push('evidence-inconsistent-with-condition');
  if (!predictionCorrect) blockers.push('prediction-incorrect');

  return {
    predictionCorrect,
    fields,
    observed: detail.observed,
    synTimes: detail.synTimes,
    evidenceOrigin,
    evidenceConsistent,
    missing: detail.missing,
    evidenceEligible: blockers.length === 0,
    blockers,
  };
}

export interface Reflection {
  causalText: string;
  causalChecks: Record<string, boolean>;
  counterfactuals: Record<string, { text: string; checks: Record<string, boolean> }>;
}

export const MIN_EXPLANATION_CHARS = 30;

/** 振り返り（説明・反事実）の自己照合が完了要件を満たしているか */
export function reflectionBlockers(unit: Unit, reflection: Reflection | null): string[] {
  if (!reflection) return ['reflection-not-recorded'];
  const b: string[] = [];
  if (reflection.causalText.trim().length < MIN_EXPLANATION_CHARS) b.push('causal-text-too-short');
  for (const r of unit.causalExplanation.rubric) {
    if (!reflection.causalChecks[r.id]) b.push(`causal-rubric-unmet:${r.id}`);
  }
  for (const cf of unit.counterfactuals) {
    const a = reflection.counterfactuals[cf.id];
    if (!a || a.text.trim().length < MIN_EXPLANATION_CHARS) {
      b.push(`counterfactual-not-answered:${cf.id}`);
      continue;
    }
    for (const r of cf.rubric) if (!a.checks[r.id]) b.push(`counterfactual-rubric-unmet:${cf.id}.${r.id}`);
  }
  return b;
}

export interface AttemptCompletion {
  completed: boolean;
  blockers: string[];
}

export function attemptCompletion(unit: Unit, evaluation: Evaluation | null, reflection: Reflection | null): AttemptCompletion {
  const blockers = [...(evaluation ? evaluation.blockers : ['no-evidence']), ...reflectionBlockers(unit, reflection)];
  return { completed: blockers.length === 0, blockers };
}

/** 単元の完了：新しい条件でも通ることを示すため、異なる portState の完了試行が2つ以上必要 */
export const REQUIRED_DISTINCT_CONDITIONS = 2;

export function unitCompletion(attempts: { condition: Record<string, string>; completion: AttemptCompletion }[]) {
  const passed = new Set(attempts.filter((a) => a.completion.completed).map((a) => a.condition.portState));
  return {
    completed: passed.size >= REQUIRED_DISTINCT_CONDITIONS,
    passedConditions: [...passed].sort(),
    requiredDistinctConditions: REQUIRED_DISTINCT_CONDITIONS,
  };
}
