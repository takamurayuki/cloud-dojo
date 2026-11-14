/**
 * 直し回3（必須1）：既存のラボを片付ける reset が期限を超えたとき、reset が片付け対象として一覧したリソースの
 * 削除の成否を cleanup の最終結果（cleanupDone／ok）と後始末中の解除条件に反映する（Docker クライアントはスタブ）。
 *
 * 再レビュー2回目で Codex がスタブで再現した手順をそのまま使う：
 * start() でラボを作成 → 一覧取得を保留して reset() を期限超過させる → 応答後に保留を解除 → cleanupDone を見る。
 * 修正前は、コンテナ2件・ネットワーク1件が残ったまま cleanupDone が ok=true・errors=[]、後始末中の状態は null だった。
 */
import { describe, expect, it } from 'vitest';
import { DockerLabRunner, LabCleanupPendingError, LabTimeoutError, LABEL_GEN, LABEL_LAB, LABEL_ROLE, LAB_ID, NAME_PREFIX, nextGeneration } from '../lab/runner';
import { fakeDocker } from './fake-docker';

const FAST = { execMs: 80, startMs: 80, resetMs: 500, abortGraceMs: 20, cleanupMs: 10 };
const cond = { portState: 'drop', connectTimeout: '5' };

/** start() で既存のラボ（コンテナ2件・ネットワーク1件）を作り、一覧取得を保留した状態で reset() を期限超過させる */
async function resetTimedOutOnExistingLab(f: ReturnType<typeof fakeDocker>, runner: DockerLabRunner) {
  await runner.start();
  expect(f.containers.size).toBe(2);
  expect(f.networks.size).toBe(1);
  const labGen = [...f.containers.values()][0].Labels[LABEL_GEN];
  f.holdLists();
  const e = (await runner.reset().catch((x: unknown) => x)) as LabTimeoutError;
  expect(e).toBeInstanceOf(LabTimeoutError);
  expect(e.operation).toBe('reset');
  // 応答の時点では後始末は終わっていない
  expect(e.cleanup).toMatchObject({ ok: false, pending: true });
  return { e, labGen };
}

describe('既存ラボを対象にした reset の期限超過：残存を最終結果に反映する', () => {
  it('Codex の再現手順：保留解除後、reset の対象（既存ラボ）を実際に削除し、削除を確認してから ok=true・解除', async () => {
    const f = fakeDocker();
    const runner = new DockerLabRunner(f.docker, FAST);
    const { e } = await resetTimedOutOnExistingLab(f, runner);
    expect(runner.cleanupState()?.operation).toBe('reset');
    f.releaseLists();
    const done = await e.cleanupDone!;
    // ok=true のときは実際に何も残っていない（誤報ではない）
    expect(f.containers.size).toBe(0);
    expect(f.networks.size).toBe(0);
    expect(done).toEqual({ ok: true, stoppedContainers: 0, removedContainers: 2, removedNetworks: 1, errors: [] });
    expect(runner.cleanupState()).toBeNull();
  });

  it('残存時（コンテナの削除が失敗）：cleanupDone は ok=false・pending=true・remaining で、後始末中は解除されず操作は 409 のまま', async () => {
    const f = fakeDocker();
    const runner = new DockerLabRunner(f.docker, FAST);
    const { e } = await resetTimedOutOnExistingLab(f, runner);
    const orig = f.docker.getContainer.bind(f.docker);
    (f.docker as unknown as { getContainer: (id: string) => unknown }).getContainer = (id: string) => ({
      ...(orig(id) as object),
      remove: async () => Promise.reject(new Error('remove failed (stub)')),
    });
    f.releaseLists();
    const done = await e.cleanupDone!;
    // コンテナ2件が残っている
    expect(f.containers.size).toBe(2);
    expect(done.ok).toBe(false);
    expect(done.pending).toBe(true);
    expect(done.errors.filter((m) => m.includes('remove failed'))).toHaveLength(2);
    expect(done.remaining).toHaveLength(2);
    expect(done.remaining!.every((m) => m.includes('reset 対象') && m.includes('残っている'))).toBe(true);
    // 解除されない（残りは状態に入る）。新しい操作は拒否のまま
    const state = runner.cleanupState();
    expect(state?.operation).toBe('reset');
    expect(state?.remaining).toEqual(done.remaining);
    for (const op of [() => runner.start(), () => runner.reset(), () => runner.collect(cond)]) {
      expect(await op().catch((x: unknown) => x)).toBeInstanceOf(LabCleanupPendingError);
    }
  });

  it('残存時（削除の要求は成功を返したが実際には残っている）：inspect で確かめ、ok=false・未解除', async () => {
    const f = fakeDocker();
    const runner = new DockerLabRunner(f.docker, FAST);
    const { e } = await resetTimedOutOnExistingLab(f, runner);
    const getNetwork = f.docker.getNetwork.bind(f.docker);
    // ネットワークの削除要求は成功を返すが、実際には消えない
    (f.docker as unknown as { getNetwork: (id: string) => unknown }).getNetwork = (id: string) => ({
      ...(getNetwork(id) as object),
      remove: async () => undefined,
    });
    f.releaseLists();
    const done = await e.cleanupDone!;
    expect(f.containers.size).toBe(0);
    expect(f.networks.size).toBe(1);
    expect(done.ok).toBe(false);
    expect(done.errors).toEqual([]);
    expect(done.remaining).toHaveLength(1);
    expect(done.remaining![0]).toMatch(/^network .*残っている$/);
    expect(runner.cleanupState()?.remaining).toHaveLength(1);
  });

  it('削除を確かめる inspect が 404 以外で失敗したら「確認できない」として未解除', async () => {
    const f = fakeDocker();
    const runner = new DockerLabRunner(f.docker, FAST);
    const { e } = await resetTimedOutOnExistingLab(f, runner);
    const orig = f.docker.getContainer.bind(f.docker);
    let removed = false;
    (f.docker as unknown as { getContainer: (id: string) => unknown }).getContainer = (id: string) => {
      const h = orig(id) as { inspect: () => Promise<unknown>; remove: () => Promise<void> };
      return {
        ...h,
        remove: async () => {
          await h.remove();
          removed = true;
        },
        // 削除の後は Docker が応答できない（500）
        inspect: async () => (removed ? Promise.reject(Object.assign(new Error('daemon error'), { statusCode: 500 })) : h.inspect()),
      };
    };
    f.releaseLists();
    const done = await e.cleanupDone!;
    expect(done.ok).toBe(false);
    expect(done.remaining?.some((m) => m.includes('削除を確認できない'))).toBe(true);
    expect(runner.cleanupState()).not.toBeNull();
  });

  it('reset の対象は reset より後の世代へ広げない（保留中に後続の世代が足されても、その世代には触れない）', async () => {
    const f = fakeDocker();
    const runner = new DockerLabRunner(f.docker, FAST);
    const { e, labGen } = await resetTimedOutOnExistingLab(f, runner);
    // reset より後に採番された世代のリソース（実際には後始末中は作れないため直接足す）
    const later = nextGeneration();
    for (const role of ['client', 'server']) {
      f.addContainer({ Id: `later-${role}`, Names: [`/${NAME_PREFIX}-${later}-${role}`], Labels: { [LABEL_LAB]: LAB_ID, [LABEL_ROLE]: role, [LABEL_GEN]: later }, State: 'running' });
    }
    f.addNetwork({ Id: 'later-net', Name: `${NAME_PREFIX}-${later}`, Internal: true, Labels: { [LABEL_LAB]: LAB_ID, [LABEL_GEN]: later } });
    f.releaseLists();
    const done = await e.cleanupDone!;
    // 既存ラボ（reset より前の世代）だけ消え、後続の世代は残る
    expect([...f.containers.keys()].sort()).toEqual(['later-client', 'later-server']);
    expect([...f.networks.keys()]).toEqual(['later-net']);
    expect([...f.calls.remove].every((id) => !id.startsWith('later-'))).toBe(true);
    expect(f.calls.removeNetwork).not.toContain('later-net');
    expect(labGen).not.toBe(later);
    expect(done.ok).toBe(true);
    expect(runner.cleanupState()).toBeNull();
  });

  it('collect 冒頭のリセットが既存ラボの一覧中に期限を超えた場合も、既存ラボを削除して確認するまで解除しない', async () => {
    const f = fakeDocker();
    const runner = new DockerLabRunner(f.docker, { ...FAST, collectTotalMs: 60 });
    await runner.start();
    f.holdLists();
    const e = (await runner.collect(cond).catch((x: unknown) => x)) as LabTimeoutError;
    expect(e).toBeInstanceOf(LabTimeoutError);
    expect(e.cleanup).toMatchObject({ ok: false, pending: true });
    f.releaseLists();
    const done = await e.cleanupDone!;
    expect(f.containers.size).toBe(0);
    expect(f.networks.size).toBe(0);
    expect(done.ok).toBe(true);
    expect(runner.cleanupState()).toBeNull();
  });
});
