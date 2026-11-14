/**
 * パイロット（N5）API クライアント。単元データ・判定結果は全て API 由来（画面側で固定値を持たない）。
 * 型は backend/api/src/pilot の応答形に合わせている（単元の正本は backend/api/src/pilot/curriculum）。
 */
import { API_BASE_URL } from '@/config/constants';

const BASE = `${API_BASE_URL}/api/pilot`;

export type EvidenceKind = 'tcpdump' | 'ss-client' | 'ss-server' | 'curl' | 'lab-env';

export interface LabEnv {
  linearTimeouts: number;
  linearTimeoutsRecorded: boolean;
  synRetries: number;
  osRelease: string | null;
}

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
  consistencyIssues: string[];
  labEnv: LabEnv | null;
  labEnvPremise: { linearTimeouts: number; synRetries: number };
  expectedSynTimes: number[] | null;
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
  running: boolean;
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
  /** ラボを使用中の操作（なければ null） */
  busy?: { owner: string; since: string } | null;
  /** 期限超過した操作の後始末が続いている間の状態（無ければ null） */
  cleanupPending?: LabCleanupState | null;
}

/** 期限超過した操作の後始末中の状態（API の LabCleanupState） */
export interface LabCleanupState {
  generation: string;
  operation: string;
  since: string;
  /** 後始末は終わったが削除を確認できなかった対象（付いているときは待っても解除されない） */
  remaining?: string[];
}

/** 後始末中が続く場合の案内（手順そのものは画面の「復旧手順」（LAB_CLEANUP_RECOVERY_STEPS）を開いて読む） */
export const LAB_CLEANUP_RECOVERY = '下の「復旧手順」を開いて対処してください。';

/**
 * 後始末中が続く場合の復旧手順。backend/api/src/pilot/README.md「後始末中が続く場合」と同じ内容。
 * 「リセット」は削除だけを行い、「ラボで実行（実測）」は削除のあとに実測用のラボを新しく起動する（実挙動どおりに書く）。
 */
export const LAB_CLEANUP_RECOVERY_STEPS: string[] = [
  'API プロセスを再起動する（pnpm run dev:pilot を止めて起動し直す）。後始末中の状態はプロセス内にだけあるので、これで解除される。',
  '「リセット」を押す。前のプロセスのものを含め、ラベル cloud-dojo.lab の付いたラボのコンテナ・ネットワークを全て削除する（ラボは停止したままになる。続けて使うときは「起動」）。',
  '「リセット」の代わりに「ラボで実行（実測）」でもよい。同じ削除を行ったあと、実測用のラボを新しく起動して実測する（実測後もそのラボは起動したまま残る）。',
  'それでも残る場合は Docker を直接確認する：docker ps -a --filter label=cloud-dojo.lab ／ docker network ls --filter label=cloud-dojo.lab',
];

/** 後始末中（LAB_CLEANUP_PENDING）の表示用の文 */
export function cleanupPendingHint(s: LabCleanupState | null | undefined): string {
  const since = s ? new Date(s.since) : null;
  const op = s ? `前の操作（${s.operation}、${since && !Number.isNaN(since.getTime()) ? since.toLocaleString('ja-JP') : s.since} 開始）` : '前の操作';
  if (s?.remaining && s.remaining.length > 0) {
    return `${op}の後始末で、削除を確認できなかったリソースがあります（${s.remaining.join(' / ')}）。待っても解除されません。${LAB_CLEANUP_RECOVERY}`;
  }
  return `${op}の後始末が続いています。通常は終わりしだい解除されるので、しばらく待ってから再試行してください。長く続く場合は${LAB_CLEANUP_RECOVERY}`;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public hint?: string,
    /** 後始末中が続く場合の復旧手順（LAB_CLEANUP_RECOVERY_STEPS）を表示するか */
    public recovery = false,
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
  if (!res.ok) {
    // 409 LAB_CLEANUP_PENDING の cleanup は後始末中の状態（LabCleanupState）、504 LAB_TIMEOUT の cleanup は後始末の結果
    const hint = data.hint ?? (data.error === 'LAB_CLEANUP_PENDING' ? cleanupPendingHint(data.cleanup) : cleanupHint(data.cleanup));
    const recovery = data.error === 'LAB_CLEANUP_PENDING' || Boolean(data.cleanup?.pending || data.cleanup?.remaining?.length);
    throw new ApiError(res.status, data.error ?? 'ERROR', data.message ?? data.error ?? res.statusText, hint, recovery);
  }
  return data as T;
}

interface CleanupResult {
  ok: boolean;
  stoppedContainers: number;
  removedContainers: number;
  removedNetworks: number;
  errors: string[];
  /** 後始末中の状態が解除されていない（期限内に終わっていない、または削除を確認できなかった。ラボ操作は 409 LAB_CLEANUP_PENDING） */
  pending?: true;
  /** 削除を確認できなかった対象 */
  remaining?: string[];
}

/** ラボ操作の期限超過（LAB_TIMEOUT）時に行われた後始末の結果を表示用の文にする */
function cleanupHint(c: CleanupResult | null | undefined): string | undefined {
  if (!c) return undefined;
  const counts = `停止 ${c.stoppedContainers}・削除 ${c.removedContainers} コンテナ、ネットワーク削除 ${c.removedNetworks}`;
  const errors = c.errors ?? [];
  if (c.remaining && c.remaining.length > 0) {
    return `ラボの後始末で、削除を確認できなかったリソースがあります（${counts}）：${[...c.remaining, ...errors].join(' / ')}。待っても解除されず、このままではラボを操作できません。${LAB_CLEANUP_RECOVERY}`;
  }
  if (c.pending) return `ラボの後始末が期限内に終わらず、まだ続いています（ここまで：${counts}）。終わるまでラボの操作はできません。しばらく待ってから再試行してください。長く続く場合は${LAB_CLEANUP_RECOVERY}`;
  return c.ok ? `ラボのコンテナを停止・削除しました（${counts}）。` : `ラボの後始末に失敗した箇所があります（${counts}）：${errors.join(' / ')}`;
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
