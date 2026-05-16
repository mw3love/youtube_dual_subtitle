// Offscreen document — Chrome 내장 Translator API 호출 호스트.
// content/service worker에서는 Translator API를 직접 못 써서 여기서 받아 호출.

const TAG = '[YDT/offscreen]';
console.log(TAG, 'loaded');

// background는 우리가 listener 등록을 마치기 전엔 sendMessage를 보내면 안 된다.
// 이 신호를 받고서야 안전.
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {
  // background가 ready listener를 아직 안 걸었으면 무시 — ensureOffscreenReady가 재시도
});

interface TranslateMsg {
  type: 'OFFSCREEN_TRANSLATE';
  texts: string[];
  src: string;
  tgt: string;
}

type TranslateResponse =
  | { ok: true; translations: string[] }
  | { ok: false; error: string };

// Chrome 138+ window.Translator. 모델 가용성·다운로드 가능 여부 확인 후 create.
interface GlobalTranslator {
  availability(opts: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(opts: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }): Promise<{ translate(text: string): Promise<string> }>;
}

function getTranslator(): GlobalTranslator | null {
  return (globalThis as unknown as { Translator?: GlobalTranslator }).Translator ?? null;
}

// Translator 인스턴스는 (src, tgt) pair별로 캐시. 매 호출마다 create하면 비용 큼.
const instanceCache = new Map<string, Awaited<ReturnType<GlobalTranslator['create']>>>();

async function getOrCreate(
  src: string,
  tgt: string,
): Promise<{
  ok: true;
  inst: Awaited<ReturnType<GlobalTranslator['create']>>;
} | { ok: false; error: string }> {
  const T = getTranslator();
  if (!T) return { ok: false, error: 'Translator API not available (Chrome 138+ required)' };

  const key = `${src}::${tgt}`;
  const existing = instanceCache.get(key);
  if (existing) return { ok: true, inst: existing };

  const av = await T.availability({ sourceLanguage: src, targetLanguage: tgt });
  // 'available' | 'downloadable' | 'downloading' | 'unavailable'
  if (av === 'unavailable') return { ok: false, error: `language pair unavailable: ${key}` };

  console.log(TAG, `creating Translator (${key}), availability:`, av);
  const inst = await T.create({
    sourceLanguage: src,
    targetLanguage: tgt,
    monitor(m) {
      m.addEventListener('downloadprogress', ((e: Event) => {
        const ev = e as Event & { loaded?: number };
        const pct = typeof ev.loaded === 'number' ? Math.round(ev.loaded * 100) : '?';
        console.log(TAG, `model download: ${pct}%`);
      }) as EventListener);
    },
  });
  instanceCache.set(key, inst);
  return { ok: true, inst };
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as { type?: string };
  if (m?.type === 'OFFSCREEN_PING') {
    sendResponse({ ok: true });
    return; // sync 응답
  }
  const tm = msg as Partial<TranslateMsg>;
  if (tm?.type !== 'OFFSCREEN_TRANSLATE' || !Array.isArray(tm.texts)) return;
  const texts = tm.texts;
  const src = tm.src ?? 'en';
  const tgt = tm.tgt ?? 'ko';

  (async (): Promise<void> => {
    try {
      const r = await getOrCreate(src, tgt);
      if (!r.ok) {
        sendResponse({ ok: false, error: r.error } satisfies TranslateResponse);
        return;
      }
      // Translator.translate는 단일 텍스트만 받음. 순차 호출.
      // 병렬 호출은 모델 메모리 충돌 가능성 — 측정 후 결정.
      const translations: string[] = [];
      for (const t of texts) {
        translations.push(await r.inst.translate(t));
      }
      sendResponse({ ok: true, translations } satisfies TranslateResponse);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(TAG, 'translate failed:', error);
      sendResponse({ ok: false, error } satisfies TranslateResponse);
    }
  })();

  return true;
});
