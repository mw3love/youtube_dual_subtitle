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

  function postCaptured(via: 'fetch' | 'xhr', url: string, body: string): void {
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

  function getTracks(): RawCaptionTrack[] {
    const w = window as unknown as {
      ytInitialPlayerResponse?: CaptionsHolder;
      ytplayer?: { config?: { args?: { raw_player_response?: CaptionsHolder } } };
    };

    const player = document.querySelector('#movie_player') as
      | (Element & { getPlayerResponse?: () => CaptionsHolder | undefined })
      | null;
    if (player?.getPlayerResponse) {
      try {
        const live = tracksFrom(player.getPlayerResponse());
        if (live) return live;
      } catch {
        // fall through
      }
    }

    const a = tracksFrom(w?.ytInitialPlayerResponse);
    if (a) return a;
    const b = tracksFrom(w?.ytplayer?.config?.args?.raw_player_response);
    if (b) return b;
    return [];
  }

  function getVideoId(): string | null {
    const q = new URLSearchParams(location.search).get('v');
    if (q) return q;
    const m = location.pathname.match(/\/shorts\/([^/?#]+)/);
    return m?.[1] ?? null;
  }

  const RETRY_DELAYS_MS = [0, 250, 500, 1000, 1500];

  function tryBroadcast(reason: string, attempt = 0): void {
    const raw = getTracks();
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
    console.log(TAG, 'broadcast', reason, 'tracks:', tracks.length, 'videoId:', getVideoId(), 'attempts:', attempt);

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
    const root: ParentNode = isShorts
      ? document.querySelector('ytd-reel-video-renderer[is-active]') ?? document
      : document;
    const ccBtn = root.querySelector<HTMLElement>('.ytp-subtitles-button');
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

  function tryEnableCaptions(attempt: number): void {
    const vid = getVideoId();
    if (vid && capturedVideoIds.has(vid)) {
      // 이미 이 영상의 자막을 한 번 잡았으니 더 시도하지 않는다.
      // (SPA navigate가 같은 영상에서 여러 번 발생할 때 무한 토글 방지)
      return;
    }

    // Shorts는 여러 reel이 DOM에 있어 첫 번째 .ytp-subtitles-button이
    // active reel의 것이 아닐 수 있다. active reel 안의 player/ccBtn을 우선.
    const isShorts = location.pathname.startsWith('/shorts/');
    const root: ParentNode = isShorts
      ? document.querySelector('ytd-reel-video-renderer[is-active]') ?? document
      : document;

    const player = root.querySelector('#movie_player, #shorts-player') as
      | (Element & {
          loadModule?: (name: string) => void;
          setOption?: (module: string, option: string, value: unknown) => void;
          getOption?: (module: string, option: string) => unknown;
        })
      | null;

    const ccBtn = root.querySelector<HTMLElement>('.ytp-subtitles-button');

    if (isShorts) {
      const reels = document.querySelectorAll('ytd-reel-video-renderer');
      const activeReels = document.querySelectorAll('ytd-reel-video-renderer[is-active]');
      console.log(
        TAG,
        'shorts diag — reels:', reels.length,
        'active:', activeReels.length,
        'rootIsActiveReel:', root !== document,
        'player:', !!player,
        'ccBtn:', !!ccBtn,
      );
    }

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

  // ───────────────────────── 4. 진입점 ─────────────────────────
  tryBroadcast('initial');

  window.addEventListener('yt-navigate-finish', () => {
    tryBroadcast('navigate');
  });
})();
