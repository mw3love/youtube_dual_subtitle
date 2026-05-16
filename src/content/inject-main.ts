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
  function postCaptured(via: 'fetch' | 'xhr', url: string, body: string): void {
    if (!body) return;
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
    if (tracks.length > 0) tryEnableCaptions(0);
  }

  // ───────────────────────── 3. 자동 CC 활성화 ─────────────────────────
  // YouTube player에 setOption('captions', 'track', {...})를 호출하면 자막 fetch가 트리거된다.
  // player가 아직 준비 안 됐을 수 있어 짧게 retry.

  const ENABLE_RETRY_MS = [0, 300, 800, 1500, 3000];

  function tryEnableCaptions(attempt: number): void {
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

    // 시도 1: setOption (silently 실패 가능)
    try {
      if (player?.loadModule) player.loadModule('captions');
      if (player?.setOption) player.setOption('captions', 'track', { languageCode: 'en' });
    } catch (e) {
      console.warn(TAG, 'setOption failed:', e);
    }

    // 시도 2: CC 버튼 click — setOption보다 확실히 fetch를 트리거
    let clickedNow = false;
    if (ccBtn) {
      const pressed = ccBtn.getAttribute('aria-pressed');
      if (pressed !== 'true') {
        ccBtn.click();
        clickedNow = true;
      }
    }

    // 진단: 현재 트랙 상태
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
      'clickedNow:', clickedNow,
      'tracklist count:', Array.isArray(tracklist) ? tracklist.length : 'n/a',
    );

    // ccBtn 없으면 player 준비 더 기다리기
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
