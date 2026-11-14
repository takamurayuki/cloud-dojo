/**
 * 直し回4補足1：/api/k8s/* のシェル注入を塞ぐ。
 * 以前は namespace・name・kind 等を文字列のまま `kubectl ...` に組み立てて exec していたため、
 * `GET /api/k8s/pods?namespace=default; docker rm -f <ID>` で任意のコマンドが実行できた。
 * 入力は Kubernetes の名前の規則で検証し（妥当でなければ 400、kubectl を起動しない）、kubectl は execFile で引数を分けて起動する。
 * child_process は記録用のスタブに差し替える（実際の kubectl・Docker は実行しない）。キューは Redis を使うため差し替える。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => {
  const calls = { exec: [] as string[], execFile: [] as { file: string; args: string[]; shell: unknown }[] };
  /** kubectl の応答（引数の先頭2つで選ぶ）。get の -o json には items を返す */
  const respond = (args: string[]) => {
    const [verb, what] = args;
    if (verb === 'get' && what === 'pods')
      return JSON.stringify({
        items: [
          {
            metadata: { name: 'web-abc12', namespace: args[3], creationTimestamp: new Date().toISOString() },
            spec: { nodeName: 'node-1' },
            status: { phase: 'Running', podIP: '10.0.0.5', containerStatuses: [{ restartCount: 2 }] },
          },
        ],
      });
    if (verb === 'get' && what === 'deployments')
      return JSON.stringify({
        items: [
          {
            metadata: { name: 'web', namespace: args[3], creationTimestamp: new Date().toISOString() },
            spec: { replicas: 3, template: { spec: { containers: [{ name: 'nginx' }] } } },
            status: { readyReplicas: 3, availableReplicas: 3 },
          },
        ],
      });
    if (verb === 'get' && what === 'services')
      return JSON.stringify({
        items: [
          {
            metadata: { name: 'web-svc', namespace: args[3], creationTimestamp: new Date().toISOString() },
            spec: { type: 'ClusterIP', clusterIP: '10.96.0.10', ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }] },
            status: {},
          },
        ],
      });
    if (verb === 'get' && what === 'namespaces') return 'default kube-system demo';
    // 直し回13：apply 後の確認（`get <Kind> <name> -n <ns> -o json`）には準備完了の状態を返す
    if (verb === 'get' && what === 'Deployment')
      return JSON.stringify({ kind: 'Deployment', metadata: { name: args[2] }, spec: { replicas: 1 }, status: { updatedReplicas: 1, availableReplicas: 1 } });
    if (verb === 'get' && what === 'Service')
      return JSON.stringify({ kind: 'Service', metadata: { name: args[2] }, spec: { type: 'ClusterIP', clusterIP: '10.96.0.20' }, status: {} });
    if (verb === 'config') return 'kind-cluster\n';
    if (verb === 'logs') return 'line1\nline2\n';
    return `ok ${args.join(' ')}\n`;
  };
  const execFile = (file: string, args: string[], opts: { shell?: unknown }, cb: (e: unknown, o: string, s: string) => void) => {
    calls.execFile.push({ file, args, shell: opts?.shell });
    cb(null, respond(args), '');
  };
  // 実物の execFile と同じく、promisify すると { stdout, stderr } で解決する
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (file: string, args: string[], opts: { shell?: unknown }) =>
      new Promise((resolve) => execFile(file, args, opts, (_e, stdout, stderr) => resolve({ stdout, stderr }))),
  });
  const exec = (cmd: string, ...rest: unknown[]) => {
    calls.exec.push(cmd);
    const cb = rest.find((r) => typeof r === 'function') as ((e: unknown, o: unknown, s: unknown) => void) | undefined;
    cb?.(null, '', '');
  };
  return { calls, execFile, exec };
});

vi.mock('child_process', () => ({ exec: cp.exec, execFile: cp.execFile, default: { exec: cp.exec, execFile: cp.execFile } }));
const queue = vi.hoisted(() => ({ addK8sDeployTask: vi.fn(async () => 'job-1') }));
vi.mock('../services/queue', () => queue);

const { kubernetesRoutes } = await import('../routes/kubernetes');
const { k8sService, KubernetesService } = await import('../services/kubernetes');
const { validateNamespace, validateResourceName, validateKind, parseTailQuery, K8sInputError } = await import('../services/k8s-args');

const PILOT_ID = 'labc0ffee0001';
/** シェルのメタ文字・空白・改行・オプション風の値を含む入力（いずれも Kubernetes の名前として妥当でない） */
const BAD_NAMES = [
  `default; docker rm -f ${PILOT_ID}`,
  `default && docker rm -f ${PILOT_ID}`,
  `default || docker stop ${PILOT_ID}`,
  `default | docker rm -f ${PILOT_ID}`,
  `default & docker rm -f ${PILOT_ID}`,
  `$(docker rm -f ${PILOT_ID})`,
  `\`docker rm -f ${PILOT_ID}\``,
  '${HOME}',
  'default > /tmp/k8s-bypass',
  'default < /etc/passwd',
  `default\ndocker rm -f ${PILOT_ID}`,
  `default\rdocker rm -f ${PILOT_ID}`,
  "default' -o json; echo '",
  'default"',
  'default\\;',
  'default name',
  '--all-namespaces',
  '-n',
  'Default',
  '',
];

const silence = () => [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined)];

let app: FastifyInstance;
let quiet: ReturnType<typeof silence>;
beforeEach(async () => {
  cp.calls.exec.length = 0;
  cp.calls.execFile.length = 0;
  queue.addK8sDeployTask.mockClear();
  // 実 kubectl の経路を通す（mock モードを切る）
  (k8sService as unknown as { useMockMode: boolean }).useMockMode = false;
  quiet = silence();
  app = Fastify();
  await app.register(kubernetesRoutes);
});
afterEach(async () => {
  quiet.forEach((s) => s.mockRestore());
  await app.close();
});

const expectNothingRan = () => {
  expect(cp.calls.exec).toHaveLength(0);
  expect(cp.calls.execFile).toHaveLength(0);
};

describe('k8s-args：Kubernetes の名前の規則', () => {
  it('メタ文字・空白・改行・大文字・オプション風・空の値は namespace・name・kind のいずれでも拒否する', () => {
    for (const v of BAD_NAMES) {
      expect(() => validateNamespace(v), JSON.stringify(v)).toThrow(K8sInputError);
      expect(() => validateResourceName(v), JSON.stringify(v)).toThrow(K8sInputError);
    }
    for (const v of BAD_NAMES.filter((x) => x !== 'Default')) expect(() => validateKind(v), JSON.stringify(v)).toThrow(K8sInputError);
    expect(() => validateNamespace('a'.repeat(64))).toThrow(K8sInputError);
    expect(() => validateResourceName('a'.repeat(254))).toThrow(K8sInputError);
    expect(() => validateNamespace(123)).toThrow(K8sInputError);
  });

  it('従来使われる正常な値は通る', () => {
    for (const v of ['default', 'kube-system', 'demo', 'team-a1', 'a']) expect(validateNamespace(v)).toBe(v);
    for (const v of ['web', 'web-abc12', 'nginx-deployment-7d9f8c6b5-x2x9z', 'my.app.v1', 'a'.repeat(253)]) expect(validateResourceName(v)).toBe(v);
    for (const v of ['Deployment', 'deployment', 'deployments', 'deploy', 'Service', 'svc', 'StatefulSet', 'pod', 'deployments.apps', 'ingresses.networking.k8s.io'])
      expect(validateKind(v)).toBe(v);
    expect(() => validateResourceName('My.App')).toThrow(K8sInputError);
  });

  it('tail は未指定なら 100、-1・0〜100000 の整数だけ通る', () => {
    expect(parseTailQuery(undefined)).toBe(100);
    expect(parseTailQuery('50')).toBe(50);
    expect(parseTailQuery('-1')).toBe(-1);
    for (const v of ['10; docker rm -f x', '1e3', '5.5', '100001', '-2', 'abc', ' 10']) expect(() => parseTailQuery(v), v).toThrow(K8sInputError);
  });
});

describe('メタ文字を含む k8s 入力は 400 で拒否され、kubectl（exec・execFile）に渡らない', () => {
  it('GET /api/k8s/pods・deployments・services：namespace', async () => {
    for (const path of ['pods', 'deployments', 'services']) {
      for (const ns of BAD_NAMES.filter(Boolean)) {
        const r = await app.inject({ method: 'GET', url: `/api/k8s/${path}?namespace=${encodeURIComponent(ns)}` });
        expect(r.statusCode, `${path} ${JSON.stringify(ns)}`).toBe(400);
        expect(r.json().error).toBe('K8S_INVALID_INPUT');
      }
    }
    expectNothingRan();
  });

  it('GET /api/k8s/pods/:name/logs：name・namespace・tail', async () => {
    const bad = [
      `/api/k8s/pods/${encodeURIComponent(`web; docker rm -f ${PILOT_ID}`)}/logs`,
      `/api/k8s/pods/${encodeURIComponent('$(docker stop x)')}/logs`,
      `/api/k8s/pods/web/logs?namespace=${encodeURIComponent(`default; docker rm -f ${PILOT_ID}`)}`,
      `/api/k8s/pods/web/logs?tail=${encodeURIComponent(`10; docker rm -f ${PILOT_ID}`)}`,
    ];
    for (const url of bad) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(400);
      expect(r.json().error).toBe('K8S_INVALID_INPUT');
    }
    expectNothingRan();
  });

  it('DELETE /api/k8s/resource：kind・name・namespace', async () => {
    const payloads = [
      { kind: `pod; docker rm -f ${PILOT_ID}`, name: 'web' },
      { kind: 'pod', name: `web && docker rm -f ${PILOT_ID}` },
      { kind: 'pod', name: 'web', namespace: `default | docker stop ${PILOT_ID}` },
      { kind: 'pod', name: '--all' },
    ];
    for (const payload of payloads) {
      const r = await app.inject({ method: 'DELETE', url: '/api/k8s/resource', payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().error).toBe('K8S_INVALID_INPUT');
    }
    expectNothingRan();
  });

  it('POST /api/k8s/apply：namespace とマニフェストの kind・metadata.name はキューに入る前に拒否する', async () => {
    const okManifest = 'apiVersion: v1\nkind: Service\nmetadata:\n  name: web-svc\n';
    const cases = [
      { manifest: okManifest, namespace: `default; docker rm -f ${PILOT_ID}` },
      { manifest: `apiVersion: v1\nkind: Service\nmetadata:\n  name: "web; docker rm -f ${PILOT_ID}"\n` },
      { manifest: `apiVersion: v1\nkind: "Service; docker rm -f ${PILOT_ID}"\nmetadata:\n  name: web\n` },
      { manifest: `apiVersion: v1\nkind: Service\nmetadata:\n  name: web\n  namespace: "x$(docker stop ${PILOT_ID})"\n` },
    ];
    for (const payload of cases) {
      const r = await app.inject({ method: 'POST', url: '/api/k8s/apply', payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().error).toBe('K8S_INVALID_INPUT');
    }
    expect(queue.addK8sDeployTask).not.toHaveBeenCalled();
    expectNothingRan();
  });

  it('applyManifest（Worker 側）も同じ検証をし、kubectl もファイル書き込みもせずに失敗する', async () => {
    const svc = new KubernetesService();
    (svc as unknown as { useMockMode: boolean }).useMockMode = false;
    await expect(svc.applyManifest('apiVersion: v1\nkind: Service\nmetadata:\n  name: ok\n', `default; docker rm -f ${PILOT_ID}`)).rejects.toThrow(K8sInputError);
    await expect(
      svc.applyManifest(`apiVersion: v1\nkind: Service\nmetadata:\n  name: "x; docker rm -f ${PILOT_ID}"\n`, 'default'),
    ).rejects.toThrow(K8sInputError);
    expectNothingRan();
  });

  it('mock モードでも同じ入力は拒否する（mock でだけ通る入力を作らない）', async () => {
    (k8sService as unknown as { useMockMode: boolean }).useMockMode = true;
    const r = await app.inject({ method: 'GET', url: `/api/k8s/pods?namespace=${encodeURIComponent(`default; docker rm -f ${PILOT_ID}`)}` });
    expect(r.statusCode).toBe(400);
    const ok = await app.inject({ method: 'GET', url: '/api/k8s/pods?namespace=default' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().pods).toEqual([]);
    expectNothingRan();
  });
});

describe('正常な k8s 入力は従来どおり、execFile（shell:false）で引数を分けて kubectl を起動する', () => {
  const lastCall = () => cp.calls.execFile[cp.calls.execFile.length - 1];

  it('GET /api/k8s/pods・deployments・services（namespace 既定 default と指定）', async () => {
    const pods = await app.inject({ method: 'GET', url: '/api/k8s/pods' });
    expect(pods.statusCode).toBe(200);
    expect(pods.json().pods[0]).toMatchObject({ name: 'web-abc12', namespace: 'default', phase: 'Running', restarts: 2, node: 'node-1', ip: '10.0.0.5' });
    expect(lastCall()).toEqual({ file: 'kubectl', args: ['get', 'pods', '-n', 'default', '-o', 'json'], shell: false });

    const deps = await app.inject({ method: 'GET', url: '/api/k8s/deployments?namespace=kube-system' });
    expect(deps.statusCode).toBe(200);
    expect(deps.json().deployments[0]).toMatchObject({ name: 'web', namespace: 'kube-system', replicas: { desired: 3, ready: 3 }, containers: ['nginx'] });
    expect(lastCall().args).toEqual(['get', 'deployments', '-n', 'kube-system', '-o', 'json']);

    const svcs = await app.inject({ method: 'GET', url: '/api/k8s/services?namespace=demo' });
    expect(svcs.statusCode).toBe(200);
    expect(svcs.json().services[0]).toMatchObject({ name: 'web-svc', type: 'ClusterIP', ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }] });
    expect(lastCall().args).toEqual(['get', 'services', '-n', 'demo', '-o', 'json']);
    expect(cp.calls.exec).toHaveLength(0);
  });

  it('GET /api/k8s/pods/:name/logs（tail 既定 100 と指定）', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/k8s/pods/web-abc12/logs' });
    expect(r.statusCode).toBe(200);
    expect(r.json().logs).toBe('line1\nline2\n');
    expect(lastCall()).toEqual({ file: 'kubectl', args: ['logs', 'web-abc12', '-n', 'default', '--tail=100'], shell: false });
    await app.inject({ method: 'GET', url: '/api/k8s/pods/web-abc12/logs?namespace=demo&tail=20' });
    expect(lastCall().args).toEqual(['logs', 'web-abc12', '-n', 'demo', '--tail=20']);
    expect(cp.calls.exec).toHaveLength(0);
  });

  it('DELETE /api/k8s/resource', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/k8s/resource', payload: { kind: 'Deployment', name: 'web', namespace: 'demo' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ success: true });
    expect(lastCall()).toEqual({ file: 'kubectl', args: ['delete', 'Deployment', 'web', '-n', 'demo'], shell: false });
  });

  it('GET /api/k8s/check・namespaces（固定の引数）', async () => {
    const check = await app.inject({ method: 'GET', url: '/api/k8s/check' });
    expect(check.json()).toEqual({ available: true, context: 'kind-cluster' });
    const ns = await app.inject({ method: 'GET', url: '/api/k8s/namespaces' });
    expect(ns.json().namespaces).toEqual(['default', 'kube-system', 'demo']);
    expect(cp.calls.execFile.map((c) => c.args)).toEqual([
      ['version', '--client', '--short'],
      ['cluster-info', '--request-timeout=2s'],
      ['config', 'current-context'],
      ['get', 'namespaces', '-o', 'jsonpath={.items[*].metadata.name}'],
    ]);
    expect(cp.calls.execFile.every((c) => c.file === 'kubectl' && c.shell === false)).toBe(true);
    expect(cp.calls.exec).toHaveLength(0);
  });

  it('POST /api/k8s/apply は従来どおりキューに入れる', async () => {
    const manifest = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 2\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: web-svc\n';
    const r = await app.inject({ method: 'POST', url: '/api/k8s/apply', payload: { manifest, namespace: 'demo' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ jobId: 'job-1', status: 'queued' });
    expect(queue.addK8sDeployTask).toHaveBeenCalledWith({ manifest, namespace: 'demo' });
    expectNothingRan();
  });

  it('applyManifest（Worker 側）は一時ファイルを apply し、各リソースを get で確かめる', async () => {
    const svc = new KubernetesService();
    (svc as unknown as { useMockMode: boolean }).useMockMode = false;
    const manifest = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: web-svc\n';
    const session = await svc.applyManifest(manifest, 'demo');
    expect(session.status).toBe('completed');
    expect(session.resources.map((r) => `${r.kind}/${r.name}:${r.status}`)).toEqual(['Deployment/web:ready', 'Service/web-svc:ready']);
    const [apply, ...gets] = cp.calls.execFile;
    expect(apply.args.slice(0, 2)).toEqual(['apply', '-f']);
    expect(apply.args[2]).toMatch(/k8s-manifest-k8s-\d+\.yaml$/);
    expect(apply.args.slice(3)).toEqual(['-n', 'demo']);
    // 直し回13：適用後の確認は種別ごとの判定のために -o json で全体を取得する（以前は Ready 条件の jsonpath を取得して結果を見ていなかった）
    expect(gets.map((c) => c.args)).toEqual([
      ['get', 'Deployment', 'web', '-n', 'demo', '-o', 'json'],
      ['get', 'Service', 'web-svc', '-n', 'demo', '-o', 'json'],
    ]);
    expect(cp.calls.execFile.every((c) => c.file === 'kubectl' && c.shell === false)).toBe(true);
    expect(cp.calls.exec).toHaveLength(0);
  }, 10000);
});
