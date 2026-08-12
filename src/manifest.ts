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
    // "Alt+Q 직접 질문"을 유튜브 밖에서도 쓰기 위한 온디맨드 주입 스크립트(A65, 섹션 40).
    // matches가 실재하지 않는 도메인(.invalid, RFC 2606 예약)이라 이 항목으로는 절대 자동 실행되지
    // 않는다 — 여기 등록하는 유일한 목적은 crxjs가 빌드 시 이 파일을 해시된 실제 경로로 처리하게
    // 하는 것. 실제 주입은 background/index.ts가 chrome.commands 'open-ask' 발화 시(사용자 제스처)
    // chrome.runtime.getManifest()로 이 해시 경로를 읽어 chrome.scripting.executeScript로 그 순간의
    // activeTab에만 건다 — 상시 <all_urls> content script(모든 사이트 권한)를 피하기 위함.
    {
      matches: ['https://ydt-ask-anywhere.invalid/*'],
      js: ['src/inject/ask-anywhere.ts'],
      run_at: 'document_idle',
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
  // activeTab: 'open-ask' 단축키(사용자 제스처)로 그 순간의 탭 하나에만 ask-anywhere를 주입하기
  // 위함(섹션 40) — 상시 host_permissions 없이 그 탭에 한정된 임시 권한만 받는다.
  permissions: ['storage', 'scripting', 'offscreen', 'activeTab'],
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
    // ask-anywhere(섹션 40)의 web_accessible_resources 그룹은 여기서 선언하지 않는다 — crxjs가
    // 위 content_scripts 등록으로부터 자동 생성하되 그 항목의 matches(placeholder .invalid)를
    // 그대로 복사해버려 실제로는 무용하다. 빌드 후 scripts/patch-manifest.mjs가 그 그룹만
    // <all_urls>로 넓힌다(그 스크립트의 주석 참고) — ask-anywhere의 loader가 임의 페이지 origin에서
    // 실제 청크를 동적 import()하기 때문에 유튜브 한정 matches로는 CORS에 막힌다.
  ],
});
