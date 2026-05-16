// Background service worker entry.
// M2 시점: 자막 fetch는 MAIN world에서 YouTube 자신이 처리하므로 background가 할 일이 없다.
// M4 이후 번역 백엔드 라우팅·캐시·offscreen 관리를 여기서 한다.

const TAG = '[YDT/bg]';
console.log(TAG, 'background service worker started');

chrome.runtime.onInstalled.addListener((details) => {
  console.log(TAG, 'onInstalled', details.reason);
});
