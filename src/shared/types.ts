export interface Word {
  text: string;
  start: number; // 초 단위, video timeline 절대시각
  end: number;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
  // 단어별 reveal용. 자동자막은 JSON3 tOffsetMs에서, 수동자막은 균등 보간으로 채운다.
  words?: Word[];
}

// 문장 재조립 단위 — 인접 cue 여러 개를 한 문장으로 묶은 것.
// Cue의 상위집합(start/end/text/words 그대로 + 구성 cue 범위)이라 렌더러·번역은 Cue처럼 다룬다.
// start/end는 구성 cue들의 합집합, text는 cue 텍스트 join, words는 구성 cue word 타이밍 이어붙임.
// ASR이 단어/구 중간에서 cue를 토막내는 문제(문맥 손실)를 해소하려고 번역·표시를 문장 단위로 끌어올림.
export interface Sentence extends Cue {
  cueStart: number; // 구성 cue 시작 인덱스 (원본 cues 배열 기준)
  cueEnd: number; // 구성 cue 끝 인덱스 (inclusive)
}

// 해설 패널 멀티턴 대화의 한 턴. 후속 질문 시 이전 대화를 문맥으로 background에 전달한다.
// role은 gemini 규약과 동일('user'/'model') — mindlogic 호출부에서 'model'→'assistant'로 매핑.
export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

export interface CaptionTrackInfo {
  baseUrl: string;
  languageCode: string;
  name?: string;
  kind?: 'asr' | undefined;
}

export interface CaptionTracksMessage {
  source: 'YDT_MAIN';
  type: 'CAPTION_TRACKS';
  reason: string;
  videoId: string | null;
  tracks: CaptionTrackInfo[];
}

// MAIN world에서 monkey-patch한 window.fetch가 timedtext 응답을 가로채 보낸다.
// PoToken·쿠키 등 인증이 YouTube 자신의 fetch에 의해 처리되므로 우리가 따로 fetch할 필요 없음.
export interface TimedtextResponseMessage {
  source: 'YDT_MAIN';
  type: 'TIMEDTEXT_RESPONSE';
  url: string;
  body: string;
}

export type MainToContentMessage = CaptionTracksMessage | TimedtextResponseMessage;

// isolated → MAIN. 모든 영상에서 우리 chosen 트랙을 강제 fetch하도록 MAIN에 요청.
// YouTube default는 사용자 hl=ko 기반으로 tlang=ko를 추가하거나 한국어 manual 트랙을
// 잡아 우리 의도와 어긋남 → MAIN이 page의 PoToken을 재사용하되 lang/kind는 chosen으로 교체.
export interface FetchTimedtextMessage {
  source: 'YDT_CONTENT';
  type: 'FETCH_TIMEDTEXT';
  baseUrl: string;
  videoId: string | null;
  languageCode: string;
  kind?: 'asr' | undefined;
}

// isolated → MAIN. 우리 subtitlesEnabled 상태를 MAIN에 전달해 자동 CC 토글이
// 사용자 의도와 충돌하지 않게 한다. false면 자동 토글/강제 재토글 모두 skip.
export interface SubtitlesEnabledMessage {
  source: 'YDT_CONTENT';
  type: 'SUBTITLES_ENABLED';
  enabled: boolean;
}

// isolated → MAIN. 워치독: 영상 진입 후 일정 시간 cue가 안 잡히면 호출.
// capture 중복 방지 Set과 retry 카운터를 reset하고 tryBroadcast를 재발사하도록 요청.
// ytInitialPlayerResponse 늦은 셋팅 / MAIN inject race / 페이지 timedtext 캐시 등 다중 원인 자가복구.
export interface ForceBootMessage {
  source: 'YDT_CONTENT';
  type: 'FORCE_BOOT';
  videoId: string | null;
}

export type ContentToMainMessage = FetchTimedtextMessage | SubtitlesEnabledMessage | ForceBootMessage;
