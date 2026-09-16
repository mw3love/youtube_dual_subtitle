// "Alt+Q 직접 질문"을 유튜브가 아닌 임의 페이지에서도 쓰기 위한 온디맨드 주입 스크립트 (A65).
//
// manifest content_scripts에는 등록돼 있지만 matches가 절대 실재하지 않는 도메인
// (`https://ydt-ask-anywhere.invalid/*`)이라 자동 실행되지 않는다 — crxjs가 빌드시 해시된 실제
// 경로로 정상 처리하게 하려는 용도뿐. 실제 주입은 background/index.ts가 chrome.commands
// 'open-ask' 발화 시(사용자 제스처) chrome.scripting.executeScript({files:[...]})로 그 순간의
// activeTab에만 1회 건다 — 상시 <all_urls> content script를 피해 스토어 최소권한 원칙을 지킨다.
//
// ExplainUI는 YouTube 비의존적으로 이미 설계돼 있다(host()=fullscreenElement??body,
// .ydt-container 셀렉터 매칭 실패는 무해) — 여기서는 content/index.ts의 해설 배선(EXPLAIN·
// NOTION_SAVE 메시지 조립)만 그대로 복제해 재사용한다. videoTitle() 대신 document.title을 씀
// (유튜브 접미사 스트립 불필요 — 일반 페이지 제목 그대로가 Notion 저장 시 더 유용).

import { ExplainUI, type ExplainResult, type NotionSaveResult } from '../content/explain/explain-ui';
import { injectStyles } from '../content/renderer/styles';
import { loadSettings, type Settings } from '../shared/settings';
import { explainModelLabel } from '../shared/lang-options';
import type { ChatTurn } from '../shared/types';
import { setUiLang, t } from '../shared/i18n';

// 재주입 가드 — 이미 이 페이지에 떠 있으면 새 인스턴스를 만들지 않고 openAsk()만 재호출
// (새 탭으로 누적, 기존 패널·탭은 그대로 보존).
declare global {
  interface Window {
    __YDT_ASK_OPEN__?: () => void;
  }
}

if (window.__YDT_ASK_OPEN__) {
  window.__YDT_ASK_OPEN__();
} else {
  void initAskAnywhere();
}

// 설정 리스너가 패널 생성보다 먼저 등록되므로(아래 loadSettings 직후) 선언만 위에 둔다.
let explainUI: ExplainUI | null = null;

async function initAskAnywhere(): Promise<void> {
  injectStyles();

  let currentSettings: Settings = await loadSettings();
  setUiLang(currentSettings.uiLang);
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area !== 'sync') return;
    void loadSettings().then((s) => {
      currentSettings = s;
      setUiLang(s.uiLang);
      // 이 스크립트는 패널을 먼저 만들고 나서 설정 변경을 받으므로, 언어가 바뀌면 이미 만들어진
      // 버튼 라벨도 다시 찍어야 한다(content/index.ts의 applySettings와 같은 처리).
      explainUI?.relabel();
    });
  });

  // content/index.ts의 requestExplain/requestQuestion/requestNotionSave와 동일 배선
  // (섹션 14·19·28 참고) — background 메시지 포맷이 같아 별도 핸들러 없이 그대로 재사용.
  async function requestExplain(text: string, context: string): Promise<ExplainResult> {
    const s = currentSettings;
    if (!s.explainPrompt.trim()) {
      return { ok: false, error: t('err.emptyExplainPrompt') };
    }
    const model = s.explainBackend === 'gemini' ? s.explainGeminiModel : s.explainMindlogicModel;
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'EXPLAIN',
        text,
        context,
        backend: s.explainBackend,
        model,
        prompt: s.explainPrompt,
      })) as ExplainResult | undefined;
      return res ?? { ok: false, error: t('err.noBgResponse') };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function requestQuestion(
    text: string,
    context: string,
    question: string,
    history: ChatTurn[],
    isAsk: boolean,
  ): Promise<ExplainResult> {
    const s = currentSettings;
    const model = s.explainBackend === 'gemini' ? s.explainGeminiModel : s.explainMindlogicModel;
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'EXPLAIN',
        text,
        context,
        question,
        isAsk,
        history,
        backend: s.explainBackend,
        model,
        prompt: s.explainPrompt,
      })) as ExplainResult | undefined;
      return res ?? { ok: false, error: t('err.noBgResponse') };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function requestNotionSave(
    term: string,
    markdown: string,
    context: string,
    prev?: { pageId: string; dbId: string; title: string },
  ): Promise<NotionSaveResult> {
    const s = currentSettings;
    if (!s.notionDatabaseId.trim()) {
      return { ok: false, error: t('err.emptyNotionDb') };
    }
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'NOTION_SAVE',
        term,
        markdown,
        context,
        databaseId: s.notionDatabaseId,
        videoTitle: document.title,
        videoUrl: location.href,
        prevPageId: prev?.pageId,
        prevDatabaseId: prev?.dbId,
        prevTitle: prev?.title,
      })) as NotionSaveResult | undefined;
      if (!res) return { ok: false, error: t('err.noBgResponse') };
      return res.ok ? { ...res, dbId: s.notionDatabaseId } : res;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  function currentExplainModelLabel(): string {
    const s = currentSettings;
    return explainModelLabel(s.explainBackend, s.explainGeminiModel, s.explainMindlogicModel);
  }

  explainUI = new ExplainUI(
    requestExplain,
    requestQuestion,
    requestNotionSave,
    currentExplainModelLabel,
  );
  explainUI.setEnabled(true);
  explainUI.setNotionEnabled(true);
  explainUI.openAsk();

  window.__YDT_ASK_OPEN__ = () => explainUI?.openAsk();
}
