// MAIN world와 isolated world 양쪽에서 같은 URL 파싱 로직을 쓰도록 추출.
// chrome.* API 미사용 → MAIN world에서도 안전하게 import 가능.

export function getVideoIdFromLocation(): string | null {
  const q = new URLSearchParams(location.search).get('v');
  if (q) return q;
  const m = location.pathname.match(/\/shorts\/([^/?#]+)/);
  return m?.[1] ?? null;
}
