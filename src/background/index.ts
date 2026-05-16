// Background service worker entry.
// M4: content가 cue를 받으면 여기로 번역 요청을 보내고, 우리는 Google 무료 백엔드로 호출한다.
// (CORS·쿠키 문제가 없고 content 쪽에서 직접 부르면 페이지 origin이 노출되어 차단 위험 ↑)

import { translateBatch } from './translators/google-free';

const TAG = '[YDT/bg]';
console.log(TAG, 'background service worker started');

interface TranslateBatchMsg {
  type: 'TRANSLATE_BATCH';
  texts: string[];
  src: string;
  tgt: string;
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
      );
      console.log(TAG, `translated ${translations.length}/${texts.length}`);
      sendResponse({ ok: true, translations } satisfies TranslateResponse);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(TAG, 'translate failed:', error);
      sendResponse({ ok: false, error } satisfies TranslateResponse);
    }
  })();

  return true; // async sendResponse
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log(TAG, 'onInstalled', details.reason);
});
