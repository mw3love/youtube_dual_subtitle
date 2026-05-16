import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'YouTube Dual Subtitle',
  description: pkg.description,
  version: pkg.version,
  action: {
    default_popup: 'src/popup/index.html',
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
    'https://factchat-cloud.mindlogic.ai/*',
  ],
  web_accessible_resources: [
    {
      resources: ['src/offscreen/document.html'],
      matches: ['<all_urls>'],
    },
  ],
});
