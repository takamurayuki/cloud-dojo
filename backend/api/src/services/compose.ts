import Docker from 'dockerode';
import { EventEmitter } from 'events';
import { assertContainerOperable, isNotFound, isPilotLabLabels, PilotLabProtectedError, type MountLike } from '../pilot/lab/protect';
import { ComposeDefinitionRejectedError, inspectBinds, inspectComposeDefinition, type ComposeViolation } from './compose-guard';

const docker = new Docker();

/**
 * 直し回4補足2：compose up が作るネットワークに付けるラベル。既存の同名ネットワークは、これ（または Docker Compose 自身の
 * 同じプロジェクト・ネットワークのラベル）を持つことを確かめてから接続する。確かめられなければ接続しない。
 */
export const COMPOSE_NETWORK_LABEL = 'cloud-dojo';
export const COMPOSE_NETWORK_LABEL_VALUE = 'compose';
export const COMPOSE_PROJECT_LABEL = 'cloud-dojo.compose.project';
export const COMPOSE_NETWORK_NAME_LABEL = 'cloud-dojo.compose.network';

/** 既存の同名ネットワークが compose 用と確かめられない。何も作成・接続せずに compose up を中止する */
export class ComposeNetworkUnverifiedError extends Error {
  readonly code = 'COMPOSE_NETWORK_UNVERIFIED';
  constructor(
    readonly networkName: string,
    reason: string,
  ) {
    super(
      `既存のネットワーク ${networkName} は compose 用と確かめられないため、接続しません（${reason}）。` +
        `このプロジェクトのものなら、docker network rm ${networkName} で削除してからやり直してください`,
    );
    this.name = 'ComposeNetworkUnverifiedError';
  }
}

/**
 * `<project>_<network>` の既存ネットワークを inspect し、接続してよいか確かめる（/lab/create の resolveReusableLabNetwork と同じ方針）。
 * - 無い（404）：null（呼び出し側で作成する）
 * - パイロットのラボ（ラベル cloud-dojo.lab）：PilotLabProtectedError
 * - 名前が完全には一致しない（ID の接頭辞で別のネットワークに解決された等）：ComposeNetworkUnverifiedError
 * - ラベル cloud-dojo が compose 以外（network-lab 等、別用途のラボ）：ComposeNetworkUnverifiedError
 * - 次のどちらかのラベルの組で、同じプロジェクト・ネットワーク名と確かめられたものだけ接続してよい
 *   - この API が作成時に付けるもの：cloud-dojo=compose、cloud-dojo.compose.project、cloud-dojo.compose.network
 *   - Docker Compose（docker compose up）が付けるもの：com.docker.compose.project、com.docker.compose.network
 * - それ以外（ラベルの無いもの、以前の版のこの API が作ったものを含む）：ComposeNetworkUnverifiedError
 */
export async function resolveComposeNetwork(projectName: string, networkName: string): Promise<{ id: string } | null> {
  const fullName = `${projectName}_${networkName}`;
  let info: { Id: string; Name?: string; Labels?: Record<string, string> | null };
  try {
    info = (await docker.getNetwork(fullName).inspect()) as typeof info;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const labels = info.Labels ?? {};
  if (isPilotLabLabels(labels)) throw new PilotLabProtectedError(info.Id);
  if (info.Name !== fullName) throw new ComposeNetworkUnverifiedError(fullName, `名前が一致しない（${info.Name ?? '不明'}）`);
  const purpose = labels[COMPOSE_NETWORK_LABEL];
  if (purpose !== undefined && purpose !== COMPOSE_NETWORK_LABEL_VALUE) {
    throw new ComposeNetworkUnverifiedError(fullName, `別用途のラベル（${COMPOSE_NETWORK_LABEL}=${purpose}）を持つ`);
  }
  const ours =
    purpose === COMPOSE_NETWORK_LABEL_VALUE &&
    labels[COMPOSE_PROJECT_LABEL] === projectName &&
    labels[COMPOSE_NETWORK_NAME_LABEL] === networkName;
  const dockerCompose = labels['com.docker.compose.project'] === projectName && labels['com.docker.compose.network'] === networkName;
  if (!ours && !dockerCompose) {
    throw new ComposeNetworkUnverifiedError(fullName, 'このプロジェクトの compose ネットワークのラベルが無い');
  }
  return { id: info.Id };
}

export interface ComposeService {
  name: string;
  image?: string;
  build?: {
    context: string;
    dockerfile?: string;
  };
  ports?: string[];
  environment?: Record<string, string>;
  depends_on?: string[];
  volumes?: string[];
  networks?: string[];
  command?: string | string[];
}

export interface ComposeConfig {
  version: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, any>;
  volumes?: Record<string, any>;
}

export interface ComposeSession {
  id: string;
  projectName: string;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
  services: Record<string, {
    containerId?: string;
    status: 'pending' | 'building' | 'starting' | 'running' | 'stopped' | 'error';
    error?: string;
  }>;
  startTime: Date;
  error?: string;
  /** パイロットのラボ（ラベル cloud-dojo.lab）のため停止・削除を拒否したサービス名。1つでもあればジョブは失敗にする */
  protectedRejections?: string[];
  /** 既存の同名ネットワークを compose 用と確かめられず、接続しなかった理由。あればジョブは失敗にする（直し回4補足2） */
  networkRejection?: string;
  /** compose 定義がホストを操作できる設定を含むため、作成を開始せずに拒否した理由。あればジョブは失敗にする（直し回5） */
  definitionRejection?: string;
  /**
   * ネットワークの準備の途中で失敗したときの後始末の結果（直し回5 推奨B）。この回に作成したネットワークだけを、
   * 作成時の ID で削除する。削除できなかったもの（remaining）があればジョブは失敗にし、残存を明示する
   */
  networkRollback?: { removed: { name: string; id: string }[]; remaining: { name: string; id: string; error: string }[] };
  /**
   * コンテナを1つも作成しないうちに compose up 全体を中止した理由（直し回6 推奨A）。ネットワークの inspect の通信エラー等で
   * 確認済みの ID を得られなかった場合など。あればジョブは失敗にする（以前は session.error に残すだけで success:true を返していた）
   */
  setupFailure?: string;
}

/**
 * サービスの volumes（この API のパーサの結果）から、HostConfig.Binds に入れるものと、作成を確かめる名前付きボリュームを求める。
 * 作成前の検査（inspectBinds）と実際のコンテナ設定の両方でこれを使い、検査したものと Docker に渡すものを一致させる。
 */
export function planVolumes(projectName: string, volumes: string[] | undefined): { binds: string[]; namedVolumes: string[] } {
  const binds: string[] = [];
  const namedVolumes: string[] = [];
  for (const volStr of volumes ?? []) {
    const [host, container] = volStr.split(':');
    if (host && container) {
      // Check if it's a named volume
      if (!host.startsWith('/') && !host.startsWith('.')) {
        namedVolumes.push(`${projectName}_${host}`);
        binds.push(`${projectName}_${host}:${container}`);
      } else {
        binds.push(volStr);
      }
    }
  }
  return { binds, namedVolumes };
}

/**
 * 作成前の検査（直し回5 必須）：YAML として解析した定義と、この API のパーサが Docker に渡す bind mount の両方を調べる。
 * ホストを操作できる設定があれば ComposeDefinitionRejectedError を投げる。
 */
export function assertComposeDefinitionSafe(composeYaml: string, config: ComposeConfig, projectName: string): void {
  const violations: ComposeViolation[] = inspectComposeDefinition(composeYaml);
  for (const [name, service] of Object.entries(config.services)) {
    for (const v of inspectBinds(name, planVolumes(projectName, service.volumes).binds)) {
      if (!violations.some((x) => x.service === v.service && x.field === v.field && x.detail === v.detail)) violations.push(v);
    }
  }
  if (violations.length > 0) throw new ComposeDefinitionRejectedError(violations);
}

/** compose-up ジョブの入力（queue.ts の ComposeUpTask と同じ形） */
export interface ComposeUpJobData {
  composeYaml: string;
  projectName?: string;
}

/**
 * compose-up ジョブの本体（workers.ts の Worker から呼ぶ。キューを使わずに試験できるよう分けてある）。
 * 同名の既存コンテナがパイロットのラボだったために停止・削除を拒否したサービスがあれば、ジョブを失敗させる
 * （以前はサービスごとのエラーとして記録するだけで success:true を返していた）。
 * それ以外のサービスのエラーの扱い（ジョブは成功のまま、session に記録）は従来どおり。
 */
export async function runComposeUpJob(
  service: Pick<DockerComposeService, 'composeUp'>,
  data: ComposeUpJobData,
  updateProgress: (p: number) => Promise<void> | void = () => undefined,
) {
  const { composeYaml, projectName } = data;
  try {
    await updateProgress(10);
    const session = await service.composeUp(composeYaml, projectName);
    if (session.definitionRejection) throw new Error(session.definitionRejection);
    if (session.networkRejection) throw new Error(session.networkRejection);
    const remaining = session.networkRollback?.remaining ?? [];
    if (remaining.length > 0) {
      throw new Error(
        `ネットワークの準備の途中で失敗し、この回に作成したネットワークを削除できませんでした（残存：${remaining
          .map((r) => `${r.name} ${r.id}: ${r.error}`)
          .join('; ')}）。元の失敗：${session.error ?? '不明'}`,
      );
    }
    if (session.setupFailure) throw new Error(session.setupFailure);
    if (session.protectedRejections && session.protectedRejections.length > 0) {
      const detail = session.protectedRejections.map((name) => `${name}: ${session.services[name]?.error ?? ''}`).join('; ');
      throw new Error(
        `パイロットのラボ（または Docker ソケットをマウントしたコンテナ）を保護するため、次のサービスの既存コンテナを停止・削除せずに中止しました（${detail}）`,
      );
    }
    await updateProgress(100);
    return {
      success: true,
      projectName,
      sessionId: session.id,
      message: 'Compose project started successfully',
    };
  } catch (error) {
    throw new Error(`Compose up failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function describeRollback(r: NonNullable<ComposeSession['networkRollback']>): string {
  const parts: string[] = [];
  if (r.removed.length > 0) parts.push(`この回に作成したネットワーク ${r.removed.map((n) => n.name).join(', ')} は削除しました`);
  if (r.remaining.length > 0) {
    parts.push(
      `この回に作成したネットワーク ${r.remaining.map((n) => `${n.name}（${n.id}）`).join(', ')} は削除できず残っています` +
        `（docker network rm ${r.remaining.map((n) => n.id).join(' ')} で削除してください）`,
    );
  }
  return parts.join('。');
}

export class DockerComposeService extends EventEmitter {
  private sessions: Map<string, ComposeSession> = new Map();

  parseComposeYAML(yaml: string): ComposeConfig {
    const lines = yaml.split('\n');
    const config: ComposeConfig = { version: '3.8', services: {} };
    let currentService: string | null = null;
    let currentSection: 'services' | 'networks' | 'volumes' | null = null;
    let serviceIndentLevel = -1;
    let currentSubSection: string | null = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const indent = line.search(/\S/);

      // Version
      if (trimmed.startsWith('version:')) {
        config.version = trimmed.split(':')[1].trim().replace(/['"]/g, '');
        continue;
      }

      // Top level sections
      if (trimmed === 'services:' && indent === 0) {
        currentSection = 'services';
        serviceIndentLevel = -1; // Will be set when first service is found
        continue;
      }
      if (trimmed === 'networks:' && indent === 0) {
        currentSection = 'networks';
        currentService = null;
        config.networks = {};
        continue;
      }
      if (trimmed === 'volumes:' && indent === 0) {
        currentSection = 'volumes';
        currentService = null;
        config.volumes = {};
        continue;
      }

      if (currentSection === 'services') {
        // Service name - any line ending with : at the first level under services
        if (trimmed.endsWith(':') && !trimmed.includes(' ') && trimmed !== 'services:') {
          // Check if this is a service name (not a subsection like 'build:', 'ports:', etc.)
          const potentialServiceName = trimmed.slice(0, -1);
          const knownSubSections = ['build', 'environment', 'ports', 'depends_on', 'volumes', 'networks', 'healthcheck', 'labels', 'restart', 'command'];
          
          if (!knownSubSections.includes(potentialServiceName)) {
            // This is a new service
            if (serviceIndentLevel === -1) {
              serviceIndentLevel = indent;
            }
            
            if (indent === serviceIndentLevel) {
              currentService = potentialServiceName;
              config.services[currentService] = { name: currentService };
              currentSubSection = null;
              continue;
            }
          }
        }

        if (currentService && indent > serviceIndentLevel) {
          const service = config.services[currentService];

          // Subsections
          if (trimmed === 'build:') {
            currentSubSection = 'build';
            service.build = { context: '.' };
            continue;
          }
          if (trimmed === 'environment:') {
            currentSubSection = 'environment';
            service.environment = {};
            continue;
          }
          if (trimmed === 'ports:') {
            currentSubSection = 'ports';
            service.ports = [];
            continue;
          }
          if (trimmed === 'depends_on:') {
            currentSubSection = 'depends_on';
            service.depends_on = [];
            continue;
          }
          if (trimmed === 'volumes:') {
            currentSubSection = 'volumes';
            service.volumes = [];
            continue;
          }
          if (trimmed === 'networks:') {
            currentSubSection = 'networks';
            service.networks = [];
            continue;
          }

          // Properties
          // Check for single-line properties first (these reset currentSubSection)
          if (trimmed.startsWith('image:') && !trimmed.startsWith('-')) {
            service.image = trimmed.split(':').slice(1).join(':').trim();
            currentSubSection = null;
            continue;
          }
          if (trimmed.startsWith('command:') && !trimmed.startsWith('-')) {
            const cmdValue = trimmed.substring('command:'.length).trim();
            // Parse command - it can be a string or array
            if (cmdValue.startsWith('[')) {
              // Array format: command: ["sleep", "infinity"]
              service.command = JSON.parse(cmdValue);
            } else {
              // String format: command: sleep infinity
              service.command = cmdValue.split(' ');
            }
            currentSubSection = null;
            continue;
          }
          
          // Process subsection items
          if (currentSubSection === 'build') {
            if (trimmed.startsWith('context:')) {
              service.build!.context = trimmed.split(':')[1].trim();
            } else if (trimmed.startsWith('dockerfile:')) {
              service.build!.dockerfile = trimmed.split(':')[1].trim();
            }
          } else if (currentSubSection === 'environment') {
            if (trimmed.includes(':') && !trimmed.startsWith('-')) {
              const [key, ...valueParts] = trimmed.split(':');
              service.environment![key.trim()] = valueParts.join(':').trim();
            }
          } else if (currentSubSection === 'ports') {
            if (trimmed.startsWith('-')) {
              service.ports!.push(trimmed.substring(1).trim().replace(/['"]/g, ''));
            }
          } else if (currentSubSection === 'depends_on') {
            if (trimmed.startsWith('-')) {
              service.depends_on!.push(trimmed.substring(1).trim());
            }
          } else if (currentSubSection === 'volumes') {
            if (trimmed.startsWith('-')) {
              service.volumes!.push(trimmed.substring(1).trim());
            }
          } else if (currentSubSection === 'networks') {
            if (trimmed.startsWith('-')) {
              service.networks!.push(trimmed.substring(1).trim());
            }
          }
        }
      }

      // Parse network names
      if (currentSection === 'networks') {
        if (indent === 2 && trimmed.endsWith(':')) {
          const networkName = trimmed.slice(0, -1);
          config.networks![networkName] = { driver: 'bridge' };
        } else if (trimmed.startsWith('driver:')) {
          // Network driver config
          const lastNetwork = Object.keys(config.networks || {}).pop();
          if (lastNetwork && config.networks) {
            config.networks[lastNetwork].driver = trimmed.split(':')[1].trim();
          }
        }
      }

      // Parse volume names
      if (currentSection === 'volumes') {
        if (indent === 2 && trimmed.endsWith(':')) {
          const volumeName = trimmed.slice(0, -1);
          config.volumes![volumeName] = {};
        }
      }
    }

    return config;
  }

  private parsePortMapping(portStr: string): { host: number; container: number } | null {
    const match = portStr.match(/^(\d+):(\d+)$/);
    if (match) {
      return { host: parseInt(match[1]), container: parseInt(match[2]) };
    }
    return null;
  }

  private topologicalSort(services: Record<string, ComposeService>): string[] {
    const sorted: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected: ${name}`);
      }

      visiting.add(name);

      const service = services[name];
      if (service.depends_on) {
        for (const dep of service.depends_on) {
          if (services[dep]) {
            visit(dep);
          }
        }
      }

      visiting.delete(name);
      visited.add(name);
      sorted.push(name);
    };

    for (const name of Object.keys(services)) {
      visit(name);
    }

    return sorted;
  }

  async composeUp(composeYaml: string, projectName: string = 'cloud-dojo'): Promise<ComposeSession> {
    const sessionId = `compose-${Date.now()}`;
    const config = this.parseComposeYAML(composeYaml);

    console.log('📋 Parsed services:');
    Object.entries(config.services).forEach(([name, service]) => {
      console.log(`  ${name}:`, { image: service.image, command: service.command });
    });

    const session: ComposeSession = {
      id: sessionId,
      projectName,
      status: 'starting',
      services: {},
      startTime: new Date()
    };

    // Initialize service statuses
    for (const serviceName of Object.keys(config.services)) {
      session.services[serviceName] = { status: 'pending' };
    }

    this.sessions.set(sessionId, session);

    // ホストを操作できる設定（Docker ソケットの bind mount、privileged、host 名前空間、許可外の cap_add 等）を含む定義は、
    // Docker への操作を何もしないうちに拒否する（直し回5 必須）
    try {
      assertComposeDefinitionSafe(composeYaml, config, projectName);
    } catch (error) {
      if (!(error instanceof ComposeDefinitionRejectedError)) throw error;
      console.error(`⛔ ${error.message}`);
      session.status = 'error';
      session.error = error.message;
      session.definitionRejection = error.message;
      for (const name of Object.keys(session.services)) session.services[name].status = 'error';
      this.emit('update', session);
      return session;
    }

    this.emit('update', session);

    try {
      // Sort services by dependencies
      const serviceOrder = this.topologicalSort(config.services);
      console.log('🚀 Starting services in order:', serviceOrder.join(' -> '));

      // Create network if needed
      // 既存の同名ネットワークは、compose 用のラベルを確かめてから接続する（直し回4補足2）。先に全件を確かめ、
      // 1つでも確かめられなければ、ネットワーク・コンテナを何も作成・停止・削除せずに中止する
      // 接続には確かめた（または作成した）ネットワークの ID を使う（直し回5 推奨A：確認後に同名の別ネットワークへ付け替わっても誤接続しない）。
      // この回に作成したものは ID を記録し、準備の途中で失敗したら削除する（直し回5 推奨B）
      const networkIds: Record<string, string> = {};
      if (config.networks && Object.keys(config.networks).length > 0) {
        const networkNames = Object.keys(config.networks);
        const created: { name: string; id: string }[] = [];
        try {
          const missing: string[] = [];
          for (const networkName of networkNames) {
            const found = await resolveComposeNetwork(projectName, networkName);
            if (found) networkIds[networkName] = found.id;
            else missing.push(networkName);
          }
          for (const networkName of missing) {
            const fullName = `${projectName}_${networkName}`;
            try {
              const network = await docker.createNetwork({
                Name: fullName,
                Driver: 'bridge',
                Labels: {
                  [COMPOSE_NETWORK_LABEL]: COMPOSE_NETWORK_LABEL_VALUE,
                  [COMPOSE_PROJECT_LABEL]: projectName,
                  [COMPOSE_NETWORK_NAME_LABEL]: networkName,
                },
              });
              created.push({ name: fullName, id: network.id });
              networkIds[networkName] = network.id;
            } catch (error) {
              // 確認の後に同名のネットワークが作られた場合（409）も、同じ確認を通ったものだけ使う
              if ((error as { statusCode?: number } | null)?.statusCode !== 409) throw error;
              const found = await resolveComposeNetwork(projectName, networkName);
              if (!found) throw error;
              networkIds[networkName] = found.id;
            }
          }
        } catch (error) {
          const rollback = await this.rollbackCreatedNetworks(created);
          const rollbackNote = created.length > 0 ? `。${describeRollback(rollback)}` : '';
          if (error instanceof ComposeNetworkUnverifiedError || error instanceof PilotLabProtectedError) {
            session.networkRejection = error.message + rollbackNote;
          }
          if (created.length > 0) session.networkRollback = rollback;
          if (error instanceof Error && rollbackNote) error.message += rollbackNote;
          throw error;
        }
      }

      // Start services in dependency order
      console.log(`🚀 Starting ${serviceOrder.length} services...`);
      
      for (const serviceName of serviceOrder) {
        const service = config.services[serviceName];
        session.services[serviceName].status = 'starting';
        this.emit('update', session);

        try {
          // Remove any existing container with the same name
          // （パイロットのラボ（ラベル cloud-dojo.lab）、または Docker ソケットをマウントしたコンテナ（直し回6 必須2）なら拒否する。
          // 操作は inspect で確かめた完全な ID に対して行う）
          try {
            const containerInfo = await docker.getContainer(`${projectName}_${serviceName}`).inspect();
            assertContainerOperable({
              Id: containerInfo.Id,
              Labels: containerInfo.Config?.Labels,
              Mounts: containerInfo.Mounts as MountLike[] | undefined,
            });
            const existingContainer = docker.getContainer(containerInfo.Id);
            if (containerInfo.State.Running) {
              await existingContainer.stop();
            }
            await existingContainer.remove();
          } catch (error) {
            if (error instanceof PilotLabProtectedError) throw error;
            // Container doesn't exist, which is fine
          }

          // Determine image name
          let imageName: string;
          
          if (service.image) {
            // Use specified image
            imageName = service.image;
          } else if (service.build) {
            // Use build tag or generate from project and service name
            imageName = `${projectName}_${serviceName}:latest`;
          } else {
            throw new Error(`Service ${serviceName} must specify either 'image' or 'build'`);
          }

          // Create container config
          const containerConfig: any = {
            name: `${projectName}_${serviceName}`,
            Image: imageName,
            Env: [],
            HostConfig: {
              PortBindings: {},
              Binds: [],
              NetworkMode: config.networks
                ? networkIds[Object.keys(config.networks)[0]]
                : 'bridge'
            }
          };

          // Command
          if (service.command) {
            containerConfig.Cmd = Array.isArray(service.command) 
              ? service.command 
              : service.command.split(' ');
          }

          // Environment variables
          if (service.environment) {
            containerConfig.Env = Object.entries(service.environment).map(
              ([key, value]) => `${key}=${value}`
            );
          }

          // Command
          if (service.command) {
            containerConfig.Cmd = Array.isArray(service.command) 
              ? service.command 
              : service.command.split(' ');
          }

          // Port mappings
          if (service.ports) {
            containerConfig.ExposedPorts = {};
            for (const portStr of service.ports) {
              const portMap = this.parsePortMapping(portStr);
              if (portMap) {
                const containerPort = `${portMap.container}/tcp`;
                containerConfig.ExposedPorts[containerPort] = {};
                containerConfig.HostConfig.PortBindings[containerPort] = [
                  { HostPort: portMap.host.toString() }
                ];
              }
            }
          }

          // Volumes（作成前の検査と同じ planVolumes の結果を渡す）
          if (service.volumes) {
            const { binds, namedVolumes } = planVolumes(projectName, service.volumes);
            for (const volumeName of namedVolumes) {
              // Named volume - ensure it exists
              try {
                await docker.getVolume(volumeName).inspect();
              } catch {
                await docker.createVolume({ Name: volumeName });
              }
            }
            containerConfig.HostConfig.Binds.push(...binds);
          }

          // Check if image exists
          let imageExists = false;
          try {
            await docker.getImage(imageName).inspect();
            imageExists = true;
          } catch {
            imageExists = false;
          }

          // If image doesn't exist, handle based on whether build or image is specified
          if (!imageExists) {
            if (service.build) {
              // Image needs to be built first
              const buildContext = service.build.context || '.';
              const dockerfile = service.build.dockerfile || 'Dockerfile';
              
              throw new Error(
                `Image '${imageName}' does not exist for service '${serviceName}'. ` +
                `Please build the image first using:\n` +
                `  docker build -t ${imageName} -f ${buildContext}/${dockerfile} ${buildContext}\n` +
                `Or use the Docker Build page in Cloud Dojo.`
              );
            } else if (service.image) {
              // Pull image if it doesn't exist
              session.services[serviceName].status = 'building';
              this.emit('update', session);
              
              await new Promise((resolve, reject) => {
                docker.pull(service.image!, (err: any, stream: any) => {
                  if (err) return reject(err);
                  docker.modem.followProgress(stream, (err: any) => {
                    if (err) return reject(err);
                    resolve(null);
                  });
                });
              });
            }
          }

          // Create and start container
          const container = await docker.createContainer(containerConfig);
          
          await container.start();

          session.services[serviceName].containerId = container.id;
          session.services[serviceName].status = 'running';
          this.emit('update', session);
          
          console.log(`✅ Service ${serviceName} is now running`);

        } catch (error: any) {
          console.error(`❌ Failed to start service ${serviceName}:`, error.message);
          session.services[serviceName].status = 'error';
          session.services[serviceName].error = error.message;
          if (error instanceof PilotLabProtectedError) (session.protectedRejections ??= []).push(serviceName);
          this.emit('update', session);
          // Continue with other services instead of throwing
        }
      }

      console.log(`\n📊 Final service status check...`);
      
      // Wait a bit for containers to settle
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Re-check all container states
      for (const serviceName of Object.keys(session.services)) {
        if (session.services[serviceName].containerId) {
          try {
            const container = docker.getContainer(session.services[serviceName].containerId!);
            const containerInfo = await container.inspect();
            if (!containerInfo.State.Running && session.services[serviceName].status === 'running') {
              console.error(`⚠️ Service ${serviceName} is not running (exit code: ${containerInfo.State.ExitCode})`);
              session.services[serviceName].status = 'error';
              session.services[serviceName].error = `Container exited with code ${containerInfo.State.ExitCode}`;
            }
          } catch (err) {
            console.error(`⚠️ Failed to inspect ${serviceName}:`, err);
          }
        }
      }
      
      // Check if all services are running or if some failed
      const allRunning = Object.values(session.services).every(s => s.status === 'running');
      const anyError = Object.values(session.services).some(s => s.status === 'error');
      console.log(`  - All running: ${allRunning}`);
      console.log(`  - Any errors: ${anyError}`);
      
      if (allRunning) {
        session.status = 'running';
        console.log(`✅ All services started successfully`);
      } else if (anyError) {
        session.status = 'error';
        const errors = Object.entries(session.services)
          .filter(([_, s]) => s.status === 'error')
          .map(([name, s]) => `${name}: ${s.error}`)
          .join('; ');
        session.error = `Some services failed to start: ${errors}`;
        console.log(`⚠️ Some services failed`);
      } else {
        session.status = 'running'; // Partial success
      }
      
      this.emit('update', session);
      console.log(`📡 Sent final session update to frontend`);

    } catch (error: any) {
      // ここに来るのは、サービスのコンテナを作成する前（依存関係の整理・ネットワークの準備）の失敗だけ
      // （サービスごとの失敗は上のループ内で記録する）。ジョブを失敗にするため setupFailure にも入れる（直し回6 推奨A）
      session.status = 'error';
      session.error = error.message;
      session.setupFailure = `コンテナを作成する前に失敗したため、compose up を中止しました（${error?.message ?? String(error)}）`;
      for (const name of Object.keys(session.services)) {
        if (session.services[name].status === 'pending') session.services[name].status = 'error';
      }
      this.emit('update', session);
    }

    return session;
  }

  /** この回に作成したネットワークを、作成時の ID で削除する。削除できなかったものは残存として返し、ログにも出す */
  private async rollbackCreatedNetworks(created: { name: string; id: string }[]): Promise<NonNullable<ComposeSession['networkRollback']>> {
    const result: NonNullable<ComposeSession['networkRollback']> = { removed: [], remaining: [] };
    for (const n of created) {
      try {
        await docker.getNetwork(n.id).remove();
        result.removed.push(n);
      } catch (error) {
        if (isNotFound(error)) {
          result.removed.push(n);
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        result.remaining.push({ ...n, error: message });
        console.error(
          `⚠️ 作成したネットワーク ${n.name}（${n.id}）を削除できず、残っています: ${message}。` +
            `復旧手順：docker network rm ${n.id} で削除してください（接続中のコンテナがあれば、先に docker rm -f でそのコンテナを削除する）`,
        );
      }
    }
    if (result.removed.length > 0) console.log(`🧹 作成途中で失敗したため、この回に作成したネットワークを削除しました: ${result.removed.map((n) => n.name).join(', ')}`);
    return result;
  }

  async composeDown(projectName: string = 'cloud-dojo'): Promise<void> {
    try {
      // List all containers with the project prefix
      const containers = await docker.listContainers({ all: true });
      const projectContainers = containers.filter(c => 
        c.Names[0]?.replace(/^\//, '').startsWith(`${projectName}_`)
      );
      const networks = await docker.listNetworks();
      const projectNetworks = networks.filter((n) => n.Name?.startsWith(`${projectName}_`));
      // パイロットのラボ（ラベル cloud-dojo.lab）、または Docker ソケットをマウントしたコンテナ（直し回6 必須2）が
      // 含まれていれば、何も停止・削除せずに拒否する
      for (const c of projectContainers) assertContainerOperable({ Id: c.Id, Labels: c.Labels, Mounts: c.Mounts as MountLike[] | undefined });
      const protectedNetwork = projectNetworks.find((n) => isPilotLabLabels(n.Labels));
      if (protectedNetwork) throw new PilotLabProtectedError(protectedNetwork.Id);
      
      const totalSteps = projectContainers.length + 1; // containers + networks
      let currentStep = 0;
      
      this.emit('down:progress', {
        projectName,
        progress: 0,
        status: 'stopping_containers',
        message: `Stopping ${projectContainers.length} containers...`,
      });
      
      for (const containerInfo of projectContainers) {
        const containerName = containerInfo.Names[0]?.replace(/^\//, '');
        const serviceName = containerName?.replace(`${projectName}_`, '');
        
        console.log(`🛑 Stopping container: ${containerName}`);
        this.emit('down:progress', {
          projectName,
          progress: Math.round((currentStep / totalSteps) * 100),
          status: 'stopping',
          message: `Stopping ${serviceName}...`,
          currentService: serviceName,
        });
        
        const container = docker.getContainer(containerInfo.Id);
        
        // Stop if running
        if (containerInfo.State === 'running') {
          await container.stop();
          console.log(`✅ Stopped: ${containerName}`);
        }
        
        // Remove container
        await container.remove();
        console.log(`🗑️ Removed: ${containerName}`);
        
        currentStep++;
        this.emit('down:progress', {
          projectName,
          progress: Math.round((currentStep / totalSteps) * 100),
          status: 'removed',
          message: `Removed ${serviceName}`,
          currentService: serviceName,
        });
      }

      // Remove networks
      console.log('🌐 Removing networks...');
      this.emit('down:progress', {
        projectName,
        progress: Math.round((currentStep / totalSteps) * 100),
        status: 'removing_networks',
        message: 'Removing networks...',
      });
      
      for (const networkInfo of projectNetworks) {
        const network = docker.getNetwork(networkInfo.Id);
        try {
          await network.remove();
          console.log(`✅ Removed network: ${networkInfo.Name}`);
        } catch (networkError: any) {
          // If network has active endpoints, log warning but don't fail
          if (networkError.message?.includes('has active endpoints')) {
            console.warn(`⚠️ Cannot remove network ${networkInfo.Name}: still has active endpoints`);
          } else {
            throw networkError;
          }
        }
      }

      this.emit('down:progress', {
        projectName,
        progress: 100,
        status: 'completed',
        message: 'Compose down completed',
      });
      
      console.log('✅ Compose down completed');

      // Note: We don't remove volumes by default (like docker-compose down)
      // Use composeDownVolumes() for that

    } catch (error: any) {
      this.emit('down:progress', {
        projectName,
        progress: 0,
        status: 'error',
        message: error.message,
      });
      throw new Error(`Failed to stop compose project: ${error.message}`);
    }
  }

  async composeDownVolumes(projectName: string = 'cloud-dojo'): Promise<void> {
    await this.composeDown(projectName);

    // Remove volumes
    const volumes = await docker.listVolumes();
    if (volumes.Volumes) {
      for (const volumeInfo of volumes.Volumes) {
        if (volumeInfo.Name?.startsWith(`${projectName}_`)) {
          const volume = docker.getVolume(volumeInfo.Name);
          await volume.remove();
        }
      }
    }
  }

  async getComposeStatus(projectName: string = 'cloud-dojo'): Promise<Record<string, any>> {
    const containers = await docker.listContainers({ all: true });
    const status: Record<string, any> = {};

    for (const containerInfo of containers) {
      const containerName = containerInfo.Names[0]?.replace(/^\//, '');
      if (containerName?.startsWith(`${projectName}_`)) {
        const serviceName = containerName.replace(`${projectName}_`, '');
        status[serviceName] = {
          id: containerInfo.Id,
          state: containerInfo.State,
          status: containerInfo.Status,
          image: containerInfo.Image,
          ports: containerInfo.Ports
        };
      }
    }

    return status;
  }

  getSession(sessionId: string): ComposeSession | undefined {
    return this.sessions.get(sessionId);
  }
}

export const composeService = new DockerComposeService();
