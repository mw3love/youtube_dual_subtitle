// 비공식 Google 무료 번역 엔드포인트.
// translate.googleapis.com/translate_a/single?client=gtx — API 키 불필요.
// 비공식이라 차단/응답 형식 변경 위험 있어 fallback 백엔드 필요 (M5 Chrome 내장).
//
// 입력: 여러 텍스트를 \n으로 join해 한 번에 보내고, 응답 chunk를 다시 join 후 split.
// Google이 \n을 보존한다는 가정 — 실측에서 확인 필요. 안 맞으면 marker 변경 또는 단건 호출로 전환.

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const SEP = '\n';

// 너무 길면 URL 길이 한계(약 8KB)에 걸려 414가 옴. 배치 분할은 호출 측 책임.
export async function translateBatch(
  texts: string[],
  src: string,
  tgt: string,
): Promise<string[]> {
  if (texts.length === 0) return [];

  const url = new URL(ENDPOINT);
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', src);
  url.searchParams.set('tl', tgt);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', texts.join(SEP));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = (await res.json()) as unknown;

  // 응답: [ [ [translated, original, null, null, ...], ... ], ... ]
  const chunks = ((data as unknown[])?.[0] as unknown[]) ?? [];
  const translatedFull = chunks
    .map((c) => (Array.isArray(c) ? (c[0] as string | undefined) ?? '' : ''))
    .join('');

  const result = translatedFull.split(SEP);

  if (result.length !== texts.length) {
    // 줄바꿈 alignment 실패. 일단 어긋난 결과를 반환하고 호출 측이 fallback 처리.
    console.warn(
      '[YDT/google-free] line count mismatch — sent:',
      texts.length,
      'got:',
      result.length,
    );
  }
  return result;
}
