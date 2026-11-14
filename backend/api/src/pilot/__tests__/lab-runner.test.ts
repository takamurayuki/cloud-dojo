/**
 * F4：ラボ処理の期限と上限（Docker 無しの環境のため、Docker クライアントはスタブ）。
 * - 期限超過で対象コンテナの停止・削除が呼ばれ、後始末の成否が結果に入る
 * - ビルド進捗の取得量上限
 * F2：client コンテナに sysctl を設定する
 */
import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import { describe, expect, it } from 'vitest';
import { CLIENT_SYSCTLS, consumeBuildStream, DockerLabRunner, LabOutputLimitError, LabTimeoutError, LABEL_LAB, LABEL_ROLE, LAB_ID } from '../lab/runner';

import { fakeDocker } from './fake-docker';

const never = () => new Promise<never>(() => undefined);

const FAST = { execMs: 80, startMs: 80, resetMs: 500, abortGraceMs: 20, cleanupMs: 1_000 };
const cond = { portState: 'drop', connectTimeout: '5' };

describe('ラボ処理の期限（スタブ）', () => {
  it('正常時は証拠一式（lab-env を含む）を返す', async () => {
    const { docker } = fakeDocker();
    const ev = await new DockerLabRunner(docker, FAST).collect(cond);
    expect(Object.keys(ev).sort()).toEqual(['curl', 'lab-env', 'ss-client', 'ss-server', 'tcpdump']);
    expect(ev['lab-env']).toContain('net.ipv4.tcp_syn_linear_timeouts=0');
  });

  it('exec が期限を超えると、ストリームを切り、ラボのコンテナを停止・削除して、後始末の成否を返す', async () => {
    const { docker, calls, containers } = fakeDocker({ hangExec: '/lab/client-run.sh' });
    const runner = new DockerLabRunner(docker, FAST);
    const err = await runner.collect(cond).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LabTimeoutError);
    const e = err as LabTimeoutError;
    expect(e.operation).toBe('collect');
    expect(e.step).toBe('exec:client-run');
    expect(e.limitMs).toBe(FAST.execMs);
    expect(calls.execStreamsDestroyed).toBe(1);
    // 停止処理が両ノードに対して呼ばれ、削除まで行われた
    expect(calls.stop).toHaveLength(2);
    expect(calls.remove.slice(-2).sort()).toEqual([...calls.stop].sort());
    expect(containers.size).toBe(0);
    expect(e.cleanup).toEqual({ ok: true, stoppedContainers: 2, removedContainers: 2, removedNetworks: 1, errors: [] });
  });

  it('後始末に失敗したら cleanup.ok=false と失敗内容を返す', async () => {
    const { docker, calls } = fakeDocker({ hangExec: '/lab/client-run.sh' });
    const runner = new DockerLabRunner(docker, FAST);
    // collect の冒頭のリセット・起動までは成功させ、期限超過後の削除だけ失敗させる
    const origGet = (docker as unknown as { getContainer: (id: string) => Record<string, unknown> }).getContainer;
    let armed = false;
    (docker as unknown as { getContainer: (id: string) => Record<string, unknown> }).getContainer = (id: string) => {
      const h = origGet(id);
      return armed ? { ...h, remove: async () => Promise.reject(new Error('remove failed (stub)')) } : h;
    };
    setTimeout(() => (armed = true), FAST.execMs / 2);
    const e = (await runner.collect(cond).catch((x: unknown) => x)) as LabTimeoutError;
    expect(e).toBeInstanceOf(LabTimeoutError);
    expect(calls.stop).toHaveLength(2);
    expect(e.cleanup?.ok).toBe(false);
    expect(e.cleanup?.removedContainers).toBe(0);
    expect(e.cleanup?.errors.some((m) => m.includes('remove failed'))).toBe(true);
  });

  it('起動（コンテナ作成）が期限を超えても、後始末が呼ばれる。作成が返らないままなら後始末は未完了（ok=false）', async () => {
    // 直し回2：作成の要求が Docker から返らない間は、後で作られる可能性が残るため後始末は完了扱いにしない
    // （直し回1では ok=true を期待していたが、再レビューで「未完了でも ok=true になり得る」と指摘された箇所）
    const { docker } = fakeDocker({ hangCreate: true });
    const runner = new DockerLabRunner(docker, FAST);
    const e = (await runner.start().catch((x: unknown) => x)) as LabTimeoutError;
    expect(e).toBeInstanceOf(LabTimeoutError);
    expect(e.step).toBe('start');
    expect(e.cleanup).not.toBeNull();
    expect(e.cleanup?.ok).toBe(false);
    expect(e.cleanup?.pending).toBe(true);
    // 作成済みのネットワークは片付けられる
    expect(e.cleanup?.removedNetworks).toBe(1);
    expect(runner.cleanupState()?.operation).toBe('start');
  });

  it('操作全体の期限は、単位の期限より短ければそちらで打ち切る', async () => {
    const { docker } = fakeDocker({ hangExec: '/lab/client-run.sh' });
    const runner = new DockerLabRunner(docker, { ...FAST, execMs: 10_000, collectTotalMs: 150 });
    const e = (await runner.collect(cond).catch((x: unknown) => x)) as LabTimeoutError;
    expect(e).toBeInstanceOf(LabTimeoutError);
    expect(e.step).toBe('collect（全体）');
    expect(e.limitMs).toBe(150);
    expect(e.cleanup?.ok).toBe(true);
  });

  it('Docker が応答しない（ping が期限超過）は Docker 未検出として扱う', async () => {
    const docker = { ping: never } as unknown as Docker;
    const e = await new DockerLabRunner(docker, { pingMs: 30 }).status().catch((x: unknown) => x);
    expect((e as { code?: string }).code).toBe('DOCKER_NOT_FOUND');
  });
});

describe('ビルド進捗の取得量上限', () => {
  it('上限を超えたらストリームを破棄して失敗する', async () => {
    const s = new PassThrough();
    const p = consumeBuildStream(s, 1024);
    for (let i = 0; i < 50; i++) s.write(`${JSON.stringify({ stream: 'x'.repeat(100) })}\n`);
    await expect(p).rejects.toBeInstanceOf(LabOutputLimitError);
    expect(s.destroyed).toBe(true);
  });

  it('上限内なら読み切って成功、error 行があればビルド失敗', async () => {
    const ok = new PassThrough();
    const p1 = consumeBuildStream(ok, 1024);
    ok.end(`${JSON.stringify({ stream: 'Step 1/4' })}\n${JSON.stringify({ stream: 'done' })}\n`);
    await expect(p1).resolves.toBeUndefined();

    const bad = new PassThrough();
    const p2 = consumeBuildStream(bad, 1024);
    bad.end(`${JSON.stringify({ error: 'apk failed' })}\n`);
    await expect(p2).rejects.toThrow('apk failed');
  });
});

describe('client の SYN 再送設定（F2）', () => {
  it('client コンテナにだけ CLIENT_SYSCTLS を設定する（CapAdd は従来どおり）', async () => {
    const { docker, calls } = fakeDocker();
    await new DockerLabRunner(docker, FAST).start();
    const byRole = Object.fromEntries(calls.created.map((s) => [(s.Labels as Record<string, string>)[LABEL_ROLE], s]));
    expect(byRole.client.HostConfig?.Sysctls).toEqual(CLIENT_SYSCTLS);
    expect(byRole.server.HostConfig?.Sysctls).toBeUndefined();
    expect(byRole.client.HostConfig?.CapAdd).toEqual(['NET_ADMIN', 'NET_RAW']);
    expect((byRole.client.Labels as Record<string, string>)[LABEL_LAB]).toBe(LAB_ID);
  });

  it('tcp_syn_linear_timeouts が無いカーネルでは、その設定だけ外して作り直す', async () => {
    const { docker, calls } = fakeDocker({
      startError: (spec) =>
        spec.HostConfig?.Sysctls?.['net.ipv4.tcp_syn_linear_timeouts'] !== undefined
          ? new Error('OCI runtime create failed: open /proc/sys/net/ipv4/tcp_syn_linear_timeouts: no such file or directory')
          : null,
    });
    const st = await new DockerLabRunner(docker, FAST).start();
    expect(st.running).toBe(true);
    const clients = calls.created.filter((s) => (s.Labels as Record<string, string>)[LABEL_ROLE] === 'client');
    expect(clients).toHaveLength(2);
    expect(clients[1].HostConfig?.Sysctls).toEqual({ 'net.ipv4.tcp_syn_retries': '6' });
  });
});
