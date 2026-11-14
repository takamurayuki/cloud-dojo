/**
 * 直し回6 必須3：Kubernetes の apply で、ノードを操作できる設定（Docker ソケット等の hostPath、privileged、
 * hostNetwork／hostPID／hostIPC、許可外の capabilities）を含むマニフェストを拒否する。
 * 受付（POST /api/k8s/apply）は 400 `K8S_MANIFEST_REJECTED` でキューに入れず、Worker 側（applyManifest）も kubectl を起動せずに失敗する。
 * child_process は記録用のスタブに差し替える（実際の kubectl は実行しない）。キューは Redis を使うため差し替える。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => {
  const calls = { execFile: [] as { file: string; args: string[] }[] };
  /** 直し回13：apply 後の `kubectl get <Kind> <name> -o json` には、どの判定対象種別でも準備完了になる状態を返す */
  const readyObject = (kind: string) =>
    JSON.stringify({
      kind,
      metadata: { name: 'x' },
      spec: { replicas: 1, clusterIP: '10.96.0.1' },
      status: {
        updatedReplicas: 1,
        availableReplicas: 1,
        readyReplicas: 1,
        desiredNumberScheduled: 1,
        updatedNumberScheduled: 1,
        numberAvailable: 1,
        phase: kind === 'PersistentVolumeClaim' ? 'Bound' : kind === 'Namespace' ? 'Active' : 'Running',
        conditions: [
          { type: 'Ready', status: 'True' },
          { type: 'Complete', status: 'True' },
        ],
      },
    });
  const execFile = (file: string, args: string[], _opts: unknown, cb: (e: unknown, o: string, s: string) => void) => {
    calls.execFile.push({ file, args });
    cb(null, args[0] === 'get' ? readyObject(args[1]) : 'ok\n', '');
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
const { K8sManifestRejectedError } = await import('../services/k8s-manifest-guard');

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
const container = (extra = '') => `  containers:
    - name: c
      image: docker:cli
${extra}`;
const deployment = (podSpec: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
${podSpec
  .split('\n')
  .map((l) => (l ? `    ${l}` : l))
  .join('\n')}`;

const SOCKET_VOLUME = `  volumes:
    - name: sock
      hostPath:
        path: /var/run/docker.sock
`;

describe('直し回6 必須3：危険なマニフェストを apply で拒否する（受付・Worker の両方）', () => {
  const cases: [string, string, RegExp][] = [
    ['Pod：hostPath が /var/run/docker.sock（再レビューの再現例）', pod(container() + SOCKET_VOLUME), /hostPath\.path: .*Docker ソケット/],
    ['Pod：hostPath が /run/docker.sock', pod(container() + '  volumes:\n    - name: s\n      hostPath: { path: /run/docker.sock, type: Socket }\n'), /Docker ソケット/],
    ['Pod：hostPath がソケットの親（/var/run）', pod(container() + '  volumes:\n    - name: s\n      hostPath:\n        path: /var/run\n'), /含むディレクトリ/],
    ['Pod：hostPath が /', pod(container() + '  volumes:\n    - name: s\n      hostPath:\n        path: /\n'), /含むディレクトリ/],
    ['Pod：hostPath が ..・重複スラッシュを含む別名', pod(container() + '  volumes:\n    - name: s\n      hostPath:\n        path: /var//lib/../run/docker.sock\n'), /Docker ソケット/],
    ['Pod：hostPath に `\\` を含む', pod(container() + "  volumes:\n    - name: s\n      hostPath:\n        path: '/srv/innocent\\alias'\n"), /判定できない/],
    ['Pod：privileged: true', pod(container('      securityContext:\n        privileged: true\n')), /securityContext\.privileged/],
    ['Pod：initContainers の privileged', pod(container() + '  initContainers:\n    - name: i\n      image: busybox\n      securityContext: { privileged: true }\n'), /initContainers\[0\]\.securityContext\.privileged/],
    ['Pod：hostNetwork: true', pod('  hostNetwork: true\n' + container()), /hostNetwork: true/],
    ['Pod：hostPID: true', pod('  hostPID: true\n' + container()), /hostPID: true/],
    ['Pod：hostIPC: true', pod('  hostIPC: true\n' + container()), /hostIPC: true/],
    ['Pod：hostPID: yes（kubectl の YAML 1.1 では真）', pod('  hostPID: yes\n' + container()), /hostPID: true/],
    ['Pod：capabilities.add SYS_ADMIN', pod(container('      securityContext:\n        capabilities:\n          add: ["SYS_ADMIN"]\n')), /SYS_ADMIN は許可していない権限/],
    ['Pod：capabilities.add ALL', pod(container('      securityContext:\n        capabilities:\n          add: [ALL]\n')), /ALL は許可していない権限/],
    ['Pod：capabilities.add CAP_SYS_MODULE（接頭辞・混在）', pod(container('      securityContext:\n        capabilities:\n          add: [NET_ADMIN, CAP_SYS_MODULE]\n')), /CAP_SYS_MODULE/],
    ['Deployment の Pod テンプレート：hostPath ソケット', deployment(container() + SOCKET_VOLUME), /spec\.template\.spec\.volumes\[0\]\.hostPath\.path/],
    ['Deployment の Pod テンプレート：privileged', deployment(container('      securityContext:\n        privileged: true\n')), /spec\.template\.spec\.containers\[0\]\.securityContext\.privileged/],
    ['Deployment の Pod テンプレート：hostNetwork', deployment('  hostNetwork: true\n' + container()), /spec\.template\.spec\.hostNetwork/],
    [
      'DaemonSet の Pod テンプレート：hostPID',
      deployment('  hostPID: true\n' + container()).replace('kind: Deployment', 'kind: DaemonSet').replace('  replicas: 1\n', ''),
      /hostPID/,
    ],
    [
      'CronJob の jobTemplate：hostPath ソケット',
      `apiVersion: batch/v1
kind: CronJob
metadata:
  name: cj
spec:
  schedule: "* * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: c
              image: docker:cli
          volumes:
            - name: s
              hostPath:
                path: /var/run/docker.sock
`,
      /spec\.jobTemplate\.spec\.template\.spec\.volumes\[0\]\.hostPath\.path/,
    ],
    [
      'PersistentVolume の hostPath（PVC 経由でソケットを渡す）',
      'apiVersion: v1\nkind: PersistentVolume\nmetadata:\n  name: pv\nspec:\n  capacity: { storage: 1Gi }\n  accessModes: [ReadWriteOnce]\n  hostPath:\n    path: /var/run\n',
      /spec\.hostPath\.path/,
    ],
    [
      '複数ドキュメントの2つ目だけが危険でも、全体を適用しない',
      `apiVersion: v1\nkind: Service\nmetadata:\n  name: ok\nspec:\n  ports: [{ port: 80 }]\n---\n${pod(container() + SOCKET_VOLUME)}`,
      /manifest\[1\]/,
    ],
    ['JSON 形式のマニフェスト', JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'j' }, spec: { hostNetwork: true, containers: [{ name: 'c', image: 'x' }] } }), /hostNetwork/],
  ];
  for (const [title, manifest, pattern] of cases) {
    it(title, async () => {
      await expectRejected(manifest, pattern);
    });
  }

  it('複数の違反はまとめて理由（violations）に出す', async () => {
    const m = pod('  hostPID: true\n' + container('      securityContext:\n        privileged: true\n') + SOCKET_VOLUME);
    const r = await app.inject({ method: 'POST', url: '/api/k8s/apply', payload: { manifest: m } });
    expect(r.statusCode).toBe(400);
    expect(r.json().violations.map((v: { path: string }) => v.path).sort()).toEqual(
      ['spec.containers[0].securityContext.privileged', 'spec.hostPID', 'spec.volumes[0].hostPath.path'].sort(),
    );
  });
});

describe('直し回6 必須3：通常のマニフェストは従来どおり通る', () => {
  const NORMAL = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels: { app: web }
spec:
  replicas: 3
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      hostNetwork: false
      securityContext:
        runAsNonRoot: true
        fsGroup: 2000
      containers:
        - name: nginx
          image: nginx:1.27
          ports:
            - containerPort: 80
          env:
            - name: DOCKER_SOCK_HINT
              value: /var/run/docker.sock
          resources:
            limits: { cpu: 500m, memory: 128Mi }
          securityContext:
            privileged: false
            allowPrivilegeEscalation: false
            capabilities:
              add: [NET_ADMIN, NET_BIND_SERVICE]
              drop: [ALL]
          volumeMounts:
            - name: cache
              mountPath: /cache
            - name: conf
              mountPath: /etc/nginx/conf.d
            - name: logs
              mountPath: /var/log/nginx
      volumes:
        - name: cache
          emptyDir: {}
        - name: conf
          configMap:
            name: web-conf
        - name: logs
          hostPath:
            path: /var/log/web
            type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
spec:
  selector: { app: web }
  ports:
    - port: 80
      targetPort: 80
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-conf
data:
  default.conf: |
    server { listen 80; }
`;

  it('受付は 200（キューに入る）、Worker 側は kubectl apply を起動する', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/k8s/apply', payload: { manifest: NORMAL, namespace: 'demo' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('queued');
    expect(queue.addK8sDeployTask).toHaveBeenCalledWith({ manifest: NORMAL, namespace: 'demo' });

    const session = await realService().applyManifest(NORMAL, 'demo');
    expect(session.resources.map((x) => `${x.kind}/${x.name}`)).toEqual(['Deployment/web', 'Service/web-svc', 'ConfigMap/web-conf']);
    expect(cp.calls.execFile[0].args.slice(0, 2)).toEqual(['apply', '-f']);
  });

  it('既存のテンプレート的な Pod（hostPath・securityContext 無し）も通る', async () => {
    const m = pod(container('      ports:\n        - containerPort: 8080\n'));
    const r = await app.inject({ method: 'POST', url: '/api/k8s/apply', payload: { manifest: m } });
    expect(r.statusCode).toBe(200);
  });
});
