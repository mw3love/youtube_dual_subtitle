// Background service worker entry.
// 번역 요청을 router로 위임. router는 사용자가 선택한 백엔드 우선, 실패 시 fallback.
// 옵션 페이지의 Gemini 키 테스트는 router 우회 — fallback에 가려져 성공처럼 보이지 않게.

import { translateBatch } from './translators/router';
import { testGeminiKey, listGeminiModels } from './translators/gemini';
import { testMindlogicKey, listMindlogicModels, getMindlogicCredits } from './translators/mindlogic';
import { explain } from './explain';
import { saveToNotion, testNotion } from './notion';
import type { BackendId } from './translators/types';
import type { ExplainBackend, GeminiModel, MindlogicModel } from '../shared/settings';
import type { ChatTurn } from '../shared/types';
import { setLastBackend } from '../shared/secrets';
import { getCached, setCached } from '../shared/cache/idb-cache';

const TAG = '[YDT/bg]';
console.log(TAG, 'background service worker started');

// 단축키(chrome://extensions/shortcuts에서 재지정 가능한 'open-ask', 기본 Alt+Q) → 활성 탭 콘텐츠로
// OPEN_ASK 전달 → 자막 선택 없이 "직접 질문" 패널을 연다. content script는 SW로 직접 단축키를 못
// 받아 이 왕복이 필요. 유튜브 탭이면 상시 content script(content/index.ts)가 받아 처리 — 자막
// 배선까지 통합된 풀 버전 패널. 그 외 탭은 sendMessage가 거부되므로(콘텐츠 스크립트 없음) 그 순간
// activeTab 제스처로 ask-anywhere(섹션 40)를 온디맨드 주입해 같은 패널을 띄운다(A65).
// tab을 onCommand가 직접 주는 인자로 받는다(별도 tabs.query 왕복 없이) — activeTab이 요구하는
// "사용자 제스처로 호출됨" 조건을 이 이벤트 콜백 프레임 안에서 바로 씀으로써 최대한 지킨다.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'open-ask' || tab.id === undefined) return;
  const tabId = tab.id;
  chrome.tabs.sendMessage(tabId, { type: 'OPEN_ASK' }).catch(() => {
    // 유튜브 탭인데 sendMessage가 실패했다면 content script가 아직 초기화 중일 가능성이 큼(레이스) —
    // 그 경우 ask-anywhere를 얹으면 자막 배선 없는 별도 ExplainUI가 중복 생겨 더 나빠진다.
    // 진짜 "콘텐츠 스크립트 자체가 없는 페이지"에서만 온디맨드 주입으로 보완한다.
    if (/^https:\/\/(www\.)?youtube\.com\//.test(tab.url ?? '')) return;
    void injectAskAnywhere(tabId);
  });
});

// manifest content_scripts에 등록해둔 ask-anywhere(섹션 40) 항목에서 crxjs가 빌드 시 해시한
// 실제 파일 경로를 찾는다 — 그 항목의 matches는 절대 안 매치되는 placeholder라 자동 실행되지
// 않고, 이 경로만 executeScript({files})로 재사용한다.
function askAnywhereFiles(): string[] {
  const scripts = chrome.runtime.getManifest().content_scripts ?? [];
  return scripts.find((s) => s.js?.some((f) => f.includes('ask-anywhere')))?.js ?? [];
}

async function injectAskAnywhere(tabId: number): Promise<void> {
  const files = askAnywhereFiles();
  if (!files.length) {
    console.warn(TAG, 'ask-anywhere script not found in manifest');
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
  } catch (e) {
    // chrome:// · 웹스토어 · PDF 뷰어 등 스크립팅이 금지된 페이지 — 조용히 무시.
    console.warn(TAG, 'ask-anywhere injection skipped:', e instanceof Error ? e.message : String(e));
  }
}

interface TranslateBatchMsg {
  type: 'TRANSLATE_BATCH';
  texts: string[];
  src: string;
  tgt: string;
  backend: BackendId;
  videoTitle?: string;
}

interface TestGeminiMsg {
  type: 'TEST_GEMINI';
  apiKey: string;
  model: GeminiModel;
}

interface TestMindlogicMsg {
  type: 'TEST_MINDLOGIC';
  apiKey: string;
  model: MindlogicModel;
  baseUrl: string;
}

// 번역 캐시는 background가 소유한다 — content script의 IndexedDB는 호스트 페이지
// (youtube.com) origin이라 옵션 페이지(chrome-extension origin)의 "비우기"가 닿지 못했음.
// SW와 옵션 페이지는 같은 확장 origin → 같은 IndexedDB를 공유하므로 여기로 일원화.
interface CacheGetMsg {
  type: 'CACHE_GET';
  key: string;
}

interface CacheSetMsg {
  type: 'CACHE_SET';
  key: string;
  translations: string[];
}

// 단어/표현 해설 — content가 선택 텍스트 + 자막 문맥 + 백엔드/모델/프롬프트를 보내면
// explain()이 AI 해설 markdown을 돌려준다. 키는 background가 secrets.ts에서 읽음.
interface ExplainMsg {
  type: 'EXPLAIN';
  text: string;
  context?: string;
  backend: ExplainBackend;
  model: GeminiModel | MindlogicModel;
  prompt: string;
  question?: string; // 있으면 해설이 아니라 사용자 자유 질문 경로
  isAsk?: boolean; // Alt+Q 직접 질문 — 해설 프롬프트로 풍부하게 답하게(explain.ts)
  history?: ChatTurn[]; // 있으면 후속 질문 — 이전 대화를 문맥으로 함께 전달
}

// 해설을 Notion DB에 페이지로 저장. content가 영상 메타까지 동봉, 토큰은 secrets.ts.
// prev*는 재저장(형광펜 수정 후 다시 저장) — 새 페이지를 만들고 옛 페이지를 휴지통으로.
interface NotionSaveMsg {
  type: 'NOTION_SAVE';
  term: string;
  markdown: string;
  context?: string;
  databaseId: string;
  videoTitle?: string;
  videoUrl?: string;
  prevPageId?: string;
  prevDatabaseId?: string;
  prevTitle?: string;
}

// 옵션 "테스트" 버튼 — 토큰+DB 공유+ID 검증.
interface TestNotionMsg {
  type: 'TEST_NOTION';
  token: string;
  databaseId: string;
}

type AnyMsg = Partial<TranslateBatchMsg> &
  Partial<TestGeminiMsg> &
  Partial<TestMindlogicMsg> &
  Partial<CacheGetMsg> &
  Partial<CacheSetMsg> &
  Partial<ExplainMsg> &
  Partial<NotionSaveMsg> &
  Partial<TestNotionMsg> & { type?: string };

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as AnyMsg;

  if (m?.type === 'TRANSLATE_BATCH' && Array.isArray(m.texts)) {
    const texts = m.texts;
    (async (): Promise<void> => {
      try {
        const result = await translateBatch(
          texts,
          m.src ?? 'en',
          m.tgt ?? 'ko',
          m.backend ?? 'google-free',
          { videoTitle: m.videoTitle },
        );
        console.log(
          TAG,
          `translated ${result.translations.length}/${texts.length} via ${result.used}` +
            (result.used !== m.backend ? ` (preferred ${m.backend} fell back)` : ''),
        );
        // 팝업이 "최근 번역" 표시할 수 있게 storage에 기록. await 안 함 — 응답 빠르게.
        // 모델은 gemini/mindlogic일 때만 의미 있음 — 그 시점 storage.sync 값을 fresh read
        // (gemini.ts/mindlogic.ts가 호출 시점에 읽는 것과 같은 값이라 실제 쓰인 모델과 일치).
        void (async (): Promise<void> => {
          let model: string | undefined;
          if (result.used === 'gemini' || result.used === 'mindlogic') {
            const key = result.used === 'gemini' ? 'geminiModel' : 'mindlogicModel';
            const r = await chrome.storage.sync.get(key);
            const v = r[key];
            if (typeof v === 'string' && v.trim()) model = v.trim();
          }
          await setLastBackend({
            used: result.used,
            preferred: m.backend ?? 'google-free',
            model,
            at: Date.now(),
          });
        })().catch(() => {});
        sendResponse({ ok: true, translations: result.translations, used: result.used });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error(TAG, 'translate failed:', error);
        sendResponse({ ok: false, error });
      }
    })();
    return true;
  }

  if (m?.type === 'TEST_GEMINI' && typeof m.apiKey === 'string' && m.model) {
    const apiKey = m.apiKey;
    const model = m.model as GeminiModel;
    (async (): Promise<void> => {
      try {
        const translation = await testGeminiKey(apiKey, model);
        sendResponse({ ok: true, translation });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.warn(TAG, 'gemini test failed:', error);
        sendResponse({ ok: false, error });
      }
    })();
    return true;
  }

  if (
    m?.type === 'TEST_MINDLOGIC' &&
    typeof m.apiKey === 'string' &&
    m.model &&
    typeof m.baseUrl === 'string'
  ) {
    const apiKey = m.apiKey;
    const model = m.model as MindlogicModel;
    const baseUrl = m.baseUrl;
    (async (): Promise<void> => {
      try {
        const translation = await testMindlogicKey(apiKey, model, baseUrl);
        sendResponse({ ok: true, translation });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.warn(TAG, 'mindlogic test failed:', error);
        sendResponse({ ok: false, error });
      }
    })();
    return true;
  }

  if (m?.type === 'MINDLOGIC_LIST_MODELS') {
    const apiKey = typeof m.apiKey === 'string' ? m.apiKey : '';
    const baseUrl = typeof m.baseUrl === 'string' ? m.baseUrl : '';
    (async (): Promise<void> => {
      try {
        const models = await listMindlogicModels(apiKey, baseUrl);
        sendResponse({ ok: true, models });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.warn(TAG, 'mindlogic models list failed:', error);
        sendResponse({ ok: false, error });
      }
    })();
    return true;
  }

  if (m?.type === 'MINDLOGIC_CREDITS') {
    const apiKey = typeof m.apiKey === 'string' ? m.apiKey : '';
    const baseUrl = typeof m.baseUrl === 'string' ? m.baseUrl : '';
    (async (): Promise<void> => {
      try {
        const credits = await getMindlogicCredits(apiKey, baseUrl);
        sendResponse({ ok: true, credits });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.warn(TAG, 'mindlogic credits failed:', error);
        sendResponse({ ok: false, error });
      }
    })();
    return true;
  }

  if (m?.type === 'GEMINI_LIST_MODELS') {
    const apiKey = typeof m.apiKey === 'string' ? m.apiKey : '';
    (async (): Promise<void> => {
      try {
        const models = await listGeminiModels(apiKey);
        sendResponse({ ok: true, models });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.warn(TAG, 'gemini models list failed:', error);
        sendResponse({ ok: false, error });
      }
    })();
    return true;
  }

  if (
    m?.type === 'EXPLAIN' &&
    typeof m.text === 'string' &&
    m.backend &&
    m.model &&
    (m.prompt || m.question) // 질문 경로는 prompt가 비어도 됨(질문 전용 프롬프트 사용)
  ) {
    const { text, context, backend, model, prompt, question, isAsk, history } = m;
    (async (): Promise<void> => {
      try {
        // prompt는 해설 경로에서만 쓰임(질문 경로는 explain()이 질문 전용 프롬프트 사용).
        // 가드가 (prompt || question)이라 prompt는 string|undefined → 빈 문자열 폴백.
        const { markdown, userMessage } = await explain({
          text,
          context,
          backend,
          model,
          prompt: prompt ?? '',
          question,
          isAsk,
          history,
        });
        sendResponse({ ok: true, markdown, userMessage });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.warn(TAG, 'explain failed:', error);
        sendResponse({ ok: false, error });
      }
    })();
    return true;
  }

  if (
    m?.type === 'NOTION_SAVE' &&
    typeof m.term === 'string' &&
    typeof m.markdown === 'string' &&
    typeof m.databaseId === 'string'
  ) {
    const { term, markdown, context, databaseId, videoTitle, videoUrl } = m;
    const { prevPageId, prevDatabaseId, prevTitle } = m;
    (async (): Promise<void> => {
      try {
        const { url, title, pageId, oldKept } = await saveToNotion({
          term,
          markdown,
          context,
          databaseId,
          videoTitle,
          videoUrl,
          prevPageId,
          prevDatabaseId,
          prevTitle,
        });
        sendResponse({ ok: true, url, title, pageId, oldKept });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.warn(TAG, 'notion save failed:', error);
        sendResponse({ ok: false, error });
      }
    })();
    return true;
  }

  if (m?.type === 'TEST_NOTION' && typeof m.token === 'string' && typeof m.databaseId === 'string') {
    const { token, databaseId } = m;
    (async (): Promise<void> => {
      try {
        const dbTitle = await testNotion(token, databaseId);
        sendResponse({ ok: true, dbTitle });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.warn(TAG, 'notion test failed:', error);
        sendResponse({ ok: false, error });
      }
    })();
    return true;
  }

  if (m?.type === 'CACHE_GET' && typeof m.key === 'string') {
    const key = m.key;
    (async (): Promise<void> => {
      try {
        const translations = await getCached(key);
        sendResponse({ translations });
      } catch (e) {
        console.warn(TAG, 'cache get failed:', e instanceof Error ? e.message : String(e));
        sendResponse({ translations: null });
      }
    })();
    return true;
  }

  if (m?.type === 'CACHE_SET' && typeof m.key === 'string' && Array.isArray(m.translations)) {
    // fire-and-forget — 응답 불필요(content가 await 안 함). sendResponse/return true 생략.
    void setCached(m.key, m.translations).catch((e) =>
      console.warn(TAG, 'cache set failed:', e instanceof Error ? e.message : String(e)),
    );
    return;
  }

  return;
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log(TAG, 'onInstalled', details.reason);
});
