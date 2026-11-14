/**
 * パイロット専用の起動入口（PostgreSQL・Redis・認証・AIキー不要）。
 *   cd backend/api && npx pnpm@9 run dev:pilot
 * 127.0.0.1 のみで待ち受ける。認証・DB に依存しないラボ系ルート（docker／compose／kubernetes／cicd／network）も
 * 登録し、パイロット画面のラボ系ページを開けるようにする（auth／users／learning／ai／queue は登録しない）。
 * 組み立ては server.ts：全経路に接続元の loopback 制限をかけ、キュー投入を伴う操作は 503 で受け付けない。
 * ラボ保護（ラベル保護等）は各ルート・サービス側にあり、そのまま効く。既定ポートは既存 API と同じ 4000（フロントの既定接続先）なので、
 * 既存 API（pnpm dev）と同時には起動しない。両方使う場合は PILOT_PORT を変える。
 */
import { buildPilotServer } from './server';

const port = Number(process.env.PILOT_PORT ?? 4000);
const app = await buildPilotServer({ logger: { level: 'info' } });

await app.listen({ port, host: '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
