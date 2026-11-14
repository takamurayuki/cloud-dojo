/**
 * PR #4 直し回1：パイロット API サーバ（server.ts）の全経路に対する接続元制限と、キュー投入を伴う操作の拒否。
 *
 * - 必須：pilot／docker／compose／kubernetes／cicd／network の各ルート群（と /health・未定義の経路・プリフライト）で、
 *   外部からの要求が 403 LOOPBACK_ONLY になり、ハンドラ（Docker 操作・キュー投入）に届かないこと。
 *   判定は実際の接続元で行い、X-Forwarded-For 等で外部を loopback に見せかけられないこと。
 *   loopback からの利用（転送ヘッダが loopback のプロキシ経由を含む）は従来どおり通ること。
 * - 推奨A：キュー投入を伴う操作は 503 PILOT_QUEUE_UNSUPPORTED（理由付き）で、投入関数を呼ばないこと。
 * Docker・Redis が無い環境のため dockerode とキューは差し替える。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureEvidence } from '../evidence/fixtures';
import { LabLock } from '../lab/lock';
import type { LabRunner } from '../lab/runner';
import { PilotStore } from '../store';

const stub = vi.hoisted(() => {
  /** Docker に届いた呼び出し（拒否された要求では空のまま） */
  const dockerCalls: string[] = [];
  const docker = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined;
        return (...args: unknown[]) => {
          dockerCalls.push(String(prop));
          if (prop === 'listContainers' || prop === 'listImages' || prop === 'listNetworks') return Promise.resolve([]);
          if (prop === 'getContainer' || prop === 'getNetwork' || prop === 'getImage') {
            return { inspect: () => Promise.reject(Object.assign(new Error('no such object'), { statusCode: 404 })), id: args[0] };
          }
          return Promise.reject(new Error(`docker stub: ${String(prop)} not available`));
        };
      },
    },
  );
  const queue = {
    addDockerBuildTask: vi.fn(async () => 'job-1'),
    addDockerRunTask: vi.fn(async () => 'job-1'),
    addK8sDeployTask: vi.fn(async () => 'job-1'),
    addComposeUpTask: vi.fn(async () => 'job-1'),
    addComposeDownTask: vi.fn(async () => 'job-1'),
    addCICDRunTask: vi.fn(async () => 'job-1'),
  };
  return { dockerCalls, docker, queue };
});

vi.mock('dockerode', () => ({
  default: function FakeDocker() {
    return stub.docker;
  },
}));
vi.mock('../../services/queue', () => stub.queue);

const { buildPilotServer, PILOT_QUEUE_ROUTES } = await import('../server');

const labRunner: LabRunner = {
  status: async () => ({ docker: 'available', running: true, nodes: [], network: null }),
  start: async () => ({ docker: 'available', running: true, nodes: [], network: null, elapsedMs: 0 }),
  reset: async () => ({ removedContainers: 0, removedNetworks: 0, elapsedMs: 0 }),
  collect: async (c) => fixtureEvidence(c.portState, Number(c.connectTimeout)),
};

let app: FastifyInstance;
beforeEach(async () => {
  stub.dockerCalls.length = 0;
  for (const f of Object.values(stub.queue)) f.mockClear();
  app = await buildPilotServer({ pilot: { store: new PilotStore(':memory:'), lab: labRunner, labLock: new LabLock() } });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

/** 各ルート群の代表経路（読み取り・変更・キュー投入・Docker 実行を含む） */
const ROUTES: { group: string; method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; payload?: unknown }[] = [
  { group: 'pilot', method: 'GET', url: '/api/pilot/units' },
  { group: 'pilot', method: 'POST', url: '/api/pilot/attempts', payload: { unitId: 'n5-tcp' } },
  { group: 'pilot', method: 'POST', url: '/api/pilot/lab/reset', payload: {} },
  { group: 'docker', method: 'GET', url: '/api/docker/containers' },
  { group: 'docker', method: 'DELETE', url: '/api/docker/containers/abc123' },
  { group: 'docker', method: 'POST', url: '/api/docker/containers/abc123/stop', payload: {} },
  { group: 'docker', method: 'POST', url: '/api/docker/build', payload: { dockerfile: 'FROM alpine', imageName: 'x', imageTag: 'latest' } },
  { group: 'compose', method: 'GET', url: '/api/compose/status' },
  { group: 'compose', method: 'POST', url: '/api/compose/up', payload: { composeYaml: 'services: {}' } },
  { group: 'compose', method: 'POST', url: '/api/compose/down', payload: {} },
  { group: 'kubernetes', method: 'GET', url: '/api/k8s/check' },
  { group: 'kubernetes', method: 'POST', url: '/api/k8s/apply', payload: { manifest: 'kind: Pod' } },
  { group: 'kubernetes', method: 'DELETE', url: '/api/k8s/resource', payload: { kind: 'pod', name: 'x' } },
  { group: 'cicd', method: 'GET', url: '/api/cicd/templates' },
  { group: 'cicd', method: 'POST', url: '/api/cicd/run', payload: { yaml: 'name: x', trigger: 'push', branch: 'main' } },
  { group: 'cicd', method: 'POST', url: '/api/cicd/workflows', payload: { name: 'x', yaml: 'name: x' } },
  { group: 'network', method: 'GET', url: '/api/network/cheatsheet' },
  { group: 'network', method: 'GET', url: '/api/network/lab/status' },
  { group: 'network', method: 'POST', url: '/api/network/exec', payload: { containerId: 'abc123', command: 'id' } },
  { group: 'network', method: 'POST', url: '/api/network/lab/create', payload: {} },
  { group: 'network', method: 'DELETE', url: '/api/network/lab/cleanup' },
  { group: 'other', method: 'GET', url: '/health' },
  { group: 'other', method: 'GET', url: '/api/no-such-route' },
];

/** 外部からの要求の形（実際の接続元が外部、または転送ヘッダに外部の元の接続元） */
const EXTERNAL: { name: string; remoteAddress?: string; headers?: Record<string, string> }[] = [
  { name: '接続元が外部（IPv4）', remoteAddress: '192.168.1.50' },
  { name: '接続元が外部（IPv6）', remoteAddress: '2001:db8::5' },
  { name: '接続元が外部（IPv4 射影 IPv6）', remoteAddress: '::ffff:192.168.1.50' },
  { name: 'Vite 経由（接続元 127.0.0.1＋X-Forwarded-For が外部）', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '192.168.1.50' } },
  { name: 'Vite 経由（X-Forwarded-For の連鎖に外部）', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '127.0.0.1, 10.0.0.5' } },
  { name: 'X-Real-IP が外部', remoteAddress: '127.0.0.1', headers: { 'x-real-ip': '10.0.0.5' } },
  { name: 'Forwarded が外部', remoteAddress: '::1', headers: { forwarded: 'for="[2001:db8::1]:4711"' } },
  { name: '偽装：接続元が外部で X-Forwarded-For に 127.0.0.1', remoteAddress: '192.168.1.50', headers: { 'x-forwarded-for': '127.0.0.1' } },
  { name: '偽装：接続元が外部で X-Real-IP／Forwarded に loopback', remoteAddress: '203.0.113.7', headers: { 'x-real-ip': '127.0.0.1', forwarded: 'for=127.0.0.1' } },
];

describe('パイロット API の全経路に接続元制限（必須）', () => {
  for (const ext of EXTERNAL) {
    it(`${ext.name}：全ルート群で 403 LOOPBACK_ONLY、ハンドラに届かない`, async () => {
      for (const r of ROUTES) {
        const res = await app.inject({ method: r.method, url: r.url, payload: r.payload as never, remoteAddress: ext.remoteAddress, headers: ext.headers });
        expect(res.statusCode, `${r.group} ${r.method} ${r.url}`).toBe(403);
        expect(res.json().error, `${r.group} ${r.method} ${r.url}`).toBe('LOOPBACK_ONLY');
      }
      expect(stub.dockerCalls).toEqual([]);
      for (const f of Object.values(stub.queue)) expect(f).not.toHaveBeenCalled();
    });
  }

  it('CORS のプリフライトも外部からは 403（CORS より先に検査する）', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/network/exec',
      remoteAddress: '192.168.1.50',
      headers: { origin: 'http://127.0.0.1:3000', 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('LOOPBACK_ONLY');
  });

  it('全ルート群が実際に登録されている（拒否が 404 の取り違えでない）', () => {
    for (const r of ROUTES.filter((x) => x.group !== 'other' && !x.url.includes('abc123'))) {
      expect(app.hasRoute({ method: r.method, url: r.url }), `${r.method} ${r.url}`).toBe(true);
    }
  });
});

describe('loopback からの利用は従来どおり', () => {
  const OK: { group: string; url: string }[] = [
    { group: 'pilot', url: '/api/pilot/units' },
    { group: 'docker', url: '/api/docker/containers' },
    { group: 'docker', url: '/api/docker/images' },
    { group: 'compose', url: '/api/compose/status' },
    { group: 'kubernetes', url: '/api/k8s/check' },
    { group: 'cicd', url: '/api/cicd/templates' },
    { group: 'cicd', url: '/api/cicd/runs' },
    { group: 'network', url: '/api/network/cheatsheet' },
    { group: 'other', url: '/health' },
  ];
  const LOCAL: { name: string; remoteAddress: string; headers?: Record<string, string> }[] = [
    { name: '127.0.0.1 から直接', remoteAddress: '127.0.0.1' },
    { name: '::1 から直接', remoteAddress: '::1' },
    { name: '::ffff:127.0.0.1 から直接', remoteAddress: '::ffff:127.0.0.1' },
    { name: '同じ端末の Vite 経由（X-Forwarded-For が loopback）', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '127.0.0.1' } },
    { name: '同じ端末の Vite 経由（X-Forwarded-For が ::1）', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '::1' } },
  ];
  for (const loc of LOCAL) {
    it(`${loc.name}：各ルート群の読み取りが 200`, async () => {
      for (const r of OK) {
        const res = await app.inject({ method: 'GET', url: r.url, remoteAddress: loc.remoteAddress, headers: loc.headers });
        expect(res.statusCode, `${r.group} ${r.url} ${res.body}`).toBe(200);
      }
    });
  }

  it('単元の試行作成と CORS のプリフライトも通る', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/pilot/attempts', payload: { unitId: 'n5-tcp' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().stage).toBe('predict');
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/api/docker/containers/abc123',
      headers: { origin: 'http://127.0.0.1:3000', 'access-control-request-method': 'DELETE' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
  });
});

describe('キュー投入を伴う操作は受け付けない（推奨A）', () => {
  const VALID_BODIES: Record<string, unknown> = {
    'POST /api/docker/build': { dockerfile: 'FROM alpine', imageName: 'x', imageTag: 'latest' },
    'POST /api/docker/containers/run': { imageName: 'alpine' },
    'POST /api/compose/up': { composeYaml: 'services:\n  web:\n    image: nginx\n', projectName: 'cloud-dojo' },
    'POST /api/compose/down': { projectName: 'cloud-dojo' },
    'POST /api/compose/down-volumes': { projectName: 'cloud-dojo' },
    'POST /api/k8s/apply': { manifest: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n', namespace: 'default' },
    'POST /api/cicd/run': { yaml: 'name: x\non: push\njobs: {}\n', trigger: 'push', branch: 'main' },
  };

  it('対象経路はすべて登録済みで、503 PILOT_QUEUE_UNSUPPORTED（理由付き）を返し、投入しない', async () => {
    expect(PILOT_QUEUE_ROUTES.map((r) => `${r.method} ${r.url}`).sort()).toEqual(Object.keys(VALID_BODIES).sort());
    for (const r of PILOT_QUEUE_ROUTES) {
      const key = `${r.method} ${r.url}`;
      expect(app.hasRoute({ method: r.method as 'POST', url: r.url }), key).toBe(true);
      const res = await app.inject({ method: r.method as 'POST', url: r.url, payload: VALID_BODIES[key] as never });
      expect(res.statusCode, key).toBe(503);
      const body = res.json();
      expect(body.error, key).toBe('PILOT_QUEUE_UNSUPPORTED');
      expect(body.queue, key).toBe(r.queue);
      expect(body.message, key).toContain('パイロットでは利用できません');
      expect(body.reason, key).toContain('Worker');
    }
    for (const f of Object.values(stub.queue)) expect(f).not.toHaveBeenCalled();
    expect(stub.dockerCalls).toEqual([]);
  });

  it('外部からのキュー投入要求は、利用不可より先に接続元制限で 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/cicd/run', payload: VALID_BODIES['POST /api/cicd/run'] as never, remoteAddress: '192.168.1.50' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('LOOPBACK_ONLY');
  });

  it('キュー投入を伴わない操作は従来どおり（例：cicd の検証・ワークフロー保存）', async () => {
    const v = await app.inject({ method: 'POST', url: '/api/cicd/validate', payload: { yaml: 'name: x\non: push\njobs: {}\n' } });
    expect(v.statusCode).not.toBe(503);
    expect(v.json().error).not.toBe('PILOT_QUEUE_UNSUPPORTED');
  });

  it('対象一覧はラボ系ルートのソースでキューへ投入している経路と一致する（追加漏れの検出）', () => {
    const routesDir = join(dirname(fileURLToPath(import.meta.url)), '../../routes');
    const files: { file: string; prefix: string }[] = [
      { file: 'docker.ts', prefix: '/api/docker' },
      { file: 'compose.ts', prefix: '' },
      { file: 'kubernetes.ts', prefix: '' },
      { file: 'cicd.ts', prefix: '/api/cicd' },
      { file: 'network.ts', prefix: '/api/network' },
    ];
    const found: string[] = [];
    for (const { file, prefix } of files) {
      const src = readFileSync(join(routesDir, file), 'utf8');
      const parts = src.split(/(?=fastify\.(?:get|post|put|delete|patch)\(')/);
      for (const part of parts) {
        const m = /^fastify\.(get|post|put|delete|patch)\('([^']+)'/.exec(part);
        if (m && /\badd\w+Task\(/.test(part)) found.push(`${m[1].toUpperCase()} ${prefix}${m[2]}`);
      }
    }
    expect(found.sort()).toEqual(PILOT_QUEUE_ROUTES.map((r) => `${r.method} ${r.url}`).sort());
  });
});
