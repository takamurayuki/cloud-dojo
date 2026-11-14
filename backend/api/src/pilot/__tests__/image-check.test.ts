/**
 * 直し回11（必須）：ラボイメージの有無の確認（inspect）は 404 だけを「未ビルド」とする。
 * それ以外の失敗（500・503・通信エラー）ではビルドに進まず、ラボ操作を中止してエラーを呼び出し元へ伝える。
 * 404 ならビルドへ進み、既存のイメージがあれば再利用する（従来どおり）。Docker が無い環境のためスタブ。
 */
import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createPilotPlugin } from '../app';
import { DockerLabRunner, LabImageCheckError, LabTimeoutError, LabUnavailableError, LAB_IMAGE } from '../lab/runner';
import { PilotStore } from '../store';
import { fakeDocker } from './fake-docker';

const FAST = { execMs: 200, startMs: 500, resetMs: 500, abortGraceMs: 20, cleanupMs: 1_000 };

/** getImage().inspect の結果と buildImage の呼び出しを差し替えたスタブ */
function withImage(inspect: () => Promise<unknown>) {
  const f = fakeDocker();
  const builds: string[] = [];
  const inspected: string[] = [];
  const d = f.docker as unknown as Record<string, unknown>;
  d.getImage = (name: string) => ({
    inspect: async () => {
      inspected.push(name);
      return inspect();
    },
  });
  d.buildImage = async (_ctx: unknown, o: { t: string }) => {
    builds.push(o.t);
    const s = new PassThrough();
    setImmediate(() => s.end('{"stream":"Successfully built"}\n'));
    return s;
  };
  return { ...f, builds, inspected };
}

const httpError = (statusCode: number) => Object.assign(new Error(`(HTTP code ${statusCode}) server error - stub`), { statusCode });
const connError = () => Object.assign(new Error('connect ECONNRESET /var/run/docker.sock'), { code: 'ECONNRESET' });

describe('直し回11：ラボイメージの確認は 404 だけを未ビルドとする', () => {
  for (const [label, make] of [
    ['500', () => httpError(500)],
    ['503', () => httpError(503)],
    ['通信エラー（statusCode 無し）', connError],
  ] as const) {
    it(`inspect が ${label} なら、ビルドせずに LabImageCheckError で start を中止し、ネットワーク・コンテナを作らない`, async () => {
      const s = withImage(() => Promise.reject(make()));
      const err = await new DockerLabRunner(s.docker, FAST).start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LabImageCheckError);
      // Docker 不在（503 DOCKER_NOT_FOUND）や期限超過として扱わない
      expect(err).not.toBeInstanceOf(LabUnavailableError);
      expect(err).not.toBeInstanceOf(LabTimeoutError);
      expect((err as LabImageCheckError).code).toBe('LAB_IMAGE_CHECK_FAILED');
      expect((err as Error).message).toContain(LAB_IMAGE);
      expect((err as Error).message).toContain(make().message);
      expect(s.inspected).toEqual([LAB_IMAGE]);
      expect(s.builds).toEqual([]);
      expect(s.calls.created).toEqual([]);
      expect(s.networks.size).toBe(0);
    });
  }

  it('collect（試行）でも inspect が 500 ならビルドせずに中止し、ラボのコンテナを作らない', async () => {
    const s = withImage(() => Promise.reject(httpError(500)));
    const err = await new DockerLabRunner(s.docker, FAST).collect({ portState: 'drop', connectTimeout: '5' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LabImageCheckError);
    expect(s.builds).toEqual([]);
    expect(s.calls.created).toEqual([]);
  });

  it('inspect が 404 なら、従来どおりビルドしてから起動する', async () => {
    const s = withImage(() => Promise.reject(httpError(404)));
    const st = await new DockerLabRunner(s.docker, FAST).start();
    expect(s.builds).toEqual([LAB_IMAGE]);
    expect(st.running).toBe(true);
    expect(s.calls.created.map((c) => c.Image)).toEqual([LAB_IMAGE, LAB_IMAGE]);
  });

  it('既存のイメージがあれば、ビルドせずに再利用して起動する', async () => {
    const s = withImage(async () => ({ Id: 'sha256:existing' }));
    const st = await new DockerLabRunner(s.docker, FAST).start();
    expect(s.inspected).toEqual([LAB_IMAGE]);
    expect(s.builds).toEqual([]);
    expect(st.running).toBe(true);
    expect(s.calls.created).toHaveLength(2);
  });

  it('API：/lab/start は inspect が 500 のとき 500 LAB_ERROR（確認できなかった理由つき）を返し、ビルドしない', async () => {
    const s = withImage(() => Promise.reject(httpError(500)));
    const app = Fastify();
    const { plugin } = createPilotPlugin({ store: new PilotStore(':memory:'), lab: new DockerLabRunner(s.docker as Docker, FAST) });
    await app.register(plugin, { prefix: '/api/pilot' });
    try {
      const r = await app.inject({ method: 'POST', url: '/api/pilot/lab/start' });
      expect(r.statusCode).toBe(500);
      expect(r.json().error).toBe('LAB_ERROR');
      expect(r.json().message).toContain('有無を確認できない');
      expect(r.json().message).toContain('HTTP 500');
      expect(s.builds).toEqual([]);
      expect(s.calls.created).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
