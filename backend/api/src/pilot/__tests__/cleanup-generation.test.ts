/**
 * 直し回2（再レビューの必須修正）：期限超過後の後始末の完了保証と対象の限定（Docker クライアントはスタブ）。
 * - 旧世代の後始末が、遅れて走っても現世代（後続の試行）のリソースを削除しない
 * - 後始末が未完了の間は、新しいラボ操作（run／start／reset）が 409
 * - cleanup.ok は後始末の実際の完了と一致する
 *
 * 再レビューで Codex がスタブで再現した手順（listContainers を保留 → 後始末の期限超過 → 保留解除後に削除が呼ばれる）を
 * そのまま使う。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPilotPlugin } from '../app';
import { getUnit } from '../curriculum';
import { deriveCondition } from '../conditions';
import { fixtureEvidence } from '../evidence/fixtures';
import { observe } from '../evidence/parse';
import { LabLock } from '../lab/lock';
import { DockerLabRunner, LabCleanupPendingError, LabTimeoutError, LABEL_GEN, LABEL_LAB, LABEL_ROLE, LAB_ID, NAME_PREFIX, nextGeneration } from '../lab/runner';
import { PilotStore } from '../store';
import { fakeDocker, type FakeOpts } from './fake-docker';

/** 後始末の期限を 10ms にする（再レビューの再現手順と同じ） */
const FAST = { execMs: 80, startMs: 80, resetMs: 500, abortGraceMs: 20, cleanupMs: 10 };
const cond = { portState: 'drop', connectTimeout: '5' };
const unit = getUnit('n5-tcp')!;

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** client-run の exec が始まった時点で一覧取得を保留し、その exec は応答させない（期限超過させる） */
function heldAtClientRun(extra: FakeOpts = {}) {
  const opts: FakeOpts = { hangExec: '/lab/client-run.sh', ...extra };
  const f = fakeDocker(opts);
  opts.onExec = (cmd) => {
    if (cmd[0] === '/lab/client-run.sh' && opts.hangExec) f.holdLists();
  };
  return { ...f, opts };
}

/** 後続の試行（別の世代）が作ったリソースを足す */
function addOtherGeneration(f: ReturnType<typeof fakeDocker>, gen: string) {
  for (const role of ['client', 'server']) {
    f.addContainer({
      Id: `other-${role}`,
      Names: [`/${NAME_PREFIX}-${gen}-${role}`],
      Labels: { [LABEL_LAB]: LAB_ID, [LABEL_ROLE]: role, [LABEL_GEN]: gen },
      State: 'running',
    });
  }
  f.addNetwork({ Id: 'other-net', Name: `${NAME_PREFIX}-${gen}`, Internal: true, Labels: { [LABEL_LAB]: LAB_ID, [LABEL_GEN]: gen } });
}

describe('旧世代の後始末は現世代のリソースを削除しない', () => {
  it('一覧を保留したまま後始末が期限を超え、その間に後続の世代のリソースができても、保留解除後に消すのは旧世代だけ', async () => {
    const f = heldAtClientRun();
    const runner = new DockerLabRunner(f.docker, FAST);
    const e = (await runner.collect(cond).catch((x: unknown) => x)) as LabTimeoutError;
    expect(e).toBeInstanceOf(LabTimeoutError);
    // 応答の時点では後始末は終わっていない
    expect(e.cleanup?.ok).toBe(false);
    expect(e.cleanup?.pending).toBe(true);
    const state = runner.cleanupState();
    expect(state).not.toBeNull();
    const oldGen = state!.generation;
    // 一覧は旧世代のラベルで絞り込んで要求している
    expect(f.calls.heldListFilters[0]?.label).toContain(`${LABEL_GEN}=${oldGen}`);

    const oldIds = [...f.containers.values()].map((c) => c.Id);
    expect(oldIds).toHaveLength(2);
    // 後続の試行の世代のリソース（実際には後始末中は作れないため、別プロセス等を想定して直接足す）
    const newGen = nextGeneration();
    addOtherGeneration(f, newGen);
    // 保留を解除する。遅れて返る一覧は絞り込みを無視した全件（旧世代＋後続の世代）を返し、以後の一覧も全件を返す
    f.setUnfiltered(true);
    f.releaseLists();
    const done = await e.cleanupDone!;

    // 削除されたのは旧世代のコンテナだけ。後続の世代のコンテナ・ネットワークは残る
    expect([...f.calls.remove].sort()).toEqual([...oldIds].sort());
    expect(f.calls.stop.some((id) => id.startsWith('other-'))).toBe(false);
    expect(f.calls.removeNetwork).not.toContain('other-net');
    expect(f.containers.has('other-client') && f.containers.has('other-server')).toBe(true);
    expect(f.networks.has('other-net')).toBe(true);
    // 旧世代のネットワークは消えている
    expect([...f.networks.values()].filter((n) => n.Labels[LABEL_GEN] === oldGen)).toHaveLength(0);
    expect(done.ok).toBe(true);
    expect(done.removedContainers).toBe(2);
    expect(done.removedNetworks).toBe(1);
  });

  it('旧世代を指定した後始末は、後続の試行が作ったラボ（実際の collect で作成）に触れない', async () => {
    const f = fakeDocker();
    const oldGen = nextGeneration();
    // 後続の試行：別の実行者が通常どおり collect してラボを作る（世代ラベル・世代入りの名前が付く）
    await new DockerLabRunner(f.docker, FAST).collect(cond);
    const before = [...f.containers.values()];
    expect(before).toHaveLength(2);
    expect(before.every((c) => c.Labels[LABEL_GEN] && c.Labels[LABEL_GEN] !== oldGen)).toBe(true);
    expect(before.every((c) => c.Names[0].startsWith(`/${NAME_PREFIX}-${c.Labels[LABEL_GEN]}-`))).toBe(true);
    // 一覧の絞り込みが効かなくても（全件が返っても）消さない
    f.setUnfiltered(true);
    const removesBefore = f.calls.remove.length;
    const r = await new DockerLabRunner(f.docker, FAST).cleanupGeneration(oldGen);
    expect(r).toEqual({ ok: true, stoppedContainers: 0, removedContainers: 0, removedNetworks: 0, errors: [] });
    expect(f.calls.remove.length).toBe(removesBefore);
    expect(f.containers.size).toBe(2);
    expect(f.networks.size).toBe(1);
  });

  it('同じ世代のラベルでも名前が世代の接頭辞で始まらないものは対象にしない', async () => {
    const f = fakeDocker();
    const gen = nextGeneration();
    f.addContainer({ Id: 'imposter', Names: ['/something-else'], Labels: { [LABEL_LAB]: LAB_ID, [LABEL_GEN]: gen }, State: 'running' });
    const r = await new DockerLabRunner(f.docker, FAST).cleanupGeneration(gen);
    expect(r.removedContainers).toBe(0);
    expect(f.containers.has('imposter')).toBe(true);
  });
});

describe('後始末が未完了の間の新しいラボ操作は 409', () => {
  it('runner：start／reset／collect は LabCleanupPendingError。完了後は受け付ける', async () => {
    const f = heldAtClientRun();
    const runner = new DockerLabRunner(f.docker, FAST);
    const e = (await runner.collect(cond).catch((x: unknown) => x)) as LabTimeoutError;
    expect(e).toBeInstanceOf(LabTimeoutError);
    for (const op of [() => runner.start(), () => runner.reset(), () => runner.collect(cond)]) {
      const err = await op().catch((x: unknown) => x);
      expect(err).toBeInstanceOf(LabCleanupPendingError);
      expect((err as LabCleanupPendingError).code).toBe('LAB_CLEANUP_PENDING');
    }
    f.releaseLists();
    await e.cleanupDone;
    expect(runner.cleanupState()).toBeNull();
    f.opts.hangExec = undefined;
    const ev = await runner.collect(cond);
    expect(Object.keys(ev).sort()).toEqual(['curl', 'lab-env', 'ss-client', 'ss-server', 'tcpdump']);
  });

  it('API：期限超過の応答（504・cleanup.ok=false）の後、後始末が終わるまで run・lab/start・lab/reset は 409 LAB_CLEANUP_PENDING', async () => {
    const f = heldAtClientRun();
    const runner = new DockerLabRunner(f.docker, FAST);
    app = Fastify();
    const store = new PilotStore(':memory:');
    const { plugin } = createPilotPlugin({ store, lab: runner, labLock: new LabLock() });
    await app.register(plugin, { prefix: '/api/pilot' });
    const a = app;

    const locked = async (seed: string) => {
      const at = (await a.inject({ method: 'POST', url: '/api/pilot/attempts', payload: { unitId: 'n5-tcp', seed } })).json();
      const c = deriveCondition(unit, seed);
      const answers = observe(fixtureEvidence(c.portState, Number(c.connectTimeout)), Number(c.connectTimeout)).observed;
      expect((await a.inject({ method: 'POST', url: `/api/pilot/attempts/${at.id}/prediction`, payload: { answers } })).statusCode).toBe(200);
      return at.id as string;
    };
    const run = (id: string) => a.inject({ method: 'POST', url: `/api/pilot/attempts/${id}/run`, payload: { mode: 'lab' } });

    const first = await locked('gen-a');
    const second = await locked('gen-b');
    const r1 = await run(first);
    expect(r1.statusCode).toBe(504);
    expect(r1.json().cleanup).toMatchObject({ ok: false, pending: true });

    // 後始末中：応答は返ったがラボは再利用可能ではない
    const r2 = await run(second);
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toMatchObject({ error: 'LAB_CLEANUP_PENDING', cleanup: { operation: 'collect' } });
    for (const url of ['/api/pilot/lab/start', '/api/pilot/lab/reset']) {
      const r = await a.inject({ method: 'POST', url });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('LAB_CLEANUP_PENDING');
    }
    // 拒否された試行は実行済みにならない（確保が解かれている）
    expect(store.getAttempt(second)?.runState).not.toBe('running');

    // 後始末が実際に終わったら受け付ける
    f.releaseLists();
    await vi.waitFor(() => expect(runner.cleanupState()).toBeNull());
    f.opts.hangExec = undefined;
    const r3 = await run(second);
    expect(r3.statusCode).toBe(200);
    expect(r3.json().evidence.every((e: { origin: string }) => e.origin === 'measured')).toBe(true);
    const status = await a.inject({ method: 'GET', url: '/api/pilot/lab/status' });
    expect(status.json().cleanupPending).toBeNull();
  });
});

describe('cleanup.ok は後始末の実際の完了と一致する', () => {
  it('期限内に完了したら ok=true（pending なし）で、応答時点で後始末中の状態は解除済み', async () => {
    const f = fakeDocker({ hangExec: '/lab/client-run.sh' });
    const runner = new DockerLabRunner(f.docker, { ...FAST, cleanupMs: 1_000 });
    const e = (await runner.collect(cond).catch((x: unknown) => x)) as LabTimeoutError;
    expect(e.cleanup).toEqual({ ok: true, stoppedContainers: 2, removedContainers: 2, removedNetworks: 1, errors: [] });
    expect(runner.cleanupState()).toBeNull();
    expect(await e.cleanupDone).toBe(e.cleanup);
  });

  it('期限内に完了しなければ ok=false・pending=true。実際に完了した時点の結果は ok=true', async () => {
    const f = heldAtClientRun();
    const runner = new DockerLabRunner(f.docker, FAST);
    const e = (await runner.collect(cond).catch((x: unknown) => x)) as LabTimeoutError;
    expect(e.cleanup).toMatchObject({ ok: false, pending: true, removedContainers: 0 });
    expect(f.calls.remove).toHaveLength(0);
    f.releaseLists();
    const done = await e.cleanupDone!;
    expect(done).toEqual({ ok: true, stoppedContainers: 2, removedContainers: 2, removedNetworks: 1, errors: [] });
    expect(runner.cleanupState()).toBeNull();
  });

  it('走っていた単位（コンテナ作成）が返るまでは完了としない。返った後に作られたコンテナが片付いてから完了する', async () => {
    const f = fakeDocker({ holdCreate: true });
    const runner = new DockerLabRunner(f.docker, FAST);
    const e = (await runner.start().catch((x: unknown) => x)) as LabTimeoutError;
    expect(e).toBeInstanceOf(LabTimeoutError);
    // 作成の要求が返っていないので完了扱いにしない
    expect(e.cleanup).toMatchObject({ ok: false, pending: true, removedNetworks: 1 });
    expect(runner.cleanupState()?.operation).toBe('start');
    // 作成が返らない限り、時間が経っても完了しない
    const early = await Promise.race([e.cleanupDone!.then(() => 'done'), new Promise((r) => setTimeout(() => r('pending'), 100))]);
    expect(early).toBe('pending');
    expect(runner.cleanupState()).not.toBeNull();
    // 遅れて Docker がコンテナを作成して返す（操作は次の単位へ進まず、作ったコンテナを自分で削除する）
    f.releaseCreate();
    const done = await e.cleanupDone!;
    expect(f.calls.created).toHaveLength(1);
    expect(f.containers.size).toBe(0);
    expect(done.ok).toBe(true);
    expect(done.pending).toBeUndefined();
    expect(runner.cleanupState()).toBeNull();
  });

  it('走っていた単位（ネットワーク作成）が後始末の1回目の後に完了したら、2回目で同じ世代のネットワークを消してから完了する', async () => {
    const f = fakeDocker({ holdCreateNetwork: true });
    const runner = new DockerLabRunner(f.docker, FAST);
    const e = (await runner.start().catch((x: unknown) => x)) as LabTimeoutError;
    expect(e.cleanup).toMatchObject({ ok: false, pending: true, removedNetworks: 0 });
    f.releaseCreate();
    const done = await e.cleanupDone!;
    expect(f.networks.size).toBe(0);
    expect(f.calls.removeNetwork).toHaveLength(1);
    expect(done).toEqual({ ok: true, stoppedContainers: 0, removedContainers: 0, removedNetworks: 1, errors: [] });
    expect(runner.cleanupState()).toBeNull();
  });

  // 直し回3で期待値を変更：削除に失敗したまま後始末中を解除しない（再レビュー2回目 A(2)。解除は削除を確認できたときだけ）
  it('後始末が完了しても削除に失敗していれば ok=false・pending=true で、後始末中の状態は解除されない', async () => {
    const f = heldAtClientRun();
    const runner = new DockerLabRunner(f.docker, FAST);
    const e = (await runner.collect(cond).catch((x: unknown) => x)) as LabTimeoutError;
    expect(e.cleanup?.ok).toBe(false);
    f.containers.forEach((c) => (c.State = 'running'));
    // 削除を失敗させてから解除する
    const orig = f.docker.getContainer.bind(f.docker);
    (f.docker as unknown as { getContainer: (id: string) => unknown }).getContainer = (id: string) => ({
      ...(orig(id) as object),
      remove: async () => Promise.reject(new Error('remove failed (stub)')),
    });
    f.releaseLists();
    const done = await e.cleanupDone!;
    expect(done.ok).toBe(false);
    expect(done.pending).toBe(true);
    expect(done.errors.some((m) => m.includes('remove failed'))).toBe(true);
    expect(done.remaining).toHaveLength(2);
    // 削除を確認できないので後始末中の状態は解除されず、残りが状態に入る（復旧は API の再起動後の run／reset）
    expect(runner.cleanupState()?.remaining).toHaveLength(2);
    expect(await runner.reset().catch((x: unknown) => x)).toBeInstanceOf(LabCleanupPendingError);
  });
});
