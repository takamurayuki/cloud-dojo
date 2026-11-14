import { describe, expect, it } from 'vitest';
import { LOOP_STAGES, UnitValidationError, validateUnit } from '../curriculum/schema';
import { getUnit } from '../curriculum';
import { n5TcpUnit } from '../curriculum/units/n5-tcp';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 欠落単元を作るために任意の階層を削除する
const clone = () => structuredClone(n5TcpUnit) as unknown as Record<string, any>;

function issuesOf(input: unknown): string[] {
  try {
    validateUnit(input);
  } catch (e) {
    expect(e).toBeInstanceOf(UnitValidationError);
    return (e as UnitValidationError).issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  }
  return [];
}

describe('単元バリデータ', () => {
  it('N5 単元（正しい単元）は通る', () => {
    const unit = validateUnit(n5TcpUnit);
    expect(unit.id).toBe('n5-tcp');
    expect(unit.loop.map((s) => s.stage)).toEqual([...LOOP_STAGES]);
    expect(getUnit('n5-tcp')).toBeDefined();
  });

  it.each(['surface', 'mechanism', 'observation'])('3層のうち %s が欠けた単元は落ちる', (layer) => {
    const u = clone();
    delete u.layers[layer];
    const issues = issuesOf(u);
    expect(issues.some((i) => i.startsWith(`layers.${layer}`))).toBe(true);
  });

  it('学習ループの段階順序が違うと落ちる（説明が観察より前）', () => {
    const u = clone();
    const loop = u.loop;
    [loop[2], loop[3]] = [loop[3], loop[2]];
    const issues = issuesOf(u);
    expect(issues.some((i) => i.startsWith('loop:') && i.includes('順'))).toBe(true);
  });

  it('学習ループの段階が欠けると落ちる（反事実なし）', () => {
    const u = clone();
    u.loop = u.loop.slice(0, 4);
    expect(issuesOf(u).some((i) => i.startsWith('loop:'))).toBe(true);
  });

  it.each([
    ['prediction'],
    ['causalExplanation'],
    ['counterfactuals'],
    ['faultScenarios'],
    ['requiredEvidence'],
  ])('必須項目 %s が欠けた単元は落ちる', (key) => {
    const u = clone();
    delete u[key];
    expect(issuesOf(u).some((i) => i.startsWith(key))).toBe(true);
  });

  it('因果チェーンのルーブリックが空だと落ちる', () => {
    const u = clone();
    u.causalExplanation.rubric = [];
    expect(issuesOf(u).some((i) => i.startsWith('causalExplanation.rubric'))).toBe(true);
  });

  it('予測項目の必須欄（選択肢）が欠けると落ちる', () => {
    const u = clone();
    delete u.prediction.fields[0].options;
    expect(issuesOf(u).some((i) => i.startsWith('prediction.fields.0.options'))).toBe(true);
  });

  it('障害シナリオが未宣言の条件を参照すると落ちる', () => {
    const u = clone();
    u.faultScenarios[0].condition = { portState: 'filtered' };
    expect(issuesOf(u).some((i) => i.includes('未宣言の条件'))).toBe(true);
  });
});
