import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest';

const here = new URL('./', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

export default defineConfig(({ mode }) => ({
  plugins: [react(), crx({ manifest })],
  // production 빌드에서 디버그 콘솔 제거. warn/error는 유지해 실제 문제는 사용자가 볼 수 있음.
  esbuild: {
    pure: mode === 'production' ? ['console.log', 'console.info', 'console.debug'] : [],
    drop: mode === 'production' ? ['debugger'] : [],
  },
  build: {
    rollupOptions: {
      // CRXJS는 manifest entry로 등록된 HTML만 처리한다. offscreen은 background에서
      // 동적으로 createDocument로 띄워서 manifest entry가 아니므로 직접 input에 추가.
      input: {
        offscreen: `${here}src/offscreen/document.html`,
      },
    },
  },
  server: {
    // host 미지정 시 Node가 이 환경에서 IPv6(::1)로만 바인딩해 Chrome의 127.0.0.1 접속이
    // 막히는 경우가 있음(CRXJS dev mode "Cannot connect" 오류) — 명시해 IPv4도 열어둠.
    host: true,
    port: 5173,
    strictPort: true,
    hmr: { port: 5174 },
  },
}));
