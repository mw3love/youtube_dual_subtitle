// API 키 등 민감 데이터 + 비-동기화 런타임 상태를 chrome.storage.local에 저장.
// settings(storage.sync)와 의도적으로 분리해 두 가지를 한 곳에 모은다:
// 1) 웹스토어 배포 시 사용자의 BYOK 키가 Google 계정 동기화로 다른 기기로 전파되지 않도록.
// 2) "마지막 번역 백엔드" 같은 휘발성 정보는 다른 기기와 공유할 가치 없음.
// storage.local은 익스텐션 sandbox 내부에서만 접근 가능 (다른 익스텐션은 못 봄).

import type { BackendId } from '../background/translators/types';

const KEY_GEMINI_API = 'geminiApiKey';
const KEY_MINDLOGIC_API = 'mindlogicApiKey';
const KEY_LAST_BACKEND = 'lastBackend';

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

export async function getMindlogicApiKey(): Promise<string | null> {
  const r = await chrome.storage.local.get(KEY_MINDLOGIC_API);
  const v = r[KEY_MINDLOGIC_API];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export async function setMindlogicApiKey(key: string | null): Promise<void> {
  if (!key) {
    await chrome.storage.local.remove(KEY_MINDLOGIC_API);
    return;
  }
  await chrome.storage.local.set({ [KEY_MINDLOGIC_API]: key });
}

// "마지막 번역 호출 결과" — 팝업에 표시. SW devtools 없이도 어느 백엔드가 실제 동작 중인지 확인.
export interface LastBackendInfo {
  used: BackendId; // 실제 처리한 백엔드
  preferred: BackendId; // 사용자가 선택한 백엔드 (다르면 fallback 발생)
  at: number; // epoch ms
}

export async function getLastBackend(): Promise<LastBackendInfo | null> {
  const r = await chrome.storage.local.get(KEY_LAST_BACKEND);
  const v = r[KEY_LAST_BACKEND];
  if (
    v &&
    typeof v === 'object' &&
    typeof (v as LastBackendInfo).used === 'string' &&
    typeof (v as LastBackendInfo).at === 'number'
  ) {
    return v as LastBackendInfo;
  }
  return null;
}

export async function setLastBackend(info: LastBackendInfo): Promise<void> {
  await chrome.storage.local.set({ [KEY_LAST_BACKEND]: info });
}
