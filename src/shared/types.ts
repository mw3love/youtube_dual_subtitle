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

// isolated → MAIN. Shorts에서 CC 버튼이 없어 페이지 fetch를 trigger 못 할 때,
// playerResponse에서 추출한 caption track baseUrl을 MAIN이 페이지 context에서 직접 fetch하도록 요청.
export interface FetchTimedtextMessage {
  source: 'YDT_CONTENT';
  type: 'FETCH_TIMEDTEXT';
  baseUrl: string;
  videoId: string | null;
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
