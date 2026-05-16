// MAIN world script — runs in page context.
// 두 가지 일을 한다:
//   1) window.fetch를 monkey-patch해서 YouTube가 호출하는 /api/timedtext 응답을 가로챈다.
//      (YouTube 자신이 만든 PoToken/쿠키로 호출하므로 우리는 응답만 받으면 끝.)
//   2) 페이지가 자막을 호출하도록 CC를 자동 활성화 트리거한다.
//      (사용자가 CC를 누르지 않아도 자막 데이터가 page->자동 fetch되게 만든다.)
// 트랙 목록도 함께 isolated content script로 broadcast한다 (UI/선택 로직용).

(() => {
  const TAG = '[YDT/main]';

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
  // 페이지가 호출한 full URL을 기억해 두면 retry 시 그걸 (tlang만 제거하고) 재사용 가능.
  let lastPageTimedtextUrl: string | null = null;

  function rememberPageUrl(url: string): void {
    if (location.pathname.startsWith('/shorts/')) lastPageTimedtextUrl = url;
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

  function getVideoId(): string | null {
    const q = new URLSearchParams(location.search).get('v');
    if (q) return q;
    const m = location.pathname.match(/\/shorts\/([^/?#]+)/);
    return m?.[1] ?? null;
  }

  const RETRY_DELAYS_MS = [0, 250, 500, 1000, 1500];

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

    // 트랙이 있고 페이지가 자막을 아직 안 켰다면, 자동으로 활성화 트리거
    if (tracks.length > 0) {
      tryEnableCaptions(0);
      armCaptureTimeout(getVideoId());
    }
  }

  // ─────── 3.5 timedtext capture timeout / 강제 재토글 ───────
  // tryEnableCaptions이 click을 보내도 YouTube가 fetch를 안 하는 경우가 있다
  // (캐시된 메타로 만족하는 듯). 일정 시간 안에 capture 신호가 안 오면 강제 off+on
  // 토글로 다시 시도. 같은 videoId당 최대 N회.

  const CAPTURE_TIMEOUT_MS = 5000;
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
    // capturedVideoIds 체크 없이 무조건 off+on. 자막이 이미 켜져있어도 강제 재fetch.
    const isShorts = location.pathname.startsWith('/shorts/');
    if (isShorts) {
      // Shorts는 CC 버튼이 없어 click path가 의미 없음.
      // 우선순위: 페이지가 호출했던 full URL(PoToken 포함) > raw baseUrl(부족하면 빈 응답)
      const candidate = lastPageTimedtextUrl ?? lastShortsBaseUrl;
      if (candidate) {
        console.log(TAG, 'forceToggleCaptions: shorts direct fetch retry, src:', lastPageTimedtextUrl ? 'page' : 'baseUrl');
        void fetchTimedtextDirect(candidate, getVideoId());
      } else {
        // playerResponse가 갓 갱신됐을 수 있으니 트랙 재broadcast로 isolated가 다시 driving.
        console.log(TAG, 'forceToggleCaptions: shorts re-broadcast tracks');
        tryBroadcast('shorts-retry');
      }
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
    const vid = getVideoId();
    if (vid && capturedVideoIds.has(vid)) {
      // 이미 이 영상의 자막을 한 번 잡았으니 더 시도하지 않는다.
      // (SPA navigate가 같은 영상에서 여러 번 발생할 때 무한 토글 방지)
      return;
    }

    // Shorts는 .ytp-subtitles-button이 DOM에 없어 click path가 futile.
    // 캡션 캡처는 isolated → MAIN FETCH_TIMEDTEXT 경로로 처리.
    if (location.pathname.startsWith('/shorts/')) return;

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

    // 시도 1: setOption (silently 실패 가능, 영상에 따라 동작)
    try {
      if (player?.loadModule) player.loadModule('captions');
      if (player?.setOption) player.setOption('captions', 'track', { languageCode: 'en' });
    } catch (e) {
      console.warn(TAG, 'setOption failed:', e);
    }

    // 시도 2: CC 버튼 click — fetch를 강제 trigger
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

  // ───────────────────────── 4. Shorts용 직접 fetch ─────────────────────────
  // Shorts에는 .ytp-subtitles-button이 없어 페이지가 자체적으로 timedtext fetch를 trigger 안 함.
  // isolated content script가 playerResponse에서 chosen track baseUrl을 뽑아 MAIN에 fetch를 요청하면,
  // MAIN이 페이지 context(쿠키/origin)에서 직접 fetch해 기존 postCaptured 경로로 결과를 흘려보낸다.
  // tlang은 강제 제거 — 소스 언어 cue가 필요(이중 번역 방지).

  let lastShortsBaseUrl: string | null = null;
  const inflightDirect = new Set<string>();

  async function fetchTimedtextDirect(rawUrl: string, videoId: string | null): Promise<void> {
    // raw baseUrl(playerResponse)에는 PoToken/cver 등 client validation params가 없어
    // origin server가 200 + empty body로 응답한다. 페이지가 자체 호출한 full URL이 있고
    // 동일 videoId면 그걸 우선 사용해야 cue를 받을 수 있다.
    let effectiveUrl = rawUrl;
    if (lastPageTimedtextUrl) {
      try {
        const pageV = new URL(lastPageTimedtextUrl, location.origin).searchParams.get('v');
        if (pageV && pageV === videoId) effectiveUrl = lastPageTimedtextUrl;
      } catch {
        // ignore
      }
    }
    let normalized: string;
    try {
      const u = new URL(effectiveUrl, location.origin);
      u.searchParams.delete('tlang');
      u.searchParams.set('fmt', 'json3');
      normalized = u.toString();
    } catch (e) {
      console.warn(TAG, 'direct: URL parse failed', e);
      return;
    }
    if (inflightDirect.has(normalized)) return;
    inflightDirect.add(normalized);
    lastShortsBaseUrl = rawUrl;
    try {
      const res = await origFetch.call(window, normalized);
      if (!res.ok) {
        console.warn(TAG, `direct fetch ${res.status} for ${videoId}`);
        return;
      }
      const body = await res.text();
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
      | { source?: string; type?: string; baseUrl?: string; videoId?: string | null }
      | undefined;
    if (!data || data.source !== 'YDT_CONTENT' || data.type !== 'FETCH_TIMEDTEXT') return;
    if (typeof data.baseUrl !== 'string' || !data.baseUrl) return;
    void fetchTimedtextDirect(data.baseUrl, data.videoId ?? null);
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
})();
