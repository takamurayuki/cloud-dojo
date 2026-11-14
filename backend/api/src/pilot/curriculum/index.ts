import { validateUnit, type Unit } from './schema';
import { n5TcpUnit } from './units/n5-tcp';

/** git 管理の単元データ。読み込み時に必ずバリデータを通す（不正なら起動時に例外） */
const RAW_UNITS: unknown[] = [n5TcpUnit];

const units = new Map<string, Unit>();
for (const raw of RAW_UNITS) {
  const unit = validateUnit(raw);
  units.set(unit.id, unit);
}

export function getUnit(id: string): Unit | undefined {
  return units.get(id);
}

export function listUnits(): Unit[] {
  return [...units.values()];
}

export * from './schema';
