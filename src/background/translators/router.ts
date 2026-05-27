import type { BackendId } from './types';
import { translateBatch as googleFree } from './google-free';
import { translateBatch as chromeBuiltin } from './chrome-builtin';
import { translateBatch as gemini } from './gemini';
import { translateBatch as mindlogic } from './mindlogic';

const TAG = '[YDT/router]';

export interface RouterResult {
  translations: string[];
  // 실제로 성공한 백엔드 — fallback 발동 여부를 호출 측이 알 수 있게.
  // content script가 F12에 로그로 찍어주면 SW devtools 없이도 확인 가능.
  used: BackendId;
}

// 사용자가 선택한 백엔드 우선. 실패 시 다른 백엔드로 fallback (1회).
// - gemini는 키 미설정/한도 초과 등 사유로 실패 가능 → google-free로 떨어뜨리는 게 가장 빠름.
// - chrome-builtin은 모델 다운로드 필요해 gemini 사용자의 fallback으로는 가치 낮음.
// - google-free → chrome-builtin fallback도 모델 미다운로드 사용자에겐 실효 없음
//   (chrome-builtin이 'unavailable' throw → 전체 실패). 이미 모델 다운로드한 사용자만 유효.
//   chain에서 빼면 그 사용자가 손해 → 그대로 유지하되 한계 인정.
export async function translateBatch(
  texts: string[],
  src: string,
  tgt: string,
  preferred: BackendId,
): Promise<RouterResult> {
  const order: BackendId[] =
    preferred === 'mindlogic'
      ? ['mindlogic', 'google-free']
      : preferred === 'gemini'
        ? ['gemini', 'google-free']
        : preferred === 'chrome-builtin'
          ? ['chrome-builtin', 'google-free']
          : ['google-free', 'chrome-builtin'];

  let lastErr: unknown = null;
  for (const id of order) {
    try {
      const fn =
        id === 'mindlogic'
          ? mindlogic
          : id === 'gemini'
            ? gemini
            : id === 'chrome-builtin'
              ? chromeBuiltin
              : googleFree;
      const translations = await fn(texts, src, tgt);
      if (id !== preferred) console.warn(TAG, `fell back to ${id} (preferred ${preferred} failed)`);
      return { translations, used: id };
    } catch (e) {
      lastErr = e;
      console.warn(TAG, `backend ${id} failed:`, e instanceof Error ? e.message : String(e));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
