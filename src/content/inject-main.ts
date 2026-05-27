// MAIN world script — runs in page context.
// 두 가지 일을 한다:
//   1) window.fetch를 monkey-patch해서 YouTube가 호출하는 /api/timedtext 응답을 가로챈다.
//      (YouTube 자신이 만든 PoToken/쿠키로 호출하므로 우리는 응답만 받으면 끝.)
//   2) 페이지가 자막을 호출하도록 CC를 자동 활성화 트리거한다.
//      (사용자가 CC를 누르지 않아도 자막 데이터가 page->자동 fetch되게 만든다.)
// 트랙 목록도 함께 isolated content script로 broadcast한다 (UI/선택 로직용).

import { getVideoIdFromLocation } from '../shared/url';

(() => {
  const TAG = '[YDT/main]';

  // isolated가 사용자 설정을 알려주는 boolean. false면 자동 CC 토글을 보류해
  // CC 버튼 시각 상태와 우리 자막 표시 상태가 어긋나지 않게 한다.
  // 초기값 false — isolated가 SUBTITLES_ENABLED 메시지로 실제 값을 보낼 때까지 자동 토글 보류.
  // (이전엔 true로 시작해 자막 off 사용자가 새 영상 진입 시 1회 CC 토글이 발화하던 race 존재.
  //  isolated가 document_start에 같이 등록되고 loadSettings 끝나면 즉시 보내므로 첫 토글
  //  지연은 수십~수백ms 수준 — 자막 ON 사용자도 체감 영향 적음.)
  let subtitlesEnabled = false;

  // ───────────────────────── 1. fetch + XHR monkey-patch (즉시) ─────────────────────────
  // YouTube가 timedtext를 fetch / XMLHttpRequest 중 어느 쪽으로 호출하는지 불분명하므로 둘 다.
  // 캡처된 videoId를 기억해 자동 CC 재토글이 무한 반복되지 않게 한다.
  const capturedVideoIds = new Set<string>();

  function postCaptured(via: 'fetch' | 'xhr' | 'direct', url: string, body: string): void {
    if (!body) return;
    try {
      const v = new URL(url, location.origin).searchParams.get('v');
      if (v) {
        capturedVideoIds.add(v);
        // capture 성공 시 그 videoId용 timeout/retry 카운터 정리
        clearCaptureTimeout(v);
      }
    } catch {
      // ignore
    }
    window.postMessage(
      { source: 'YDT_MAIN', type: 'TIMEDTEXT_RESPONSE', url, body },
      location.origin,
    );
    console.log(TAG, `captured timedtext (${via}), len:`, body.length, 'url:', url);
  }

  // 페이지가 자체적으로 호출한 timedtext URL의 마지막 값.
  // raw baseUrl(playerResponse)에는 PoToken/cver 등 client validation params가 없어 200+empty body가 옴.
  // 페이지가 호출한 full URL의 PoToken/cver를 재사용하되 lang/kind/tlang은 우리 chosen으로 교체.
  // (이전엔 Shorts만 보관했으나 일반 영상에도 우리가 chosen 강제 fetch하므로 모든 영상에 보관.)
  let lastPageTimedtextUrl: string | null = null;

  function rememberPageUrl(url: string): void {
    lastPageTimedtextUrl = url;
  }

  const origFetch = window.fetch;
  window.fetch = function patched(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const promise = origFetch.call(this, input as RequestInfo, init);
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url && url.includes('/api/timedtext')) {
        rememberPageUrl(url);
        promise
          .then((res) => {
            if (!res.ok) return;
            res.clone().text().then((body) => postCaptured('fetch', url, body)).catch(() => {});
          })
          .catch(() => {});
      }
    } catch {
      // monkey-patch는 항상 원본을 반환해야 함
    }
    return promise;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  // open 시그니처 오버로드를 우회하기 위해 rest로 받고 그대로 전달
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
    const url = args[1];
    (this as unknown as { _ydtUrl?: string })._ydtUrl =
      typeof url === 'string' ? url : url instanceof URL ? url.href : undefined;
    return origOpen.apply(this, args as Parameters<typeof origOpen>);
  };

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = (this as unknown as { _ydtUrl?: string })._ydtUrl;
    if (url && url.includes('/api/timedtext')) {
      rememberPageUrl(url);
      this.addEventListener('load', () => {
        if (this.status >= 200 && this.status < 300) {
          // responseText 접근은 responseType이 '' 또는 'text'일 때만 가능. 다른 경우 대비.
          let text = '';
          try {
            text = this.responseText;
          } catch {
            try {
              text = String(this.response ?? '');
            } catch {
              // ignore
            }
          }
          if (text) postCaptured('xhr', url, text);
        }
      });
    }
    return origSend.call(this, body);
  };

  console.log(TAG, 'fetch + XHR patched');

  // ───────────────────────── 2. 트랙 정보 broadcast ─────────────────────────
  interface RawCaptionTrack {
    baseUrl: string;
    languageCode: string;
    name?: { simpleText?: string; runs?: { text: string }[] };
    kind?: string;
  }

  interface CaptionsHolder {
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: RawCaptionTrack[] } };
  }

  function readName(n: RawCaptionTrack['name']): string | undefined {
    if (!n) return undefined;
    if (n.simpleText) return n.simpleText;
    if (Array.isArray(n.runs)) return n.runs.map((r) => r.text).join('');
    return undefined;
  }

  function tracksFrom(holder: CaptionsHolder | undefined): RawCaptionTrack[] | null {
    const c = holder?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return Array.isArray(c) ? c : null;
  }

  function getTracks(): { tracks: RawCaptionTrack[]; via: string } {
    const w = window as unknown as {
      ytInitialPlayerResponse?: CaptionsHolder;
      ytplayer?: { config?: { args?: { raw_player_response?: CaptionsHolder } } };
    };

    type PlayerEl = Element & { getPlayerResponse?: () => CaptionsHolder | undefined };
    const isShorts = location.pathname.startsWith('/shorts/');

    // Shorts는 활성 reel의 #shorts-player를 우선 — swipe 후에도 현재 reel의 metadata를 얻는다.
    if (isShorts) {
      const root = findShortsActiveRoot();
      const shortsPlayer = (root as ParentNode).querySelector?.('#shorts-player') as PlayerEl | null;
      if (shortsPlayer?.getPlayerResponse) {
        try {
          const live = tracksFrom(shortsPlayer.getPlayerResponse());
          if (live && live.length > 0) return { tracks: live, via: 'shorts-active' };
        } catch {
          // fall through
        }
      }
    }

    const player = document.querySelector('#movie_player, #shorts-player') as PlayerEl | null;
    if (player?.getPlayerResponse) {
      try {
        const live = tracksFrom(player.getPlayerResponse());
        if (live) return { tracks: live, via: 'getPlayerResponse' };
      } catch {
        // fall through
      }
    }

    const a = tracksFrom(w?.ytInitialPlayerResponse);
    if (a) return { tracks: a, via: 'ytInitialPlayerResponse' };
    const b = tracksFrom(w?.ytplayer?.config?.args?.raw_player_response);
    if (b) return { tracks: b, via: 'ytplayer.config' };
    return { tracks: [], via: 'none' };
  }

  const getVideoId = getVideoIdFromLocation;

  // Shorts swipe 직후 player의 새 playerResponse가 load되는 데 시간이 걸리는 경우가 있어
  // 짧은 retry로는 빈 트랙으로 끝나 cue를 못 잡는다. 최대 7초까지 늘려 안정성 확보.
  const RETRY_DELAYS_MS = [0, 250, 500, 1000, 2000, 4000, 7000];

  function tryBroadcast(reason: string, attempt = 0): void {
    const { tracks: raw, via } = getTracks();
    if (raw.length === 0 && attempt + 1 < RETRY_DELAYS_MS.length) {
      setTimeout(() => tryBroadcast(reason, attempt + 1), RETRY_DELAYS_MS[attempt + 1]);
      return;
    }
    const tracks = raw.map((t) => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode,
      name: readName(t.name),
      kind: t.kind === 'asr' ? ('asr' as const) : undefined,
    }));
    window.postMessage(
      { source: 'YDT_MAIN', type: 'CAPTION_TRACKS', reason, videoId: getVideoId(), tracks },
      location.origin,
    );
    console.log(TAG, 'broadcast', reason, 'tracks:', tracks.length, 'via:', via, 'videoId:', getVideoId(), 'attempts:', attempt);

    // M1: CC click을 여기서 발화하지 않음 — page가 sticky lang으로 fetch 시작하는 걸 막기 위해.
    // 대신 isolated가 chosen 결정 후 FETCH_TIMEDTEXT 메시지 보내면, MAIN handler에서
    // setOption(chosen) → CC click 순서로 발화 — page가 처음부터 chosen lang으로 fetch하도록.
    // armCaptureTimeout은 그대로 발화 — page가 우리 click 없이 자체적으로 fetch하는 경우 안전망.
    if (tracks.length > 0) {
      armCaptureTimeout(getVideoId());
    }
  }

  // ─────── 3.5 timedtext capture timeout / 강제 재토글 ───────
  // tryEnableCaptions이 click을 보내도 YouTube가 fetch를 안 하는 경우가 있다
  // (캐시된 메타로 만족하는 듯). 일정 시간 안에 capture 신호가 안 오면 강제 off+on
  // 토글로 다시 시도. 같은 videoId당 최대 N회.

  // 첫 click이 page fetch를 발화 못 한 경우 강제 재토글까지 기다리는 시간.
  // 너무 길면 영상 첫 N초 무자막 — 정상 fetch latency(보통 100~500ms)는 통과할 정도로.
  const CAPTURE_TIMEOUT_MS = 1500;
  const MAX_CAPTURE_RETRIES = 2;
  const captureTimers = new Map<string, number>();
  const captureRetries = new Map<string, number>();

  function clearCaptureTimeout(videoId: string): void {
    const t = captureTimers.get(videoId);
    if (t !== undefined) {
      clearTimeout(t);
      captureTimers.delete(videoId);
    }
    captureRetries.delete(videoId);
  }

  function armCaptureTimeout(videoId: string | null): void {
    if (!videoId) return;
    if (!subtitlesEnabled) return; // 자막 기능 off면 강제 재토글도 안 함
    if (capturedVideoIds.has(videoId)) return; // 이미 잡음
    const existing = captureTimers.get(videoId);
    if (existing !== undefined) clearTimeout(existing);
    const t = window.setTimeout(() => {
      captureTimers.delete(videoId);
      if (capturedVideoIds.has(videoId)) return;
      if (videoId !== getVideoId()) return; // 영상이 바뀐 경우 stale 타이머
      const tries = captureRetries.get(videoId) ?? 0;
      if (tries >= MAX_CAPTURE_RETRIES) {
        console.warn(TAG, `gave up on timedtext for ${videoId} after ${tries + 1} attempts`);
        return;
      }
      captureRetries.set(videoId, tries + 1);
      console.log(TAG, `timedtext not captured in ${CAPTURE_TIMEOUT_MS}ms, force toggle retry ${tries + 1}/${MAX_CAPTURE_RETRIES} for ${videoId}`);
      forceToggleCaptions();
      armCaptureTimeout(videoId);
    }, CAPTURE_TIMEOUT_MS);
    captureTimers.set(videoId, t);
  }

  function forceToggleCaptions(): void {
    if (!subtitlesEnabled) return;
    // capturedVideoIds 체크 없이 무조건 off+on. 자막이 이미 켜져있어도 강제 재fetch.
    const isShorts = location.pathname.startsWith('/shorts/');
    if (isShorts) {
      // Shorts는 CC 버튼이 없어 click path가 의미 없음. chosen 정보가 여기 없으니
      // 트랙 재broadcast로 isolated가 chosen 결정 + FETCH_TIMEDTEXT 재발사하도록.
      console.log(TAG, 'forceToggleCaptions: shorts re-broadcast tracks');
      tryBroadcast('shorts-retry');
      return;
    }
    const ccBtn = document.querySelector<HTMLElement>('.ytp-subtitles-button');
    if (!ccBtn) {
      console.warn(TAG, 'forceToggleCaptions: ccBtn not found');
      return;
    }
    const pressed = ccBtn.getAttribute('aria-pressed') === 'true';
    if (pressed) {
      ccBtn.click(); // off
      setTimeout(() => ccBtn.click(), 300); // on
    } else {
      ccBtn.click(); // on
      setTimeout(() => {
        ccBtn.click(); // off
        setTimeout(() => ccBtn.click(), 200); // on
      }, 300);
    }
  }

  // ───────────────────────── 3. 자동 CC 활성화 ─────────────────────────
  // YouTube player에 setOption('captions', 'track', {...})를 호출하면 자막 fetch가 트리거된다.
  // player가 아직 준비 안 됐을 수 있어 짧게 retry.

  const ENABLE_RETRY_MS = [0, 300, 800, 1500, 3000];

  function findShortsActiveRoot(): ParentNode {
    // 1순위: [is-active] reel
    const active = document.querySelector('ytd-reel-video-renderer[is-active]');
    if (active) return active;
    // 2순위: 화면에 visible한 video element의 가장 가까운 reel/player
    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      if (r.width > 100 && r.height > 100 && r.top < window.innerHeight && r.bottom > 0) {
        const reel = v.closest('ytd-reel-video-renderer');
        if (reel) return reel;
        const sp = v.closest('#shorts-player');
        if (sp) return sp;
        return v.parentElement ?? document;
      }
    }
    return document;
  }

  function tryEnableCaptions(attempt: number): void {
    // 사용자가 자막 기능을 꺼놨으면 자동 토글 보류 — CC 버튼 ON인데 우리 자막 OFF인 미스매치 방지.
    if (!subtitlesEnabled) return;
    const vid = getVideoId();
    if (vid && capturedVideoIds.has(vid)) {
      // 이미 이 영상의 자막을 한 번 잡았으니 더 시도하지 않는다.
      // (SPA navigate가 같은 영상에서 여러 번 발생할 때 무한 토글 방지)
      return;
    }

    // Shorts는 .ytp-subtitles-button이 hidden이지만 별도 .ytmClosedCaptioningButtonButton이
    // DOM에 있다. timedtext capture는 isolated의 direct fetch로 이미 처리되므로 여기서는
    // CC 버튼 시각 상태만 subtitlesEnabled와 매칭시키는 게 목적.
    if (location.pathname.startsWith('/shorts/')) {
      const shortsCc = document.querySelector<HTMLElement>('.ytmClosedCaptioningButtonButton');
      if (shortsCc && shortsCc.getAttribute('aria-pressed') !== 'true') {
        shortsCc.click();
      }
      return;
    }

    const player = document.querySelector('#movie_player') as
      | (Element & {
          loadModule?: (name: string) => void;
          setOption?: (module: string, option: string, value: unknown) => void;
          getOption?: (module: string, option: string) => unknown;
        })
      | null;

    const ccBtn = document.querySelector<HTMLElement>('.ytp-subtitles-button');

    if (!player && !ccBtn) {
      if (attempt + 1 < ENABLE_RETRY_MS.length) {
        setTimeout(() => tryEnableCaptions(attempt + 1), ENABLE_RETRY_MS[attempt + 1]);
      }
      return;
    }

    // CC 버튼 click — fetch를 강제 trigger
    // (이전에는 setOption('captions','track',{languageCode:'en'})도 호출했으나
    //  이 호출이 모든 영상에 영어 트랙을 강제하고 YouTube 계정 선호로 sticky되어
    //  한국어 영상에 영어 자동번역이 발화되는 부작용 발생 — 제거.)
    // 자막이 꺼져있으면 click 한 번으로 켜기 + fetch.
    // 자막이 이미 켜져있는데 fetch가 안 일어난 영상(YouTube 캐시 등)에서는
    // off → on 토글로 강제 재fetch.
    let toggled: 'none' | 'on' | 'off+on' = 'none';
    if (ccBtn) {
      const pressed = ccBtn.getAttribute('aria-pressed');
      if (pressed === 'true') {
        ccBtn.click(); // off
        setTimeout(() => ccBtn.click(), 200); // on
        toggled = 'off+on';
      } else {
        ccBtn.click(); // on
        toggled = 'on';
      }
    }

    let tracklist: unknown = undefined;
    try {
      tracklist = player?.getOption?.('captions', 'tracklist');
    } catch {
      // ignore
    }
    console.log(
      TAG,
      'enable captions attempt', attempt,
      '— ccBtn:', !!ccBtn,
      'aria-pressed before:', ccBtn?.getAttribute('aria-pressed'),
      'toggled:', toggled,
      'tracklist count:', Array.isArray(tracklist) ? tracklist.length : 'n/a',
    );

    if (!ccBtn && attempt + 1 < ENABLE_RETRY_MS.length) {
      setTimeout(() => tryEnableCaptions(attempt + 1), ENABLE_RETRY_MS[attempt + 1]);
    }
  }

  // ───────────────────────── 4. chosen 트랙 직접 fetch ─────────────────────────
  // isolated가 pickTrack으로 결정한 chosen 트랙(lang/kind)을 우리가 강제 fetch한다.
  // YouTube default는 사용자 hl=ko 기반으로 tlang=ko를 자동 추가하거나 한국어 manual 트랙을
  // 잡아 우리 의도와 어긋남 → 페이지가 호출한 URL에서 PoToken/cver를 가져와 재사용하되
  // lang/kind는 chosen으로 교체, tlang은 제거.

  const inflightDirect = new Set<string>();

  // S7+M2: page가 우리 chosen 트랙으로 fetch하도록 player에 트랙 set 요청.
  // M2: tlang(자동번역 target) sticky를 명시적으로 무력화 — YouTube가 이전 영상의
  // 자동번역 설정을 다음 영상에 sticky로 적용해 잘못된 lang으로 fetch하는 문제 해결.
  // (예: 한국어 영상 보다 영어 영상 가면 영어+한국어자번역 sticky가 영어 영상에 적용)
  function trySetTrack(lang: string, kind: 'asr' | undefined): void {
    const player = document.querySelector('#movie_player') as
      | (Element & {
          loadModule?: (name: string) => void;
          setOption?: (module: string, option: string, value: unknown) => void;
        })
      | null;
    if (!player?.setOption) return;
    // M2: 자동번역 sticky 해제 — track set 전에 호출. setOption 미공식 API라 여러 형태 시도.
    try {
      player.setOption('captions', 'translationLanguage', null);
    } catch {
      // ignore — 옵션 이름이 다를 수 있음
    }
    try {
      // value에 translationLanguage: null 명시 — track value 안에 통합돼 있을 가능성도 커버.
      const value: Record<string, unknown> = { languageCode: lang, translationLanguage: null };
      if (kind === 'asr') value.kind = 'asr';
      player.setOption('captions', 'track', value);
      console.log(TAG, `setOption track lang=${lang} kind=${kind ?? 'manual'} (tlang reset)`);
    } catch (e) {
      console.warn(TAG, 'setOption failed:', e);
    }
  }

  async function waitForMatchingPageUrl(videoId: string | null): Promise<string | null> {
    // page가 호출한 timedtext URL의 PoToken/cver는 client validation 통과에 필수.
    // CC 토글이 page fetch를 트리거하지만 우리 direct fetch와 race될 수 있어 짧게 대기.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (lastPageTimedtextUrl) {
        try {
          const v = new URL(lastPageTimedtextUrl, location.origin).searchParams.get('v');
          if (v === videoId) return lastPageTimedtextUrl;
        } catch {
          // ignore
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  async function fetchTimedtextDirect(
    rawUrl: string,
    videoId: string | null,
    chosenLang: string,
    chosenKind: 'asr' | undefined,
  ): Promise<void> {
    // raw baseUrl에는 PoToken/cver가 없어 그대로 fetch하면 200+empty body가 옴.
    // page fetch 도착 대기 (최대 5초). 도착 못 하면 raw로라도 시도 (실패 가능 인정).
    const pageUrl = await waitForMatchingPageUrl(videoId);
    const effectiveUrl = pageUrl ?? rawUrl;

    let normalized: string;
    try {
      const u = new URL(effectiveUrl, location.origin);
      // 우리 chosen으로 트랙 식별자 강제 교체 — YouTube default 회피.
      u.searchParams.delete('tlang');
      u.searchParams.set('lang', chosenLang);
      if (chosenKind === 'asr') u.searchParams.set('kind', 'asr');
      else u.searchParams.delete('kind');
      u.searchParams.set('fmt', 'json3');
      normalized = u.toString();
    } catch (e) {
      console.warn(TAG, 'direct: URL parse failed', e);
      return;
    }
    if (inflightDirect.has(normalized)) return;
    inflightDirect.add(normalized);
    try {
      const res = await origFetch.call(window, normalized);
      if (!res.ok) {
        console.warn(TAG, `direct fetch ${res.status} for ${videoId}`);
        return;
      }
      const body = await res.text();
      console.log(TAG, `direct fetch ${res.status} body.len=${body.length} for ${videoId} (pageUrl=${!!pageUrl})`);
      if (body) postCaptured('direct', normalized, body);
    } catch (e) {
      console.warn(TAG, 'direct fetch failed', e);
    } finally {
      inflightDirect.delete(normalized);
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data as
      | {
          source?: string;
          type?: string;
          baseUrl?: string;
          videoId?: string | null;
          enabled?: boolean;
        }
      | undefined;
    if (!data || data.source !== 'YDT_CONTENT') return;
    if (data.type === 'FETCH_TIMEDTEXT') {
      if (typeof data.baseUrl !== 'string' || !data.baseUrl) return;
      if (typeof (data as { languageCode?: unknown }).languageCode !== 'string') return;
      const d = data as {
        baseUrl: string;
        videoId?: string | null;
        languageCode: string;
        kind?: 'asr' | undefined;
      };
      // M1: setOption(chosen) → 짧은 delay 후 CC click 순서로 발화.
      // page가 sticky 기반으로 잘못된 lang fetch하기 전에 chosen lang으로 선점.
      // (tryBroadcast에서 CC click을 발화하지 않도록 변경했으므로 여기서 click 책임.)
      trySetTrack(d.languageCode, d.kind);
      // 100ms: setOption이 page state에 적용될 시간 확보 후 CC click.
      // 200ms 후 추가 force toggle: 첫 click이 안 먹은 경우 보완.
      setTimeout(() => tryEnableCaptions(0), 100);
      setTimeout(() => forceToggleCaptions(), 300);
      void fetchTimedtextDirect(
        d.baseUrl,
        d.videoId ?? null,
        d.languageCode,
        d.kind === 'asr' ? 'asr' : undefined,
      );
    } else if (data.type === 'SUBTITLES_ENABLED') {
      if (typeof data.enabled !== 'boolean') return;
      subtitlesEnabled = data.enabled;
      console.log(TAG, 'subtitlesEnabled =', subtitlesEnabled);
    } else if (data.type === 'FORCE_BOOT') {
      // 워치독에서 호출. 현재 영상의 capture 상태를 reset하고 부트 시퀀스를 재발사.
      // (stale 요청 — isolated가 보낸 후 영상이 바뀐 경우 — 은 무시)
      const reqVid = typeof data.videoId === 'string' ? data.videoId : null;
      const curVid = getVideoId();
      if (reqVid && reqVid !== curVid) {
        console.log(TAG, `[health] FORCE_BOOT stale (req=${reqVid}, cur=${curVid}) — ignored`);
        return;
      }
      console.warn(TAG, `[health] FORCE_BOOT for ${curVid} — resetting capture state and re-broadcasting`);
      capturedVideoIds.clear();
      captureRetries.clear();
      captureTimers.forEach((t) => clearTimeout(t));
      captureTimers.clear();
      tryBroadcast('watchdog');
    }
  });

  // Shorts swipe 감지 — 활성 video element가 새 source를 로드하면 loadeddata 발화.
  // capture phase로 페이지 전역의 video 이벤트를 캐치 (페이지가 후속 listener를 막아도 안전).
  document.addEventListener(
    'loadeddata',
    (ev) => {
      if (!location.pathname.startsWith('/shorts/')) return;
      const target = ev.target;
      if (!(target instanceof HTMLVideoElement)) return;
      const rect = target.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) return;
      tryBroadcast('shorts-reel-change');
    },
    true,
  );

  // ───────────────────────── 5. 진입점 ─────────────────────────
  tryBroadcast('initial');

  window.addEventListener('yt-navigate-finish', () => {
    tryBroadcast('navigate');
  });

  // 재생목록 자동 다음 재생 / 같은 영상 재진입은 yt-navigate-finish가 발화 안 될 수 있다.
  // video element의 src 교체 시 발화하는 'emptied'를 통합 신호로 사용해
  //   1) capture 상태(중복 방지용 Set) 리셋 — 재진입 영상이 다시 처리되도록
  //   2) 새 영상 트랙 재broadcast — playerResponse 갱신 후 RETRY로 잡힘
  document.addEventListener(
    'emptied',
    (ev) => {
      if (!(ev.target instanceof HTMLVideoElement)) return;
      const r = ev.target.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) return; // 광고/preload 등 hidden 무시
      console.log(TAG, 'emptied — reset capture state, rebroadcast');
      capturedVideoIds.clear();
      captureRetries.clear();
      captureTimers.forEach((t) => clearTimeout(t));
      captureTimers.clear();
      tryBroadcast('video-emptied');
    },
    true,
  );

  // Shorts swipe / 자동 다음 재생은 yt-navigate-finish와 emptied 모두 누락될 수 있다.
  // location.pathname 변화를 1초 폴링으로 감지해 최종 안전망 — 변화 시 capture 상태 리셋 + rebroadcast.
  let lastPathname = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPathname) return;
    console.log(TAG, `pathname ${lastPathname} -> ${location.pathname}, rebroadcast`);
    lastPathname = location.pathname;
    capturedVideoIds.clear();
    captureRetries.clear();
    captureTimers.forEach((t) => clearTimeout(t));
    captureTimers.clear();
    tryBroadcast('pathname-change');
  }, 1000);
})();
