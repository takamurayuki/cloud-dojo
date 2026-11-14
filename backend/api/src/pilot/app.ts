/**
 * パイロット経路の組み立て。PostgreSQL・Redis・認証・AIキーに依存しない。
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { LabLock } from './lab/lock';
import { DockerLabRunner, type LabRunner } from './lab/runner';
import { pilotRoutes } from './routes';
import { PilotStore } from './store';

export const DEFAULT_PILOT_DB = process.env.PILOT_DB_PATH ?? '.data/pilot.sqlite';

export interface PilotOptions {
  dbPath?: string;
  store?: PilotStore;
  lab?: LabRunner;
  /** ラボ操作の排他区間（既定はプロセス共有のロック。テストでは個別に渡す） */
  labLock?: LabLock;
}

/** 既存サーバ・単独起動・テストのいずれからも登録できるプラグイン */
export function createPilotPlugin(opts: PilotOptions = {}): { plugin: FastifyPluginAsync; store: PilotStore } {
  const store = opts.store ?? new PilotStore(opts.dbPath ?? DEFAULT_PILOT_DB);
  const lab = opts.lab ?? new DockerLabRunner();
  const plugin: FastifyPluginAsync = async (f: FastifyInstance) => {
    f.addHook('onClose', async () => store.close());
    await pilotRoutes(f, { store, lab, labLock: opts.labLock });
  };
  return { plugin, store };
}
