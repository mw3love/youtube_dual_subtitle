// API 키 등 민감 데이터 저장 — settings(storage.sync)와 의도적으로 분리해 storage.local에 둠.
// 웹스토어 배포 시 사용자의 BYOK 키가 Google 계정 동기화로 다른 기기로 전파되지 않도록.
// storage.local은 익스텐션 sandbox 내부에서만 접근 가능 (다른 익스텐션은 못 봄).

const KEY_GEMINI_API = 'geminiApiKey';

export async function getGeminiApiKey(): Promise<string | null> {
  const r = await chrome.storage.local.get(KEY_GEMINI_API);
  const v = r[KEY_GEMINI_API];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export async function setGeminiApiKey(key: string | null): Promise<void> {
  if (!key) {
    await chrome.storage.local.remove(KEY_GEMINI_API);
    return;
  }
  await chrome.storage.local.set({ [KEY_GEMINI_API]: key });
}
