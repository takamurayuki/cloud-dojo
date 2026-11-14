/**
 * 直し回2（必須B）：既存のコンテナ操作 API からパイロットのラボコンテナ（ラベル cloud-dojo.lab）を守る。
 * 対象：POST /api/network/exec、DELETE /api/docker/containers/:id、POST /api/docker/containers/:id/stop・start。
 * Docker が無い環境のため dockerode をスタブに差し替える（キューは Redis を使うため差し替える）。
 */
import { PassThrough } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => {
  const calls = { exec: [] as string[], remove: [] as string[], stop: [] as string[], start: [] as string[] };
  const containers: Record<string, { Id: string; Name: string; Labels: Record<string, string> }> = {};
  const find = (idOrName: string) => containers[idOrName] ?? Object.values(containers).find((c) => c.Name === `/${idOrName}`);
  const docker = {
    getContainer: (idOrName: string) => ({
      inspect: async () => {
        const c = find(idOrName);
        if (!c) throw Object.assign(new Error(`no such container: ${idOrName}`), { statusCode: 404 });
        return { Id: c.Id, Name: c.Name, Config: { Labels: c.Labels } };
      },
      exec: async () => {
        calls.exec.push(idOrName);
        return {
          start: async () => {
            const s = new PassThrough();
            setImmediate(() => s.end(Buffer.concat([Buffer.alloc(8), Buffer.from('hello')])));
            return s;
          },
          inspect: async () => ({ ExitCode: 0 }),
        };
      },
      remove: async () => {
        calls.remove.push(idOrName);
      },
      stop: async () => {
        calls.stop.push(idOrName);
      },
      start: async () => {
        calls.start.push(idOrName);
      },
    }),
  };
  return { calls, containers, docker };
});

vi.mock('dockerode', () => ({
  default: function FakeDocker() {
    return stub.docker;
  },
}));
vi.mock('../services/queue.js', () => ({ addDockerBuildTask: vi.fn(), addDockerRunTask: vi.fn() }));

const { networkRoutes } = await import('../routes/network');
const { dockerRoutes } = await import('../routes/docker');

let app: FastifyInstance;
beforeEach(async () => {
  for (const k of Object.keys(stub.calls) as (keyof typeof stub.calls)[]) stub.calls[k].length = 0;
  for (const k of Object.keys(stub.containers)) delete stub.containers[k];
  stub.containers['labc0ffee0001'] = {
    Id: 'labc0ffee0001',
    Name: '/cloud-dojo-lab-n5-tcp-abcg1-client',
    Labels: { 'cloud-dojo.lab': 'n5-tcp', 'cloud-dojo.role': 'client', 'cloud-dojo.gen': 'abcg1' },
  };
  stub.containers['plain0000001'] = { Id: 'plain0000001', Name: '/my-app', Labels: { 'cloud-dojo': 'network-lab' } };
  app = Fastify();
  await app.register(networkRoutes, { prefix: '/api/network' });
  await app.register(dockerRoutes, { prefix: '/api/docker' });
});
afterEach(async () => {
  await app.close();
});

describe('既存 API からのパイロットのラボコンテナへの操作を拒否する', () => {
  it('/api/network/exec：ラボコンテナは ID でも名前でも 403、exec は呼ばれない', async () => {
    for (const containerId of ['labc0ffee0001', 'cloud-dojo-lab-n5-tcp-abcg1-client']) {
      const r = await app.inject({ method: 'POST', url: '/api/network/exec', payload: { containerId, command: 'sysctl -w net.ipv4.tcp_syn_retries=1' } });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('PILOT_LAB_PROTECTED');
    }
    expect(stub.calls.exec).toHaveLength(0);
  });

  it('/api/network/exec：ラベルの無い通常のコンテナは従来どおり実行できる（確かめた ID で実行する）', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/network/exec', payload: { containerId: 'my-app', command: 'hostname' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ exitCode: 0, output: 'hello' });
    expect(stub.calls.exec).toEqual(['plain0000001']);
  });

  it('/api/docker/containers/:id の削除・停止・起動：ラボコンテナは 403、操作は呼ばれない', async () => {
    const reqs = [
      { method: 'DELETE' as const, url: '/api/docker/containers/labc0ffee0001?force=true' },
      { method: 'POST' as const, url: '/api/docker/containers/labc0ffee0001/stop' },
      { method: 'POST' as const, url: '/api/docker/containers/cloud-dojo-lab-n5-tcp-abcg1-client/start' },
    ];
    for (const q of reqs) {
      const r = await app.inject(q);
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('PILOT_LAB_PROTECTED');
    }
    expect(stub.calls.remove).toHaveLength(0);
    expect(stub.calls.stop).toHaveLength(0);
    expect(stub.calls.start).toHaveLength(0);
  });

  it('/api/docker/containers/:id の削除・停止・起動：通常のコンテナは従来どおり', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/docker/containers/plain0000001/stop' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/docker/containers/plain0000001/start' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/docker/containers/my-app' })).statusCode).toBe(200);
    expect(stub.calls).toMatchObject({ stop: ['plain0000001'], start: ['plain0000001'], remove: ['plain0000001'] });
  });

  it('存在しないコンテナは従来どおりのエラー（500）で、403 にはならない', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/docker/containers/nope' });
    expect(r.statusCode).toBe(500);
  });
});
