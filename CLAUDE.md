# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트

YouTube 듀얼 자막(원문 + 번역) Chrome MV3 확장. TypeScript + React(옵션 페이지만) + Vite + `@crxjs/vite-plugin`. UI/주석은 한국어 기준.

## 명령

| 명령 | 용도 |
|---|---|
| `npm run dev` | HMR 개발 빌드. `dist/` 갱신. 옵션/팝업은 자동 리로드, content/background는 변경 종류에 따라 `chrome://extensions`에서 수동 ↻ 필요할 수 있음 |
| `npm run build` | `tsc --noEmit && vite build`. 배포·테스트용 결과물을 `dist/`에 |
| `npm run typecheck` | `tsc --noEmit`만 |

테스트 프레임워크 없음(스크립트 정의 안 됨).

### 변경 사항을 브라우저에서 보려면
1. `npm run build` (또는 `dev`)
2. `chrome://extensions` → 이 확장 카드의 **↻** 클릭
3. 이미 열려 있던 옵션/팝업 탭은 별도로 새로고침(F5)해야 새 번들이 로드됨

dev 모드에서도 결국 `dist/`를 Chrome이 읽으므로 한 번은 압축해제 로드(`dist/` 선택)가 선행돼야 함.

## 아키텍처 — 여러 파일을 함께 봐야 이해되는 부분

### 1. 자막 데이터 capture: MAIN world ↔ isolated world 분리

YouTube의 `/api/timedtext`는 PoToken·쿠키 등 client validation 인증이 필요하다. 우리가 직접 요청을 만들지 않고 **YouTube 자신의 fetch에 빌붙어 응답만 가로채는 게 핵심 트릭**이다.

- `src/content/inject-main.ts` (MAIN world, `document_start`): `window.fetch` + `XMLHttpRequest.prototype.open/send`를 monkey-patch. URL이 `/api/timedtext` 포함이면 응답 body를 `window.postMessage`로 isolated에 전달.
- `src/content/index.ts` (isolated world): postMessage 수신 → `parseJson3` → cue 배열 → renderer + 번역.
- 메시지 형태는 `src/shared/types.ts`의 `MainToContentMessage` / `ContentToMainMessage`로 고정. `source` 필드(`'YDT_MAIN'` / `'YDT_CONTENT'`)로 페이지의 다른 postMessage와 구분.
- manifest 등록도 두 갈래: `inject-main.ts`는 `world: 'MAIN'`, `index.ts`는 isolated (`src/manifest.ts:17-29`).

### 2. 트랙 선택 강제 + sticky 무력화 (A16)

기본 흐름은 "YouTube가 자체 fetch하고 우리는 가로채기"였지만, YouTube의 자막 메뉴 sticky(이전 영상에서 사용자가 선택한 lang/tlang을 다음 영상에 자동 적용)가 끼어들어 잘못된 트랙이 잡히는 문제가 누적됨. 해결로 **모든 영상에서 isolated가 chosen 트랙을 결정하고 MAIN이 그 트랙을 강제로 fetch**하도록 함.

- 트랙 선택 (`content/index.ts:pickTrack`): ASR 트랙의 lang을 영상 원본 lang hint로 사용.
  - 영상 원본 lang === `targetLang`(예: 한국어 영상) → 모국어 single 의도 → tgt 트랙 강제 (manual > asr).
  - 외국어 영상 → `preferredSource` 매치 트랙 우선 (manual > asr).
  - 한국어 영상에 영어/일본어 manual이 같이 있어도 한국어 잡음 (예전엔 외국어 잡혀 듀얼됨).
- chosen 강제 fetch: isolated → `FETCH_TIMEDTEXT { baseUrl, languageCode, kind }` 메시지. MAIN의 `fetchTimedtextDirect`가:
  1. `waitForMatchingPageUrl`: page가 자체 fetch한 timedtext URL의 PoToken을 얻기 위해 최대 5초 대기.
  2. 그 URL의 `lang/kind`만 chosen으로 교체, `tlang` 제거 → server에 다시 fetch.
  3. 일부 영상은 PoToken이 (lang, kind) 조합에 묶여 lang 교체 시 server가 200+empty body로 응답 (lang-binding 추정) — 그땐 page xhr fallback에 의존.
- page sticky 무력화 (`trySetTrack`): chosen 결정 후 `player.setOption('captions', 'track', { languageCode, kind, translationLanguage: null })` 호출 + 별도 `setOption('captions', 'translationLanguage', null)`도 호출 (옵션명 비공식이라 두 형태 시도). 핵심은 `translationLanguage: null` 명시 — 이게 없으면 이전 영상의 자동번역 target이 sticky로 적용돼 한→영 또는 영→한 전환 시 잘못된 자동번역 fetch됨.
- 호출 순서가 중요 (`inject-main.ts`의 `FETCH_TIMEDTEXT` handler):
  ```
  1. trySetTrack(chosen)        ← player state 갱신 (sticky tlang 명시 reset)
  2. 100ms 후 tryEnableCaptions ← CC click. setOption이 page에 반영된 후라야 chosen lang으로 fetch.
  3. 300ms 후 forceToggleCaptions ← 첫 click 안 먹은 경우 보완.
  4. fetchTimedtextDirect(chosen) ← 우리도 동시 시도.
  ```
  `tryBroadcast`는 트랙 알림 + 워치독만. CC click은 발화하지 않음 — page가 sticky로 잘못된 lang fetch하기 전에 우리 setOption이 선점하기 위함.
- page response에서 `tlang` 있는 응답은 isolated에서 skip(`handleTimedtextResponse`) — 우리 direct fetch만 처리해 자동번역 응답으로 덮어쓰기 방지.

### 3. Shorts vs 일반 영상 분기

같은 코드베이스에서 두 영상 형식 모두 다루지만 자막 capture 경로 일부가 다르다. 트랙 강제 fetch(섹션 2)는 양쪽 공통.

- **일반 영상**: `.ytp-subtitles-button`(CC 버튼)이 DOM에 있음. `tryEnableCaptions`이 click → page도 fetch (우리 direct fetch와 병행).
- **Shorts**: CC 버튼이 visibly 없어 click 효과 낮음. direct fetch가 사실상 단일 경로. `lastPageTimedtextUrl`(이제 모든 영상에서 보관)의 PoToken 재사용.
- Shorts swipe 감지: 페이지 전역 `loadeddata`를 capture phase로 들어 새 reel이 로드되면 `tryBroadcast('shorts-reel-change')`로 트랙 재방송.

### 4. Capture timeout / 강제 재토글 / 워치독

`tryEnableCaptions`의 click이 발화돼도 YouTube가 캐시 등으로 fetch를 안 하는 경우가 있다. `armCaptureTimeout`이 5초 내 capture 신호가 없으면 강제 off+on 토글로 재시도(같은 videoId당 최대 2회). 자세한 로직은 `inject-main.ts:205-279`.

추가로 isolated 측 **워치독**(`content/index.ts`)이 영상 진입 후 누적 8s/38s/98s에 cue가 여전히 없으면 MAIN에 `FORCE_BOOT`를 송신. MAIN은 `capturedVideoIds`/`captureRetries`/`captureTimers`를 reset하고 `tryBroadcast('watchdog')`로 재발사. `armCaptureTimeout`이 MAIN 내부에서 click을 재시도하는 단기 보호라면, 워치독은 isolated에서 capture 상태 전체를 reset하는 장기 보호. 자가복구 대상 원인: `ytInitialPlayerResponse` 늦은 셋팅, MAIN inject race, 페이지의 `/api/timedtext` 응답 캐시. 1초 polling으로 videoId 변화 감지 → rearm. cue 도착 시 자동 해제.

### 5. 번역 백엔드 — router + fallback

- `src/background/translators/router.ts`: 사용자가 선택한 백엔드(`backend` 설정) 우선, 실패 시 다른 쪽으로 **1회 fallback**.
- `google-free.ts`: `translate.googleapis.com/translate_a/single?client=gtx` 비공식 엔드포인트. N개 텍스트를 `\n`으로 join해 **HTTP 1회**. URL ~8KB 한계 → 배치 분할은 호출 측 책임(`content/index.ts`의 `TRANSLATE_BATCH_SIZE = 25` / 첫 배치 `FIRST_BATCH_SIZE = 4`. 번역 단위가 cue→문장으로 커져 옛 50/8에서 낮춤 — 섹션 13). `\n` 보존 가정이 깨지면 줄 수 불일치 → 호출 측에서 캐싱 안 함.
- `chrome-builtin.ts`: Chrome 138+ `window.Translator`. **service worker에서 직접 호출 불가** → offscreen document(`src/offscreen/`)에 위임.
  - `OFFSCREEN_READY` 신호로 race 회피: createDocument resolve 직후엔 offscreen의 onMessage listener가 아직 안 걸려있을 수 있음.
  - `OFFSCREEN_PING`으로 살아있는지 확인 후 reuse, 죽었으면 재생성.
  - `Translator.translate`는 단건만 받아 N회 **순차** 호출(메모리 충돌 회피, `offscreen/index.ts:96-99`). 짧은 자막 한 줄씩 독립 번역되므로 문맥 손실 있음.
  - Translator 인스턴스는 `(src, tgt)` pair별로 캐시.
- `gemini.ts` (BYOK, A19): `generativelanguage.googleapis.com/v1beta/models/{id}:generateContent`. 사용자가 본인 키 입력. 모델 ID는 `gemini-2.5-flash` / `gemini-2.5-flash-lite` / `gemini-3.5-flash`(A32 추가) 안정 버전(preview/latest alias 회피). 번역은 `geminiModel`, 해설은 별도 `explainGeminiModel`로 분리(섹션 17).
  - 입력 배열을 `JSON.stringify` → user 메시지 한 줄, `generationConfig.responseMimeType=application/json + responseSchema(ARRAY of STRING)`로 JSON 강제. 응답 배열 길이 ≠ 입력 길이면 throw → router fallback.
  - 429/5xx만 1500ms 1회 재시도. 401/403/400은 즉시 throw. safety filter로 candidate empty면 finishReason 포함 throw.
  - **429 cooldown (A21)**: 429 받으면 `rateLimitedUntil`을 60s 후로 set → 다음 `translateBatch` 진입 시 즉시 throw → router가 google-free로 fallback. 매 batch마다 1.5s 백오프 × 청크 누적 지연 방지. `testGeminiKey`는 cooldown 우회 + 성공 시 reset (사용자가 새 키 검증 가능하게).
  - **키는 settings(storage.sync) 아니라 `secrets.ts` + `chrome.storage.local`** — 웹스토어 배포 시 사용자 키가 Google 계정 동기화로 전파되지 않도록 분리. gemini.ts가 호출 시점에 storage.local과 storage.sync에서 fresh read (race 회피).
  - 옵션 페이지 "테스트" 버튼은 router 우회용 `TEST_GEMINI` 메시지 + `testGeminiKey(apiKey, model)` 직접 호출. router fallback이 키 오류를 가려 "성공"으로 보이는 사고 방지. 클릭 시 디바운스 보류 중인 키 저장 먼저 flush.
- `mindlogic.ts` (BYOK, A24, v0.3.0): `factchat-cloud.mindlogic.ai/v1/gateway/chat/completions`. Mindlogic API Gateway는 OpenAI/Anthropic/Google/xAI/Perplexity 등 여러 upstream을 단일 endpoint로 통과시키는 학교/조직 게이트웨이. OpenAI 호환 path로 통일해 모델 ID만 바꾸면 여러 provider 사용 가능.
  - **모델 목록은 동적(A32)**: 게이트웨이 `GET /v1/gateway/models`로 사용 가능 모델 전체를 가져와 옵션 드롭다운에 표시(섹션 17). `MindlogicModelSchema`는 enum이 아니라 `z.string()` — 어떤 모델 id를 골라도 검증 통과(게이트웨이가 실제 유효성 판정). `lang-options.ts:MINDLOGIC_MODELS`의 6개(`gemini-2.5-flash` default·`gemini-3.1-flash-lite`·`claude-sonnet-4-6`·`claude-haiku-4-5-20251001`·`gpt-5.4-mini`·`gpt-5.4-nano`)는 추천 마커 + 새로고침 전 fallback으로 남는 하드코딩 부분집합. 권한 없는 모델은 401/403 → 번역은 router가 google-free로 fallback(해설은 fallback 없음).
  - 요청 포맷 (A26, Immersive 레시피 차용): `{model, messages:[system,user], temperature:0, max_tokens:4096}`. 짧은 자막 cue를 모델이 "유창하게" 합쳐 줄 수를 줄이는 경향(N in, N-2 out)으로 정렬이 깨지는 걸 세 가지로 억제 — (1) 청크 작게 `MINDLOGIC_CHUNK_SIZE = 5`, (2) `temperature: 0`(합치는 재량 제거), (3) cue를 JSON 배열이 아니라 **`%%` 구분자**(`"\n\n%%\n\n"` join) + few-shot 예시로 "같은 개수 in/out" 강하게 지시. (JSON 배열은 합쳐도 valid라 모델이 부담 없이 합침 — 구분자 방식이 순응도 높음.) `parseResponse`의 `splitSegments`가 `%%`로 split해 개수 검증, ```fence·preamble은 먼저 벗김. 단위가 문장으로 올라간 뒤(섹션 13) 합침 mismatch 자체가 크게 줄어 이 방어는 안전망 성격.
  - 길이 mismatch 시 1회 재시도, 그래도 안 맞으면 throw → router fallback. 429/5xx 1회 백오프 재시도, 401/403/400 즉시 throw. 429 시 60s cooldown (gemini와 동일 패턴).
  - 키 저장 위치/테스트 버튼 패턴 모두 gemini와 동일. `TEST_MINDLOGIC` 메시지로 router 우회 검증.
  - 캐시 키는 `mindlogic:<modelId>` 합성 (섹션 7) — 모델 바꾸면 별개 캐시.

### 6. Settings — 즉시 반영 + 자동 재번역

- `src/shared/settings.ts`: `zod` 스키마로 검증, partial 마이그레이션(새 필드는 default로). 모든 페이지가 같은 schema 공유.
- 옵션 페이지(`src/options/main.tsx`)는 변경을 즉시 UI에 반영하되 `storage.sync.set`은 **250ms 디바운스** (color/slider 입력으로 분당 120회 quota에 안 걸리게).
- `src/content/index.ts:241-255`: `chrome.storage.onChanged` 수신 → settings 전체 reload → `applySettings`. `RETRANSLATE_KEYS = {sourceLang, targetLang, backend, geminiModel, mindlogicModel}` 중 하나가 바뀌면 현재 영상 자동 재번역(재조립된 `lastSentences` 보관 덕분 — 섹션 13).

### 7. 캐시

- `src/shared/cache/idb-cache.ts`: IndexedDB via `idb-keyval`.
- **소유는 background SW (A26)**: content script의 IndexedDB는 youtube.com origin이라 옵션 페이지(확장 origin)의 "비우기"가 못 닿는다 → content는 `CACHE_GET`/`CACHE_SET` 메시지로 background에 위임하고, SW가 확장 origin DB 하나만 소유(`content/index.ts:getCachedViaBg/setCachedViaBg`).
- key: `ydt::v{N}::{videoId}::{src}::{tgt}::{backend}` — `v{N}`은 `CACHE_SCHEMA_VERSION`(A26 도입, 현재 **3**). 번역 로직(프롬프트·청크·temp·전송 포맷, 또는 cue→문장 단위 전환)이 바뀌면 bump → 키가 달라져 옛 캐시 자동 miss·재번역, 수동 비우기 불필요. `clearCache`/`getCacheStats`는 `ydt::` prefix로 매칭해 옛 버전도 함께 처리.
- backend가 바뀌면 별개 캐시(품질 다르므로). 모델 선택이 있는 BYOK 백엔드는 모델 ID까지 합성: `gemini:flash` / `gemini:flash-lite`, `mindlogic:gemini-2.5-flash` / `mindlogic:claude-haiku-4-5-20251001` 등(`content/index.ts:cacheBackendTag`). 모델 ID에 단일 `:`이 들어가도 segment separator `::`와 충돌 없음. 다른 백엔드는 기존 포맷 유지(하위 호환).
- TTL 30일, MAX 200엔트리, `set` 시 5% 확률로 lazy prune.
- 번역 결과 길이가 입력(문장) 길이와 일치할 때만 저장 (alignment 어긋난 결과 캐싱 방지).

### 8. 렌더링

- `SubtitleRenderer`(`src/content/renderer/subtitle-renderer.ts`): `requestAnimationFrame` 루프로 매 프레임 cue 인덱스 갱신. `video.timeupdate`는 ~250ms 간격이라 onset/offset이 끊겨 부적합.
- **렌더 단위는 raw cue가 아니라 재조립된 `Sentence`**(⊇`Cue`, 섹션 13). `setCues`에 sentence 배열이 들어와 코드는 그대로 `cue`처럼 다루되 한 항목 = 한 문장. 그래서 문장 전체가 `[start,end)` 내내 블록으로 떠 있고(원문·번역 둘 다), word-reveal이 그 안에서 현재 발화 위치를 칠해 "preview + 진행 표시"가 한 메커니즘으로 통합됨.
- `findCueIndex`는 이전 인덱스 기반 빠른 경로(현재 cue 유지 / 다음 cue 진입) 두 번 체크 후 선형 폴백 — 정주행 시 ~1회 비교.
- `findMountTarget`(`container.ts`): YouTube DOM 셀렉터에 최소 의존. **video element 기반 탐지**로 active 영상(Shorts 다중 reel 포함) 찾음.
- `styles.ts`: 사용자 조절 값은 모두 CSS 변수로 `:root`에 박아 `:fullscreen` / `[data-mode="shorts"]` 보정까지 한 번에 적용. native YouTube 자막은 `.ytp-caption-window-container { display: none !important }`로 숨김.
- **드래그 UX**: DOM 핸들 없음(A13에서 제거). `.ydt-container` 자체가 `pointerdown` 타겟이고, `::before`(`inset: -6px`)가 hit-area 확장 + cyan halo 시각 affordance 둘 다 담당. 텍스트 선택이 1순위라 `e.target`이 `.ydt-cue-text` 또는 `.ydt-history`(누적 윗줄) 안이면 pointerdown은 early-return — native 선택에 완전 양보. 같은 두 셀렉터에 `cursor: text`도 매칭. 드래그 가능 영역은 행 padding + 두 행 사이 4px gap + 외곽 6px halo 띠. `clampPosition`은 좌우 대칭(예전 `HANDLE_MARGIN_PX` 없음). **위치(%) 좌표계 기준은 컨테이너의 CSS offset parent(= mount host `#movie_player`)이지 `video` 요소가 아니다(A28)** — YouTube는 레터박스(상하 검은 띠) 영상에서 `<video>`를 콘텐츠 크기로 축소·중앙배치해 player보다 세로로 작고 위치가 다른데, CSS `left/bottom %`는 offset parent 기준으로 풀리므로 드래그/clamp 계산도 같은 박스를 써야 한다. `positioningRect()`(`offsetParent ?? host`)가 `clampPosition`·`onPointerDown`·`onMove` 공통 기준. 옛 코드가 `video` rect를 써서 폭은 우연히 일치(좌우 정상)하나 세로가 어긋나 레터박스 영상 맨 아래에서 세로 드래그가 0에 고착되던 버그를 수정.
- **누적(rolling) 윈도우**(A14): 싱글 자막 모드(translation-only / source-only / 모국어 영상)에서만 현재 cue(=문장) 위에 직전 `singleContextLines-1`개 cue(=문장)를 쌓아 맥락 보강. 듀얼 모드는 두 줄 이미 보이므로 누적 안 함. 행마다 `.ydt-history` div가 텍스트 span 위에 자리. `isRollingActive()`로 게이트, `renderHistory(idx)`가 윈도우 그림. Sticky gap-fill: 발화 사이 공백에서 cue가 -1이어도 직전 윈도우 유지(`update()`의 sticky 분기). `historyLayout: 'stacked'`는 cue마다 한 줄, `'inline'`은 현재 줄과 한 문단 흐름. `dimHistory`는 stacked일 때만 컨테이너 opacity로 적용 (inline은 한 문단 흐름이라 흐려지면 가독성↓ — A18에서 분기 추가). 번역 줄에서 history cue의 번역 아직 미도착이면 원문으로 임시 대체(setTargetTexts 도착 시 lastIdx=-2로 재렌더).

### 9. SPA navigation race

YouTube는 `yt-navigate-finish` 이벤트로 영상 전환을 알림. 단순히 매 navigate마다 cue를 비우면 새 cue가 동시에 도착할 때 파괴됨. 해결: `mountedVideoId`에 현재 cue가 어느 영상 것인지 기록해두고, navigate 시 `currentVideoId() !== mountedVideoId`일 때만 `clearCues`(`content/index.ts:201-207`). 번역 mid-flight 응답도 `currentVideoId()` 비교로 drop(같은 파일의 `translateCues`).

### 10. 'C' 단축키

`subtitlesEnabled` 토글. capture phase + `stopImmediatePropagation`으로 YouTube native 'c' 핸들러를 **차단**(동시 발화하면 우리 click과 native click이 합쳐져 토글이 상쇄됨)한 뒤, CC 버튼 `aria-pressed`가 우리 상태와 다르면 직접 `btn.click()`해 하단 CC 버튼 시각 상태를 동기화한다(우리 native 자막은 CSS로 숨겨져 있으므로 native가 켜져도 보이지 않음). input/textarea/contenteditable focus 시는 통과(검색창의 'c' 입력 보호). 키 판별은 물리 키 `ev.code === 'KeyC'` 우선(+ `ev.key === 'c'` 폴백) — `ev.key`만 보면 CapsLock 시 `'C'`, 한글 IME 시 `'ㅊ'`이 되어 우리 핸들러는 새고 native(keyCode 기반)만 발화해 "CC 아이콘만 바뀌고 자막은 안 토글"되는 불일치가 생김.

### 11. 마지막 번역 백엔드 표시 (A21)

production build는 `console.log`를 strip하므로(`vite.config.ts:12`) F12/SW devtools에서 성공 로그가 안 보인다. 사용자가 "지금 어느 백엔드로 동작 중인지" 확인하기 어려운 문제를 팝업 한 줄로 해결.

- `secrets.ts:setLastBackend({ used, preferred, at })`: background가 매 성공 호출 후 `chrome.storage.local`에 기록. fire-and-forget.
- 팝업(`popup/main.tsx:LastBackendLine`): 열릴 때 `getLastBackend()` 호출 → "최근 번역: Gemini · 2분 전" 한 줄 표시. preferred ≠ used면 ⚠ 표시 + 색 변경(fallback 시각화). 1분 간격으로 "N초/N분 전" 갱신. 30분 이상 지난 정보는 흐리게(stale 표시).
- 왜 storage.sync 아닌 local: 휘발성 런타임 상태(다른 기기와 공유 가치 없음) + sync 쿼터 절약. 키 분리 패턴과 같은 storage area 공유.

### 12. CC 버튼 ↔ subtitlesEnabled 단방향 sync (A16)

`ccButtonObserver`는 page CC 버튼의 `aria-pressed`를 감시하지만 **CC=true → 우리 true만 sync**, CC=false는 무시. 이유: page sticky 잘못된 lang으로 새 영상에 자막이 자동 disable되는 케이스에서 우리까지 따라 disable되면 사용자가 자막을 못 봄. 자막 끄기는 사용자가 C 키나 팝업으로만 함. trade-off: 사용자가 native CC 버튼을 직접 클릭해 끄는 동작이 우리에 반영 안 됨 (native만 끔, 우리 자막은 계속 표시).

### 13. 문장 재조립 — cue → Sentence 세그멘테이션 (A27, v0.4.0)

**근본 문제:** YouTube ASR이 단어/구 중간에서 cue를 토막낸다(예: "amazing social currency"가 `...amazing social` / `currency` 두 cue로). cue 단위로 번역하면 토막만 보고 번역해 문맥이 손실된다(currency 누락 등). Immersive Translate처럼 인접 cue를 한 문장으로 묶어 번역·표시하면 온전한 문맥을 본다.

**핵심 추상화:** `parseJson3 → cues[]` 와 translate/render 사이에 세그멘테이션 레이어를 끼운다. `src/shared/segment.ts`의 `segmentCues(cues): Sentence[]`. `Sentence`는 `Cue`의 **상위집합**(`{start,end,text,words?}` + `cueStart/cueEnd`, `shared/types.ts`)이라 렌더러·번역은 sentence를 cue처럼 그대로 다룬다(섹션 8). 이 추상화 하나가 병합기준·타이밍·렌더 영향을 동시에 해결.

- **병합 기준** (다중 신호 + fallback — ASR이 문장부호를 주든 안 주든 동작): `segment.ts` 상단 상수가 튜닝 노브.
  1. 종결 부호: cur cue가 `SENTENCE_FINAL`(`.?!…。！？` + 닫는 따옴표/괄호)로 끝나면 거기서 끊음(가장 신뢰도 높은 신호).
  2. 긴 침묵: 다음 cue와의 간격 ≥ `GAP_THRESHOLD_SEC`(0.8s)면 절/문장 경계. parseJson3가 겹친 cue를 clip해 contiguous하게 만들므로 gap>0은 실제 무음을 의미.
  3. 길이 캡: `MAX_CHARS`(200) / `MAX_CUES`(12) — 부호 없는 ASR이 영상 전체를 한 문장으로 묶는 runaway 방지.
- **타이밍:** 문장 start/end = 구성 cue들의 합집합. 문장 사이는 contiguous(overlap-clip 덕), 진짜 무음 구간만 gap → 침묵엔 자연히 빈 화면(또는 rolling sticky 유지).
- **word-reveal:** 문장의 `words`는 구성 cue들의 word 타이밍(절대 시각)을 이어붙임. 하나라도 words 없으면 전체 undefined(텍스트만 표시). 문장을 통째로 띄우되 미발화 단어는 word-reveal이 dim → preview 효과가 자동으로 따라옴(섹션 8).
- **번역 정렬 개선:** 단위가 진짜 문장이라 모델이 인접 조각을 합칠 게 없어 길이 mismatch가 크게 줄어든다. 백엔드 청크 문맥(섹션 5의 mindlogic %% 등)과 겹쳐 단어 뜻·말투도 더 정확.
- **배선** (`content/index.ts`): `parseJson3` 직후 `segmentCues` → `renderer.setCues(sentences)` + `translateCues(sentences)`. `lastSentences` 보관(재번역용, 섹션 6). 캐시 길이 검증·배치 분할 모두 문장 개수 기준. 배치 크기는 문장이 길어 25/4로 낮춤(섹션 5).
- **한계:** `naughty.`처럼 종결부호로 끝나는 단독 문장은 여전히 단독 번역 — 청크 문맥으로 단어 뜻은 보정되나 완전 해소는 아님. `GAP_THRESHOLD_SEC`·길이 캡은 영상별 편차가 있어 Immersive와 나란히 두고 튜닝 대상.

### 14. 단어·표현 해설 (드래그 선택 → AI 영어 선생님, A29, v0.5.0)

**의도:** 자막에서 모르는 표현을 드래그하면 단순 번역을 넘어 예문·어원·표·뉘앙스까지 "영어 선생님" 스타일로 해설. 사용자가 쓰던 Gemini Gem 흐름(탭 왕복)을 확장 안으로 들여옴. **번역과 완전 별개 경로** — router/캐시/길이검증을 안 거치는 on-demand 단발 chat 호출.

- **트리거·표시** (`content/explain/explain-ui.ts`, `ExplainUI`): `mouseup` → `window.getSelection()`이 `.ydt-container` 안의 비어있지 않은 선택이면 선택 rect 위에 `.ydt-explain-btn`("💡 해설")을 띄움. native 텍스트 선택은 이미 동작(렌더러 pointerdown이 `.ydt-cue-text`에서 양보, 섹션 8) — UI는 그 결과만 읽는다. 클릭 시 우상단 사이드 패널(`.ydt-explain-panel`)에 로딩→markdown 렌더. 문맥은 같은 박스의 원문 줄(`.ydt-source .ydt-cue-text`) 전체를 같이 보내 단어 뜻 disambiguation. 버튼/패널은 `document.fullscreenElement ?? document.body`에 append하고 `fullscreenchange`에 re-home(전체화면에서도 보이게). Esc로 패널 닫기.
- **백엔드** (`background/explain.ts`, `explain()`): 자유서술이 가능한 BYOK 둘만 — `ExplainBackendSchema = enum('gemini','mindlogic')`. `google-free`/`chrome-builtin`은 해설 불가라 제외. gemini는 `generateContent`(systemInstruction=프롬프트, JSON schema 없음), mindlogic은 `chat/completions`(system+user). `temperature 0.3`, `maxOutputTokens/max_tokens 4096`(A32, 표 여러 개 잘림 방지). 429/5xx 1회 백오프, 401/403 즉시 throw. 키는 번역과 동일하게 `secrets.ts`(storage.local) 재사용 — 새 키 입력 UI 불필요. 모델은 번역과 분리된 `explainGeminiModel`/`explainMindlogicModel`(섹션 17).
- **프롬프트는 사용자 편집 가능**: `settings.explainPrompt`(storage.sync), 기본값 `DEFAULT_EXPLAIN_PROMPT`(=사용자 Gem 프롬프트, `settings.ts`). 옵션 페이지 textarea + "기본값으로" 버튼. system 메시지로 그대로 전달돼 답변 형식을 정함.
- **배선**: content `requestExplain(text, context)` → `EXPLAIN` 메시지(backend/model/prompt 동봉, 모델은 explainBackend에 따라 `explainGeminiModel`/`explainMindlogicModel` — 번역 모델과 분리, 섹션 17) → background 핸들러 → `explain()` → `{ok, markdown}`. `applySettings`가 `explainUI.setEnabled(explainEnabled)`. 로딩 패널에 현재 모델명 표시(섹션 17).
- **markdown 렌더는 자체 구현** (`content/explain/markdown.ts`, `renderMarkdown`): 신뢰 불가한 LLM 출력이라 **innerHTML 미사용** — 모든 텍스트를 `textContent`로만 넣고 element를 직접 생성해 XSS를 원천 차단(sanitizer 의존성 불필요). 지원 문법은 해설에 실제 쓰이는 것만: 헤딩·GFM 표·순서/비순서 목록·코드펜스·인라인(`` `code` ``/`**bold**`/`*italic*`). 스타일은 `styles.ts`의 `.ydt-explain-*`(패널 하위로 스코프).
- **옵션 키 노출 조건**: Gemini/Mindlogic 설정 섹션이 예전엔 번역 backend === 그 백엔드일 때만 보였으나, explain이 그 백엔드를 쓰면(`explainEnabled && explainBackend === ...`)도 보이도록 조건 확장 — 번역=google-free + 해설=gemini 조합에서 키 입력 가능.
- **비용·한계:** 사용자가 누를 때만 1회 호출이라 비용 통제됨(자막 전체 번역과 다름). 페이지의 다른 사전 확장과 선택 팝업이 겹칠 수 있으나 우리 버튼은 `.ydt-container` 안 선택에만 발화. 후속 대화(follow-up Q)는 v1 미지원 — 단발 해설만.

### 15. 해설 → Notion/클립보드 정리 (A30, v0.6.0)

**의도:** 해설 패널 내용을 모아 복습할 수 있게 외부로 내보낸다. 두 경로를 제공 — **무설정 클립보드 복사**와 **BYOK Notion API 직접 저장**.

- **패널 액션 버튼** (`explain-ui.ts`): 해설 도착 시 헤더의 `📋 복사`/`📝 Notion` 활성화. `lastResult{term,markdown,context}` 보관해 두 버튼이 참조. Notion 버튼은 `notionEnabled`일 때만 표시(`setNotionEnabled`).
  - **📋 복사**: `navigator.clipboard.writeText`로 `## term` + markdown(+ 자막 인용)을 복사. **Notion은 markdown 붙여넣기를 자동으로 리치 블록 변환**하므로 무설정으로도 표·예문이 살아 들어감. 가장 빠른 효용.
  - **📝 Notion**: `requestNotionSave` → `NOTION_SAVE` 메시지(영상 제목/URL 동봉) → background. 저장중→`✓ 저장됨 ↗`(클릭 시 생성된 페이지 열기)/`✗ 저장 실패`(2.5s 후 원복).
- **백엔드** (`background/notion.ts`, `saveToNotion`): 호출 경로는 gemini/mindlogic와 동일 — SW가 `host_permissions`의 `api.notion.com`으로 fetch(CORS 우회). 토큰은 `secrets.ts`(storage.local), DB ID는 settings(storage.sync). `Notion-Version: 2022-06-28`.
  - **DB 스키마 적응**: `GET /v1/databases/{id}`로 **title 속성 "이름"**(DB마다 Name/이름/… 다름)을 찾아 제목=선택표현 매핑. URL/Date 타입 속성이 있으면 best-effort로 영상 링크/오늘 날짜 채움(없으면 건너뜀 — 어떤 DB에도 안 깨짐). 그 외 속성은 안 건드림.
  - **본문**: 영상 링크 paragraph + 자막 문맥 quote + divider + `markdownToBlocks(markdown)`. 단 **URL 속성이 있으면 본문 영상링크 문단은 생략**(A32, 중복 제거 — 링크는 속성으로 가고, URL 속성 없는 DB에서만 본문 fallback).
  - **ID 정규화**: DB URL을 통째로 붙여넣어도 **첫 번째** 32 hex 추출 → 대시 형태로 재조립(`normalizeId`). DB URL은 경로의 DB id + 쿼리 `?v=`의 view id로 32-hex가 둘이라, 마지막을 쓰면 view id를 잡아 오답 — 첫 매치가 DB id.
- **markdown→Notion 블록** (`background/notion-blocks.ts`, `markdownToBlocks`): SW엔 DOM이 없어 `content/explain/markdown.ts`를 재사용 못 함 — **같은 블록 인식 로직의 평행 구현**이되 출력이 Notion 블록 JSON. heading_1~3·paragraph·목록·code·table(+table_row)·인라인 rich_text(bold/italic/code). `inlineToRichText`는 **재귀**라 볼드/이탤릭 안의 코드를 결합 annotation(`{bold,code}`)으로 — 사용자가 볼드 단어에 백틱 표시 시 나오는 ``**`word`**``를 평면 파싱하면 안쪽 백틱이 리터럴로 깨지던 걸 해결(A32, 섹션 17). rich_text 조각 2000자 청크, children 100블록 cap.
- **테스트 버튼**: `TEST_NOTION` → `testNotion(token, dbId)`가 `GET databases`로 토큰+DB 연결(share)+ID를 한 번에 검증(DB 제목 반환). gemini/mindlogic의 router 우회 테스트 패턴과 동일.
- **셋업 부담**: integration 토큰 + DB를 integration에 연결(share) + DB URL 입력 3단계 — 옵션 페이지에 안내. (gemini 키 복붙 1회보다 많음.)

### 16. 폰트 크기 조절 — 휠 행별 분기 + 팝업 스테퍼 (A31, v0.7.0)

원문/번역 폰트 크기는 데이터 모델에서 이미 분리돼 있다(`settings.sourceStyle.fontSize` / `targetStyle.fontSize`, DOM도 `sourceEl`/`targetEl`). 조절 경로 둘:

- **휠** (`subtitle-renderer.ts:onWheel`): 자막 컨테이너 위 휠 → 1px씩 ±. **행별 분기** — `targetEl.contains(target)`이면 **번역만**, 그 외(원문 행·행 사이 4px gap·외곽 halo)는 **원문+번역 둘 다**. 비명백한 비대칭의 의도: 사용자가 원문을 크게 보는 패턴이라 큰 원문 행이 호버하기 쉬워 "둘 다"의 기본 타겟이 되고, 번역만 미세조정하고 싶을 때만 작은 번역 행을 정조준한다. `document`에 capture phase + `passive:false`로 부착(YouTube player가 wheel 가로채는 것 회피 + 페이지 스크롤 차단). 변경분은 `onFontSizeChange(source, target)` → `content/index.ts`가 `saveSettings({sourceStyle, targetStyle})`로 영속화.
- **팝업** (`popup/main.tsx:SizeRow`/`bumpSource`/`bumpTarget`): `원문 크기`/`번역 크기` 행에 `−`/`+` 버튼(±2px). 휠이 발견성 0(안내 없는 제스처)인 걸 보완하는 명시 컨트롤. 기존 `update()` 배선 그대로 — `storage.sync` 저장 → content가 `onChanged`로 즉시 반영(`applySettings` → `setFontSizes`). 스키마·메시지 추가 없음.
- 범위는 양쪽 모두 8~72(`FONT_SIZE_MIN/MAX` ≡ settings 스키마). 옵션 페이지의 슬라이더와 같은 값을 공유하므로 세 surface(옵션·팝업·휠)가 동일 settings를 조작.

### 17. 해설 모델 분리 + Mindlogic 동적 모델 + 백틱 하이라이트 (A32, v0.8.0)

**(1) 번역/해설 모델 분리.** 번역(자막 수백 cue, 가성비)과 해설(드래그 1회, 품질)은 호출 프로필이 정반대라 모델을 나눈다. `settings.explainGeminiModel`/`explainMindlogicModel` 신설(번역용 `geminiModel`/`mindlogicModel`과 별개). `content/index.ts:requestExplain`이 explainBackend에 따라 이 둘 중 하나를 `EXPLAIN`에 실음. Gemini에 `3.5-flash`(=`gemini-3.5-flash`) 추가 — 해설 기본값(Gem과 동급; 2.5-flash는 다단계 포맷 지시 순응도가 낮아 답변이 부실했던 게 발단). 해설 로딩 메시지에 현재 모델명 표시(`lang-options.ts:explainModelLabel` → `ExplainUI` 생성자 콜백).

**(2) Mindlogic 동적 모델.** 게이트웨이 `GET /v1/gateway/models`(OpenAI 호환 `{data:[{id,owned_by}]}`)로 사용 가능 모델 전체를 가져온다(`mindlogic.ts:listMindlogicModels`, background `MINDLOGIC_LIST_MODELS` 메시지). 옵션 "모델 새로고침" 버튼 → `chrome.storage.local`(`ydtMindlogicModels`) 캐시 → owner별 `<optgroup>` 드롭다운(번역·해설 모델 둘 다). 이를 위해 `MindlogicModelSchema`를 **enum→`z.string()`**(목록 밖 모델 선택 시 검증 실패→default 리셋 방지; 게이트웨이가 실제 유효성 판정). `mindlogic.ts:validateModel`도 비어있지 않은 문자열 허용으로 완화. `lang-options.ts:MINDLOGIC_MODELS`(+`GEMINI_MODELS`)는 추천 마커(`transHint`=번역 관점, `explainHint`=해설 관점)와 새로고침 전 fallback으로 남는 **하드코딩** 목록 — `/models`는 id·owner만 주므로 "추천"은 자동 갱신 안 됨(모델 라인업 바뀌면 코드로 갱신).

**(3) 백틱 하이라이트 도구.** 해설 패널에서 텍스트를 형광펜처럼 백틱(코드)으로 표시 — 복사/Notion에 백틱으로 반영, 공부·기록용. **DOM이 source of truth**(옛 markdown 문자열 매칭은 드래그에서 반복어구·서식 가로지름에 엉뚱한 위치를 감싸 깨졌음): 선택된 **텍스트 노드마다** 그 부분만 `surroundContents(<code class=ydt-user-mark>)`로 감싸 노드 경계 걸침을 회피한다(`explain-ui.ts:toggleMarkSelection`/`textNodesInRange`/`unwrapMark`; 사용자의 Chrome Annotation 프로젝트 검증 방식 차용). 내보낼 때만 `markdown.ts:domToMarkdown`(`renderMarkdown`의 역방향: heading/목록/표/코드펜스 + 인라인 직렬화)으로 DOM→markdown → 복사/Notion이 그걸 사용(`currentMarkdown`). `lastResult.markdown`은 더 이상 마크용으로 변형 안 함(DOM이 진실). 버튼 동작: 선택 있으면 그 선택을 토글하고 모드 ON 유지(드래그 후 버튼도 OK, 순서 무관 — `mousedown preventDefault`로 선택 보존), 선택 없으면 모드 토글. 수동 표시는 빨강(`.ydt-user-mark`), AI 예문 백틱은 청록 — 패널 안 구분(Notion엔 동일 백틱). 빨간 칩 클릭으로 해제.

**(4) Notion 내보내기 보강.** `notion-blocks.ts:inlineToRichText` 재귀화로 볼드+코드 결합 annotation 지원(섹션 15). `notion.ts:saveToNotion`은 DB에 **URL 속성이 있으면 본문 맨 윗줄 영상링크 문단 생략**(중복 제거 — 링크는 속성으로; 속성 없는 DB에서만 본문 fallback).

## 비명백한 주의사항

- **코드를 바꾸면 `npm run build` 필수**. Chrome은 `dist/`만 본다. 옵션 페이지가 변경 안 보이면 99% 빌드 안 했거나 확장 ↻ 안 했거나 옵션 탭 안 새로고침함.
- **번역 백엔드별 호출 모델이 다르다**. `google-free`는 batch 1회 GET, `chrome-builtin`은 N회 순차, `gemini`는 batch 1회 POST(Gemini native API + JSON schema 강제), `mindlogic`은 batch 1회 POST(OpenAI 호환 chat/completions + `%%` 구분자·few-shot로 개수 보존 유도, temp 0). 새 백엔드 추가 시 `router.ts`의 fallback 로직과 `idb-cache`의 key 포맷, `settings.BackendIdSchema`+`translators/types.ts:BackendId` 두 곳, `lang-options.ts:BACKENDS` 모두 동기 갱신. BYOK면 `secrets.ts`에 키 getter/setter + 옵션 페이지 키 입력 UI + `background/index.ts`의 `TEST_<backend>` 메시지 핸들러 + manifest `host_permissions`까지 추가.
- **BYOK 비밀값은 `secrets.ts` + `chrome.storage.local`** — settings(storage.sync)와 의도적으로 분리. 새 BYOK 백엔드 추가 시 같은 패턴 따를 것. 옵션 페이지에서 키 입력은 별도 디바운스 저장 + "테스트" 클릭 시 보류 저장 flush.
- **웹스토어 배포 권한 사유**: `generativelanguage.googleapis.com`은 "사용자 본인 Gemini API 키로 자막 번역/해설", `factchat-cloud.mindlogic.ai`는 "학교/조직 발급 Mindlogic Gateway 키로 자막 번역/해설", `api.notion.com`은 "사용자 본인 Notion integration 토큰으로 해설을 본인 DB에 저장" 용도. 모두 자체 키 미포함(BYOK), 익스텐션 코드에 비밀값 없음. 제출 시 manifest justification에 그대로 사용 가능.
- **`world: 'MAIN'` 스크립트는 HMR 제약**이 있다. 빌드 로그에 `Some content-scripts don't support HMR because the world is MAIN: /src/content/inject-main.ts` 경고가 나오는 게 정상 — `inject-main.ts`를 바꾸면 확장 ↻로 새로 로드해야 함.
- **`offscreen` 문서는 manifest entry가 아니다**. `vite.config.ts:14-17`에서 별도로 rollup input에 등록되어 있음. 새 offscreen 페이지 추가 시 같은 패턴 따를 것.
- **`web_accessible_resources.matches`는 `youtube.com`으로 좁혀져 있음** (`manifest.ts:49-57`). offscreen HTML은 익스텐션 내부 호출(`chrome.offscreen.createDocument`)로만 띄워지므로 외부 origin 화이트리스트는 좁아도 동작에 영향 없음. 스토어 최소권한 원칙에 맞게 유지.

## 커밋 메시지 컨벤션 (관찰된 패턴)

`git log` 기준: `M1`~`M7`은 마일스톤, `A1`~`A3`는 부가/알고리즘 작업으로 보인다. 형식: `<태그>: <변경 요약>`. 영어, 짧고 함축적. 예: `A3: C-key shortcut toggles dual subtitles` / `M7: options page, live restyle, language/backend retranslate`.
