export interface Cue {
  start: number;
  end: number;
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

// isolated → MAIN. Shorts에서 CC 버튼이 없어 페이지 fetch를 trigger 못 할 때,
// playerResponse에서 추출한 caption track baseUrl을 MAIN이 페이지 context에서 직접 fetch하도록 요청.
export interface FetchTimedtextMessage {
  source: 'YDT_CONTENT';
  type: 'FETCH_TIMEDTEXT';
  baseUrl: string;
  videoId: string | null;
}

export type ContentToMainMessage = FetchTimedtextMessage;
