/**
 * 直し回11（推奨）：compose down・down-volumes でネットワークを削除できなかったら、残存として結果に出す。
 * - 404（既に無い）だけを削除済みとする。それ以外（使用中＝has active endpoints・500・通信エラー）は残存。
 * - 残存があっても残りのネットワークの削除は試みる。残存が1つでもあれば成功とせず ComposeDownResidueError
 *   （名前・ID・理由・復旧手順と、削除できたもの）を投げる。
 * - down-volumes は、ネットワークが残ってもボリュームの削除は続け、そのうえで失敗にする。
 * Docker が無い環境のため dockerode をスタブに差し替える。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => {
  const calls = { stop: [] as string[], remove: [] as string[], removeNetwork: [] as string[], removeVolume: [] as string[], listVolumes: 0 };
  const containers: { Id: string; Names: string[]; Labels: Record<string, string>; State: string }[] = [];
  const networks: { Id: string; Name: string; Labels: Record<string, string> }[] = [];
  const volumes: string[] = [];
  /** ネットワーク ID → remove で投げるエラー */
  const networkRemoveError = new Map<string, () => Error>();
  const opts = { containerRemoveError: null as null | (() => Error), volumeRemoveError: null as null | (() => Error) };
  const docker = {
    listContainers: async () => containers.map((c) => ({ ...c })),
    listNetworks: async () => networks.map((n) => ({ ...n })),
    getContainer: (id: string) => ({
      stop: async () => {
        calls.stop.push(id);
      },
      remove: async () => {
        calls.remove.push(id);
        if (opts.containerRemoveError) throw opts.containerRemoveError();
      },
    }),
    getNetwork: (id: string) => ({
      remove: async () => {
        calls.removeNetwork.push(id);
        const e = networkRemoveError.get(id);
        if (e) throw e();
      },
    }),
    listVolumes: async () => {
      calls.listVolumes++;
      return { Volumes: volumes.map((Name) => ({ Name })) };
    },
    getVolume: (name: string) => ({
      remove: async () => {
        calls.removeVolume.push(name);
        if (opts.volumeRemoveError) throw opts.volumeRemoveError();
      },
    }),
  };
  return { calls, containers, networks, volumes, networkRemoveError, opts, docker };
});

vi.mock('dockerode', () => ({
  default: function FakeDocker() {
    return stub.docker;
  },
}));

const { composeService, ComposeDownResidueError } = await import('../services/compose');

const activeEndpoints = () =>
  Object.assign(new Error('(HTTP code 403) unexpected - error while removing network: network proj_front id net-front has active endpoints'), {
    statusCode: 403,
  });
const http = (statusCode: number) => () => Object.assign(new Error(`(HTTP code ${statusCode}) stub`), { statusCode });

let silence: { mockRestore: () => void }[] = [];
beforeEach(() => {
  stub.calls.stop.length = 0;
  stub.calls.remove.length = 0;
  stub.calls.removeNetwork.length = 0;
  stub.calls.removeVolume.length = 0;
  stub.calls.listVolumes = 0;
  stub.containers.length = 0;
  stub.networks.length = 0;
  stub.volumes.length = 0;
  stub.networkRemoveError.clear();
  stub.opts.containerRemoveError = null;
  stub.opts.volumeRemoveError = null;
  stub.containers.push(
    { Id: 'web0000000001', Names: ['/proj_web'], Labels: {}, State: 'running' },
    { Id: 'db00000000001', Names: ['/proj_db'], Labels: {}, State: 'exited' },
    { Id: 'other00000001', Names: ['/other_app'], Labels: {}, State: 'running' },
  );
  stub.networks.push(
    { Id: 'net-front', Name: 'proj_front', Labels: {} },
    { Id: 'net-back', Name: 'proj_back', Labels: {} },
    { Id: 'net-other', Name: 'other_default', Labels: {} },
  );
  stub.volumes.push('proj_data', 'proj_cache', 'other_data');
  silence = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined)];
});
afterEach(() => {
  for (const s of silence) s.mockRestore();
});

describe('直し回11：compose down のネットワーク削除失敗を残存として出す', () => {
  it('すべて削除できれば従来どおり成功し、削除したコンテナ・ネットワークを返す（残存なし）', async () => {
    const r = await composeService.composeDown('proj');
    expect(r).toEqual({
      removedContainers: ['proj_web', 'proj_db'],
      removedNetworks: [
        { name: 'proj_front', id: 'net-front' },
        { name: 'proj_back', id: 'net-back' },
      ],
      remainingNetworks: [],
    });
    expect(stub.calls.stop).toEqual(['web0000000001']);
    expect(stub.calls.removeNetwork).toEqual(['net-front', 'net-back']);
  });

  it('使用中（has active endpoints）で削除できなければ、残りも削除したうえで残存（名前・ID・理由・復旧手順）つきで失敗する', async () => {
    stub.networkRemoveError.set('net-front', activeEndpoints);
    const events: Record<string, unknown>[] = [];
    const onProgress = (e: Record<string, unknown>) => events.push(e);
    composeService.on('down:progress', onProgress);
    const err = await composeService.composeDown('proj').catch((e: unknown) => e);
    composeService.off('down:progress', onProgress);

    expect(err).toBeInstanceOf(ComposeDownResidueError);
    const e = err as InstanceType<typeof ComposeDownResidueError>;
    expect(e.code).toBe('COMPOSE_DOWN_RESIDUE');
    // 他のネットワークの削除は止めない
    expect(stub.calls.removeNetwork).toEqual(['net-front', 'net-back']);
    expect(e.result.removedContainers).toEqual(['proj_web', 'proj_db']);
    expect(e.result.removedNetworks).toEqual([{ name: 'proj_back', id: 'net-back' }]);
    expect(e.result.remainingNetworks).toEqual([
      { name: 'proj_front', id: 'net-front', error: expect.stringContaining('has active endpoints'), recovery: 'docker network rm net-front' },
    ]);
    expect(e.message).toContain('proj_front（net-front）');
    expect(e.message).toContain('docker network rm net-front');
    expect(e.message).toContain('削除したもの：コンテナ proj_web, proj_db／ネットワーク proj_back');
    // 進捗の最後は完了ではなく error（残存つき）
    const last = events.at(-1)!;
    expect(last.status).toBe('error');
    expect(last.remaining).toEqual(e.result.remainingNetworks);
    expect(events.some((x) => x.status === 'completed')).toBe(false);
  });

  it('500・通信エラーでも残存として扱い（以前は例外で残りを試みなかった）、全ネットワークの削除を試みる', async () => {
    stub.networkRemoveError.set('net-front', http(500));
    stub.networkRemoveError.set('net-back', () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const e = (await composeService.composeDown('proj').catch((x: unknown) => x)) as InstanceType<typeof ComposeDownResidueError>;
    expect(e).toBeInstanceOf(ComposeDownResidueError);
    expect(stub.calls.removeNetwork).toEqual(['net-front', 'net-back']);
    expect(e.result.remainingNetworks.map((n) => [n.name, n.id, n.recovery])).toEqual([
      ['proj_front', 'net-front', 'docker network rm net-front'],
      ['proj_back', 'net-back', 'docker network rm net-back'],
    ]);
    expect(e.result.remainingNetworks[1].error).toContain('socket hang up');
    expect(e.result.removedNetworks).toEqual([]);
  });

  it('削除時に 404（既に無い）なら削除済みとして成功する', async () => {
    stub.networkRemoveError.set('net-back', http(404));
    const r = await composeService.composeDown('proj');
    expect(r.remainingNetworks).toEqual([]);
    expect(r.removedNetworks.map((n) => n.id)).toEqual(['net-front', 'net-back']);
  });

  it('down-volumes：ネットワークが残ってもボリュームの削除は続け、そのうえで残存つきで失敗する', async () => {
    stub.networkRemoveError.set('net-front', activeEndpoints);
    const e = (await composeService.composeDownVolumes('proj').catch((x: unknown) => x)) as InstanceType<typeof ComposeDownResidueError>;
    expect(e).toBeInstanceOf(ComposeDownResidueError);
    expect(stub.calls.removeVolume).toEqual(['proj_data', 'proj_cache']);
    expect(e.result.removedVolumes).toEqual(['proj_data', 'proj_cache']);
    expect(e.result.remainingNetworks.map((n) => n.id)).toEqual(['net-front']);
    expect(e.volumeError).toBeUndefined();
    expect(e.message).toContain('ボリューム proj_data, proj_cache');
  });

  it('down-volumes：ネットワークが残り、ボリュームの削除にも失敗したら、両方を出して失敗する', async () => {
    stub.networkRemoveError.set('net-front', activeEndpoints);
    stub.opts.volumeRemoveError = () => new Error('volume is in use (stub)');
    const e = (await composeService.composeDownVolumes('proj').catch((x: unknown) => x)) as InstanceType<typeof ComposeDownResidueError>;
    expect(e).toBeInstanceOf(ComposeDownResidueError);
    expect(e.volumeError).toContain('volume is in use');
    expect(e.result.remainingNetworks.map((n) => n.id)).toEqual(['net-front']);
    expect(e.message).toContain('ボリュームの削除にも失敗しました');
  });

  it('down-volumes：すべて削除できれば従来どおり成功し、削除したボリュームを返す', async () => {
    const r = await composeService.composeDownVolumes('proj');
    expect(r.remainingNetworks).toEqual([]);
    expect(r.removedVolumes).toEqual(['proj_data', 'proj_cache']);
  });

  it('down-volumes：コンテナの削除に失敗して down が中止した場合は、従来どおりボリュームに触れない', async () => {
    stub.opts.containerRemoveError = http(500);
    const err = await composeService.composeDownVolumes('proj').catch((x: unknown) => x);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ComposeDownResidueError);
    expect(stub.calls.listVolumes).toBe(0);
    expect(stub.calls.removeVolume).toEqual([]);
    expect(stub.calls.removeNetwork).toEqual([]);
  });
});
