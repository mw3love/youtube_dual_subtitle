// 영상별 번역 결과 캐시 (IndexedDB via idb-keyval).
// 같은 영상 재시청·중복 fetch 시 0 비용으로 응답.
//
// 만료: 30일 또는 200개 엔트리 초과 시 오래된 것부터 정리.
// 정리는 set 호출 시 lazy하게 (별도 스케줄러 없이 amortized).

import { get, set, del, keys } from 'idb-keyval';

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일
const MAX_ENTRIES = 200;

interface CacheEntry {
  translations: string[];
  createdAt: number;
}

export function makeKey(
  videoId: string,
  src: string,
  tgt: string,
  backend: string,
): string {
  return `ydt::${videoId}::${src}::${tgt}::${backend}`;
}

export async function getCached(key: string): Promise<string[] | null> {
  const entry = (await get(key)) as CacheEntry | undefined;
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    void del(key);
    return null;
  }
  return entry.translations;
}

export async function setCached(key: string, translations: string[]): Promise<void> {
  const entry: CacheEntry = { translations, createdAt: Date.now() };
  await set(key, entry);
  // 너무 자주 도는 비용 막기 위해 5% 확률로만 정리
  if (Math.random() < 0.05) {
    void pruneOldest().catch((e) => console.warn('[YDT/cache] prune failed:', e));
  }
}

async function pruneOldest(): Promise<void> {
  const allKeys = (await keys()).filter(
    (k): k is string => typeof k === 'string' && k.startsWith('ydt::'),
  );
  if (allKeys.length <= MAX_ENTRIES) return;

  // 모든 엔트리 createdAt 읽어 오래된 순으로 제거
  const entries: Array<{ key: string; createdAt: number }> = [];
  for (const k of allKeys) {
    const e = (await get(k)) as CacheEntry | undefined;
    if (e) entries.push({ key: k, createdAt: e.createdAt });
  }
  entries.sort((a, b) => a.createdAt - b.createdAt);
  const toDelete = entries.slice(0, entries.length - MAX_ENTRIES);
  for (const e of toDelete) await del(e.key);
  console.log('[YDT/cache] pruned', toDelete.length, 'entries');
}
