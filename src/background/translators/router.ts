import type { BackendId } from './types';
import { translateBatch as googleFree } from './google-free';
import { translateBatch as chromeBuiltin } from './chrome-builtin';

const TAG = '[YDT/router]';

// 사용자가 선택한 백엔드 우선. 실패 시 다른 백엔드로 fallback (1회).
// Chrome 내장은 모델 다운로드·지원 언어 제약이 있어 fallback 가치 큼.
export async function translateBatch(
  texts: string[],
  src: string,
  tgt: string,
  preferred: BackendId,
): Promise<string[]> {
  const order: BackendId[] =
    preferred === 'chrome-builtin'
      ? ['chrome-builtin', 'google-free']
      : ['google-free', 'chrome-builtin'];

  let lastErr: unknown = null;
  for (const id of order) {
    try {
      const fn = id === 'chrome-builtin' ? chromeBuiltin : googleFree;
      const result = await fn(texts, src, tgt);
      if (id !== preferred) console.warn(TAG, `fell back to ${id} (preferred ${preferred} failed)`);
      return result;
    } catch (e) {
      lastErr = e;
      console.warn(TAG, `backend ${id} failed:`, e instanceof Error ? e.message : String(e));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
