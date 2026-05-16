// Content script entry — isolated world.
// MAIN world script가 가로챈 timedtext 응답을 받아서 parseJson3 → cue 배열로 만든다.
// 트랙 목록도 받아 어떤 트랙이 선택될지 로깅 (소스 언어 결정용).

import type { CaptionTrackInfo, Cue, MainToContentMessage } from '../shared/types';
import { parseJson3 } from '../shared/json3';
import { SubtitleRenderer } from './renderer/subtitle-renderer';
import { loadSettings } from '../shared/settings';
import { getCached, makeKey, setCached } from '../shared/cache/idb-cache';

const TAG = '[YDT]';
console.log(TAG, 'content script loaded on', location.href);

const renderer = new SubtitleRenderer();

function currentVideoId(): string | null {
  const q = new URLSearchParams(location.search).get('v');
  if (q) return q;
  const m = location.pathname.match(/\/shorts\/([^/?#]+)/);
  return m?.[1] ?? null;
}

// 현재 renderer가 들고 있는 cue가 어느 video의 것인지. setCues 호출 시 갱신된다.
// yt-navigate-finish에서 이걸 비교해 stale cue만 clear한다.
let mountedVideoId: string | null = null;

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
    if (cues.length === 0) return;
    renderer.setCues(cues);
    // setCues 직후 mountedVideoId 갱신 — yt-navigate-finish가 이후 발생해도
    // 이미 새 video의 cue가 들어왔다는 걸 알아 clear하지 않게 한다.
    mountedVideoId = currentVideoId();
    void translateCues(cues, mountedVideoId);
  } catch (e) {
    console.error(TAG, 'JSON parse failed:', e);
  }
}

// Google 무료 엔드포인트 URL은 ~8KB. cue 텍스트가 길어지면 URL 414가 와서
// 작은 배치로 나눠 부른다. 각 배치 결과가 도착하는 대로 renderer에 점진 반영해
// 사용자가 영상 시작부터 곧장 번역을 본다.
const TRANSLATE_BATCH_SIZE = 50;

async function translateCues(cues: Cue[], requestVideoId: string | null): Promise<void> {
  if (!requestVideoId) return;
  const texts = cues.map((c) => c.text);
  const cacheKey = makeKey(requestVideoId, 'en', 'ko', 'google-free');

  // 1) 캐시 hit
  const cached = await getCached(cacheKey);
  if (cached && cached.length === texts.length) {
    console.log(TAG, `cache hit: ${cached.length} translations`);
    if (currentVideoId() === requestVideoId) renderer.setTargetTexts(cached);
    return;
  }

  // 2) miss — 배치로 fetch
  const all: string[] = [];
  for (let i = 0; i < texts.length; i += TRANSLATE_BATCH_SIZE) {
    const batch = texts.slice(i, i + TRANSLATE_BATCH_SIZE);
    let res: { ok: true; translations: string[] } | { ok: false; error: string };
    try {
      res = (await chrome.runtime.sendMessage({
        type: 'TRANSLATE_BATCH',
        texts: batch,
        src: 'en',
        tgt: 'ko',
      })) as typeof res;
    } catch (e) {
      console.error(TAG, 'translate request failed:', e);
      return;
    }

    if (currentVideoId() !== requestVideoId) {
      console.log(TAG, 'translate: video changed mid-flight, dropping');
      return;
    }
    if (!res.ok) {
      console.error(TAG, 'translate failed:', res.error);
      return;
    }

    all.push(...res.translations);
    renderer.setTargetTexts(all);
  }
  console.log(TAG, `translate complete: ${all.length}/${texts.length}`);

  // 3) 전체 길이 일치할 때만 캐시 (alignment 어긋난 결과 캐싱 방지)
  if (all.length === texts.length) {
    void setCached(cacheKey, all).catch((e) => console.warn(TAG, 'cache write failed:', e));
  }
}

// 영상이 실제로 바뀌었고 아직 새 cue가 도착하지 않은 경우만 cue 비움.
// 새 cue가 이미 setCues됐다면 mountedVideoId가 새 ID로 갱신돼 비교가 통과돼 clear 안 함.
window.addEventListener('yt-navigate-finish', () => {
  const next = currentVideoId();
  if (next !== mountedVideoId) {
    console.log(TAG, `nav: mounted=${mountedVideoId}, now=${next} — clearing cues`);
    renderer.clearCues();
  }
});

// 자막 표시는 popup의 토글로 제어 (chrome.storage.sync).
// native CC 버튼 토글은 안 따라간다 — YouTube의 CC click을 표준 이벤트로 잡을 수 없고
// 우리 자동 토글과 구분이 어려워 popup 컨트롤로 일원화.
void loadSettings().then((s) => {
  renderer.setUserVisible(s.subtitlesEnabled);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if ('subtitlesEnabled' in changes) {
    const enabled = changes.subtitlesEnabled.newValue !== false;
    console.log(TAG, 'settings: subtitlesEnabled =', enabled);
    renderer.setUserVisible(enabled);
  }
});
