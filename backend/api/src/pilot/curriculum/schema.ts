/**
 * 単元データの型とバリデータ（学習エンジンの契約）。
 *
 * 単元は git 管理の型付きデータとして書き、読み込み時にこのバリデータで構造を強制する。
 * - 3層（表層の操作／内部機構／観察）は全て必須
 * - 学習ループは 予測→実行→観察→説明→反事実 の5段階をこの順で必須
 * - 予測問題（構造化回答）、因果説明（因果チェーン＋自由記述＋ルーブリック）、反事実問題、障害シナリオは必須
 */
import { z } from 'zod';

/** 学習ループの段階（この順序が正規） */
export const LOOP_STAGES = ['predict', 'execute', 'observe', 'explain', 'counterfactual'] as const;
export type LoopStage = (typeof LOOP_STAGES)[number];

/** 観察証拠の種類。単元・ルーブリックはこの種類で必要な証拠を宣言する */
export const EVIDENCE_KINDS = ['tcpdump', 'ss-client', 'ss-server', 'curl'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const nonEmpty = z.string().trim().min(1);

const layerSchema = z.object({
  title: nonEmpty,
  /** 段落の配列 */
  body: z.array(nonEmpty).min(1),
  /** 表層の操作で叩くコマンドなど（任意） */
  commands: z.array(nonEmpty).optional(),
});

const observationToolSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  tool: nonEmpty,
  /** 何が見えるか */
  shows: nonEmpty,
  /** どこを読むか */
  howToRead: nonEmpty,
});

const layersSchema = z
  .object({
    surface: layerSchema,
    mechanism: layerSchema,
    observation: layerSchema.extend({ tools: z.array(observationToolSchema).min(1) }),
  })
  .strict();

const stageSchema = z.object({
  stage: z.enum(LOOP_STAGES),
  title: nonEmpty,
  instructions: nonEmpty,
});

const optionSchema = z.object({ value: nonEmpty, label: nonEmpty });

const predictionFieldSchema = z.object({
  id: nonEmpty,
  label: nonEmpty,
  /** 構造化回答：選択肢から1つ選ぶ */
  kind: z.literal('choice'),
  options: z.array(optionSchema).min(2),
  /** この項目の正解を算出するのに使う証拠 */
  derivedFrom: z.array(z.enum(EVIDENCE_KINDS)).min(1),
});

const conditionVariantSchema = z.object({
  value: nonEmpty,
  label: nonEmpty,
  /** 予測問題の前提として学習者に示す状況説明 */
  scenario: nonEmpty,
});

const conditionParamSchema = z.object({
  id: nonEmpty,
  label: nonEmpty,
  variants: z.array(conditionVariantSchema).min(2),
});

const predictionSchema = z.object({
  prompt: nonEmpty,
  /** シードで値が決まる条件パラメータ。正解は条件ではなく証拠から算出する */
  conditionParams: z.array(conditionParamSchema).min(1),
  fields: z.array(predictionFieldSchema).min(1),
});

const rubricItemSchema = z.object({
  id: nonEmpty,
  criterion: nonEmpty,
  /** この基準を満たす主張が結び付くべき証拠 */
  evidence: z.array(z.enum(EVIDENCE_KINDS)).min(1),
});

const causalLinkSchema = z.object({
  id: nonEmpty,
  cause: nonEmpty,
  effect: nonEmpty,
  /** この因果を裏付ける観察証拠 */
  evidence: z.array(z.enum(EVIDENCE_KINDS)).min(1),
});

const causalExplanationSchema = z.object({
  prompt: nonEmpty,
  chain: z.array(causalLinkSchema).min(2),
  freeTextPrompt: nonEmpty,
  rubric: z.array(rubricItemSchema).min(1),
});

const counterfactualSchema = z.object({
  id: nonEmpty,
  prompt: nonEmpty,
  /** 反事実は実測できない条件を問うため、証拠の紐付けは任意 */
  rubric: z.array(z.object({ id: nonEmpty, criterion: nonEmpty })).min(1),
});

const faultScenarioSchema = z.object({
  id: nonEmpty,
  name: nonEmpty,
  /** conditionParams の値の組（このシナリオを再現する条件） */
  condition: z.record(nonEmpty, nonEmpty),
  injection: nonEmpty,
  symptom: nonEmpty,
});

export const unitSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    code: nonEmpty,
    domain: nonEmpty,
    title: nonEmpty,
    summary: nonEmpty,
    layers: layersSchema,
    loop: z.array(stageSchema),
    prediction: predictionSchema,
    causalExplanation: causalExplanationSchema,
    counterfactuals: z.array(counterfactualSchema).min(1),
    faultScenarios: z.array(faultScenarioSchema).min(1),
    /** 完了判定に必須の観察証拠 */
    requiredEvidence: z.array(z.enum(EVIDENCE_KINDS)).min(1),
  })
  .superRefine((unit, ctx) => {
    // 学習ループ：5段階が正規の順序で過不足なく並ぶこと
    const stages = unit.loop.map((s) => s.stage);
    const ok = stages.length === LOOP_STAGES.length && stages.every((s, i) => s === LOOP_STAGES[i]);
    if (!ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['loop'],
        message: `学習ループは ${LOOP_STAGES.join('→')} の順で5段階が必要（実際: ${stages.join('→') || '空'}）`,
      });
    }

    // ID の重複禁止
    const dup = (ids: string[], path: (string | number)[], what: string) => {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `${what} の id が重複: ${id}` });
        }
        seen.add(id);
      }
    };
    dup(unit.prediction.fields.map((f) => f.id), ['prediction', 'fields'], '予測項目');
    dup(unit.prediction.conditionParams.map((p) => p.id), ['prediction', 'conditionParams'], '条件パラメータ');
    dup(unit.causalExplanation.rubric.map((r) => r.id), ['causalExplanation', 'rubric'], 'ルーブリック');
    dup(unit.counterfactuals.map((c) => c.id), ['counterfactuals'], '反事実問題');

    // 障害シナリオの条件は宣言済みパラメータの値であること
    const params = new Map(unit.prediction.conditionParams.map((p) => [p.id, new Set(p.variants.map((v) => v.value))]));
    unit.faultScenarios.forEach((fs, i) => {
      for (const [k, v] of Object.entries(fs.condition)) {
        if (!params.get(k)?.has(v)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['faultScenarios', i, 'condition', k],
            message: `未宣言の条件 ${k}=${v}`,
          });
        }
      }
    });

    // 予測項目・ルーブリックが参照する証拠は requiredEvidence に含まれていること
    const req = new Set(unit.requiredEvidence);
    const refs: [EvidenceKind[], (string | number)[]][] = [
      ...unit.prediction.fields.map((f, i): [EvidenceKind[], (string | number)[]] => [f.derivedFrom, ['prediction', 'fields', i, 'derivedFrom']]),
      ...unit.causalExplanation.chain.map((c, i): [EvidenceKind[], (string | number)[]] => [c.evidence, ['causalExplanation', 'chain', i, 'evidence']]),
      ...unit.causalExplanation.rubric.map((r, i): [EvidenceKind[], (string | number)[]] => [r.evidence, ['causalExplanation', 'rubric', i, 'evidence']]),
    ];
    for (const [kinds, path] of refs) {
      for (const k of kinds) {
        if (!req.has(k)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `requiredEvidence に無い証拠を参照: ${k}` });
        }
      }
    }
  });

export type Unit = z.infer<typeof unitSchema>;
export type PredictionField = Unit['prediction']['fields'][number];
export type RubricItem = Unit['causalExplanation']['rubric'][number];

export class UnitValidationError extends Error {
  constructor(
    public readonly unitId: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(
      `単元 ${unitId} の構造が不正: ` +
        issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join(' / '),
    );
    this.name = 'UnitValidationError';
  }
}

/** 単元を検証する。不正なら UnitValidationError を投げる */
export function validateUnit(input: unknown): Unit {
  const r = unitSchema.safeParse(input);
  if (!r.success) {
    const id = typeof input === 'object' && input && 'id' in input ? String((input as { id: unknown }).id) : '(unknown)';
    throw new UnitValidationError(id, r.error.issues);
  }
  return r.data;
}
