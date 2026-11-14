import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * 通常の開発（`vite`、mode=development）は従来どおり全インターフェースで待ち受ける（host: true）。
 * パイロット（`vite --mode pilot`、ルートの `pnpm run dev:pilot`）では 127.0.0.1 のみで待ち受ける。
 * パイロット API は loopback 限定のため、別端末から Vite のプロキシ経由で届く経路を作らない。
 * どちらのモードでもプロキシは xfwd で元の接続元を X-Forwarded-For に載せ、API 側（routes.ts）が
 * loopback 以外の元の接続元を拒否する（通常の開発で host: true のままでも迂回できない）。
 */
// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const pilot = mode === 'pilot';
  const host = pilot ? '127.0.0.1' : true;
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 3000,
      host,
      // パイロットでは別ポートへ黙って移らない（127.0.0.1:3000 で起動できなければ失敗させる）
      strictPort: pilot,
      proxy: {
        '/api': {
          target: 'http://localhost:4000',
          changeOrigin: true,
          xfwd: true,
        },
        '/socket.io': {
          target: 'http://localhost:4000',
          ws: true,
          xfwd: true,
        },
      },
    },
    preview: pilot ? { host: '127.0.0.1', strictPort: true } : undefined,
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
