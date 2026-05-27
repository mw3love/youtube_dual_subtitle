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
- `google-free.ts`: `translate.googleapis.com/translate_a/single?client=gtx` 비공식 엔드포인트. N개 텍스트를 `\n`으로 join해 **HTTP 1회**. URL ~8KB 한계 → 배치 분할은 호출 측 책임(`content/index.ts`의 `TRANSLATE_BATCH_SIZE = 50`). `\n` 보존 가정이 깨지면 줄 수 불일치 → 호출 측에서 캐싱 안 함.
- `chrome-builtin.ts`: Chrome 138+ `window.Translator`. **service worker에서 직접 호출 불가** → offscreen document(`src/offscreen/`)에 위임.
  - `OFFSCREEN_READY` 신호로 race 회피: createDocument resolve 직후엔 offscreen의 onMessage listener가 아직 안 걸려있을 수 있음.
  - `OFFSCREEN_PING`으로 살아있는지 확인 후 reuse, 죽었으면 재생성.
  - `Translator.translate`는 단건만 받아 N회 **순차** 호출(메모리 충돌 회피, `offscreen/index.ts:96-99`). 짧은 자막 한 줄씩 독립 번역되므로 문맥 손실 있음.
  - Translator 인스턴스는 `(src, tgt)` pair별로 캐시.
- `gemini.ts` (BYOK, A19): `generativelanguage.googleapis.com/v1beta/models/{id}:generateContent`. 사용자가 본인 키 입력. 모델 ID는 `gemini-2.5-flash` / `gemini-2.5-flash-lite` 안정 버전(preview/latest alias 회피).
  - 입력 배열을 `JSON.stringify` → user 메시지 한 줄, `generationConfig.responseMimeType=application/json + responseSchema(ARRAY of STRING)`로 JSON 강제. 응답 배열 길이 ≠ 입력 길이면 throw → router fallback.
  - 429/5xx만 1500ms 1회 재시도. 401/403/400은 즉시 throw. safety filter로 candidate empty면 finishReason 포함 throw.
  - **키는 settings(storage.sync) 아니라 `secrets.ts` + `chrome.storage.local`** — 웹스토어 배포 시 사용자 키가 Google 계정 동기화로 전파되지 않도록 분리. gemini.ts가 호출 시점에 storage.local과 storage.sync에서 fresh read (race 회피).
  - 옵션 페이지 "테스트" 버튼은 router 우회용 `TEST_GEMINI` 메시지 + `testGeminiKey(apiKey, model)` 직접 호출. router fallback이 키 오류를 가려 "성공"으로 보이는 사고 방지. 클릭 시 디바운스 보류 중인 키 저장 먼저 flush.

### 6. Settings — 즉시 반영 + 자동 재번역

- `src/shared/settings.ts`: `zod` 스키마로 검증, partial 마이그레이션(새 필드는 default로). 모든 페이지가 같은 schema 공유.
- 옵션 페이지(`src/options/main.tsx`)는 변경을 즉시 UI에 반영하되 `storage.sync.set`은 **250ms 디바운스** (color/slider 입력으로 분당 120회 quota에 안 걸리게).
- `src/content/index.ts:241-255`: `chrome.storage.onChanged` 수신 → settings 전체 reload → `applySettings`. `RETRANSLATE_KEYS = {sourceLang, targetLang, backend, geminiModel}` 중 하나가 바뀌면 현재 영상 자동 재번역(`lastCues` 보관 덕분).

### 7. 캐시

- `src/shared/cache/idb-cache.ts`: IndexedDB via `idb-keyval`.
- key: `ydt::{videoId}::{src}::{tgt}::{backend}` — backend가 바뀌면 별개 캐시(품질 다르므로). Gemini는 모델별 결과가 달라 backend 자리에 `gemini:flash` / `gemini:flash-lite` 합성(`content/index.ts:cacheBackendTag`). 다른 백엔드는 기존 포맷 유지(하위 호환).
- TTL 30일, MAX 200엔트리, `set` 시 5% 확률로 lazy prune.
- 번역 결과 길이가 입력 길이와 일치할 때만 저장 (alignment 어긋난 결과 캐싱 방지).

### 8. 렌더링

- `SubtitleRenderer`(`src/content/renderer/subtitle-renderer.ts`): `requestAnimationFrame` 루프로 매 프레임 cue 인덱스 갱신. `video.timeupdate`는 ~250ms 간격이라 onset/offset이 끊겨 부적합.
- `findCueIndex`는 이전 인덱스 기반 빠른 경로(현재 cue 유지 / 다음 cue 진입) 두 번 체크 후 선형 폴백 — 정주행 시 ~1회 비교.
- `findMountTarget`(`container.ts`): YouTube DOM 셀렉터에 최소 의존. **video element 기반 탐지**로 active 영상(Shorts 다중 reel 포함) 찾음.
- `styles.ts`: 사용자 조절 값은 모두 CSS 변수로 `:root`에 박아 `:fullscreen` / `[data-mode="shorts"]` 보정까지 한 번에 적용. native YouTube 자막은 `.ytp-caption-window-container { display: none !important }`로 숨김.
- **드래그 UX**: DOM 핸들 없음(A13에서 제거). `.ydt-container` 자체가 `pointerdown` 타겟이고, `::before`(`inset: -6px`)가 hit-area 확장 + cyan halo 시각 affordance 둘 다 담당. 텍스트 선택이 1순위라 `e.target`이 `.ydt-cue-text` 또는 `.ydt-history`(누적 윗줄) 안이면 pointerdown은 early-return — native 선택에 완전 양보. 같은 두 셀렉터에 `cursor: text`도 매칭. 드래그 가능 영역은 행 padding + 두 행 사이 4px gap + 외곽 6px halo 띠. `clampPosition`은 좌우 대칭(예전 `HANDLE_MARGIN_PX` 없음).
- **누적(rolling) 윈도우**(A14): 싱글 자막 모드(translation-only / source-only / 모국어 영상)에서만 현재 cue 위에 직전 `singleContextLines-1`개 cue를 쌓아 맥락 보강. 듀얼 모드는 두 줄 이미 보이므로 누적 안 함. 행마다 `.ydt-history` div가 텍스트 span 위에 자리. `isRollingActive()`로 게이트, `renderHistory(idx)`가 윈도우 그림. Sticky gap-fill: 발화 사이 공백에서 cue가 -1이어도 직전 윈도우 유지(`update()`의 sticky 분기). `historyLayout: 'stacked'`는 cue마다 한 줄, `'inline'`은 현재 줄과 한 문단 흐름. `dimHistory`는 stacked일 때만 컨테이너 opacity로 적용 (inline은 한 문단 흐름이라 흐려지면 가독성↓ — A18에서 분기 추가). 번역 줄에서 history cue의 번역 아직 미도착이면 원문으로 임시 대체(setTargetTexts 도착 시 lastIdx=-2로 재렌더).

### 9. SPA navigation race

YouTube는 `yt-navigate-finish` 이벤트로 영상 전환을 알림. 단순히 매 navigate마다 cue를 비우면 새 cue가 동시에 도착할 때 파괴됨. 해결: `mountedVideoId`에 현재 cue가 어느 영상 것인지 기록해두고, navigate 시 `currentVideoId() !== mountedVideoId`일 때만 `clearCues`(`content/index.ts:201-207`). 번역 mid-flight 응답도 `currentVideoId()` 비교로 drop(같은 파일의 `translateCues`).

### 10. 'C' 단축키

`subtitlesEnabled` 토글. `preventDefault` 하지 않아 YouTube native 핸들러도 동시 발화 → 하단 CC 버튼 시각 상태가 자동 동기화됨(우리 native 자막은 CSS로 숨겨져 있으므로 native가 켜져도 보이지 않음). input/textarea/contenteditable focus 시는 통과(검색창의 'c' 입력 보호).

### 11. CC 버튼 ↔ subtitlesEnabled 단방향 sync (A16)

`ccButtonObserver`는 page CC 버튼의 `aria-pressed`를 감시하지만 **CC=true → 우리 true만 sync**, CC=false는 무시. 이유: page sticky 잘못된 lang으로 새 영상에 자막이 자동 disable되는 케이스에서 우리까지 따라 disable되면 사용자가 자막을 못 봄. 자막 끄기는 사용자가 C 키나 팝업으로만 함. trade-off: 사용자가 native CC 버튼을 직접 클릭해 끄는 동작이 우리에 반영 안 됨 (native만 끔, 우리 자막은 계속 표시).

## 비명백한 주의사항

- **코드를 바꾸면 `npm run build` 필수**. Chrome은 `dist/`만 본다. 옵션 페이지가 변경 안 보이면 99% 빌드 안 했거나 확장 ↻ 안 했거나 옵션 탭 안 새로고침함.
- **번역 백엔드별 호출 모델이 다르다**. `google-free`는 batch 1회 GET, `chrome-builtin`은 N회 순차, `gemini`는 batch 1회 POST + JSON in/out. 새 백엔드 추가 시 `router.ts`의 fallback 로직과 `idb-cache`의 key 포맷, `settings.BackendIdSchema`+`translators/types.ts:BackendId` 두 곳, `lang-options.ts:BACKENDS` 모두 동기 갱신.
- **BYOK 비밀값은 `secrets.ts` + `chrome.storage.local`** — settings(storage.sync)와 의도적으로 분리. 새 BYOK 백엔드 추가 시 같은 패턴 따를 것. 옵션 페이지에서 키 입력은 별도 디바운스 저장 + "테스트" 클릭 시 보류 저장 flush.
- **웹스토어 배포 권한 사유**: `generativelanguage.googleapis.com` host_permission은 "사용자가 본인 Gemini API 키로 자막 번역" 용도. 자체 키 미포함(BYOK), 익스텐션 코드에 비밀값 없음. 제출 시 manifest justification에 그대로 사용 가능.
- **`world: 'MAIN'` 스크립트는 HMR 제약**이 있다. 빌드 로그에 `Some content-scripts don't support HMR because the world is MAIN: /src/content/inject-main.ts` 경고가 나오는 게 정상 — `inject-main.ts`를 바꾸면 확장 ↻로 새로 로드해야 함.
- **`offscreen` 문서는 manifest entry가 아니다**. `vite.config.ts:14-17`에서 별도로 rollup input에 등록되어 있음. 새 offscreen 페이지 추가 시 같은 패턴 따를 것.
- **`host_permissions`에 `factchat-cloud.mindlogic.ai`가 있음** (`manifest.ts:34`)이지만 현재 코드에서 사용 흔적 없음 — 추후 백엔드 추가 예정인지 dead permission인지 확인 필요.

## 커밋 메시지 컨벤션 (관찰된 패턴)

`git log` 기준: `M1`~`M7`은 마일스톤, `A1`~`A3`는 부가/알고리즘 작업으로 보인다. 형식: `<태그>: <변경 요약>`. 영어, 짧고 함축적. 예: `A3: C-key shortcut toggles dual subtitles` / `M7: options page, live restyle, language/backend retranslate`.
