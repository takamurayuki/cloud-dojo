/**
 * パイロット（N5）API クライアント。単元データ・判定結果は全て API 由来（画面側で固定値を持たない）。
 * 型は backend/api/src/pilot の応答形に合わせている（単元の正本は backend/api/src/pilot/curriculum）。
 */
import { API_BASE_URL } from '@/config/constants';

const BASE = `${API_BASE_URL}/api/pilot`;

export type EvidenceKind = 'tcpdump' | 'ss-client' | 'ss-server' | 'curl';

export interface UnitLayer {
  title: string;
  body: string[];
  commands?: string[];
}

export interface Unit {
  id: string;
  code: string;
  domain: string;
  title: string;
  summary: string;
  layers: {
    surface: UnitLayer;
    mechanism: UnitLayer;
    observation: UnitLayer & { tools: { kind: EvidenceKind; tool: string; shows: string; howToRead: string }[] };
  };
  loop: { stage: string; title: string; instructions: string }[];
  prediction: {
    prompt: string;
    fields: { id: string; label: string; options: { value: string; label: string }[]; derivedFrom: EvidenceKind[] }[];
  };
  causalExplanation: {
    prompt: string;
    chain: { id: string; cause: string; effect: string; evidence: EvidenceKind[] }[];
    freeTextPrompt: string;
    rubric: { id: string; criterion: string; evidence: EvidenceKind[] }[];
  };
  counterfactuals: { id: string; prompt: string; rubric: { id: string; criterion: string }[] }[];
  requiredEvidence: EvidenceKind[];
}

export interface Evaluation {
  predictionCorrect: boolean;
  fields: { fieldId: string; label: string; predicted: string; actual: string | null; correct: boolean }[];
  observed: Record<string, string>;
  synTimes: number[];
  evidenceOrigin: 'measured' | 'fixture' | 'mixed' | 'none';
  evidenceConsistent: boolean;
  missing: string[];
  evidenceEligible: boolean;
  blockers: string[];
}

export interface Reflection {
  causalText: string;
  causalChecks: Record<string, boolean>;
  counterfactuals: Record<string, { text: string; checks: Record<string, boolean> }>;
}

export interface Attempt {
  id: string;
  unitId: string;
  seed: string;
  createdAt: string;
  condition: { paramId: string; label: string; value: string; valueLabel: string; scenario: string }[];
  stage: string;
  predictionLocked: boolean;
  predictionLockedAt: string | null;
  prediction: Record<string, string> | null;
  evidence: { kind: EvidenceKind; origin: 'measured' | 'fixture'; sha256: string; collectedAt: string }[];
  evaluation: Evaluation | null;
  reflection: Reflection | null;
  completion: { completed: boolean; blockers: string[] };
}

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  origin: 'measured' | 'fixture';
  content: string;
  sha256: string;
  collectedAt: string;
}

export interface UnitStatus {
  unitId: string;
  attempts: number;
  completed: boolean;
  passedConditions: string[];
  requiredDistinctConditions: number;
}

export interface LabStatus {
  docker: 'available';
  running: boolean;
  nodes: { role: string; containerId: string; state: string }[];
  network: { name: string; internal: boolean } | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'API_UNREACHABLE', `API に接続できません（${BASE}）`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'ERROR', data.message ?? data.error ?? res.statusText, data.hint);
  return data as T;
}

export const pilotApi = {
  unit: (id: string) => call<Unit>('GET', `/units/${id}`),
  status: (id: string) => call<UnitStatus>('GET', `/units/${id}/status`),
  createAttempt: (unitId: string) => call<Attempt>('POST', '/attempts', { unitId }),
  attempt: (id: string) => call<Attempt>('GET', `/attempts/${id}`),
  predict: (id: string, answers: Record<string, string>) => call<Attempt>('POST', `/attempts/${id}/prediction`, { answers }),
  run: (id: string, mode: 'lab' | 'fixture') => call<Attempt>('POST', `/attempts/${id}/run`, { mode }),
  evidence: (id: string) => call<EvidenceItem[]>('GET', `/attempts/${id}/evidence`),
  reflect: (id: string, r: Reflection) => call<Attempt>('PUT', `/attempts/${id}/reflection`, r),
  labStatus: () => call<LabStatus>('GET', '/lab/status'),
  labStart: () => call<LabStatus & { elapsedMs: number }>('POST', '/lab/start'),
  labReset: () => call<{ removedContainers: number; removedNetworks: number; elapsedMs: number }>('POST', '/lab/reset'),
};
