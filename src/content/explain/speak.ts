// 🔊 듣기 — 선택한 표현을 브라우저 내장 TTS(Web Speech API speechSynthesis)로 읽어 준다.
// 키·권한·네트워크 왕복 없이 content script에서 바로 호출 가능(Chrome은 "Google US English" 등
// 원어민 음성을 기본 제공). 품질이 아쉬우면 게이트웨이 TTS를 옵션으로 붙일 여지(미구현).

// getVoices()는 첫 호출 때 빈 배열일 수 있어 모듈 로드 시 한 번 깨워 둔다(목록은 비동기로 채워짐).
try {
  window.speechSynthesis?.getVoices();
} catch {
  /* speechSynthesis 미지원 환경 — speak()에서 조용히 무시 */
}

// 글자 체계로 언어를 추정 — 자막 원문 줄이 아닌 선택(번역 줄·해설 본문·일반 웹페이지)용.
// 라틴 문자는 언어 구분이 안 되므로 학습 대상인 영어로 본다.
export function guessSpeechLang(text: string): string {
  if (/[가-힣]/.test(text)) return 'ko-KR';
  if (/[぀-ヿ]/.test(text)) return 'ja-JP';
  if (/[一-鿿]/.test(text)) return 'zh-CN';
  if (/[Ѐ-ӿ]/.test(text)) return 'ru-RU';
  return 'en-US';
}

// 같은 언어 음성 중 Google 음성(원어민 품질)을 우선, 없으면 그 언어 아무 음성, 그것도 없으면
// lang만 지정해 브라우저가 고르게 둔다. 영어는 en-US를 en-GB보다 우선.
function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const base = lang.toLowerCase().split('-')[0];
  const same = voices.filter((v) => v.lang.toLowerCase().split('-')[0] === base);
  if (!same.length) return null;
  const exact = same.filter((v) => v.lang.toLowerCase() === lang.toLowerCase());
  const pool = exact.length ? exact : same;
  return pool.find((v) => /google/i.test(v.name)) ?? pool[0];
}

export function speak(text: string, lang: string): void {
  const synth = window.speechSynthesis;
  if (!synth || !text.trim()) return;
  // 이전 발화가 남아 있으면 끊고 새로 — 연타 시 큐에 쌓이지 않게.
  synth.cancel();
  // 자막 트랙 언어는 'en'처럼 지역 없이 오므로 영어만 en-US로 보정(그 외는 base 매칭으로 충분).
  const full = lang === 'en' ? 'en-US' : lang;
  const u = new SpeechSynthesisUtterance(text.trim());
  u.lang = full;
  const voice = pickVoice(full);
  if (voice) u.voice = voice;
  synth.speak(u);
}
