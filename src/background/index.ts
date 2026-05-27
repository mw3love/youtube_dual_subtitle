// Background service worker entry.
// 번역 요청을 router로 위임. router는 사용자가 선택한 백엔드 우선, 실패 시 fallback.
// 옵션 페이지의 Gemini 키 테스트는 router 우회 — fallback에 가려져 성공처럼 보이지 않게.

import { translateBatch } from './translators/router';
import { testGeminiKey } from './translators/gemini';
import { testMindlogicKey } from './translators/mindlogic';
import type { BackendId } from './translators/types';
import type { GeminiModel, MindlogicModel } from '../shared/settings';
import { setLastBackend } from '../shared/secrets';

const TAG = '[YDT/bg]';
console.log(TAG, 'background service worker started');

interface TranslateBatchMsg {
  type: 'TRANSLATE_BATCH';
  texts: string[];
  src: string;
  tgt: string;
  backend: BackendId;
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

type AnyMsg = Partial<TranslateBatchMsg> &
  Partial<TestGeminiMsg> &
  Partial<TestMindlogicMsg> & { type?: string };

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

  return;
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log(TAG, 'onInstalled', details.reason);
});
