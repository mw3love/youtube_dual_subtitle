// Content script entry — isolated world.
// MAIN world script가 가로챈 timedtext 응답을 받아서 parseJson3 → cue 배열로 만든다.
// 트랙 목록도 받아 어떤 트랙이 선택될지 로깅 (소스 언어 결정용).

import type { CaptionTrackInfo, Cue, MainToContentMessage, Sentence } from '../shared/types';
import { parseJson3 } from '../shared/json3';
import { segmentCues } from '../shared/segment';
import { SubtitleRenderer } from './renderer/subtitle-renderer';
import { applyStyleSettings } from './renderer/styles';
import { ExplainUI, type ExplainResult, type NotionSaveResult } from './explain/explain-ui';
import { loadSettings, saveSettings, type BackendId, type Settings } from '../shared/settings';
import { makeKey } from '../shared/cache/idb-cache';
import { getVideoIdFromLocation } from '../shared/url';
import { explainModelLabel } from '../shared/lang-options';

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

// 휠로 폰트 크기 조절 → CSS 변수는 즉시 반영, storage 저장은 debounce.
// chrome.storage.sync 쿼터(분당 120회)를 빠른 휠 스크롤이 넘기지 않도록 ~300ms 묶음.
let fontSizeSaveTimer: number | null = null;
renderer.setOnFontSizeChange((sourceSize, targetSize) => {
  if (!currentSettings) return;
  const sourceStyle = { ...currentSettings.sourceStyle, fontSize: sourceSize };
  const targetStyle = { ...currentSettings.targetStyle, fontSize: targetSize };
  // 즉시 화면 반영 — applySettings를 거치지 않고 CSS 변수만 갱신해도 충분.
  applyStyleSettings({
    sourceStyle,
    targetStyle,
    shortsFontScale: currentSettings.shortsFontScale,
    backgroundOpacity: currentSettings.backgroundOpacity,
    lineHeight: currentSettings.lineHeight,
  });
  currentSettings = { ...currentSettings, sourceStyle, targetStyle };
  if (fontSizeSaveTimer !== null) clearTimeout(fontSizeSaveTimer);
  fontSizeSaveTimer = window.setTimeout(() => {
    fontSizeSaveTimer = null;
    void saveSettings({ sourceStyle, targetStyle });
  }, 300);
});

// 단어/표현 해설 — 자막 드래그 선택 → 버튼 → AI 해설 패널. 선택 텍스트 + 자막 문맥을
// background EXPLAIN으로 보내고 markdown을 받아 패널이 렌더한다. 백엔드/모델/프롬프트는
// 현재 settings에서 가져옴(키는 background가 secrets.ts에서 읽음).
async function requestExplain(text: string, context: string): Promise<ExplainResult> {
  const s = currentSettings;
  if (!s) return { ok: false, error: '설정 로드 전입니다. 잠시 후 다시 시도하세요.' };
  if (!s.explainPrompt.trim()) {
    return { ok: false, error: '해설 프롬프트가 비어 있어요 (옵션에서 입력하거나 "기본값으로").' };
  }
  const model = s.explainBackend === 'gemini' ? s.explainGeminiModel : s.explainMindlogicModel;
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'EXPLAIN',
      text,
      context,
      backend: s.explainBackend,
      model,
      prompt: s.explainPrompt,
    })) as ExplainResult | undefined;
    if (!res) return { ok: false, error: '백그라운드 응답 없음 — 확장 재로드' };
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
// 자유 질문 — 드래그 선택 + 사용자 질문을 background EXPLAIN으로 보낸다(question 필드 동봉).
// 해설과 같은 경로지만 question이 있으면 background가 질문 전용 프롬프트를 쓴다(해설 프롬프트
// 비어도 됨 — 그래서 여기선 explainPrompt 비어있음 가드 안 함).
async function requestQuestion(
  text: string,
  context: string,
  question: string,
): Promise<ExplainResult> {
  const s = currentSettings;
  if (!s) return { ok: false, error: '설정 로드 전입니다. 잠시 후 다시 시도하세요.' };
  const model = s.explainBackend === 'gemini' ? s.explainGeminiModel : s.explainMindlogicModel;
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'EXPLAIN',
      text,
      context,
      question,
      backend: s.explainBackend,
      model,
      prompt: s.explainPrompt,
    })) as ExplainResult | undefined;
    if (!res) return { ok: false, error: '백그라운드 응답 없음 — 확장 재로드' };
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
// 해설을 Notion DB에 페이지로 저장 — background가 Notion API 호출(토큰은 secrets.ts).
// 영상 제목·URL은 content가 알고 있으니 같이 보내 페이지 본문/속성에 넣게 한다.
async function requestNotionSave(
  term: string,
  markdown: string,
  context: string,
): Promise<NotionSaveResult> {
  const s = currentSettings;
  if (!s) return { ok: false, error: '설정 로드 전입니다.' };
  if (!s.notionDatabaseId.trim()) {
    return { ok: false, error: 'Notion 데이터베이스 ID가 비어 있어요 (옵션에서 입력).' };
  }
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'NOTION_SAVE',
      term,
      markdown,
      context,
      databaseId: s.notionDatabaseId,
      videoTitle: videoTitle(),
      videoUrl: location.href,
    })) as NotionSaveResult | undefined;
    if (!res) return { ok: false, error: '백그라운드 응답 없음 — 확장 재로드' };
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
// 해설 로딩 메시지에 띄울 현재 해설 모델 이름 ("Gemini 3.5 Flash" 등). 설정 로드 전이면 빈 문자열.
function currentExplainModelLabel(): string {
  const s = currentSettings;
  if (!s) return '';
  return explainModelLabel(s.explainBackend, s.explainGeminiModel, s.explainMindlogicModel);
}
const explainUI = new ExplainUI(
  requestExplain,
  requestQuestion,
  requestNotionSave,
  currentExplainModelLabel,
);

const currentVideoId = getVideoIdFromLocation;

// 현재 renderer가 들고 있는 cue가 어느 video의 것인지. setCues 호출 시 갱신된다.
// yt-navigate-finish에서 이걸 비교해 stale cue만 clear한다.
let mountedVideoId: string | null = null;
// 마지막 cues 보관 — raw cue는 팝업 상태(자막 유무) 표시용.
let lastCues: Cue[] = [];
// 재조립된 문장 — 번역·렌더의 실제 단위. 언어/백엔드 변경 시 reload 없이 재번역하려고 보관.
let lastSentences: Sentence[] = [];

// 현재 활성 settings 캐시. boot 후 storage.onChanged로 갱신.
// 'en' default는 storage 로드 전 한 짧은 순간 동안만 쓰임.
let currentSettings: Settings | null = null;
function preferredSource(): string {
  return currentSettings?.sourceLang ?? 'en';
}
function targetLang(): string {
  return currentSettings?.targetLang ?? 'ko';
}
function activeBackend(): BackendId {
  return currentSettings?.backend ?? 'google-free';
}
// 영상 제목 — LLM 백엔드에 주제 문맥으로 전달. document.title은 "(2) 제목 - YouTube" 형태라
// 알림 카운트 prefix와 " - YouTube" suffix를 벗겨 제목만 남김.
function videoTitle(): string {
  return document.title
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s*-\s*YouTube\s*$/, '')
    .trim();
}

// 캐시 키용 backend 식별자. 모델 선택이 있는 BYOK 백엔드는 모델 ID까지 합성해 캐시 분리.
// google-free·chrome-builtin은 기존 키 포맷 유지(하위 호환).
function cacheBackendTag(): string {
  const b = activeBackend();
  if (b === 'gemini') {
    const model = currentSettings?.geminiModel ?? 'gemini-2.5-flash';
    return `gemini:${model}`;
  }
  if (b === 'mindlogic') {
    const model = currentSettings?.mindlogicModel ?? 'claude-sonnet-4-6';
    return `mindlogic:${model}`;
  }
  return b;
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

  // L2: 영상 원본 lang 자동 감지 — ASR 트랙의 lang이 영상 음성 lang.
  // 영상 원본이 사용자 모국어(targetLang)면 모국어 single 의도로 보고 그 lang 트랙 강제.
  // (외국어 영상에 모국어 manual이 있어도 학습 의도로 외국어 우선은 그대로.)
  const asrTrack = tracks.find((t) => t.kind === 'asr');
  const videoLang = asrTrack?.languageCode?.toLowerCase() ?? null;
  const tgt = targetLang().toLowerCase();
  if (videoLang && (videoLang === tgt || videoLang.startsWith(`${tgt}-`))) {
    const tgtManual = tracks.find((t) => {
      const l = (t.languageCode ?? '').toLowerCase();
      return (l === tgt || l.startsWith(`${tgt}-`)) && t.kind !== 'asr';
    });
    if (tgtManual) return tgtManual;
    const tgtAsr = tracks.find((t) => {
      const l = (t.languageCode ?? '').toLowerCase();
      return (l === tgt || l.startsWith(`${tgt}-`)) && t.kind === 'asr';
    });
    if (tgtAsr) return tgtAsr;
  }

  // 외국어 영상 → preferredSource 매치 우선 (기존 로직)
  const sorted = [...tracks].sort(
    (a, b) => trackScore(a, preferredSource()) - trackScore(b, preferredSource()),
  );
  return sorted[0];
}

// 같은 videoId에 대해 중복 direct-fetch 요청 방지. emptied 시 clear.
const requestedDirectFetchVideoIds = new Set<string>();

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
    lastSentences = [];
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

  // 모든 영상에서 우리가 chosen 트랙을 강제 fetch — YouTube default 무시.
  // (이전엔 Shorts만 direct fetch했고 일반 영상은 page fetch에 의존했으나, page는
  //  사용자 hl=ko 기반으로 tlang=ko 자동 추가 / 한국어 manual 트랙 default 잡음 → 우리 의도 어긋남.)
  if (payload.videoId && !requestedDirectFetchVideoIds.has(payload.videoId)) {
    requestedDirectFetchVideoIds.add(payload.videoId);
    window.postMessage(
      {
        source: 'YDT_CONTENT',
        type: 'FETCH_TIMEDTEXT',
        baseUrl: chosen.baseUrl,
        videoId: payload.videoId,
        languageCode: chosen.languageCode,
        kind: chosen.kind,
      },
      location.origin,
    );
    console.log(
      TAG,
      `requested direct fetch for ${payload.videoId} (lang=${chosen.languageCode} kind=${chosen.kind ?? 'manual'})`,
    );
  }
}

function handleTimedtextResponse(payload: { url: string; body: string }): void {
  // tlang 있는 응답은 YouTube의 자동번역(사용자 hl 기반 default) — 우리는 chosen 트랙을
  // 별도 direct fetch하므로 page의 tlang 응답은 skip해서 우리 direct만 처리한다.
  // 그렇지 않으면 page 응답이 먼저 도착 → currentTrackLang='ko' → suppress 되어 듀얼 깨짐.
  try {
    const tlang = new URL(payload.url, location.origin).searchParams.get('tlang');
    if (tlang) {
      console.log(TAG, `skipping page response with tlang=${tlang} — waiting for direct fetch`);
      return;
    }
  } catch {
    // URL parse 실패 시 그대로 진행
  }
  // 직전 처리와 같은 트랙이면 중복(page xhr + direct fetch)으로 보고 skip.
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
    // ASR이 토막낸 cue를 문장으로 재조립 — 번역·표시 단위를 문장으로 끌어올려 문맥 손실 해소.
    const sentences = segmentCues(cues);
    console.log(TAG, `cues parsed: ${cues.length} → sentences: ${sentences.length}`);
    if (sentences.length === 0) return;

    // 트랙 lang을 URL에서 추출해 suppress 상태 재평가 — 사용자가 CC 메뉴에서 트랙을 바꾸면
    // handleCaptionTracks가 다시 호출되지 않으므로 여기서 currentTrackLang을 갱신해야 한다.
    const urlLang = effectiveLangFromUrl(payload.url);
    if (urlLang && urlLang !== currentTrackLang) {
      currentTrackLang = urlLang;
      renderer.setSuppressTarget(isTrackLangMatchingTarget());
    }

    // Sentence는 Cue 상위집합이라 렌더러는 그대로 문장을 cue처럼 다룬다(블록 표시 + word-reveal).
    renderer.setCues(sentences);
    // setCues 직후 mountedVideoId 갱신 — yt-navigate-finish가 이후 발생해도
    // 이미 새 video의 cue가 들어왔다는 걸 알아 clear하지 않게 한다.
    mountedVideoId = currentVideoId();
    lastCues = cues;
    lastSentences = sentences;
    if (key) lastProcessedTrackKey = key;
    // 자막 들어왔으니 워치독 해제 — 재발사가 새 trigger(영상 변경) 때 다시 걸린다.
    clearWatchdog();
    void translateCues(sentences, mountedVideoId);
  } catch (e) {
    console.error(TAG, 'JSON parse failed:', e);
  }
}

// Google 무료 엔드포인트 URL은 ~8KB. 단위가 cue→문장으로 커져(문장은 보통 2~4배 길다)
// 옛 50이면 URL 414 위험 → 25로 낮춰 join 길이를 비슷하게 유지. 각 배치 결과가 도착하는
// 대로 renderer에 점진 반영해 사용자가 영상 시작부터 곧장 번역을 본다.
const TRANSLATE_BATCH_SIZE = 25;
// 첫 batch는 작게 — 영상 첫 문장 시점에 번역이 도착하도록.
// google-free는 batch=1회 HTTP라 작아도 손해 적고, chrome-builtin은 N회 순차라
// 첫 batch가 크면 첫 문장 번역까지 수십 초 → 첫 N개만 우선 처리.
const FIRST_BATCH_SIZE = 4;

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
  const cacheKey = makeKey(requestVideoId, src, tgt, cacheBackendTag());

  // 1) 캐시 hit
  const cached = await getCachedViaBg(cacheKey);
  if (cached && cached.length === texts.length) {
    console.log(TAG, `cache hit (${cacheBackendTag()}): ${cached.length} translations`);
    if (currentVideoId() === requestVideoId) renderer.setTargetTexts(cached);
    return;
  }

  // 2) miss — 배치로 fetch. 첫 batch만 작게, 이후는 표준 크기.
  const all: string[] = [];
  const usedSet = new Set<string>(); // 어떤 백엔드(들)로 처리됐는지 — 마지막에 한 줄로 요약.
  let i = 0;
  while (i < texts.length) {
    const size = i === 0 ? FIRST_BATCH_SIZE : TRANSLATE_BATCH_SIZE;
    const batch = texts.slice(i, i + size);
    let res:
      | { ok: true; translations: string[]; used?: BackendId }
      | { ok: false; error: string };
    try {
      res = (await chrome.runtime.sendMessage({
        type: 'TRANSLATE_BATCH',
        texts: batch,
        src,
        tgt,
        backend,
        videoTitle: videoTitle(),
      })) as typeof res;
    } catch (e) {
      console.error(TAG, 'translate request failed:', e);
      return;
    }
    if (!res) {
      // service worker dead — 드물지만 dev 빌드/MV3 wake-up race에서 발생 가능.
      console.warn(TAG, `translate batch ${i}: null response (service worker?)`);
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

    if (res.used) usedSet.add(res.used);
    // 배치마다 한 줄 로그 — F12에서 실제 사용된 백엔드를 바로 확인 (SW devtools 불필요).
    console.log(
      TAG,
      `batch ${i}-${i + batch.length - 1}: ${res.translations.length}/${batch.length} via ${res.used ?? '?'}` +
        (res.used && res.used !== backend ? ` ⚠ preferred ${backend} fell back` : ''),
    );
    all.push(...res.translations);
    renderer.setTargetTexts(all);
    i += batch.length;
  }
  const usedSummary = usedSet.size === 0 ? '?' : Array.from(usedSet).join('+');
  console.log(TAG, `translate complete: ${all.length}/${texts.length} via ${usedSummary}`);

  // 3) 전체 길이 일치할 때만 캐시 (alignment 어긋난 결과 캐싱 방지)
  if (all.length === texts.length) {
    setCachedViaBg(cacheKey, all);
  }
}

// 캐시 접근은 background에 위임 — content script의 IndexedDB는 youtube.com origin이라
// 옵션 페이지(확장 origin)의 "비우기"가 닿지 못한다. SW가 확장 origin DB를 소유하도록 일원화.
async function getCachedViaBg(key: string): Promise<string[] | null> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'CACHE_GET', key })) as
      | { translations: string[] | null }
      | undefined;
    return res?.translations ?? null;
  } catch (e) {
    console.warn(TAG, 'cache get failed:', e);
    return null;
  }
}

function setCachedViaBg(key: string, translations: string[]): void {
  void chrome.runtime
    .sendMessage({ type: 'CACHE_SET', key, translations })
    .catch((e) => console.warn(TAG, 'cache write failed:', e));
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
    lastSentences = [];
    // 같은 영상 재진입 시 dedup이 cue 표시를 막지 않도록 timedtext 처리 이력 초기화.
    // (Shorts direct-fetch 이력도 같이 비워 재진입 영상이 Shorts면 다시 요청 가능)
    lastProcessedTrackKey = null;
    requestedDirectFetchVideoIds.clear();
    // 트랙 언어 정보 reset — 새 영상의 handleCaptionTracks가 다시 세팅한다.
    currentTrackLang = null;
    renderer.setSuppressTarget(false);
    // Shorts swipe / 일반 영상 자동 다음 재생 시 CC 버튼 element가 새로 mount될 수 있어
    // observer 재attach. (yt-navigate-finish는 이 케이스에서 발화 안 함)
    ensureCcObserver();
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
  renderer.setSingleContextLines(s.singleContextLines);
  renderer.setDimHistory(s.dimHistory);
  renderer.setHistoryLayout(s.historyLayout);
  renderer.setFontSizes(s.sourceStyle.fontSize, s.targetStyle.fontSize);
  applyStyleSettings({
    sourceStyle: s.sourceStyle,
    targetStyle: s.targetStyle,
    shortsFontScale: s.shortsFontScale,
    backgroundOpacity: s.backgroundOpacity,
    lineHeight: s.lineHeight,
  });
  renderer.setPositions(s.subtitlePosition);
  explainUI.setEnabled(s.explainEnabled);
  explainUI.setNotionEnabled(s.notionEnabled);
  // MAIN world에도 전달 — inject-main의 자동 CC 토글이 사용자 설정에 맞춰 동작하도록.
  window.postMessage(
    { source: 'YDT_CONTENT', type: 'SUBTITLES_ENABLED', enabled: s.subtitlesEnabled },
    location.origin,
  );
}

void loadSettings().then(applySettings);

// CC 버튼 양방향 동기 — 사용자가 native CC를 직접 클릭하면 우리 subtitlesEnabled도 따라감.
// 우리 C 키 토글이나 자동 토글로 인한 변화도 같이 감지되지만 saveSettings가 idempotent +
// 이미 같은 값이면 storage.onChanged가 안 발화하므로 무한 루프는 없음.
let ccButtonObserver: MutationObserver | null = null;
let observedCcButton: HTMLElement | null = null;

// ccObserver — page CC 버튼 상태와 우리 storage sync. 단 한 방향만:
//   CC=true → 우리 true (사용자가 native CC를 켰거나 우리 tryEnableCaptions이 켰음)
//   CC=false → 무시 (page sticky의 잘못된 lang으로 자막 자동 disable되는 케이스를 막기 위해.
//   자막 끄기는 사용자가 C 키나 팝업으로만 — page CC의 disable은 sticky-induced로 가정.)
function syncSubtitlesEnabledFromCc(btn: HTMLElement): void {
  const pressed = btn.getAttribute('aria-pressed') === 'true';
  if (!currentSettings) return;
  if (currentSettings.subtitlesEnabled === pressed) return;
  if (!pressed) return;
  console.log(TAG, `CC button -> subtitlesEnabled=true`);
  void saveSettings({ subtitlesEnabled: true });
}

function attachCcObserver(): void {
  // Shorts는 .ytmClosedCaptioningButtonButton(가시), 일반은 .ytp-subtitles-button.
  // 화면에 실제로 보이는 쪽을 우선. Shorts 페이지엔 둘 다 존재하는데 일반 셀렉터는 hidden.
  const candidates = [
    '.ytmClosedCaptioningButtonButton',
    '.ytp-subtitles-button',
  ];
  let btn: HTMLElement | null = null;
  for (const sel of candidates) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && el.getBoundingClientRect().width > 0) {
      btn = el;
      break;
    }
  }
  if (!btn || btn === observedCcButton) return;
  ccButtonObserver?.disconnect();
  observedCcButton = btn;
  ccButtonObserver = new MutationObserver(() => syncSubtitlesEnabledFromCc(btn));
  ccButtonObserver.observe(btn, { attributes: true, attributeFilter: ['aria-pressed'] });
  // 첫 attach 시도 한 번 sync. (한 방향 sync라 추가 분기 불필요)
  syncSubtitlesEnabledFromCc(btn);
}

// player가 DOM에 늦게 들어올 수 있어 짧게 retry. Shorts는 CC 버튼 없으므로 자연스럽게 패스.
const CC_OBSERVER_RETRY_MS = [0, 500, 1500, 3000];
function ensureCcObserver(attempt = 0): void {
  attachCcObserver();
  if (!observedCcButton && attempt + 1 < CC_OBSERVER_RETRY_MS.length) {
    setTimeout(() => ensureCcObserver(attempt + 1), CC_OBSERVER_RETRY_MS[attempt + 1]);
  }
}
ensureCcObserver();
// SPA navigate로 player가 새로 mount될 수 있어 재시도.
window.addEventListener('yt-navigate-finish', () => ensureCcObserver());
// 1초 폴링은 아래 tickWatchdog과 합쳐 한 interval로 처리 (성능: setInterval 3→2).

// C 키로 듀얼 자막 on/off.
// YouTube native 'c' 핸들러는 .ytp-subtitles-button만 click하므로 Shorts에선 CC 시각 동기가
// 안 된다. 우리가 책임지고 setting 토글 + 적절한 CC 버튼 click 둘 다 수행.
// capture phase + stopImmediatePropagation으로 native 중복 발화 차단 — 안 그러면 일반 영상에서
// 우리 click과 native click이 합쳐져 토글이 상쇄될 수 있음.
// input/textarea/contenteditable focus 시는 통과 (검색창 'c' 입력 보호).
// 키 판별은 ev.code('KeyC', 물리 키)로 — ev.key는 CapsLock 시 'C', 한글 IME 시 'ㅊ'이 되어
// 새는 반면 native(keyCode 기반)는 발화해 "CC 아이콘만 바뀌고 우리 자막은 안 토글"되는 불일치 방지.
document.addEventListener(
  'keydown',
  (ev) => {
    if (ev.code !== 'KeyC' && ev.key !== 'c') return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!currentSettings) return;
    ev.stopImmediatePropagation();
    const next = !currentSettings.subtitlesEnabled;
    void saveSettings({ subtitlesEnabled: next });
    // CC 버튼이 있고 상태가 우리와 다르면 click해 시각 동기. MutationObserver가
    // 같은 값으로 또 saveSettings 호출해도 storage no-op이라 안전.
    const btn = observedCcButton;
    if (btn && (btn.getAttribute('aria-pressed') === 'true') !== next) {
      btn.click();
    }
    console.log(TAG, `toggled: ${next ? 'on' : 'off'} via shortcut`);
  },
  true,
);

// ──── Watchdog ────
// 영상 진입 후 일정 시간 안에 cue가 안 잡히면 MAIN에 capture 상태 reset + 재부팅을 요청.
// 자가복구 대상 원인:
//   1) ytInitialPlayerResponse가 7초 안에 set 안 돼서 inject-main의 retry 체인이 빈 트랙으로 끝남
//   2) MAIN world inject가 페이지 fetch 캡처 race에서 졌음
//   3) 페이지가 timedtext 응답을 캐시해서 CC 토글에도 fetch가 안 일어남
// 누적 지연: 8s, 38s, 98s — 광고 길이/네트워크 변동 고려.
const WATCHDOG_DELAYS_MS = [8000, 30000, 60000];
let watchdogVideoId: string | null = null;
let watchdogTimers: number[] = [];

function clearWatchdog(): void {
  watchdogTimers.forEach((t) => clearTimeout(t));
  watchdogTimers = [];
  watchdogVideoId = null;
}

function armWatchdog(videoId: string): void {
  clearWatchdog();
  watchdogVideoId = videoId;
  let elapsed = 0;
  WATCHDOG_DELAYS_MS.forEach((delta, idx) => {
    elapsed += delta;
    const cumulative = elapsed;
    const attempt = idx + 1;
    const t = window.setTimeout(() => {
      // 영상이 바뀌었거나 사용자가 자막 끄거나 이미 cue 도착한 경우는 skip.
      if (watchdogVideoId !== videoId) return;
      if (currentVideoId() !== videoId) return;
      if (!currentSettings?.subtitlesEnabled) return;
      if (lastCues.length > 0) return;
      console.warn(
        TAG,
        `[health] watchdog ${attempt}/${WATCHDOG_DELAYS_MS.length}: no cues for ${videoId} after ${cumulative}ms — requesting force boot`,
      );
      window.postMessage(
        { source: 'YDT_CONTENT', type: 'FORCE_BOOT', videoId },
        location.origin,
      );
    }, elapsed);
    watchdogTimers.push(t);
  });
}

// 1초 폴링으로 videoId 변화 감지 → 새 영상마다 rearm.
// yt-navigate-finish가 발화 안 되는 케이스(첫 페이지 로드, 일부 플레이리스트 전이)도 함께 커버.
let lastWatchdogVideoId: string | null = null;
function tickWatchdog(): void {
  const vid = currentVideoId();
  if (!vid) return;
  if (vid === lastWatchdogVideoId) return;
  lastWatchdogVideoId = vid;
  armWatchdog(vid);
}
tickWatchdog();
// 1초 폴링 — watchdog rearm + CC observer 안전망(Shorts swipe 등 navigate 이벤트 누락 케이스).
// 두 호출 모두 같은 인스턴스에 idempotent라 한 interval로 합쳐도 비용 차이 없음.
setInterval(() => {
  tickWatchdog();
  attachCcObserver();
}, 1000);

// 번역 결과를 바꾸는 키 — 변경되면 현재 영상 다시 번역.
const RETRANSLATE_KEYS = new Set([
  'sourceLang',
  'targetLang',
  'backend',
  'geminiModel',
  'mindlogicModel',
]);

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
      if (needsRetranslate && lastSentences.length > 0 && mountedVideoId) {
        console.log(TAG, 'retranslating with new settings');
        void translateCues(lastSentences, mountedVideoId);
      }
    })
    .catch((e) => console.warn(TAG, 'reload settings failed:', e));
});

} // end initContent
