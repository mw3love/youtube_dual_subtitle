// Chrome 138+ window.Translator. Service worker에서 직접 못 써서 offscreen document에 위임.
//
// createDocument가 resolve된 직후엔 offscreen의 module 로딩 + onMessage listener 등록이
// 아직 안 끝났을 수 있다. 그 상태에서 sendMessage하면 "Receiving end does not exist"가 난다.
// 그래서 offscreen이 "OFFSCREEN_READY" 신호를 보내올 때까지 기다린 뒤에 호출한다.

const TAG = '[YDT/chrome-builtin]';
const OFFSCREEN_URL = chrome.runtime.getURL('src/offscreen/document.html');

let readyPromise: Promise<void> | null = null;

async function ensureOffscreenReady(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const has = await chrome.offscreen.hasDocument();

    // 이미 떠있고 살아있는지 ping으로 확인. 살아있으면 즉시 reuse.
    if (has) {
      try {
        const r = (await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' })) as
          | { ok: true }
          | undefined;
        if (r?.ok) return;
      } catch {
        // ping 실패 = ready listener가 아직 없거나 죽음. 새로 만든다.
        try {
          await chrome.offscreen.closeDocument();
        } catch {
          // ignore
        }
      }
    }

    // ready 신호를 먼저 listen, 그다음 createDocument
    const ready = new Promise<void>((resolve) => {
      const listener = (msg: unknown): void => {
        const m = msg as { type?: string };
        if (m?.type === 'OFFSCREEN_READY') {
          chrome.runtime.onMessage.removeListener(listener);
          resolve();
        }
      };
      chrome.runtime.onMessage.addListener(listener);
    });

    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['DOM_PARSER' as chrome.offscreen.Reason],
      justification: 'Run Chrome built-in Translator API which requires a DOM context.',
    });
    console.log(TAG, 'offscreen document created, waiting for ready signal');

    // 타임아웃 10초 — 너무 오래 기다리면 다음 호출에 다시 시도
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('offscreen ready timeout')), 10000),
    );
    await Promise.race([ready, timeout]);
    console.log(TAG, 'offscreen ready');
  })();

  try {
    await readyPromise;
  } catch (e) {
    readyPromise = null; // 다음 호출에서 재시도 가능하게
    throw e;
  }
}

type OffscreenResponse =
  | { ok: true; translations: string[] }
  | { ok: false; error: string };

export async function translateBatch(
  texts: string[],
  src: string,
  tgt: string,
): Promise<string[]> {
  if (texts.length === 0) return [];
  await ensureOffscreenReady();

  const res = (await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_TRANSLATE',
    texts,
    src,
    tgt,
  })) as OffscreenResponse;

  if (!res.ok) throw new Error(res.error);
  return res.translations;
}
