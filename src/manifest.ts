import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'YouTube Dual Subtitle',
  description: pkg.description,
  version: pkg.version,
  action: {
    default_popup: 'src/popup/index.html',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  options_page: 'src/options/index.html',
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['https://www.youtube.com/*'],
      js: ['src/content/inject-main.ts'],
      world: 'MAIN',
      run_at: 'document_start',
    },
    {
      matches: ['https://www.youtube.com/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_start',
    },
  ],
  permissions: ['storage', 'scripting', 'offscreen'],
  host_permissions: [
    'https://www.youtube.com/*',
    'https://translate.googleapis.com/*',
    // Gemini (BYOK) 번역 백엔드. 사용자가 옵션 페이지에서 본인 키 입력 시에만 호출.
    'https://generativelanguage.googleapis.com/*',
  ],
  web_accessible_resources: [
    {
      resources: ['src/offscreen/document.html'],
      matches: ['<all_urls>'],
    },
  ],
});
