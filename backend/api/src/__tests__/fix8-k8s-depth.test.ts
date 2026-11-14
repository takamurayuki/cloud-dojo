/**
 * 直し回8 必須2：Kubernetes マニフェストの List の入れ子が検査の段数上限（MAX_LIST_DEPTH）を超えたら、
 * 検査不能として明示的に拒否する（受付 400 `K8S_MANIFEST_REJECTED`、Worker 側は kubectl を起動せずに失敗）。
 * 上限ちょうどの入れ子は従来どおり中身を検査し、上限+1 以上は中身によらず拒否する（危険な指定の無い深い List も拒否する方針）。
 * 直し回8 必須1（hostPath 経路）：空・空白だけの hostPath を受付・Worker で拒否する。
 * child_process は記録用のスタブに差し替える（実際の kubectl は実行しない）。キューは Redis を使うため差し替える。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => {
  const calls = { execFile: [] as { file: string; args: string[] }[] };
  const execFile = (file: string, args: string[], _opts: unknown, cb: (e: unknown, o: string, s: string) => void) => {
    calls.execFile.push({ file, args });
    cb(null, args[0] === 'get' ? JSON.stringify({ status: {} }) : 'ok\n', '');
  };
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (file: string, args: string[], opts: unknown) =>
      new Promise((resolve) => execFile(file, args, opts, (_e, stdout, stderr) => resolve({ stdout, stderr }))),
  });
  const exec = () => {
    throw new Error('exec must not be used');
  };
  return { calls, execFile, exec };
});
vi.mock('child_process', () => ({ exec: cp.exec, execFile: cp.execFile, default: { exec: cp.exec, execFile: cp.execFile } }));
const queue = vi.hoisted(() => ({ addK8sDeployTask: vi.fn(async () => 'job-1') }));
vi.mock('../services/queue', () => queue);

const { kubernetesRoutes } = await import('../routes/kubernetes');
const { KubernetesService } = await import('../services/kubernetes');
const { K8sManifestRejectedError, MAX_LIST_DEPTH, assertManifestSafe } = await import('../services/k8s-manifest-guard');

let app: FastifyInstance;
let quiet: { mockRestore: () => void }[];
beforeEach(async () => {
  cp.calls.execFile.length = 0;
  queue.addK8sDeployTask.mockClear();
  quiet = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined)];
  app = Fastify();
  await app.register(kubernetesRoutes);
});
afterEach(async () => {
  quiet.forEach((q) => q.mockRestore());
  await app.close();
});

const realService = () => {
  const svc = new KubernetesService();
  (svc as unknown as { useMockMode: boolean }).useMockMode = false;
  return svc;
};

/** 受付で 400・キュー非投入、Worker 側で kubectl を起動せずに失敗すること */
async function expectRejected(manifest: string, pattern: RegExp) {
  const r = await app.inject({ method: 'POST', url: '/api/k8s/apply', payload: { manifest, namespace: 'demo' } });
  expect(r.statusCode, manifest).toBe(400);
  expect(r.json().error).toBe('K8S_MANIFEST_REJECTED');
  expect(r.json().message, manifest).toMatch(pattern);
  expect(queue.addK8sDeployTask).not.toHaveBeenCalled();

  const svc = realService();
  await expect(svc.applyManifest(manifest, 'demo'), manifest).rejects.toThrow(K8sManifestRejectedError);
  await expect(svc.applyManifest(manifest, 'demo')).rejects.toThrow(pattern);
  // mock モードでも同じに拒否する
  const mock = new KubernetesService();
  (mock as unknown as { useMockMode: boolean }).useMockMode = true;
  await expect(mock.applyManifest(manifest, 'demo')).rejects.toThrow(K8sManifestRejectedError);
  expect(cp.calls.execFile, manifest).toEqual([]);
}


/** 受付で 200（キュー投入）、Worker 側で kubectl apply を起動すること */
async function expectAccepted(manifest: string) {
  const r = await app.inject({ method: 'POST', url: '/api/k8s/apply', payload: { manifest, namespace: 'demo' } });
  expect(r.statusCode, `${manifest}\n${r.body}`).toBe(200);
  expect(queue.addK8sDeployTask).toHaveBeenCalledWith({ manifest, namespace: 'demo' });
  await realService().applyManifest(manifest, 'demo');
  expect(cp.calls.execFile[0]?.args.slice(0, 2)).toEqual(['apply', '-f']);
}


const DANGER_POD = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'attacker' },
  spec: {
    hostPID: true,
    containers: [{ name: 'c', image: 'docker:cli', securityContext: { privileged: true } }],
    volumes: [{ name: 's', hostPath: { path: '/var/run/docker.sock' } }],
  },
};
const BENIGN_POD = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web' }, spec: { containers: [{ name: 'c', image: 'nginx' }] } };

/** item を n 重の List（apiVersion: v1, kind: List）で包む。JSON は YAML としてそのまま読める */
function nest(item: unknown, n: number): unknown {
  let cur = item;
  for (let i = 0; i < n; i++) cur = { apiVersion: 'v1', kind: 'List', metadata: { name: `l${i}` }, items: [cur] };
  return cur;
}
const manifestOf = (item: unknown, n: number) => JSON.stringify(nest(item, n));
const itemsPath = (n: number) => Array.from({ length: n }, () => 'items[0]').join('.');

describe('直し回8 必須2：List の入れ子が上限を超えたら検査不能として拒否する', () => {
  it('上限は 8 段（最上位を 0 段、List の items の要素を 1 段深いとする）', () => {
    expect(MAX_LIST_DEPTH).toBe(8);
  });

  it('上限ちょうど（8 重）の List の中の危険な Pod は中身を検査して拒否する（検査不能ではなく、個々の違反を報告する）', async () => {
    const m = manifestOf(DANGER_POD, MAX_LIST_DEPTH);
    await expectRejected(m, /hostPID: true/);
    try {
      assertManifestSafe([nest(DANGER_POD, MAX_LIST_DEPTH)]);
      throw new Error('拒否されなかった');
    } catch (e) {
      const v = (e as InstanceType<typeof K8sManifestRejectedError>).violations;
      expect(v.map((x) => x.path)).toEqual([
        `${itemsPath(8)}.spec.hostPID`,
        `${itemsPath(8)}.spec.volumes[0].hostPath.path`,
        `${itemsPath(8)}.spec.containers[0].securityContext.privileged`,
      ]);
      expect(v.some((x) => /検査できない/.test(x.detail))).toBe(false);
    }
  });

  it('上限ちょうど（8 重）の List の中の通常の Pod は従来どおり通る', async () => {
    await expectAccepted(manifestOf(BENIGN_POD, MAX_LIST_DEPTH));
  });

  it('上限+1（9 重）の List の中の危険な Pod は検査不能として拒否する（再レビューの再現例。受付 400・キュー非投入・kubectl 起動なし）', async () => {
    const m = manifestOf(DANGER_POD, MAX_LIST_DEPTH + 1);
    await expectRejected(m, /List の入れ子が 8 段を超えるため検査できない/);
    try {
      assertManifestSafe([nest(DANGER_POD, MAX_LIST_DEPTH + 1)]);
      throw new Error('拒否されなかった');
    } catch (e) {
      const v = (e as InstanceType<typeof K8sManifestRejectedError>).violations;
      expect(v).toEqual([{ doc: 0, path: itemsPath(9), detail: expect.stringMatching(/検査できない/) }]);
    }
  });

  it('上限+1 以上は、危険な指定の無い Pod でも検査不能として拒否する（9・10・20 重）', async () => {
    for (const n of [MAX_LIST_DEPTH + 1, MAX_LIST_DEPTH + 2, 20]) {
      cp.calls.execFile.length = 0;
      queue.addK8sDeployTask.mockClear();
      await expectRejected(manifestOf(BENIGN_POD, n), /検査できない/);
    }
  });

  it('同じマニフェストの別ドキュメントが通常でも、深すぎる List が1つあれば全体を拒否する（何も適用しない）', async () => {
    const m = `${JSON.stringify(BENIGN_POD)}\n---\n${manifestOf(BENIGN_POD, MAX_LIST_DEPTH + 1)}\n`;
    await expectRejected(m, /manifest\[1\]\.items\[0\].*検査できない/);
  });
});

describe('直し回8 必須1（hostPath 経路）：空・空白だけの hostPath を受付・Worker で拒否する', () => {
  it.each(['', ' ', '\t', '\u00a0'])('hostPath.path = %j を拒否する', async (p) => {
    const m = JSON.stringify({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'p' },
      spec: { containers: [{ name: 'c', image: 'x' }], volumes: [{ name: 's', hostPath: { path: p } }] },
    });
    await expectRejected(m, /判定できない/);
  });
});
