import { randomBytes } from 'node:crypto';
import type { Unit } from './curriculum/schema';

export type Condition = Record<string, string>;

/** FNV-1a 32bit。シード→条件の写像を実行環境に依らず決定的にするための単純なハッシュ */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** シードから条件パラメータの値を決める（同じ単元・同じシードなら常に同じ条件） */
export function deriveCondition(unit: Unit, seed: string): Condition {
  const condition: Condition = {};
  for (const param of unit.prediction.conditionParams) {
    const idx = fnv1a(`${unit.id}|${param.id}|${seed}`) % param.variants.length;
    condition[param.id] = param.variants[idx].value;
  }
  return condition;
}

export function newSeed(): string {
  return randomBytes(6).toString('hex');
}

/** 学習者に示す前提（条件の状況説明） */
export function describeCondition(unit: Unit, condition: Condition): { paramId: string; label: string; value: string; valueLabel: string; scenario: string }[] {
  return unit.prediction.conditionParams.map((p) => {
    const v = p.variants.find((x) => x.value === condition[p.id]);
    if (!v) throw new Error(`条件 ${p.id}=${condition[p.id]} は単元 ${unit.id} に無い`);
    return { paramId: p.id, label: p.label, value: v.value, valueLabel: v.label, scenario: v.scenario };
  });
}
