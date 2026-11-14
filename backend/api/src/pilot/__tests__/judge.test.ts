import { describe, expect, it } from 'vitest';
import { getUnit } from '../curriculum';
import { deriveCondition } from '../conditions';
import { fixtureEvidence } from '../evidence/fixtures';
import { observe, parseSs, parseTcpdump } from '../evidence/parse';
import { attemptCompletion, evaluateAttempt, unitCompletion, type EvidenceRecord, type Reflection } from '../judge';
import { splitSections } from '../lab/runner';

const unit = getUnit('n5-tcp')!;

function records(attemptId: string, texts: Record<string, string>, origin: 'measured' | 'fixture'): EvidenceRecord[] {
  return Object.entries(texts).map(([kind, content], i) => ({ id: `e${i}`, attemptId, kind: kind as EvidenceRecord['kind'], origin, content }));
}

/** 条件ごとに、証拠から算出した観察結果をそのまま予測にした「正しい予測」 */
function correctPrediction(portState: string, timeout: number) {
  return observe(fixtureEvidence(portState, timeout), timeout).observed;
}

function findSeed(portState: string, connectTimeout?: string): string {
  for (let i = 0; i < 10_000; i++) {
    const c = deriveCondition(unit, `s${i}`);
    if (c.portState === portState && (!connectTimeout || c.connectTimeout === connectTimeout)) return `s${i}`;
  }
  throw new Error('seed not found');
}

const fullReflection: Reflection = {
  causalText: 'x'.repeat(40),
  causalChecks: Object.fromEntries(unit.causalExplanation.rubric.map((r) => [r.id, true])),
  counterfactuals: Object.fromEntries(
    unit.counterfactuals.map((cf) => [cf.id, { text: 'y'.repeat(40), checks: Object.fromEntries(cf.rubric.map((r) => [r.id, true])) }]),
  ),
};

describe('証拠の解析（実測形式テキスト）', () => {
  it('tcpdump のフラグ列を読める', () => {
    const pkts = parseTcpdump(
      [
        '1794643200.000100 IP 172.30.0.2.45678 > 172.30.0.3.8080: Flags [S], seq 1, win 64240, length 0',
        '1794643200.000130 IP 172.30.0.3.8080 > 172.30.0.2.45678: Flags [R.], seq 0, ack 2, win 0, length 0',
        '2 packets captured',
      ].join('\n'),
    );
    expect(pkts.map((p) => p.flags)).toEqual(['S', 'R.']);
  });

  it('ss -tan の状態列を読める', () => {
    const rows = parseSs('State      Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nSYN-SENT   0      1      172.30.0.2:45678   172.30.0.3:8080\n');
    expect(rows).toEqual([{ state: 'SYN-SENT', local: '172.30.0.2', localPort: 45678, peer: '172.30.0.3', peerPort: 8080 }]);
  });

  it('ラボ出力の区切りを証拠ごとに分割できる', () => {
    const s = splitSections('=====tcpdump\nA\n=====ss-client\nB\n=====curl\ntime_total=1 http_code=200\nexit=0\n');
    expect(Object.keys(s)).toEqual(['tcpdump', 'ss-client', 'curl']);
    expect(s['ss-client']).toBe('B\n');
  });

  it('DROP の SYN 再送はバックオフ間隔（1,2,4 秒）で並ぶ', () => {
    const d = observe(fixtureEvidence('drop', 10), 10);
    expect(d.observed.synCount).toBe('4');
    const gaps = d.synTimes.slice(1).map((t, i) => Math.round(t - d.synTimes[i]));
    expect(gaps).toEqual([1, 2, 4]);
  });
});

describe('判定：シードで条件と正解が変わる／同一条件で決定的', () => {
  it('シードによって open / closed / drop が切り替わる', () => {
    const states = new Set(Array.from({ length: 60 }, (_, i) => deriveCondition(unit, `seed-${i}`).portState));
    expect(states).toEqual(new Set(['open', 'closed', 'drop']));
  });

  it('同じシードからは常に同じ条件', () => {
    expect(deriveCondition(unit, 'abc123')).toEqual(deriveCondition(unit, 'abc123'));
  });

  it('別シード（別条件）では証拠から算出される正解が変わる', () => {
    const answers = ['open', 'closed', 'drop'].map((ps) => {
      const c = deriveCondition(unit, findSeed(ps, '5'));
      return observe(fixtureEvidence(c.portState, Number(c.connectTimeout)), Number(c.connectTimeout)).observed;
    });
    expect(answers[0].curlResult).toBe('connected');
    expect(answers[1].curlResult).toBe('refused');
    expect(answers[2].curlResult).toBe('timeout');
    expect(answers[0].synReply).toBe('syn-ack');
    expect(answers[1].synReply).toBe('rst');
    expect(answers[2].synReply).toBe('none');
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(3);
  });

  it('DROP でも connect-timeout のシードで SYN 回数の正解が変わる', () => {
    const counts = ['2', '5', '10'].map((t) => correctPrediction('drop', Number(t)).synCount);
    expect(counts).toEqual(['2', '3', '4']);
  });

  it('ある条件で正しい予測を別条件の証拠に当てると不正解になる', () => {
    const openAnswer = correctPrediction('open', 5);
    const ev = evaluateAttempt(unit, { id: 'a1', condition: { portState: 'closed', connectTimeout: '5' }, prediction: openAnswer }, records('a1', fixtureEvidence('closed', 5), 'fixture'));
    expect(ev.predictionCorrect).toBe(false);
    expect(ev.fields.find((f) => f.fieldId === 'curlResult')).toMatchObject({ predicted: 'connected', actual: 'refused', correct: false });
  });

  it('同一条件・同一証拠・同一予測なら判定は決定的', () => {
    for (const ps of ['open', 'closed', 'drop']) {
      const attempt = { id: 'a', condition: { portState: ps, connectTimeout: '2' }, prediction: correctPrediction(ps, 2) };
      const ev = records('a', fixtureEvidence(ps, 2), 'measured');
      const r1 = evaluateAttempt(unit, attempt, ev);
      const r2 = evaluateAttempt(unit, attempt, ev);
      expect(r1).toEqual(r2);
      expect(r1.predictionCorrect).toBe(true);
      expect(r1.evidenceConsistent).toBe(true);
    }
  });
});

describe('完了フラグ', () => {
  const cond = { portState: 'drop', connectTimeout: '5' };

  it('証拠なしでは完了しない', () => {
    const ev = evaluateAttempt(unit, { id: 'a', condition: cond, prediction: correctPrediction('drop', 5) }, []);
    expect(ev.evidenceEligible).toBe(false);
    expect(ev.blockers).toContain('no-evidence');
    expect(attemptCompletion(unit, ev, fullReflection).completed).toBe(false);
    expect(attemptCompletion(unit, null, fullReflection)).toMatchObject({ completed: false, blockers: ['no-evidence'] });
  });

  it('必須証拠が一部欠けると完了しない', () => {
    const texts = fixtureEvidence('drop', 5) as Record<string, string>;
    delete texts['ss-server'];
    const ev = evaluateAttempt(unit, { id: 'a', condition: cond, prediction: correctPrediction('drop', 5) }, records('a', texts, 'measured'));
    expect(ev.blockers).toContain('missing-evidence:ss-server');
    expect(attemptCompletion(unit, ev, fullReflection).completed).toBe(false);
  });

  it('フィクスチャ証拠では予測が正解でも完了しない（判定と完了フラグは分離）', () => {
    const ev = evaluateAttempt(unit, { id: 'a', condition: cond, prediction: correctPrediction('drop', 5) }, records('a', fixtureEvidence('drop', 5), 'fixture'));
    expect(ev.predictionCorrect).toBe(true);
    expect(ev.evidenceOrigin).toBe('fixture');
    expect(ev.evidenceEligible).toBe(false);
    expect(ev.blockers).toEqual(['fixture-evidence']);
    expect(attemptCompletion(unit, ev, fullReflection).completed).toBe(false);
  });

  it('別試行の証拠では完了しない', () => {
    const ev = evaluateAttempt(unit, { id: 'a', condition: cond, prediction: correctPrediction('drop', 5) }, records('other', fixtureEvidence('drop', 5), 'measured'));
    expect(ev.blockers).toContain('evidence-from-other-attempt');
    expect(ev.blockers).toContain('no-evidence');
  });

  it('実測証拠＋正解＋振り返り自己照合が揃えば試行は完了、振り返り未記入なら未完了', () => {
    const ev = evaluateAttempt(unit, { id: 'a', condition: cond, prediction: correctPrediction('drop', 5) }, records('a', fixtureEvidence('drop', 5), 'measured'));
    expect(ev.evidenceEligible).toBe(true);
    expect(attemptCompletion(unit, ev, fullReflection)).toEqual({ completed: true, blockers: [] });
    const partial = { ...fullReflection, causalChecks: { ...fullReflection.causalChecks, 'cites-packets': false } };
    expect(attemptCompletion(unit, ev, partial).blockers).toEqual(['causal-rubric-unmet:cites-packets']);
    expect(attemptCompletion(unit, ev, null).completed).toBe(false);
  });

  it('予測が不正解なら実測でも完了しない', () => {
    const wrong = { ...correctPrediction('drop', 5), synCount: '1' };
    const ev = evaluateAttempt(unit, { id: 'a', condition: cond, prediction: wrong }, records('a', fixtureEvidence('drop', 5), 'measured'));
    expect(ev.blockers).toEqual(['prediction-incorrect']);
  });

  it('証拠が条件と食い違う（ラボ構成不良）と完了しない', () => {
    // 条件は drop なのに証拠は closed の挙動
    const pred = correctPrediction('closed', 5);
    const ev = evaluateAttempt(unit, { id: 'a', condition: cond, prediction: pred }, records('a', fixtureEvidence('closed', 5), 'measured'));
    expect(ev.predictionCorrect).toBe(true);
    expect(ev.blockers).toContain('evidence-inconsistent-with-condition');
  });

  it('単元の完了には異なる portState の完了試行が2つ必要', () => {
    const done = { completed: true, blockers: [] };
    expect(unitCompletion([{ condition: { portState: 'drop' }, completion: done }]).completed).toBe(false);
    expect(unitCompletion([{ condition: { portState: 'drop' }, completion: done }, { condition: { portState: 'drop' }, completion: done }]).completed).toBe(false);
    expect(unitCompletion([{ condition: { portState: 'drop' }, completion: done }, { condition: { portState: 'open' }, completion: done }]).completed).toBe(true);
  });
});
