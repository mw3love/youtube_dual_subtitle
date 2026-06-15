// Background service worker entry.
// 번역 요청을 router로 위임. router는 사용자가 선택한 백엔드 우선, 실패 시 fallback.
// 옵션 페이지의 Gemini 키 테스트는 router 우회 — fallback에 가려져 성공처럼 보이지 않게.

import { translateBatch } from './translators/router';
import { testGeminiKey } from './translators/gemini';
import { testMindlogicKey, listMindlogicModels } from './translators/mindlogic';
import { explain } from './explain';
import { saveToNotion, testNotion } from './notion';
import type { BackendId } from './translators/types';
import type { ExplainBackend, GeminiModel, MindlogicModel } from '../shared/settings';
import { setLastBackend } from '../shared/secrets';
import { getCached, setCached } from '../shared/cache/idb-cache';

const TAG = '[YDT/bg]';
console.log(TAG, 'background service worker started');

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
}

// 해설을 Notion DB에 페이지로 저장. content가 영상 메타까지 동봉, 토큰은 secrets.ts.
interface NotionSaveMsg {
  type: 'NOTION_SAVE';
  term: string;
  markdown: string;
  context?: string;
  databaseId: string;
  videoTitle?: string;
  videoUrl?: string;
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
        void setLastBackend({
          used: result.used,
          preferred: m.backend ?? 'google-free',
          at: Date.now(),
        }).catch(() => {});
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

  if (m?.type === 'TEST_MINDLOGIC' && typeof m.apiKey === 'string' && m.model) {
    const apiKey = m.apiKey;
    const model = m.model as MindlogicModel;
    (async (): Promise<void> => {
      try {
        const translation = await testMindlogicKey(apiKey, model);
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
    (async (): Promise<void> => {
      try {
        const models = await listMindlogicModels(apiKey);
        sendResponse({ ok: true, models });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.warn(TAG, 'mindlogic models list failed:', error);
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
    const { text, context, backend, model, prompt, question } = m;
    (async (): Promise<void> => {
      try {
        // prompt는 해설 경로에서만 쓰임(질문 경로는 explain()이 질문 전용 프롬프트 사용).
        // 가드가 (prompt || question)이라 prompt는 string|undefined → 빈 문자열 폴백.
        const markdown = await explain({ text, context, backend, model, prompt: prompt ?? '', question });
        sendResponse({ ok: true, markdown });
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
    (async (): Promise<void> => {
      try {
        const { url } = await saveToNotion({
          term,
          markdown,
          context,
          databaseId,
          videoTitle,
          videoUrl,
        });
        sendResponse({ ok: true, url });
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
