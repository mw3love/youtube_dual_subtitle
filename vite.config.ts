import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest';

const here = new URL('./', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

export default defineConfig({
  plugins: [react(), crx({ manifest })],
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
    port: 5173,
    strictPort: true,
    hmr: { port: 5174 },
  },
});
