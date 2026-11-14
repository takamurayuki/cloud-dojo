/**
 * 直し回7 必須2：Kubernetes の検査を構造上の位置（PodSpec の中のコンテナ securityContext、hostNetwork／hostPID／hostIPC、
 * volumes の hostPath）で行う。ConfigMap・Secret の data 等に危険な名前のキーと真に相当する値があっても通り、
 * Pod テンプレート内の危険な指定は引き続き拒否される。
 * 直し回7 必須1（hostPath 経路）：前後の空白・`\`・制御文字を含む hostPath は、書き換えずに判定不能として拒否する。
 * child_process は記録用のスタブに差し替える（実際の kubectl は実行しない）。キューは Redis を使うため差し替える。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const { K8sManifestRejectedError, POD_SPEC_LOCATIONS } = await import('../services/k8s-manifest-guard');

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

const pod = (spec: string) => `apiVersion: v1
kind: Pod
metadata:
  name: attacker
spec:
${spec}`;

/** 受付で 200（キュー投入）、Worker 側で kubectl apply を起動すること */
async function expectAccepted(manifest: string) {
  const r = await app.inject({ method: 'POST', url: '/api/k8s/apply', payload: { manifest, namespace: 'demo' } });
  expect(r.statusCode, `${manifest}\n${r.body}`).toBe(200);
  expect(queue.addK8sDeployTask).toHaveBeenCalledWith({ manifest, namespace: 'demo' });
  await realService().applyManifest(manifest, 'demo');
  expect(cp.calls.execFile[0]?.args.slice(0, 2)).toEqual(['apply', '-f']);
}

const DANGER_SPEC = `hostNetwork: true
hostPID: "yes"
hostIPC: "on"
privileged: "true"
securityContext:
  privileged: true
  capabilities:
    add: [SYS_ADMIN]
hostPath:
  path: /var/run/docker.sock`;
const indent = (s: string, n: number) => s.split('\n').map((l) => ' '.repeat(n) + l).join('\n');

describe('直し回7 必須2：データ領域の危険名キーは検査しない（誤検出の回帰を直す）', () => {
  it('ConfigMap の data に hostNetwork: "on" があっても通る（再レビューの再現例）', async () => {
    await expectAccepted('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ordinary\ndata:\n  hostNetwork: "on"\n');
  });

  it('ConfigMap の data・Secret の stringData に危険名のキーと真相当の値（true/yes/on/y、ソケットのパス）があっても通る', async () => {
    await expectAccepted(`apiVersion: v1
kind: ConfigMap
metadata:
  name: flags
data:
  hostNetwork: "true"
  hostPID: "yes"
  hostIPC: "y"
  privileged: "on"
  hostPath: /var/run/docker.sock
  securityContext: "privileged: true"
---
apiVersion: v1
kind: Secret
metadata:
  name: s
stringData:
  hostNetwork: "true"
  privileged: "yes"
`);
  });

  it('PodSpec の外（metadata の annotations・labels、env の値、CRD の任意の設定）にある同名キーは検査しない', async () => {
    await expectAccepted(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  annotations:
    hostNetwork: "true"
spec:
  selector: { matchLabels: { app: web } }
  template:
    metadata:
      labels: { app: web, hostPID: "yes" }
      annotations:
        privileged: "true"
    spec:
      containers:
        - name: web
          image: nginx
          env:
            - name: hostNetwork
              value: "true"
            - name: SOCK
              value: /var/run/docker.sock
---
apiVersion: example.dojo/v1
kind: Widget
metadata:
  name: w
spec:
  config:
${indent(DANGER_SPEC, 4)}
`);
  });

  it('対象の種類と PodSpec の位置の一覧（報告書に列挙したもの）', () => {
    expect(POD_SPEC_LOCATIONS).toEqual({
      Pod: ['spec'],
      Deployment: ['spec', 'template', 'spec'],
      StatefulSet: ['spec', 'template', 'spec'],
      DaemonSet: ['spec', 'template', 'spec'],
      ReplicaSet: ['spec', 'template', 'spec'],
      Job: ['spec', 'template', 'spec'],
      ReplicationController: ['spec', 'template', 'spec'],
      PodTemplate: ['template', 'spec'],
      CronJob: ['spec', 'jobTemplate', 'spec', 'template', 'spec'],
    });
  });
});

const podSpec = (extra: string, containerExtra = '', list = 'containers') => `${list === 'containers' ? '' : `containers:\n  - name: main\n    image: nginx\n`}${list}:
  - name: c
    image: docker:cli
${containerExtra ? indent(containerExtra, 4) + '\n' : ''}${extra}`;

const workload = (kind: string, spec: string) => {
  const loc = POD_SPEC_LOCATIONS[kind];
  const api = kind === 'Pod' || kind === 'ReplicationController' || kind === 'PodTemplate' ? 'v1' : kind === 'Job' || kind === 'CronJob' ? 'batch/v1' : 'apps/v1';
  // 位置のキーを順に入れ子にする（最後が PodSpec）
  let body = spec;
  for (let i = loc.length - 1; i >= 0; i--) body = `${loc[i]}:\n${indent(body, 2)}`;
  return `apiVersion: ${api}\nkind: ${kind}\nmetadata:\n  name: attacker\n${body}\n`;
};

describe('直し回7 必須2：Pod テンプレート内の危険な指定は、構造上の位置で引き続き拒否する', () => {
  const kinds = Object.keys(POD_SPEC_LOCATIONS);

  for (const kind of kinds) {
    it(`${kind}（${POD_SPEC_LOCATIONS[kind].join('.')}）：hostPath ソケット・privileged・host 系・許可外 capabilities をすべて拒否し、位置を報告する`, async () => {
      const spec = podSpec(
        'hostNetwork: true\nhostPID: "yes"\nhostIPC: "On"\nvolumes:\n  - name: sock\n    hostPath:\n      path: /var/run/docker.sock\n',
        'securityContext:\n  privileged: "y"\n  capabilities:\n    add: [SYS_ADMIN]',
      );
      const m = workload(kind, spec);
      await expectRejected(m, /hostPath\.path: \/var\/run\/docker\.sock は Docker ソケット/);
      const at = POD_SPEC_LOCATIONS[kind].join('.');
      const r = await app.inject({ method: 'POST', url: '/api/k8s/apply', payload: { manifest: m } });
      expect((r.json().violations as { path: string }[]).map((v) => v.path).sort()).toEqual(
        [
          `${at}.hostNetwork`,
          `${at}.hostPID`,
          `${at}.hostIPC`,
          `${at}.volumes[0].hostPath.path`,
          `${at}.containers[0].securityContext.privileged`,
          `${at}.containers[0].securityContext.capabilities.add`,
        ].sort(),
      );
    });
  }

  it('initContainers・ephemeralContainers の privileged も拒否する', async () => {
    await expectRejected(workload('Deployment', podSpec('', 'securityContext:\n  privileged: true', 'initContainers')), /initContainers\[0\]\.securityContext\.privileged/);
    await expectRejected(workload('Pod', podSpec('', 'securityContext:\n  privileged: true', 'ephemeralContainers')), /ephemeralContainers\[0\]\.securityContext\.privileged/);
  });

  it('List の items の中の Pod テンプレート、PersistentVolume の spec.hostPath、Pod テンプレートを持つ CRD も拒否する', async () => {
    await expectRejected(
      `apiVersion: v1\nkind: List\nmetadata:\n  name: l\nitems:\n  - apiVersion: v1\n    kind: ConfigMap\n    metadata: { name: ok }\n    data: { hostNetwork: "true" }\n  - ${indent(workload('DaemonSet', podSpec('hostPID: true\n')), 4).trimStart()}`,
      /items\[1\]\.spec\.template\.spec\.hostPID/,
    );
    await expectRejected(
      'apiVersion: v1\nkind: PersistentVolume\nmetadata:\n  name: pv\nspec:\n  capacity: { storage: 1Gi }\n  accessModes: [ReadWriteOnce]\n  hostPath:\n    path: /run\n',
      /spec\.hostPath\.path/,
    );
    await expectRejected(
      `apiVersion: argoproj.io/v1alpha1\nkind: Rollout\nmetadata:\n  name: r\nspec:\n  template:\n    spec:\n${indent(podSpec('volumes:\n  - name: s\n    hostPath:\n      path: /var/run\n'), 6)}\n`,
      /spec\.template\.spec\.volumes\[0\]\.hostPath\.path/,
    );
  });
});

describe('直し回7 必須1（hostPath 経路）：前後空白・`\\`・制御文字を含む hostPath は書き換えずに判定不能として拒否する', () => {
  for (const p of ['/var/run/docker.sock ', ' /var/run/docker.sock', '/srv/innocent\\\\alias', '/run/docker.sock\\t', '/srv/ok\\u00a0']) {
    it(`hostPath ${p}`, async () => {
      await expectRejected(workload('Deployment', podSpec(`volumes:\n  - name: s\n    hostPath:\n      path: "${p}"\n`)), /判定できない/);
    });
  }

  it('実際のファイルシステム上の `<dir>/alias `（末尾空白付き、ソケットへのリンク）を拒否し、trim した別パスを調べない', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-fix7k-'));
    try {
      fs.symlinkSync('/run/docker.sock', `${dir}/alias `);
      const spy = vi.spyOn(fs, 'realpathSync');
      await expectRejected(pod(`  containers:\n    - name: c\n      image: x\n  volumes:\n    - name: s\n      hostPath:\n        path: "${dir}/alias "\n`), /前後に空白を含む/);
      expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain(`${dir}/alias`);
      spy.mockRestore();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('途中に空白を含む通常の hostPath（ソケットと無関係）は通る', async () => {
    await expectAccepted(workload('Deployment', podSpec('volumes:\n  - name: logs\n    hostPath:\n      path: "/var/log/my app"\n')));
  });
});
