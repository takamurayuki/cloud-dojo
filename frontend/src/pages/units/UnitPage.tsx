import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  XCircle,
} from 'lucide-react';
import {
  ApiError,
  pilotApi,
  type Attempt,
  type EvidenceItem,
  type LabStatus,
  type Reflection,
  type Unit,
  type UnitStatus,
} from '@/features/pilot/api';

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

function ErrorBox({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <div className="rounded-xl border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-200 flex gap-2" role="alert">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <div>
        <div className="font-semibold">{ERROR_TITLES[error.code] ?? `エラー（${error.code}）`}</div>
        <div>{error.message}</div>
        {error.hint && <div className="mt-1 opacity-80">{error.hint}</div>}
      </div>
    </div>
  );
}

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
      <div className="p-8 space-y-4">
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

  return (
    <div className="p-6 space-y-4">
      {/* 見出し */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-sm text-muted-foreground">
            {unit.domain} / {unit.code}
          </div>
          <h1 className="text-2xl font-bold">{unit.title}</h1>
          <p className="text-muted-foreground max-w-3xl">{unit.summary}</p>
        </div>
        {status && (
          <div className="glass rounded-xl px-4 py-2 text-sm" data-testid="unit-status">
            <div className="font-semibold">{status.completed ? '単元完了' : '単元未完了'}</div>
            <div className="text-muted-foreground">
              完了した条件：{status.passedConditions.length > 0 ? status.passedConditions.join('、') : 'なし'}（異なる条件で {status.requiredDistinctConditions} つ必要）
            </div>
            <div className="text-muted-foreground">試行数：{status.attempts}</div>
          </div>
        )}
      </header>

      {/* 学習ループの進行（試行の状態から表示） */}
      <ol className="flex flex-wrap gap-2 text-sm">
        {unit.loop.map((s, i) => (
          <li
            key={s.stage}
            className={`px-3 py-1 rounded-full border ${i === stageIndex ? 'bg-blue-600 text-white border-blue-600' : i < stageIndex ? 'border-blue-400 text-blue-300' : 'border-border text-muted-foreground'}`}
            title={s.instructions}
          >
            {i + 1}. {s.title}
          </li>
        ))}
      </ol>

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
                  className={`px-3 py-1.5 text-sm -mb-px border-b-2 ${layer === t.key ? 'border-blue-600 font-semibold' : 'border-transparent text-muted-foreground'}`}
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
              <pre className="text-xs bg-slate-900 text-slate-100 rounded-lg p-3 overflow-x-auto">{unit.layers[layer].commands!.join('\n')}</pre>
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
                <button onClick={newAttempt} disabled={busy} className="text-sm flex items-center gap-1 px-3 py-1 rounded-lg border border-border hover:bg-muted disabled:opacity-50">
                  <RefreshCw className="w-4 h-4" /> 新しい条件で試す
                </button>
              )
            }
          >
            {!attempt ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">試行を始めると、シードから条件が決まります。条件ごとに正解は変わります。</p>
                <button onClick={newAttempt} disabled={busy} className="px-4 py-2 rounded-lg bg-blue-600 text-white disabled:opacity-50">
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
                  <div className="flex items-center gap-2 text-sm text-amber-300" data-testid="prediction-locked">
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
                            className={`text-sm px-3 py-1 rounded-lg border cursor-pointer ${answers[f.id] === o.value ? 'border-blue-500 bg-blue-500/20' : 'border-border'} ${locked ? 'cursor-not-allowed opacity-80' : ''}`}
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
                  <button onClick={submitPrediction} disabled={busy || !fieldsComplete} className="px-4 py-2 rounded-lg bg-blue-600 text-white disabled:opacity-50 flex items-center gap-2">
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
                  className="mt-1 w-full rounded-lg border border-border bg-background p-2 text-sm"
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
                    <textarea className="w-full rounded-lg border border-border bg-background p-2 text-sm" rows={3} value={a.text} onChange={(e) => setCf({ ...a, text: e.target.value })} />
                    {cf.rubric.map((r) => (
                      <label key={r.id} className="flex gap-2 text-sm items-start">
                        <input type="checkbox" className="mt-1" checked={!!a.checks[r.id]} onChange={(e) => setCf({ ...a, checks: { ...a.checks, [r.id]: e.target.checked } })} />
                        <span>{r.criterion}</span>
                      </label>
                    ))}
                  </div>
                );
              })}
              <button onClick={saveReflection} disabled={busy} className="px-4 py-2 rounded-lg bg-blue-600 text-white disabled:opacity-50">
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
                <button onClick={() => labAction(pilotApi.labStart)} disabled={busy} className="text-sm flex items-center gap-1 px-3 py-1 rounded-lg border border-border hover:bg-muted disabled:opacity-50">
                  <Server className="w-4 h-4" /> 起動
                </button>
                <button onClick={() => labAction(pilotApi.labReset)} disabled={busy} className="text-sm flex items-center gap-1 px-3 py-1 rounded-lg border border-border hover:bg-muted disabled:opacity-50">
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
                {lab.busy && <div className="text-amber-200">使用中：{lab.busy.owner}（{lab.busy.since} から）</div>}
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
                className="px-4 py-2 rounded-lg bg-emerald-600 text-white disabled:opacity-50 flex items-center gap-2"
              >
                <Play className="w-4 h-4" /> ラボで実行（実測）
              </button>
              <button
                onClick={() => run('fixture')}
                disabled={busy || !locked || evidence.length > 0}
                className="px-4 py-2 rounded-lg border border-amber-500 text-amber-300 disabled:opacity-50 flex items-center gap-2"
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
                  className={`text-xs px-2 py-1 rounded-full ${isFixture ? 'bg-amber-500/20 text-amber-200' : 'bg-emerald-500/20 text-emerald-200'}`}
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
                  <div className="rounded-xl border border-amber-500/60 bg-amber-500/10 p-2 text-sm text-amber-200">
                    これは実測形式のフィクスチャ証拠です。実際のラボで取得したものではありません。
                  </div>
                )}
                {unit.layers.observation.tools.map((t) => {
                  const e = evidenceByKind[t.kind];
                  return (
                    <div key={t.kind}>
                      <div className="text-sm font-semibold">{t.tool}</div>
                      {e ? (
                        <pre className="text-xs bg-slate-900 text-slate-100 rounded-lg p-3 overflow-x-auto max-h-64">{e.content.trimEnd() || '（出力なし）'}</pre>
                      ) : (
                        <div className="text-sm text-red-400">この証拠はありません</div>
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
                      <td className="py-1">{f.correct ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-red-400" />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-sm font-semibold">
                予測：{evaluation.predictionCorrect ? `全項目が${observedLabel}と一致` : `${evaluation.fields.filter((f) => !f.correct).length} 項目が${observedLabel}と不一致`}
              </div>
              {!evaluation.evidenceConsistent && (evaluation.consistencyIssues ?? []).length > 0 && (
                <div className="text-sm text-amber-200" data-testid="consistency-issues">
                  <div className="font-semibold">条件・実行環境から期待される結果との食い違い</div>
                  <ul className="list-disc pl-5">
                    {evaluation.consistencyIssues.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="text-sm" data-testid="attempt-completion">
                <div className="font-semibold">この試行：{attempt.completion.completed ? '完了条件を満たした' : '未完了'}</div>
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
    </div>
  );
}
