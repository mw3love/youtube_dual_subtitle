// 사용자 설정 — chrome.storage.sync에 저장.
// API 키 같은 민감 정보는 여기 두지 않음 (M6에서 chrome.storage.local로 분리).

export type BackendId = 'chrome-builtin' | 'google-free';

export interface Settings {
  subtitlesEnabled: boolean;
  backend: BackendId;
}

export const DEFAULT_SETTINGS: Settings = {
  subtitlesEnabled: true,
  backend: 'google-free', // 안정성 우선. M5 검증 후 chrome-builtin으로 바꿔도 됨.
};

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(raw as Partial<Settings>) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}
