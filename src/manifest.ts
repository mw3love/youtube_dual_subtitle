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
  // 자막 선택 없이 "직접 질문" 패널을 여는 단축키. _execute_action(팝업 열기)과 겹치지 않게
  // 커스텀 커맨드로 둬 chrome://extensions/shortcuts 에 노출 → 사용자가 자유 재지정 가능.
  // background가 onCommand로 받아 활성 탭 콘텐츠에 OPEN_ASK 전달.
  commands: {
    'open-ask': {
      suggested_key: { default: 'Alt+Q', mac: 'Alt+Q' },
      description: '자막 직접 질문 패널 열기 (AI에게 물어보기)',
    },
  },
  permissions: ['storage', 'scripting', 'offscreen'],
  host_permissions: [
    'https://www.youtube.com/*',
    'https://translate.googleapis.com/*',
    // Gemini (BYOK) 번역 백엔드. 사용자가 옵션 페이지에서 본인 키 입력 시에만 호출.
    'https://generativelanguage.googleapis.com/*',
    // Mindlogic API Gateway (BYOK) — 학교/조직 계정 키로 OpenAI/Anthropic/Gemini 등 통과.
    // base URL은 옵션 페이지에서 사용자가 직접 입력(조직마다 도메인이 다름) — host_permissions는
    // 정적 선언이라 지금 아는 도메인만 미리 등록. 새 조직 도메인이 추가되면 여기도 추가 필요.
    'https://factchat-cloud.mindlogic.ai/*', // 전북대(학교)
    'https://factchat.mindlogic-kr-api.com/*', // KBS(회사)
    // Notion API (BYOK) — 해설 패널을 사용자 본인 Notion DB에 저장. integration 토큰 입력 시에만 호출.
    'https://api.notion.com/*',
  ],
  web_accessible_resources: [
    {
      // offscreen document는 background SW에서 chrome.offscreen.createDocument로만 띄우며
      // 익스텐션 내부 호출이라 matches와 무관하게 동작. matches는 *외부 origin*이 이 HTML을
      // fetch할 수 있는 화이트리스트일 뿐 — content script가 도는 youtube.com만 허용해도
      // 우리 동작에 영향 없음. 스토어 최소권한 원칙에 맞게 좁힘.
      resources: ['src/offscreen/document.html'],
      matches: ['https://www.youtube.com/*'],
    },
  ],
});
