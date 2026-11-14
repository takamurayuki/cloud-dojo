/**
 * パイロット API サーバの組み立て（main.ts から起動。テストでは inject で使う）。
 *
 * - 接続元制限：ルートスコープの onRequest フックで、このサーバが提供する全経路（/api/pilot、ラボ系、/health、
 *   未定義の経路・CORS のプリフライトを含む）を loopback 限定にする（loopback.ts）。CORS より先に登録する。
 * - キュー投入の拒否：パイロット入口は Redis キューの Worker を起動しないため、キューへ投入する操作は
 *   受け付けず 503 PILOT_QUEUE_UNSUPPORTED を返す（投入成功に見えて処理されない状態を作らない）。
 */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { createPilotPlugin, type PilotOptions } from './app';
import { loopbackOnlyHook } from './loopback';
import { dockerRoutes } from '../routes/docker';
import { composeRoutes } from '../routes/compose';
import { kubernetesRoutes } from '../routes/kubernetes';
import { cicdRoutes } from '../routes/cicd';
import { networkRoutes } from '../routes/network';

/** パイロットで受け付けない、Redis キューへ投入する経路（method と登録上の URL） */
export const PILOT_QUEUE_ROUTES: ReadonlyArray<{ method: string; url: string; queue: string }> = [
  { method: 'POST', url: '/api/docker/build', queue: 'docker-build' },
  { method: 'POST', url: '/api/docker/containers/run', queue: 'docker-run' },
  { method: 'POST', url: '/api/compose/up', queue: 'compose-up' },
  { method: 'POST', url: '/api/compose/down', queue: 'compose-down' },
  { method: 'POST', url: '/api/compose/down-volumes', queue: 'compose-down' },
  { method: 'POST', url: '/api/k8s/apply', queue: 'k8s-deploy' },
  { method: 'POST', url: '/api/cicd/run', queue: 'cicd-run' },
];

const queueRouteKey = (method: string, url: string) => `${method.toUpperCase()} ${url}`;
const QUEUE_ROUTE_INDEX = new Map(PILOT_QUEUE_ROUTES.map((r) => [queueRouteKey(r.method, r.url), r]));

export interface PilotServerOptions {
  pilot?: PilotOptions;
  logger?: FastifyServerOptions['logger'];
}

export async function buildPilotServer(opts: PilotServerOptions = {}): Promise<FastifyInstance> {
  // trustProxy は使わない：req.ip は TCP の実際の接続元（転送ヘッダで書き換えられない）
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: false });

  // 全経路共通の接続元制限（ルートスコープ。以降に登録する全プラグイン・経路・404 に継承される）
  app.addHook('onRequest', loopbackOnlyHook);

  // キュー投入を伴う操作は、ハンドラ（検証・投入）に入る前に止める
  app.addHook('onRequest', async (req, reply) => {
    const url = req.routeOptions?.url;
    if (!url) return;
    const hit = QUEUE_ROUTE_INDEX.get(queueRouteKey(req.method, url));
    if (!hit) return;
    return reply.status(503).send({
      error: 'PILOT_QUEUE_UNSUPPORTED',
      message: 'この操作はパイロットでは利用できません',
      reason: `この操作はジョブキュー（${hit.queue}）に投入して Worker が処理しますが、パイロットの起動構成は Redis キューの Worker を起動しないため、投入しても処理されません。通常の起動（pnpm dev）で利用してください。`,
      queue: hit.queue,
    });
  });

  await app.register(cors, {
    origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  const { plugin } = createPilotPlugin(opts.pilot);
  await app.register(plugin, { prefix: '/api/pilot' });
  // ラボ系ルート。付け方は routes/index.ts と同じ（compose／kubernetes は prefix なしで /api/compose・/api/k8s を自前で持つ）
  await app.register(dockerRoutes, { prefix: '/api/docker' });
  await app.register(composeRoutes);
  await app.register(kubernetesRoutes);
  await app.register(cicdRoutes, { prefix: '/api/cicd' });
  await app.register(networkRoutes, { prefix: '/api/network' });
  app.get('/health', async () => ({ status: 'ok', mode: 'pilot' }));
  return app;
}
