import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  FlaskConical,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  XCircle,
} from 'lucide-react';
import {
  ApiError,
  cleanupPendingHint,
  LAB_CLEANUP_RECOVERY_STEPS,
  pilotApi,
  type Attempt,
  type EvidenceItem,
  type LabStatus,
  type Reflection,
  type Unit,
  type UnitStatus,
} from '@/features/pilot/api';
import { PageLayout } from '@/layouts/PageLayout';
import { PageHeader } from '@/layouts/PageHeader';

const STORAGE_KEY = (unitId: string) => `pilot-attempt-${unitId}`;

const BLOCKER_LABELS: Record<string, string> = {
  'no-evidence': '観察証拠がない',
  'fixture-evidence': 'フィクスチャ（模擬）証拠のため完了にできない',
  'prediction-incorrect': '予測が観察結果と一致していない',
  'evidence-inconsistent-with-condition': '証拠が、条件と記録された実行環境から期待される結果と一致しない（ラボ構成不良の可能性）',
  'lab-env-premise-mismatch': 'ラボの実行環境（SYN 再送の設定）が教材の前提と異なる',
  'evidence-from-other-attempt': '別の試行の証拠が混じっている',
  'reflection-not-recorded': '説明・反事実が未記録',
  'causal-text-too-short': '因果説明の記述が短すぎる（30文字以上）',
};

function blockerLabel(b: string): string {
  if (BLOCKER_LABELS[b]) return BLOCKER_LABELS[b];
  const [k, v] = b.split(':');
  if (k === 'missing-evidence') return `必須証拠 ${v} がない`;
  if (k === 'causal-rubric-unmet') return `因果説明のルーブリック未達：${v}`;
  if (k === 'counterfactual-not-answered') return `反事実問題 ${v} が未回答（30文字以上）`;
  if (k === 'counterfactual-rubric-unmet') return `反事実のルーブリック未達：${v}`;
  return b;
}

const ORIGIN_LABEL: Record<string, string> = { measured: '実測', fixture: 'フィクスチャ（模擬）', mixed: '混在', none: 'なし' };

/** 証拠から算出した値の呼び方。実測のときだけ「実測」と呼び、それ以外は由来を添えて「観察結果」と呼ぶ */
const OBSERVED_LABEL: Record<string, string> = { measured: '実測', fixture: '観察結果（フィクスチャ）', mixed: '観察結果（実測とフィクスチャの混在）', none: '観察結果' };

const ERROR_TITLES: Record<string, string> = {
  DOCKER_NOT_FOUND: 'Docker 未検出',
  LAB_BUSY: 'ラボは使用中',
  LAB_TIMEOUT: 'ラボ操作が期限を超えた',
  LAB_CLEANUP_PENDING: 'ラボの後始末中',
  RUN_IN_PROGRESS: 'この試行は実行中',
};

function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="glass rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

/** 後始末中が続く場合の復旧手順（開いて読む。README「後始末中が続く場合」と同じ内容） */
function RecoverySteps() {
  return (
    <details className="mt-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-foreground" data-testid="lab-recovery-steps">
      <summary className="cursor-pointer font-semibold select-none text-warning">復旧手順</summary>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        {LAB_CLEANUP_RECOVERY_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="mt-2 text-xs text-muted-foreground">
        同じ内容をリポジトリの backend/api/src/pilot/README.md「後始末中が続く場合」にも記載しています。
      </div>
    </details>
  );
}

function ErrorBox({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <div className="rounded-xl border border-danger/50 bg-danger/10 p-3 text-sm text-foreground flex gap-2" role="alert">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-danger" />
      <div>
        <div className="font-semibold text-danger">{ERROR_TITLES[error.code] ?? `エラー（${error.code}）`}</div>
        <div>{error.message}</div>
        {error.hint && <div className="mt-1 text-muted-foreground">{error.hint}</div>}
        {error.recovery && <RecoverySteps />}
      </div>
    </div>
  );
}

/** 次に押すボタンの種類（表示用。学習フローの判定は API の状態をそのまま使う） */
type NextAction = 'start' | 'choose' | 'submit' | 'run' | 'reflect' | 'review' | 'retry' | 'done';

const NEXT_ACTION_TEXT: Record<NextAction, { title: string; detail: string }> = {
  start: { title: '「試行を始める」を押す', detail: '左の「予測」カードから。シードから条件が決まります。' },
  choose: { title: '予測の各項目を選ぶ', detail: '左の「予測」カードで、すべての項目を選ぶと提出できます。' },
  submit: { title: '「予測を提出してロック」を押す', detail: '提出すると予測は変更できません。提出後にラボで実行できます。' },
  run: { title: '「ラボで実行（実測）」を押す', detail: '右の「ラボ」カードから。フィクスチャ実行は練習用で、完了にはなりません。' },
  reflect: { title: '観察を読み、説明と反事実を書いて「自己照合を記録」を押す', detail: '右の「観察」「判定と振り返り」で結果を確かめてから、左の「説明と反事実」へ。' },
  review: { title: '未達の項目を直して記録し直すか、「新しい条件で試す」', detail: '「判定と振り返り」に、この試行が完了にならない理由が出ています。' },
  retry: { title: '「新しい条件で試す」で別の条件に進む', detail: '単元の完了には、異なる条件での完了が必要です。' },
  done: { title: '単元完了', detail: '必要な条件をすべて完了しました。別の条件で練習を続けることもできます。' },
};

/** 次に押すボタンを目立たせる枠 */
const NEXT_RING = 'ring-2 ring-primary ring-offset-2 ring-offset-background';

const LAYER_TABS = [
  { key: 'surface', label: '表層の操作' },
  { key: 'mechanism', label: '内部機構' },
  { key: 'observation', label: '観察' },
] as const;

export function UnitPage() {
  const { unitId = 'n5-tcp' } = useParams();
  const [unit, setUnit] = useState<Unit | null>(null);
  const [status, setStatus] = useState<UnitStatus | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [lab, setLab] = useState<LabStatus | null>(null);
  const [labError, setLabError] = useState<ApiError | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [layer, setLayer] = useState<(typeof LAYER_TABS)[number]['key']>('surface');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Reflection>({ causalText: '', causalChecks: {}, counterfactuals: {} });

  const guard = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'ERROR', String(e)));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  const refreshLab = useCallback(async () => {
    try {
      setLab(await pilotApi.labStatus());
      setLabError(null);
    } catch (e) {
      setLab(null);
      setLabError(e instanceof ApiError ? e : new ApiError(0, 'ERROR', String(e)));
    }
  }, []);

  const applyAttempt = useCallback(
    async (a: Attempt) => {
      setAttempt(a);
      localStorage.setItem(STORAGE_KEY(unitId), a.id);
      setAnswers(a.prediction ?? {});
      if (a.reflection) setDraft(a.reflection);
      setEvidence(a.predictionLocked ? await pilotApi.evidence(a.id) : []);
      setStatus(await pilotApi.status(unitId));
    },
    [unitId],
  );

  useEffect(() => {
    void guard(async () => {
      setUnit(await pilotApi.unit(unitId));
      setStatus(await pilotApi.status(unitId));
      const saved = localStorage.getItem(STORAGE_KEY(unitId));
      if (saved) {
        try {
          await applyAttempt(await pilotApi.attempt(saved));
        } catch {
          localStorage.removeItem(STORAGE_KEY(unitId));
        }
      }
    });
    void refreshLab();
  }, [unitId, guard, applyAttempt, refreshLab]);

  const newAttempt = () =>
    guard(async () => {
      setDraft({ causalText: '', causalChecks: {}, counterfactuals: {} });
      await applyAttempt(await pilotApi.createAttempt(unitId));
    });

  const submitPrediction = () => guard(async () => attempt && applyAttempt(await pilotApi.predict(attempt.id, answers)));
  const run = (mode: 'lab' | 'fixture') => guard(async () => attempt && applyAttempt(await pilotApi.run(attempt.id, mode)));
  const saveReflection = () => guard(async () => attempt && applyAttempt(await pilotApi.reflect(attempt.id, draft)));
  const labAction = (fn: () => Promise<unknown>) =>
    guard(async () => {
      try {
        await fn();
      } finally {
        await refreshLab();
      }
    });

  if (!unit) {
    return (
      <div className="p-8 space-y-4 max-w-7xl mx-auto">
        <ErrorBox error={error} />
        {!error && <div className="text-muted-foreground">読み込み中…</div>}
      </div>
    );
  }

  const isLabError = error !== null && ['DOCKER_NOT_FOUND', 'LAB_ERROR', 'LAB_BUSY', 'LAB_TIMEOUT', 'LAB_CLEANUP_PENDING'].includes(error.code);
  const fieldsComplete = unit.prediction.fields.every((f) => answers[f.id]);
  const locked = attempt?.predictionLocked ?? false;
  const evaluation = attempt?.evaluation ?? null;
  const isFixture = evidence.length > 0 && evidence.some((e) => e.origin === 'fixture');
  const observedLabel = OBSERVED_LABEL[evaluation?.evidenceOrigin ?? 'none'];
  const stageIndex = !attempt ? -1 : unit.loop.findIndex((s) => s.stage === attempt.stage);
  const evidenceByKind = Object.fromEntries(evidence.map((e) => [e.kind, e]));
  const optionLabel = (fieldId: string, v: string | null) =>
    v === null ? '（証拠から算出できず）' : unit.prediction.fields.find((f) => f.id === fieldId)?.options.find((o) => o.value === v)?.label ?? v;
  const remainingFields = unit.prediction.fields.filter((f) => !answers[f.id]).length;
  // 表示だけのための「次にやること」。各ボタンの有効・無効の条件は従来どおり
  const nextAction: NextAction =
    status?.completed && attempt?.completion.completed
      ? 'done'
      : !attempt
        ? 'start'
        : !locked
          ? fieldsComplete
            ? 'submit'
            : 'choose'
          : evidence.length === 0
            ? 'run'
            : !attempt.reflection
              ? 'reflect'
              : attempt.completion.completed
                ? 'retry'
                : 'review';
  const next = NEXT_ACTION_TEXT[nextAction];
  const ringIf = (a: NextAction | NextAction[]) => ((Array.isArray(a) ? a : [a]).includes(nextAction) && !busy ? NEXT_RING : '');

  return (
    <PageLayout>
      {/* 見出し */}
      <PageHeader
        eyebrow={`${unit.domain} / ${unit.code}`}
        title={unit.title}
        description={unit.summary}
        Icon={FlaskConical}
        bgColor="bg-gradient-to-br from-emerald-500 to-teal-500"
        aside={
          status && (
            <div
              className={`rounded-xl border px-4 py-2 text-sm ${status.completed ? 'border-success/50 bg-success/10' : 'border-border bg-card'}`}
              data-testid="unit-status"
            >
              <div className={`font-semibold ${status.completed ? 'text-success' : ''}`}>{status.completed ? '単元完了' : '単元未完了'}</div>
              <div className="text-muted-foreground">
                完了した条件：{status.passedConditions.length > 0 ? status.passedConditions.join('、') : 'なし'}（異なる条件で {status.requiredDistinctConditions} つ必要）
              </div>
              <div className="text-muted-foreground">試行数：{status.attempts}</div>
            </div>
          )
        }
      />

      {/* 学習ループの進行（試行の状態から表示）と次にやること。スクロールしても上部に残す */}
      <div className="sticky top-0 z-20 -mx-2 px-2 py-3 bg-background/90 backdrop-blur border-b border-border space-y-3" data-testid="unit-progress">
        <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 text-sm" aria-label="学習の段階">
          {unit.loop.map((s, i) => {
            const state = i === stageIndex ? 'current' : i < stageIndex ? 'done' : 'todo';
            return (
              <li key={s.stage} className="flex items-center gap-1" title={s.instructions} aria-current={state === 'current' ? 'step' : undefined}>
                {i > 0 && <span aria-hidden className={`h-px w-4 sm:w-6 ${i <= stageIndex ? 'bg-primary' : 'bg-border'}`} />}
                <span
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-full border ${
                    state === 'current'
                      ? 'bg-primary text-primary-foreground border-primary font-semibold shadow-sm'
                      : state === 'done'
                        ? 'border-primary/50 bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground'
                  }`}
                >
                  {state === 'done' ? <Check className="w-3.5 h-3.5" /> : <span className="tabular-nums">{i + 1}.</span>}
                  {s.title}
                  {state === 'current' && <span className="sr-only">（現在の段階）</span>}
                </span>
              </li>
            );
          })}
        </ol>
        <div
          className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${nextAction === 'done' ? 'border-success/50 bg-success/10' : 'border-primary/40 bg-primary/5'}`}
          data-testid="next-action"
          aria-live="polite"
        >
          {busy ? (
            <Loader2 className="w-4 h-4 mt-0.5 shrink-0 animate-spin text-primary" />
          ) : nextAction === 'done' ? (
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-success" />
          ) : (
            <ArrowRight className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
          )}
          <div>
            <div className="font-semibold">
              {busy ? (
                '処理中…'
              ) : (
                <>
                  次にやること：{next.title}
                  {nextAction === 'choose' && `（残り ${remainingFields} 項目）`}
                </>
              )}
            </div>
            {!busy && <div className="text-muted-foreground">{next.detail}</div>}
          </div>
        </div>
      </div>

      {!isLabError && <ErrorBox error={error} />}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        {/* ===== 左ペイン：教材と回答 ===== */}
        <div className="space-y-4">
          <Card title="教材">
            <div className="flex gap-1 border-b border-border">
              {LAYER_TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setLayer(t.key)}
                  aria-pressed={layer === t.key}
                  className={`px-3 py-1.5 text-sm -mb-px border-b-2 transition-colors ${layer === t.key ? 'border-primary text-primary font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <h3 className="font-semibold">{unit.layers[layer].title}</h3>
            {unit.layers[layer].body.map((p, i) => (
              <p key={i} className="text-sm leading-relaxed">
                {p}
              </p>
            ))}
            {unit.layers[layer].commands && (
              <pre className="terminal text-xs rounded-lg p-3 overflow-x-auto">{unit.layers[layer].commands!.join('\n')}</pre>
            )}
            {layer === 'observation' && (
              <ul className="space-y-2">
                {unit.layers.observation.tools.map((t) => (
                  <li key={t.kind} className="text-sm">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{t.tool}</code>
                    <div className="mt-1">{t.shows}。{t.howToRead}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="予測"
            right={
              attempt && (
                <button onClick={newAttempt} disabled={busy} className={`btn btn-outline btn-sm ${ringIf(['retry', 'review', 'done'])}`}>
                  <RefreshCw className="w-4 h-4" /> 新しい条件で試す
                </button>
              )
            }
          >
            {!attempt ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">試行を始めると、シードから条件が決まります。条件ごとに正解は変わります。</p>
                <button onClick={newAttempt} disabled={busy} className={`btn btn-primary ${ringIf('start')}`}>
                  試行を始める
                </button>
              </div>
            ) : (
              <>
                <div className="rounded-xl bg-muted/60 p-3 text-sm space-y-1">
                  <div className="text-xs text-muted-foreground">シード {attempt.seed}</div>
                  <div className="font-medium">{unit.prediction.prompt}</div>
                  {attempt.condition.map((c) => (
                    <div key={c.paramId}>
                      <span className="font-semibold">{c.label}：</span>
                      {c.scenario}
                    </div>
                  ))}
                </div>
                {locked && (
                  <div className="flex items-center gap-2 text-sm text-warning" data-testid="prediction-locked">
                    <Lock className="w-4 h-4" /> 予測は提出済みでロックされています（{attempt.predictionLockedAt && new Date(attempt.predictionLockedAt).toLocaleString()}）
                  </div>
                )}
                <div className="space-y-3">
                  {unit.prediction.fields.map((f) => (
                    <fieldset key={f.id} disabled={locked} className="space-y-1">
                      <legend className="text-sm font-semibold">{f.label}</legend>
                      <div className="flex flex-wrap gap-2">
                        {f.options.map((o) => (
                          <label
                            key={o.value}
                            className={`text-sm px-3 py-1 rounded-lg border transition-colors focus-within:ring-2 focus-within:ring-ring ${
                              answers[f.id] === o.value ? 'border-primary bg-primary/15 text-foreground font-medium ring-1 ring-primary' : 'border-input bg-card'
                            } ${locked ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:bg-muted'}`}
                          >
                            <input
                              type="radio"
                              className="sr-only"
                              name={f.id}
                              value={o.value}
                              checked={answers[f.id] === o.value}
                              onChange={() => setAnswers({ ...answers, [f.id]: o.value })}
                            />
                            {o.label}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                </div>
                {!locked && (
                  <button onClick={submitPrediction} disabled={busy || !fieldsComplete} className={`btn btn-primary ${ringIf('submit')}`}>
                    <Lock className="w-4 h-4" /> 予測を提出してロック
                  </button>
                )}
              </>
            )}
          </Card>

          {attempt && evaluation && (
            <Card title="説明と反事実（ルーブリック自己照合）">
              <div className="text-sm font-medium">{unit.causalExplanation.prompt}</div>
              <ol className="text-sm space-y-1 list-decimal pl-5">
                {unit.causalExplanation.chain.map((c) => (
                  <li key={c.id}>
                    {c.cause} → {c.effect} <span className="text-xs text-muted-foreground">（証拠：{c.evidence.join(', ')}）</span>
                  </li>
                ))}
              </ol>
              <label className="block text-sm">
                {unit.causalExplanation.freeTextPrompt}
                <textarea
                  className="field mt-1"
                  rows={5}
                  value={draft.causalText}
                  onChange={(e) => setDraft({ ...draft, causalText: e.target.value })}
                />
              </label>
              <div className="space-y-1">
                {unit.causalExplanation.rubric.map((r) => (
                  <label key={r.id} className="flex gap-2 text-sm items-start">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={!!draft.causalChecks[r.id]}
                      onChange={(e) => setDraft({ ...draft, causalChecks: { ...draft.causalChecks, [r.id]: e.target.checked } })}
                    />
                    <span>
                      {r.criterion} <span className="text-xs text-muted-foreground">（{r.evidence.join(', ')}）</span>
                    </span>
                  </label>
                ))}
              </div>
              {unit.counterfactuals.map((cf) => {
                const a = draft.counterfactuals[cf.id] ?? { text: '', checks: {} };
                const setCf = (next: typeof a) => setDraft({ ...draft, counterfactuals: { ...draft.counterfactuals, [cf.id]: next } });
                return (
                  <div key={cf.id} className="border-t border-border pt-3 space-y-1">
                    <div className="text-sm font-medium">反事実：{cf.prompt}</div>
                    <textarea className="field" rows={3} value={a.text} onChange={(e) => setCf({ ...a, text: e.target.value })} />
                    {cf.rubric.map((r) => (
                      <label key={r.id} className="flex gap-2 text-sm items-start">
                        <input type="checkbox" className="mt-1" checked={!!a.checks[r.id]} onChange={(e) => setCf({ ...a, checks: { ...a.checks, [r.id]: e.target.checked } })} />
                        <span>{r.criterion}</span>
                      </label>
                    ))}
                  </div>
                );
              })}
              <button onClick={saveReflection} disabled={busy} className={`btn btn-primary ${ringIf(['reflect', 'review'])}`}>
                自己照合を記録
              </button>
            </Card>
          )}
        </div>

        {/* ===== 右ペイン：ラボと観察 ===== */}
        <div className="space-y-4">
          <Card
            title="ラボ"
            right={
              <div className="flex gap-2">
                <button onClick={() => labAction(pilotApi.labStart)} disabled={busy} className="btn btn-outline btn-sm">
                  <Server className="w-4 h-4" /> 起動
                </button>
                <button onClick={() => labAction(pilotApi.labReset)} disabled={busy} className="btn btn-outline btn-sm">
                  <RotateCcw className="w-4 h-4" /> リセット
                </button>
              </div>
            }
          >
            {labError ? (
              <ErrorBox error={labError} />
            ) : lab ? (
              <div className="text-sm space-y-1" data-testid="lab-status">
                <div>状態：{lab.running ? '起動中' : '停止'}</div>
                {lab.busy && <div className="text-warning">使用中：{lab.busy.owner}（{lab.busy.since} から）</div>}
                {lab.cleanupPending && (
                  <div className="text-warning" data-testid="lab-cleanup-pending">
                    後始末中：{cleanupPendingHint(lab.cleanupPending)}
                    <RecoverySteps />
                  </div>
                )}
                <div>ネットワーク：{lab.network ? `${lab.network.name}（${lab.network.internal ? 'internal・外部疎通なし' : '外部疎通あり'}）` : 'なし'}</div>
                <ul>
                  {lab.nodes.map((n) => (
                    <li key={n.containerId}>
                      {n.role}：{n.state}（{n.containerId}）
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">ラボ状態を取得中…</div>
            )}
            {isLabError && labError?.code !== error?.code && <ErrorBox error={error} />}
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={() => run('lab')}
                disabled={busy || !locked || evidence.length > 0}
                className={`btn btn-success ${ringIf('run')}`}
              >
                <Play className="w-4 h-4" /> ラボで実行（実測）
              </button>
              <button
                onClick={() => run('fixture')}
                disabled={busy || !locked || evidence.length > 0}
                className="btn btn-warning-outline"
              >
                <FlaskConical className="w-4 h-4" /> フィクスチャで実行（練習用・完了不可）
              </button>
            </div>
            {attempt && !locked && <div className="text-sm text-muted-foreground flex items-center gap-1"><Lock className="w-4 h-4" /> 予測を提出するまで実行・観察はできません</div>}
          </Card>

          <Card
            title="観察"
            right={
              evidence.length > 0 && (
                <span
                  data-testid="evidence-origin"
                  className={`text-xs font-medium px-2 py-1 rounded-full border ${isFixture ? 'border-warning/40 bg-warning/10 text-warning' : 'border-success/40 bg-success/10 text-success'}`}
                >
                  証拠：{isFixture ? 'フィクスチャ（模擬・完了判定に使えません）' : '実測'}
                </span>
              )
            }
          >
            {evidence.length === 0 ? (
              <div className="text-sm text-muted-foreground">まだ証拠がありません。</div>
            ) : (
              <div className="space-y-3">
                {isFixture && (
                  <div className="rounded-xl border border-warning/60 bg-warning/10 p-2 text-sm text-warning">
                    これは実測形式のフィクスチャ証拠です。実際のラボで取得したものではありません。
                  </div>
                )}
                {unit.layers.observation.tools.map((t) => {
                  const e = evidenceByKind[t.kind];
                  return (
                    <div key={t.kind}>
                      <div className="text-sm font-semibold">{t.tool}</div>
                      {e ? (
                        <pre className="terminal text-xs rounded-lg p-3 overflow-x-auto max-h-64">{e.content.trimEnd() || '（出力なし）'}</pre>
                      ) : (
                        <div className="text-sm text-danger">この証拠はありません</div>
                      )}
                    </div>
                  );
                })}
                {evaluation && evaluation.synTimes.length > 0 && (
                  <div className="text-sm">SYN の送信時刻（最初の SYN からの秒）：{evaluation.synTimes.map((t) => t.toFixed(3)).join(' / ')}</div>
                )}
                {/* 旧版で保存された評価には実行環境の項目が無い */}
                {evaluation?.labEnvPremise && (
                  <div className="text-sm" data-testid="lab-env">
                    実行環境：
                    {evaluation.labEnv
                      ? `tcp_syn_linear_timeouts=${evaluation.labEnv.linearTimeoutsRecorded ? evaluation.labEnv.linearTimeouts : 'absent（0 と同じ）'}、tcp_syn_retries=${evaluation.labEnv.synRetries}`
                      : '記録なし'}
                    （教材の前提：tcp_syn_linear_timeouts={evaluation.labEnvPremise.linearTimeouts}、tcp_syn_retries={evaluation.labEnvPremise.synRetries}）
                    {evaluation.expectedSynTimes && evaluation.expectedSynTimes.length > 1 && (
                      <div>この設定から期待される SYN の送信時刻：{evaluation.expectedSynTimes.join(' / ')} 秒</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </Card>

          {evaluation && attempt && (
            <Card title="判定と振り返り">
              <div className="text-sm">
                証拠の由来：<span className="font-semibold">{ORIGIN_LABEL[evaluation.evidenceOrigin]}</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-2">項目</th>
                    <th className="py-1 pr-2">予測</th>
                    <th className="py-1 pr-2" data-testid="observed-column">{observedLabel}（証拠から算出）</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {evaluation.fields.map((f) => (
                    <tr key={f.fieldId} className="border-t border-border align-top">
                      <td className="py-1 pr-2">{f.label}</td>
                      <td className="py-1 pr-2">{optionLabel(f.fieldId, f.predicted)}</td>
                      <td className="py-1 pr-2">{optionLabel(f.fieldId, f.actual)}</td>
                      <td className="py-1">{f.correct ? <CheckCircle2 className="w-4 h-4 text-success" aria-label="一致" /> : <XCircle className="w-4 h-4 text-danger" aria-label="不一致" />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-sm font-semibold">
                予測：{evaluation.predictionCorrect ? `全項目が${observedLabel}と一致` : `${evaluation.fields.filter((f) => !f.correct).length} 項目が${observedLabel}と不一致`}
              </div>
              {!evaluation.evidenceConsistent && (evaluation.consistencyIssues ?? []).length > 0 && (
                <div className="text-sm text-warning" data-testid="consistency-issues">
                  <div className="font-semibold">条件・実行環境から期待される結果との食い違い</div>
                  <ul className="list-disc pl-5">
                    {evaluation.consistencyIssues.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="text-sm" data-testid="attempt-completion">
                <div className={`font-semibold ${attempt.completion.completed ? 'text-success' : ''}`}>この試行：{attempt.completion.completed ? '完了条件を満たした' : '未完了'}</div>
                {attempt.completion.blockers.length > 0 && (
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {attempt.completion.blockers.map((b) => (
                      <li key={b}>{blockerLabel(b)}</li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </PageLayout>
  );
}
