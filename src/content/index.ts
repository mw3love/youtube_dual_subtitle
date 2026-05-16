// Content script entry — isolated world.
// MAIN world script가 가로챈 timedtext 응답을 받아서 parseJson3 → cue 배열로 만든다.
// 트랙 목록도 받아 어떤 트랙이 선택될지 로깅 (소스 언어 결정용).

import type { CaptionTrackInfo, MainToContentMessage } from '../shared/types';
import { parseJson3 } from '../shared/json3';

const TAG = '[YDT]';
console.log(TAG, 'content script loaded on', location.href);

// 소스 언어 하드코딩 — 설정 UI는 M7에서.
const PREFERRED_SOURCE = 'en';

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const data = ev.data as MainToContentMessage | undefined;
  if (!data || data.source !== 'YDT_MAIN') return;

  if (data.type === 'CAPTION_TRACKS') {
    handleCaptionTracks(data);
  } else if (data.type === 'TIMEDTEXT_RESPONSE') {
    handleTimedtextResponse(data);
  }
});

function trackScore(t: CaptionTrackInfo, preferred: string): number {
  const lang = (t.languageCode ?? '').toLowerCase();
  const isPreferred = lang === preferred || lang.startsWith(`${preferred}-`);
  const isAsr = t.kind === 'asr';
  if (isPreferred && !isAsr) return 0;
  if (isPreferred && isAsr) return 1;
  if (!isPreferred && !isAsr) return 2;
  return 3;
}

function pickTrack(tracks: CaptionTrackInfo[]): CaptionTrackInfo | null {
  if (!tracks.length) return null;
  const sorted = [...tracks].sort(
    (a, b) => trackScore(a, PREFERRED_SOURCE) - trackScore(b, PREFERRED_SOURCE),
  );
  return sorted[0];
}

function handleCaptionTracks(payload: {
  reason: string;
  videoId: string | null;
  tracks: CaptionTrackInfo[];
}): void {
  console.log(
    TAG,
    `available tracks for ${payload.videoId} (${payload.reason}):`,
    payload.tracks.map(
      (t) => `${t.languageCode}${t.kind === 'asr' ? '(asr)' : ''}/${t.name ?? '-'}`,
    ),
  );
  const chosen = pickTrack(payload.tracks);
  if (!chosen) {
    console.log(TAG, 'no caption tracks for', payload.videoId, `(reason: ${payload.reason})`);
    return;
  }
  console.log(
    TAG,
    `chosen track for ${payload.videoId}: lang=${chosen.languageCode} kind=${chosen.kind ?? 'manual'} name=${chosen.name ?? '-'}`,
  );
}

function handleTimedtextResponse(payload: { url: string; body: string }): void {
  // YouTube의 timedtext는 fmt=json3 또는 fmt=srv3, 우리가 받은 그대로 parse 시도.
  // fmt 미지정 시 srv1(XML)이 올 수 있어 그건 일단 무시하고 JSON만 처리.
  if (!payload.body.trimStart().startsWith('{')) {
    console.log(TAG, 'timedtext body is not JSON, skipping (likely srv1/XML)');
    return;
  }
  try {
    const json = JSON.parse(payload.body) as unknown;
    const cues = parseJson3(json);
    console.log(TAG, `cues parsed: ${cues.length}`);
    if (cues.length) {
      console.log(TAG, 'first 3 cues:', cues.slice(0, 3));
      console.log(TAG, 'last cue:', cues[cues.length - 1]);
    }
  } catch (e) {
    console.error(TAG, 'JSON parse failed:', e);
  }
}
