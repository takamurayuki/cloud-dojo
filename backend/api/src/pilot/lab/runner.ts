/**
 * N5 ラボランナー（dockerode）。
 *
 * 安全境界：
 * - 操作対象はラベル cloud-dojo.lab=n5-tcp が付いたコンテナ／ネットワークだけ。対象はラベルで検索し、
 *   リクエストから受け取った ID や固定名で実行・削除しない（旧 routes/network.ts の方式は使わない）。
 * - ネットワークは Internal（外部への疎通なし）。実行するコマンドはこのファイル内の固定スクリプトのみ。
 * - exec の出力量と時間に上限を設ける。
 * - Docker が無い環境では LabUnavailableError（code=DOCKER_NOT_FOUND）を投げる。呼び出し側は明示エラーで返す。
 */
import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { EvidenceKind } from '../curriculum/schema';

export const LAB_ID = 'n5-tcp';
export const LABEL_LAB = 'cloud-dojo.lab';
export const LABEL_ROLE = 'cloud-dojo.role';
export const LAB_IMAGE = 'cloud-dojo-lab/n5-tcp:0.1';
const LAB_CONTEXT = fileURLToPath(new URL('../../../labs/n5-tcp', import.meta.url));
const NETWORK_NAME = 'cloud-dojo-lab-n5-tcp';
const ROLES = ['client', 'server'] as const;
type Role = (typeof ROLES)[number];

const EXEC_TIMEOUT_MS = 30_000;
const EXEC_MAX_BYTES = 256 * 1024;

export class LabUnavailableError extends Error {
  readonly code = 'DOCKER_NOT_FOUND';
  constructor(detail: string) {
    super(`Docker が見つかりません（Docker Engine に接続できない）: ${detail}`);
    this.name = 'LabUnavailableError';
  }
}

export interface LabNode {
  role: string;
  containerId: string;
  state: string;
}

export interface LabStatus {
  docker: 'available';
  running: boolean;
  nodes: LabNode[];
  network: { name: string; internal: boolean } | null;
}

export interface LabRunner {
  status(): Promise<LabStatus>;
  start(): Promise<LabStatus & { elapsedMs: number }>;
  reset(): Promise<{ removedContainers: number; removedNetworks: number; elapsedMs: number }>;
  /** 条件を適用して接続試行を行い、証拠テキスト（実測）を返す */
  collect(condition: { portState: string; connectTimeout: string }): Promise<Record<EvidenceKind, string>>;
}

/** client-run.sh の区切り付き出力を証拠の種類ごとに分ける */
export function splitSections(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current: string | null = null;
  for (const line of output.split('\n')) {
    const m = /^=====(\S+)$/.exec(line);
    if (m) {
      current = m[1];
      out[current] = '';
      continue;
    }
    if (current) out[current] += `${line}\n`;
  }
  return out;
}

const SERVER_APPLY: Record<string, string> = {
  open: 'nohup python3 /lab/server.py >/tmp/server.log 2>&1 & sleep 0.5',
  closed: 'true',
  drop: 'nohup python3 /lab/server.py >/tmp/server.log 2>&1 & sleep 0.5; iptables -A INPUT -p tcp --dport 8080 -j DROP',
};

export class DockerLabRunner implements LabRunner {
  private docker: Docker;

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
  }

  private async ensureDocker() {
    try {
      await this.docker.ping();
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      throw new LabUnavailableError(err.code ?? err.message);
    }
  }

  private async labContainers() {
    return this.docker.listContainers({ all: true, filters: { label: [`${LABEL_LAB}=${LAB_ID}`] } });
  }

  private async labNetworks() {
    return this.docker.listNetworks({ filters: { label: [`${LABEL_LAB}=${LAB_ID}`] } });
  }

  private async node(role: Role) {
    const list = await this.docker.listContainers({ filters: { label: [`${LABEL_LAB}=${LAB_ID}`, `${LABEL_ROLE}=${role}`] } });
    if (list.length !== 1) throw new Error(`ラボの ${role} ノードが起動していない（該当 ${list.length} 件）`);
    return this.docker.getContainer(list[0].Id);
  }

  async status(): Promise<LabStatus> {
    await this.ensureDocker();
    const containers = await this.labContainers();
    const networks = await this.labNetworks();
    const nodes = containers.map((c) => ({ role: c.Labels[LABEL_ROLE] ?? '?', containerId: c.Id.slice(0, 12), state: c.State }));
    return {
      docker: 'available',
      running: ROLES.every((r) => nodes.some((n) => n.role === r && n.state === 'running')),
      nodes,
      network: networks[0] ? { name: networks[0].Name, internal: Boolean(networks[0].Internal) } : null,
    };
  }

  private async ensureImage() {
    try {
      await this.docker.getImage(LAB_IMAGE).inspect();
      return;
    } catch {
      // 未ビルドならリポジトリ内の Dockerfile からビルドする（ビルド時のみ外部取得が発生する）
    }
    const stream = await this.docker.buildImage(
      { context: LAB_CONTEXT, src: ['Dockerfile', 'server.py', 'client-run.sh'] },
      { t: LAB_IMAGE, labels: { [LABEL_LAB]: LAB_ID } },
    );
    await new Promise((resolve, reject) => this.docker.modem.followProgress(stream, (err, res) => (err ? reject(err) : resolve(res))));
  }

  async start() {
    const t0 = Date.now();
    await this.ensureDocker();
    await this.ensureImage();
    let net = (await this.labNetworks())[0];
    if (!net) {
      await this.docker.createNetwork({ Name: NETWORK_NAME, Driver: 'bridge', Internal: true, Labels: { [LABEL_LAB]: LAB_ID } });
      net = (await this.labNetworks())[0];
    }
    const existing = await this.labContainers();
    for (const role of ROLES) {
      const found = existing.find((c) => c.Labels[LABEL_ROLE] === role);
      if (found) {
        if (found.State !== 'running') await this.docker.getContainer(found.Id).start();
        continue;
      }
      const c = await this.docker.createContainer({
        Image: LAB_IMAGE,
        Cmd: ['sleep', 'infinity'],
        Hostname: role,
        Labels: { [LABEL_LAB]: LAB_ID, [LABEL_ROLE]: role },
        HostConfig: {
          NetworkMode: net.Name,
          CapAdd: ['NET_ADMIN', 'NET_RAW'],
          Memory: 128 * 1024 * 1024,
          PidsLimit: 128,
        },
        NetworkingConfig: { EndpointsConfig: { [net.Name]: { Aliases: [role] } } },
      });
      await c.start();
    }
    return { ...(await this.status()), elapsedMs: Date.now() - t0 };
  }

  async reset() {
    const t0 = Date.now();
    await this.ensureDocker();
    const containers = await this.labContainers();
    for (const c of containers) await this.docker.getContainer(c.Id).remove({ force: true });
    const networks = await this.labNetworks();
    for (const n of networks) await this.docker.getNetwork(n.Id).remove();
    return { removedContainers: containers.length, removedNetworks: networks.length, elapsedMs: Date.now() - t0 };
  }

  private async exec(container: Docker.Container, cmd: string[]): Promise<{ exitCode: number; output: string }> {
    const ex = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
    const stream = await ex.start({ hijack: true, stdin: false });
    const sink = new PassThrough();
    let output = '';
    sink.on('data', (chunk: Buffer) => {
      if (output.length < EXEC_MAX_BYTES) output += chunk.toString('utf8');
    });
    this.docker.modem.demuxStream(stream, sink, sink);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stream.destroy();
        reject(new Error(`ラボ内コマンドが ${EXEC_TIMEOUT_MS}ms を超えた`));
      }, EXEC_TIMEOUT_MS);
      stream.on('end', () => {
        clearTimeout(timer);
        resolve();
      });
      stream.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    const info = await ex.inspect();
    return { exitCode: info.ExitCode ?? -1, output: output.slice(0, EXEC_MAX_BYTES) };
  }

  async collect(condition: { portState: string; connectTimeout: string }): Promise<Record<EvidenceKind, string>> {
    const apply = SERVER_APPLY[condition.portState];
    if (!apply) throw new Error(`未知の portState: ${condition.portState}`);
    if (!/^\d+$/.test(condition.connectTimeout)) throw new Error(`不正な connectTimeout: ${condition.connectTimeout}`);

    // 前の試行の TIME_WAIT 等が残らないよう、試行ごとにラボを作り直す
    await this.reset();
    await this.start();
    const server = await this.node('server');
    const client = await this.node('client');

    const applied = await this.exec(server, ['sh', '-c', apply]);
    if (applied.exitCode !== 0) throw new Error(`server への条件適用に失敗: ${applied.output}`);

    const run = await this.exec(client, ['/lab/client-run.sh', condition.connectTimeout]);
    const sections = splitSections(run.output);
    const ssServer = await this.exec(server, ['ss', '-tan']);

    for (const k of ['tcpdump', 'ss-client', 'curl']) {
      if (sections[k] === undefined) throw new Error(`client の証拠出力に ${k} が無い: ${run.output.slice(0, 500)}`);
    }
    return { tcpdump: sections.tcpdump, 'ss-client': sections['ss-client'], 'ss-server': ssServer.output, curl: sections.curl };
  }
}
