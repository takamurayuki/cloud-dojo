/**
 * パイロット専用の起動入口（PostgreSQL・Redis・認証・AIキー不要）。
 *   cd backend/api && npx pnpm@9 run dev:pilot
 * 127.0.0.1 のみで待ち受ける。既定ポートは既存 API と同じ 4000（フロントの既定接続先）なので、
 * 既存 API（pnpm dev）と同時には起動しない。両方使う場合は PILOT_PORT を変える。
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createPilotPlugin } from './app';

const port = Number(process.env.PILOT_PORT ?? 4000);
const app = Fastify({ logger: { level: 'info' } });

await app.register(cors, {
  origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
  methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
});
const { plugin } = createPilotPlugin();
await app.register(plugin, { prefix: '/api/pilot' });
app.get('/health', async () => ({ status: 'ok', mode: 'pilot' }));

await app.listen({ port, host: '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
