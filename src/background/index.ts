// Background service worker entry.
// 번역 요청을 router로 위임. router는 사용자가 선택한 백엔드 우선, 실패 시 fallback.

import { translateBatch } from './translators/router';
import type { BackendId } from './translators/types';

const TAG = '[YDT/bg]';
console.log(TAG, 'background service worker started');

interface TranslateBatchMsg {
  type: 'TRANSLATE_BATCH';
  texts: string[];
  src: string;
  tgt: string;
  backend: BackendId;
}

type TranslateResponse =
  | { ok: true; translations: string[] }
  | { ok: false; error: string };

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as Partial<TranslateBatchMsg>;
  if (m?.type !== 'TRANSLATE_BATCH' || !Array.isArray(m.texts)) return;
  const texts = m.texts;

  (async (): Promise<void> => {
    try {
      const translations = await translateBatch(
        texts,
        m.src ?? 'en',
        m.tgt ?? 'ko',
        m.backend ?? 'google-free',
      );
      console.log(TAG, `translated ${translations.length}/${texts.length} via ${m.backend}`);
      sendResponse({ ok: true, translations } satisfies TranslateResponse);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(TAG, 'translate failed:', error);
      sendResponse({ ok: false, error } satisfies TranslateResponse);
    }
  })();

  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log(TAG, 'onInstalled', details.reason);
});
