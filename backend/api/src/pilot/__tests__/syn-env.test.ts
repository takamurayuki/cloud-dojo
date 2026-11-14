/**
 * F2：SYN 再送の前提を実行環境（記録された sysctl 値）から導き、実測と照合する。
 * Docker が無い環境のため、設定値 → 期待スケジュールの導出と照合ロジックをユニットテストで示す。
 */
import { describe, expect, it } from 'vitest';
import { getUnit } from '../curriculum';
import { fixtureEvidence } from '../evidence/fixtures';
import {
  checkConsistency,
  expectedFromMechanism,
  formatLabEnv,
  LAB_SYN_PREMISE,
  observe,
  parseLabEnv,
  PREMISE_ENV,
  synGiveUpSec,
  synSchedule,
  type SynEnv,
} from '../evidence/parse';
import { evaluateAttempt, type EvidenceRecord } from '../judge';
import { CLIENT_SYSCTLS } from '../lab/runner';

const unit = getUnit('n5-tcp')!;
const env = (linearTimeouts: number, synRetries = 6, linearTimeoutsRecorded = true): SynEnv => ({ linearTimeouts, synRetries, linearTimeoutsRecorded, osRelease: '6.12.0-test' });
const L0 = env(0);
const L4 = env(4);

function records(attemptId: string, texts: Record<string, string>): EvidenceRecord[] {
  return Object.entries(texts).map(([kind, content], i) => ({ id: `e${i}`, attemptId, kind: kind as EvidenceRecord['kind'], origin: 'measured', content }));
}

describe('設定値 → 期待スケジュールの導出', () => {
  it('tcp_syn_linear_timeouts=0（ラボの前提）では最初から倍々：0,1,3,7,15,31,63 秒', () => {
    expect(synSchedule(L0)).toEqual([0, 1, 3, 7, 15, 31, 63]);
    expect(synGiveUpSec(L0)).toBe(127);
  });

  it('tcp_syn_linear_timeouts=4（Linux 既定）では最初の再送が1秒間隔：0,1,2,3,4,5,7 秒', () => {
    expect(synSchedule(L4)).toEqual([0, 1, 2, 3, 4, 5, 7]);
  });

  it('tcp_syn_retries が再送の上限回数を決める', () => {
    expect(synSchedule(env(0, 2))).toEqual([0, 1, 3]);
    expect(synGiveUpSec(env(0, 2))).toBe(7);
  });

  it('異なる設定値では DROP の期待 SYN 回数が変わる', () => {
    const count = (e: SynEnv, t: number) => expectedFromMechanism('drop', t, e).expected.synCount;
    expect([2, 5, 10].map((t) => count(L0, t))).toEqual([['2'], ['3'], ['4']]);
    // L=4：2 秒は境界（2 秒目の SYN）が揺れるので 2 か 3、5 秒・10 秒は 5 回以上
    expect([2, 5, 10].map((t) => count(L4, t))).toEqual([['2', '3'], ['5+'], ['5+']]);
    expect(expectedFromMechanism('drop', 10, L0).synSchedule).toEqual([0, 1, 3, 7]);
    expect(expectedFromMechanism('drop', 10, L4).synSchedule).toEqual([0, 1, 2, 3, 4, 5, 7]);
  });

  it('カーネルが connect-timeout より先に諦める設定では curl の結果・所要時間を照合しない', () => {
    const e = expectedFromMechanism('drop', 10, env(0, 2));
    expect(e.expected.curlResult).toBeUndefined();
    expect(expectedFromMechanism('drop', 10, L0).expected.curlResult).toEqual(['timeout']);
  });
});

describe('実行環境の記録（lab-env）の解析', () => {
  it('client-run.sh の出力形式を読める', () => {
    const r = parseLabEnv('net.ipv4.tcp_syn_linear_timeouts=0\nnet.ipv4.tcp_syn_retries=6\nkernel.osrelease=6.12.0\n');
    expect(r).toEqual({ env: { linearTimeouts: 0, linearTimeoutsRecorded: true, synRetries: 6, osRelease: '6.12.0' }, problems: [] });
  });

  it('sysctl が無いカーネル（absent）は倍々のみ（0 と同じ）として扱う', () => {
    const r = parseLabEnv('net.ipv4.tcp_syn_linear_timeouts=absent\nnet.ipv4.tcp_syn_retries=6\n');
    expect(r.env).toMatchObject({ linearTimeouts: 0, linearTimeoutsRecorded: false, synRetries: 6 });
    expect(synSchedule(r.env!)).toEqual([0, 1, 3, 7, 15, 31, 63]);
  });

  it('値が読めなければ環境は不明（null）で、理由を返す', () => {
    expect(parseLabEnv('').env).toBeNull();
    const r = parseLabEnv('net.ipv4.tcp_syn_linear_timeouts=x\nnet.ipv4.tcp_syn_retries=6');
    expect(r.env).toBeNull();
    expect(r.problems.join()).toContain('tcp_syn_linear_timeouts');
  });

  it('formatLabEnv と parseLabEnv は往復で一致する', () => {
    expect(parseLabEnv(formatLabEnv(L4)).env).toEqual(L4);
  });
});

describe('記録された環境から導いた期待と実測の照合', () => {
  it('L=0 の記録と L=0 の再送時刻：整合し、完了を妨げない', () => {
    const ev = evaluateAttempt(unit, { id: 'a', condition: { portState: 'drop', connectTimeout: '10' }, prediction: observe(fixtureEvidence('drop', 10), 10).observed }, records('a', fixtureEvidence('drop', 10)));
    expect(ev.evidenceConsistent).toBe(true);
    expect(ev.labEnv).toMatchObject({ linearTimeouts: 0, synRetries: 6 });
    expect(ev.expectedSynTimes).toEqual([0, 1, 3, 7]);
    expect(ev.blockers).toEqual([]);
  });

  it('L=4 の記録と L=4 の再送時刻：記録どおりなので整合（固定期待で落とさない）が、教材の前提と違うので完了しない', () => {
    const texts = fixtureEvidence('drop', 10, L4);
    const pred = observe(texts, 10).observed;
    expect(pred.synCount).toBe('5+');
    const ev = evaluateAttempt(unit, { id: 'a', condition: { portState: 'drop', connectTimeout: '10' }, prediction: pred }, records('a', texts));
    expect(ev.evidenceConsistent).toBe(true);
    expect(ev.consistencyIssues).toEqual([]);
    expect(ev.blockers).toEqual(['lab-env-premise-mismatch']);
  });

  it('L=0 と記録されているのに再送が1秒間隔（設定が効いていない）：整合しない', () => {
    const texts = { ...fixtureEvidence('drop', 10, L4), 'lab-env': formatLabEnv(L0) };
    const ev = evaluateAttempt(unit, { id: 'a', condition: { portState: 'drop', connectTimeout: '10' }, prediction: observe(texts, 10).observed }, records('a', texts));
    expect(ev.evidenceConsistent).toBe(false);
    expect(ev.blockers).toContain('evidence-inconsistent-with-condition');
    expect(ev.consistencyIssues.some((s) => s.startsWith('synCount'))).toBe(true);
    expect(ev.consistencyIssues.some((s) => s.startsWith('SYN#3'))).toBe(true);
  });

  it('再送時刻が期待から外れると整合しない（回数が同じでも）', () => {
    const exp = expectedFromMechanism('drop', 5, L0);
    expect(checkConsistency(exp, { observed: { synReply: 'none', synCount: '3', clientState: 'SYN-SENT', serverState: 'LISTEN', curlResult: 'timeout', duration: 'connect-timeout' }, synTimes: [0, 1, 3] }).consistent).toBe(true);
    const bad = checkConsistency(exp, { observed: { synReply: 'none', synCount: '3', clientState: 'SYN-SENT', serverState: 'LISTEN', curlResult: 'timeout', duration: 'connect-timeout' }, synTimes: [0, 1, 2] });
    expect(bad.consistent).toBe(false);
    expect(bad.issues).toEqual(['SYN#3: 期待 3 秒、観察 2.000 秒']);
  });

  it('実行環境の記録が無いと期待を導けず、整合扱いにしない（必須証拠の欠落にもなる）', () => {
    const texts: Record<string, string> = { ...fixtureEvidence('drop', 5) };
    delete texts['lab-env'];
    const ev = evaluateAttempt(unit, { id: 'a', condition: { portState: 'drop', connectTimeout: '5' }, prediction: observe(texts, 5).observed }, records('a', texts));
    expect(ev.evidenceConsistent).toBe(false);
    expect(ev.labEnv).toBeNull();
    expect(ev.blockers).toEqual(expect.arrayContaining(['missing-evidence:lab-env', 'evidence-inconsistent-with-condition']));
  });
});

describe('教材・反事実・フィクスチャ・ラボ設定が同じ前提を使う', () => {
  it('ラボが client に設定する sysctl は前提と同じ値', () => {
    expect(CLIENT_SYSCTLS).toEqual({
      'net.ipv4.tcp_syn_linear_timeouts': String(LAB_SYN_PREMISE.linearTimeouts),
      'net.ipv4.tcp_syn_retries': String(LAB_SYN_PREMISE.synRetries),
    });
  });

  it('フィクスチャの lab-env は前提の値を記録している', () => {
    expect(parseLabEnv(fixtureEvidence('open', 2)['lab-env']).env).toMatchObject({ ...LAB_SYN_PREMISE, linearTimeoutsRecorded: true });
    expect(PREMISE_ENV).toMatchObject(LAB_SYN_PREMISE);
  });

  it('教材本文・DROP の状況説明・反事実が前提の設定値を明示している', () => {
    const premise = `net.ipv4.tcp_syn_linear_timeouts=${LAB_SYN_PREMISE.linearTimeouts}`;
    expect(unit.layers.mechanism.body.some((p) => p.includes(premise) && p.includes(`tcp_syn_retries=${LAB_SYN_PREMISE.synRetries}`))).toBe(true);
    const drop = unit.prediction.conditionParams.find((p) => p.id === 'portState')!.variants.find((v) => v.value === 'drop')!;
    expect(drop.scenario).toContain(premise);
    const cf = unit.counterfactuals.find((c) => c.id === 'longer-timeout')!;
    expect(cf.prompt).toContain(premise);
    // 反事実の「20 秒で 5 回」は前提の設定から導いた値と一致する
    expect(synSchedule(PREMISE_ENV).filter((t) => t < 20)).toHaveLength(5);
    expect(unit.requiredEvidence).toContain('lab-env');
  });
});
