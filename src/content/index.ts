// Content script entry — isolated world.
// MAIN world script가 가로챈 timedtext 응답을 받아서 parseJson3 → cue 배열로 만든다.
// 트랙 목록도 받아 어떤 트랙이 선택될지 로깅 (소스 언어 결정용).

import type { CaptionTrackInfo, Cue, MainToContentMessage } from '../shared/types';
import { parseJson3 } from '../shared/json3';
import { SubtitleRenderer } from './renderer/subtitle-renderer';
import { applyStyleSettings } from './renderer/styles';
import { loadSettings, saveSettings, type Settings } from '../shared/settings';
import { getCached, makeKey, setCached } from '../shared/cache/idb-cache';

const TAG = '[YDT]';

// 중복 주입 가드 — 동일 페이지에 content script가 두 번 실행되면 listener가 중복 등록되어
// 동일 메시지가 여러 번 처리됨. CRX HMR / 수동 reload / manifest 갱신 등에서 발생 가능.
declare global {
  interface Window {
    __YDT_LOADED__?: true;
  }
}
if (window.__YDT_LOADED__) {
  console.warn(TAG, 'content script already loaded — skipping duplicate init');
} else {
  window.__YDT_LOADED__ = true;
  initContent();
}

function initContent(): void {
console.log(TAG, 'content script loaded on', location.href);

const renderer = new SubtitleRenderer();
renderer.setOnPositionChange((mode, pos) => {
  // 드래그로 위치 변경 시 settings 갱신. 다른 필드는 건드리지 않음.
  if (!currentSettings) return;
  const next = {
    ...currentSettings.subtitlePosition,
    [mode]: pos,
  };
  void saveSettings({ subtitlePosition: next });
  // 로컬 cache도 동기화 — storage.onChanged가 돌아오기 전에 일관성 유지
  currentSettings = { ...currentSettings, subtitlePosition: next };
});

function currentVideoId(): string | null {
  const q = new URLSearchParams(location.search).get('v');
  if (q) return q;
  const m = location.pathname.match(/\/shorts\/([^/?#]+)/);
  return m?.[1] ?? null;
}

// 현재 renderer가 들고 있는 cue가 어느 video의 것인지. setCues 호출 시 갱신된다.
// yt-navigate-finish에서 이걸 비교해 stale cue만 clear한다.
let mountedVideoId: string | null = null;
// 마지막 cues 보관 — 언어/백엔드 설정이 바뀌면 영상 reload 없이 재번역하려고.
let lastCues: Cue[] = [];

// 현재 활성 settings 캐시. boot 후 storage.onChanged로 갱신.
// 'en' default는 storage 로드 전 한 짧은 순간 동안만 쓰임.
let currentSettings: Settings | null = null;
function preferredSource(): string {
  return currentSettings?.sourceLang ?? 'en';
}
function targetLang(): string {
  return currentSettings?.targetLang ?? 'ko';
}
function activeBackend(): 'chrome-builtin' | 'google-free' {
  return currentSettings?.backend ?? 'google-free';
}

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

// 팝업이 현재 탭 상태를 묻는다.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const m = msg as { type?: string };
  if (m?.type === 'YDT_GET_STATUS') {
    sendResponse({
      hasCues: lastCues.length > 0,
      cueCount: lastCues.length,
      videoId: mountedVideoId,
      subtitlesEnabled: currentSettings?.subtitlesEnabled ?? false,
      sourceLang: currentSettings?.sourceLang ?? 'en',
      targetLang: currentSettings?.targetLang ?? 'ko',
    });
  }
  return false;
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
    (a, b) => trackScore(a, preferredSource()) - trackScore(b, preferredSource()),
  );
  return sorted[0];
}

// Shorts에서 같은 reel에 대해 중복 direct-fetch 요청 방지.
// 일반 영상은 이 Set을 사용하지 않음 — 페이지 자체 fetch가 인터셉트로 처리됨.
const requestedShortsVideoIds = new Set<string>();

// 같은 트랙의 timedtext가 연속해서 두 번 잡히는 경우(Shorts: page xhr + 우리 direct fetch)
// 두 번째 처리는 setCues 재할당으로 잠깐 깜빡임 유발 → 첫 번째만 처리.
// 직전 1개 key만 보관하므로 사용자가 다른 트랙 갔다가 같은 트랙으로 돌아오면 새로 처리된다.
// key는 (videoId | lang | tlang | kind) 조합. PoToken 같은 변동 파라미터에는 영향 없음.
let lastProcessedTrackKey: string | null = null;

function trackKeyFromUrl(url: string): string | null {
  try {
    const u = new URL(url, location.origin);
    const v = u.searchParams.get('v');
    if (!v) return null;
    const lang = u.searchParams.get('lang') ?? '';
    const tlang = u.searchParams.get('tlang') ?? '';
    const kind = u.searchParams.get('kind') ?? '';
    return `${v}|${lang}|${tlang}|${kind}`;
  } catch {
    return null;
  }
}

function effectiveLangFromUrl(url: string): string | null {
  // 자동번역 트랙은 tlang에 표시 언어. 일반 트랙은 lang에 원본 언어.
  try {
    const u = new URL(url, location.origin);
    return u.searchParams.get('tlang') || u.searchParams.get('lang');
  } catch {
    return null;
  }
}

// 현재 선택된 트랙의 언어 코드. 원본 언어 == 번역 언어일 때 번역 호출을 skip하기 위해 추적.
// handleCaptionTracks에서 갱신, emptied(영상 전환)에서 reset.
let currentTrackLang: string | null = null;

// 트랙 언어가 번역 대상 언어와 같으면 true (sub-tag도 매치: 'ko' === 'ko-KR').
function isTrackLangMatchingTarget(): boolean {
  if (!currentTrackLang) return false;
  const lang = currentTrackLang.toLowerCase();
  const tgt = targetLang().toLowerCase();
  return lang === tgt || lang.startsWith(`${tgt}-`) || tgt.startsWith(`${lang}-`);
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
  // Shorts swipe는 yt-navigate-finish가 발동되지 않아 기존 clearCues 경로가 누락된다.
  // 새 트랙이 broadcast된 시점에 mountedVideoId와 다르면 즉시 이전 cue를 비워
  // 다음 영상 첫 1~2초간 이전 자막이 잘못된 timing으로 보이는 현상을 막는다.
  if (payload.videoId && payload.videoId !== mountedVideoId) {
    console.log(TAG, `new video ${payload.videoId} (was ${mountedVideoId}) — clearing cues`);
    renderer.clearCues();
    lastCues = [];
  }
  const chosen = pickTrack(payload.tracks);
  if (!chosen) {
    console.log(TAG, 'no caption tracks for', payload.videoId, `(reason: ${payload.reason})`);
    return;
  }
  console.log(
    TAG,
    `chosen track for ${payload.videoId}: lang=${chosen.languageCode} kind=${chosen.kind ?? 'manual'} name=${chosen.name ?? '-'}`,
  );

  // 트랙 언어 == 번역 언어면 번역 줄을 숨긴다(모국어 영상에서 의미 없는 paraphrase 방지).
  // cue 도착 전에 미리 적용해 layout 변경을 최소화.
  currentTrackLang = chosen.languageCode ?? null;
  renderer.setSuppressTarget(isTrackLangMatchingTarget());

  // Shorts: 페이지가 자체 fetch를 trigger 안 하므로 MAIN에 직접 fetch 요청.
  // 일반 영상은 CC 버튼 click이 페이지 fetch를 발화 → 우리 monkey-patch가 가로채므로 추가 동작 불필요.
  const isShorts = location.pathname.startsWith('/shorts/');
  if (isShorts && payload.videoId && !requestedShortsVideoIds.has(payload.videoId)) {
    requestedShortsVideoIds.add(payload.videoId);
    window.postMessage(
      {
        source: 'YDT_CONTENT',
        type: 'FETCH_TIMEDTEXT',
        baseUrl: chosen.baseUrl,
        videoId: payload.videoId,
      },
      location.origin,
    );
    console.log(TAG, `requested direct fetch for shorts ${payload.videoId}`);
  }
}

function handleTimedtextResponse(payload: { url: string; body: string }): void {
  // 직전 처리와 같은 트랙이면 Shorts 중복(page xhr + direct fetch)으로 보고 skip.
  // 다른 트랙 갔다가 같은 트랙으로 돌아오면 lastKey가 갱신돼 있어 다시 처리된다.
  const key = trackKeyFromUrl(payload.url);
  if (key && key === lastProcessedTrackKey) {
    console.log(TAG, `same track as last (${key}), skipping duplicate`);
    return;
  }

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

    // 트랙 lang을 URL에서 추출해 suppress 상태 재평가 — 사용자가 CC 메뉴에서 트랙을 바꾸면
    // handleCaptionTracks가 다시 호출되지 않으므로 여기서 currentTrackLang을 갱신해야 한다.
    const urlLang = effectiveLangFromUrl(payload.url);
    if (urlLang && urlLang !== currentTrackLang) {
      currentTrackLang = urlLang;
      renderer.setSuppressTarget(isTrackLangMatchingTarget());
    }

    renderer.setCues(cues);
    // setCues 직후 mountedVideoId 갱신 — yt-navigate-finish가 이후 발생해도
    // 이미 새 video의 cue가 들어왔다는 걸 알아 clear하지 않게 한다.
    mountedVideoId = currentVideoId();
    lastCues = cues;
    if (key) lastProcessedTrackKey = key;
    void translateCues(cues, mountedVideoId);
  } catch (e) {
    console.error(TAG, 'JSON parse failed:', e);
  }
}

// Google 무료 엔드포인트 URL은 ~8KB. cue 텍스트가 길어지면 URL 414가 와서
// 작은 배치로 나눠 부른다. 각 배치 결과가 도착하는 대로 renderer에 점진 반영해
// 사용자가 영상 시작부터 곧장 번역을 본다.
const TRANSLATE_BATCH_SIZE = 50;
// 첫 batch는 작게 — 영상 첫 cue 시점에 번역이 도착하도록.
// google-free는 batch=1회 HTTP라 작아도 손해 적고, chrome-builtin은 N회 순차라
// 첫 batch가 50이면 첫 cue 번역까지 수십 초 → 첫 N개만 우선 처리.
const FIRST_BATCH_SIZE = 8;

async function translateCues(cues: Cue[], requestVideoId: string | null): Promise<void> {
  if (!requestVideoId) return;

  // 트랙 언어가 번역 언어와 같으면 호출 자체를 skip — API 호출 절감 + paraphrase 방지.
  // (suppress flag는 handleCaptionTracks에서 미리 set돼 있어 UI상 target 줄이 hide 상태)
  if (isTrackLangMatchingTarget()) {
    console.log(TAG, `track lang (${currentTrackLang}) matches target (${targetLang()}) — skip translation`);
    return;
  }

  const texts = cues.map((c) => c.text);
  const src = preferredSource();
  const tgt = targetLang();
  const backend = activeBackend();
  const cacheKey = makeKey(requestVideoId, src, tgt, backend);

  // 1) 캐시 hit
  const cached = await getCached(cacheKey);
  if (cached && cached.length === texts.length) {
    console.log(TAG, `cache hit (${backend}): ${cached.length} translations`);
    if (currentVideoId() === requestVideoId) renderer.setTargetTexts(cached);
    return;
  }

  // 2) miss — 배치로 fetch. 첫 batch만 작게, 이후는 표준 크기.
  const all: string[] = [];
  let i = 0;
  while (i < texts.length) {
    const size = i === 0 ? FIRST_BATCH_SIZE : TRANSLATE_BATCH_SIZE;
    const batch = texts.slice(i, i + size);
    let res: { ok: true; translations: string[] } | { ok: false; error: string };
    try {
      res = (await chrome.runtime.sendMessage({
        type: 'TRANSLATE_BATCH',
        texts: batch,
        src,
        tgt,
        backend,
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
    i += batch.length;
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

// 재생목록 자동 다음 재생(쇼츠 재생목록 포함)은 yt-navigate-finish가 발화되지 않아
// 위 핸들러로 처리 안 된다. video element가 새 src로 교체될 때 발화하는 'emptied'
// 이벤트를 직접 감지해 cleanup. document capture phase로 모든 video를 잡는다.
// emptied는 같은 영상의 단순 play/pause/seek에는 발화하지 않아 false trigger 적음.
document.addEventListener(
  'emptied',
  (ev) => {
    if (!(ev.target instanceof HTMLVideoElement)) return;
    const r = ev.target.getBoundingClientRect();
    // 화면 밖 hidden video element(광고 preroll, preload 등) 무시
    if (r.width < 100 || r.height < 100) return;
    console.log(TAG, 'video emptied — clearing cues (next video transition)');
    renderer.clearCues();
    lastCues = [];
    // 같은 영상 재진입 시 dedup이 cue 표시를 막지 않도록 timedtext 처리 이력 초기화.
    // (Shorts direct-fetch 이력도 같이 비워 재진입 영상이 Shorts면 다시 요청 가능)
    lastProcessedTrackKey = null;
    requestedShortsVideoIds.clear();
    // 트랙 언어 정보 reset — 새 영상의 handleCaptionTracks가 다시 세팅한다.
    currentTrackLang = null;
    renderer.setSuppressTarget(false);
  },
  true,
);

// settings를 한 번에 적용 — display mode·visibility·styles 모두.
// 호출 흐름: boot 시 1회, storage.onChanged 시마다.
function applySettings(s: Settings): void {
  currentSettings = s;
  renderer.setUserVisible(s.subtitlesEnabled);
  renderer.setDisplayMode(s.displayMode);
  renderer.setWordRevealEnabled(s.wordRevealEnabled);
  applyStyleSettings({
    sourceStyle: s.sourceStyle,
    targetStyle: s.targetStyle,
    shortsFontScale: s.shortsFontScale,
    backgroundOpacity: s.backgroundOpacity,
    lineHeight: s.lineHeight,
  });
  renderer.setPositions(s.subtitlePosition);
}

void loadSettings().then(applySettings);

// C 키로 듀얼 자막 on/off. YouTube native 핸들러도 함께 발화하도록 preventDefault 안 함 —
// 하단 자막 버튼 시각 상태도 자동 동기화된다. native 자막은 hide-native-captions CSS로 안 보임.
// input/textarea/contenteditable focus 시는 통과 (검색창 'c' 입력 보호).
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'c') return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const t = ev.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!currentSettings) return;
  const next = !currentSettings.subtitlesEnabled;
  void saveSettings({ subtitlesEnabled: next });
  console.log(TAG, `toggled: ${next ? 'on' : 'off'} via shortcut`);
});

// 번역 결과를 바꾸는 키 — 변경되면 현재 영상 다시 번역.
const RETRANSLATE_KEYS = new Set(['sourceLang', 'targetLang', 'backend']);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  // 변경 키가 무엇이든 settings 전체를 다시 읽어 일관되게 반영.
  // partial diff 적용은 복잡하고 zod 검증 우회 위험.
  void loadSettings()
    .then((s) => {
      console.log(TAG, 'settings changed:', Object.keys(changes));
      applySettings(s);

      // targetLang 변경 시 suppress 재평가 — 한국어 영상에서 target=ko↔en 토글에 즉시 반응.
      // (translateCues가 호출되면 그 안에서도 한 번 더 체크해 호출만 skip되지만, 미리 setSuppress해
      //  UI 깜빡임을 줄인다.)
      if (changes.targetLang) {
        renderer.setSuppressTarget(isTrackLangMatchingTarget());
      }

      const needsRetranslate = Object.keys(changes).some((k) => RETRANSLATE_KEYS.has(k));
      if (needsRetranslate && lastCues.length > 0 && mountedVideoId) {
        console.log(TAG, 'retranslating with new settings');
        void translateCues(lastCues, mountedVideoId);
      }
    })
    .catch((e) => console.warn(TAG, 'reload settings failed:', e));
});

} // end initContent
