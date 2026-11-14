/**
 * パイロット専用の起動入口（PostgreSQL・Redis・認証・AIキー不要）。
 *   cd backend/api && npx pnpm@9 run dev:pilot
 * 127.0.0.1 のみで待ち受ける。認証・DB に依存しないラボ系ルート（docker／compose／kubernetes／cicd／network）も
 * 登録し、パイロット画面のラボ系ページを開けるようにする（auth／users／learning／ai／queue は登録しない）。
 * ラボ保護（ラベル保護等）は各ルート・サービス側にあり、そのまま効く。既定ポートは既存 API と同じ 4000（フロントの既定接続先）なので、
 * 既存 API（pnpm dev）と同時には起動しない。両方使う場合は PILOT_PORT を変える。
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createPilotPlugin } from './app';
import { dockerRoutes } from '../routes/docker';
import { composeRoutes } from '../routes/compose';
import { kubernetesRoutes } from '../routes/kubernetes';
import { cicdRoutes } from '../routes/cicd';
import { networkRoutes } from '../routes/network';

const port = Number(process.env.PILOT_PORT ?? 4000);
const app = Fastify({ logger: { level: 'info' } });

await app.register(cors, {
  origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});
const { plugin } = createPilotPlugin();
await app.register(plugin, { prefix: '/api/pilot' });
// ラボ系ルート。付け方は routes/index.ts と同じ（compose／kubernetes は prefix なしで /api/compose・/api/k8s を自前で持つ）
await app.register(dockerRoutes, { prefix: '/api/docker' });
await app.register(composeRoutes);
await app.register(kubernetesRoutes);
await app.register(cicdRoutes, { prefix: '/api/cicd' });
await app.register(networkRoutes, { prefix: '/api/network' });
app.get('/health', async () => ({ status: 'ok', mode: 'pilot' }));

await app.listen({ port, host: '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
