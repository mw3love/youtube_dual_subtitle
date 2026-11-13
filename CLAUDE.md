# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트

YouTube 듀얼 자막(원문 + 번역) Chrome MV3 확장. TypeScript + React(옵션 페이지만) + Vite + `@crxjs/vite-plugin`. **코드 주석은 한국어 기준이고, 화면에 나가는 문자열은 전부 `shared/i18n.ts` 사전을 거친다(기본 영어, 옵션에서 한국어 — 섹션 46).** UI 문자열을 코드에 직접 박지 말 것.

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

여기엔 핵심 구조(섹션 1~13)만 둔다. 이후 기능별 섹션(12·14~53)의 전문은 `docs/FEATURE_NOTES.md`, 요약 색인은 이 파일 아래 「기능 노트 색인」.

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
  - 외국어 영상 → 영상 원본 언어(`videoLang`, ASR 트랙 lang) 매치 트랙 우선 (manual > asr). **A62(섹션 38)부터** — 그 전엔 사용자 설정 `preferredSource` 매치가 기준이었으나 설정 자체를 제거하고 완전 자동감지로 전환.
  - 자동 더빙 영상(ASR 트랙이 더빙 언어마다 있음)은 첫 ASR이 원래 언어가 아니라서, MAIN이 보내는 `originalLang`(더빙 아닌 음성 트랙 언어)과 맞는 ASR을 `videoLang`으로 쓴다 — 섹션 52.
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
- `gemini.ts` (BYOK, A19): `generativelanguage.googleapis.com/v1beta/models/{id}:generateContent`. 사용자가 본인 키 입력. 모델 ID는 **A38부터 자유 문자열 + `/models` 동적 목록**(섹션 21) — `gemini-2.5-flash` / `gemini-2.5-flash-lite` / `gemini-3.5-flash`는 추천 curated 기본값(안정 버전, preview/latest alias 회피)이자 새로고침 전 fallback. 번역은 `geminiModel`, 해설은 별도 `explainGeminiModel`로 분리(섹션 17).
  - 입력 배열을 `JSON.stringify` → user 메시지 한 줄, `generationConfig.responseMimeType=application/json + responseSchema(ARRAY of STRING)`로 JSON 강제. 응답 배열 길이 ≠ 입력 길이면 throw → router fallback.
  - 429/5xx만 1500ms 1회 재시도. 401/403/400은 즉시 throw. safety filter로 candidate empty면 finishReason 포함 throw.
  - **429 cooldown (A21)**: 429 받으면 `rateLimitedUntil`을 60s 후로 set → 다음 `translateBatch` 진입 시 즉시 throw → router가 google-free로 fallback. 매 batch마다 1.5s 백오프 × 청크 누적 지연 방지. `testGeminiKey`는 cooldown 우회 + 성공 시 reset (사용자가 새 키 검증 가능하게).
  - **키는 settings(storage.sync) 아니라 `secrets.ts` + `chrome.storage.local`** — 웹스토어 배포 시 사용자 키가 Google 계정 동기화로 전파되지 않도록 분리. gemini.ts가 호출 시점에 storage.local과 storage.sync에서 fresh read (race 회피).
  - 옵션 페이지 "테스트" 버튼은 router 우회용 `TEST_GEMINI` 메시지 + `testGeminiKey(apiKey, model)` 직접 호출. router fallback이 키 오류를 가려 "성공"으로 보이는 사고 방지. 클릭 시 디바운스 보류 중인 키 저장 먼저 flush.
- `mindlogic.ts` (BYOK, A24, v0.3.0): **UI 표시 이름은 A70(섹션 46)부터 「OpenAI 호환 게이트웨이」** — 우리가 쓰는 건 이 게이트웨이의 OpenAI 호환 Chat Completions 경로 하나뿐이고, 조직 브랜드를 공개 UI에 박을 이유가 없어서다. **내부 `BackendId`는 `'mindlogic'` 그대로**(캐시 키·storage 값·`TEST_MINDLOGIC` 메시지가 전부 이 문자열 기준이라 개명하면 기존 설정이 default로 리셋되고 캐시가 통째로 miss된다 — 표시 라벨과 식별자를 분리해 얻을 게 없음). Mindlogic API Gateway는 OpenAI/Anthropic/Google/xAI/Perplexity 등 여러 upstream을 단일 endpoint로 통과시키는 학교/조직 게이트웨이. OpenAI 호환 path로 통일해 모델 ID만 바꾸면 여러 provider 사용 가능. **base URL은 A61(섹션 37)부터 옵션 페이지 사용자 입력**(`settings.mindlogicBaseUrl`, 기본값 없음) — 조직마다 도메인이 달라(예: `factchat-cloud.mindlogic.ai` vs `factchat.mindlogic-kr-api.com`) 하드코딩 상수 대신 `getMindlogicBaseUrl() + '/chat/completions'`로 조립.
  - **모델 목록은 동적(A32)**: 게이트웨이 `GET /v1/gateway/models`로 사용 가능 모델 전체를 가져와 옵션 드롭다운에 표시(섹션 17). `MindlogicModelSchema`는 enum이 아니라 `z.string()` — 어떤 모델 id를 골라도 검증 통과(게이트웨이가 실제 유효성 판정). `lang-options.ts:MINDLOGIC_MODELS`의 6개(`gemini-2.5-flash` default·`gemini-3.1-flash-lite`·`claude-sonnet-4-6`·`claude-haiku-4-5-20251001`·`gpt-5.4-mini`·`gpt-5.4-nano`)는 추천 마커 + 새로고침 전 fallback으로 남는 하드코딩 부분집합. 권한 없는 모델은 401/403 → 번역은 router가 google-free로 fallback(해설은 fallback 없음).
  - 요청 포맷 (A26, Immersive 레시피 차용): `{model, messages:[system,user], temperature:0, max_tokens:4096}`. 짧은 자막 cue를 모델이 "유창하게" 합쳐 줄 수를 줄이는 경향(N in, N-2 out)으로 정렬이 깨지는 걸 세 가지로 억제 — (1) 청크 작게 `MINDLOGIC_CHUNK_SIZE = 5`, (2) `temperature: 0`(합치는 재량 제거), (3) cue를 JSON 배열이 아니라 **`%%` 구분자**(`"\n\n%%\n\n"` join) + few-shot 예시로 "같은 개수 in/out" 강하게 지시. (JSON 배열은 합쳐도 valid라 모델이 부담 없이 합침 — 구분자 방식이 순응도 높음.) `parseResponse`의 `splitSegments`가 `%%`로 split해 개수 검증, ```fence·preamble은 먼저 벗김. 단위가 문장으로 올라간 뒤(섹션 13) 합침 mismatch 자체가 크게 줄어 이 방어는 안전망 성격. **A44(섹션 24)부터 mindlogic은 문장당 1요청이라 입력이 항상 1개 → 이 `%%`·few-shot 방어는 사실상 vestigial이고, 정렬 보장은 호출 측의 batch size 1이 담당.**
  - 길이 mismatch 시 1회 재시도, 그래도 안 맞으면 throw → router fallback. 429/5xx 1회 백오프 재시도, 401/403/400 즉시 throw. 429 시 60s cooldown (gemini와 동일 패턴).
  - 키 저장 위치/테스트 버튼 패턴 모두 gemini와 동일. `TEST_MINDLOGIC` 메시지로 router 우회 검증.
  - 캐시 키는 `mindlogic:<modelId>` 합성 (섹션 7) — 모델 바꾸면 별개 캐시.

### 6. Settings — 즉시 반영 + 자동 재번역

- `src/shared/settings.ts`: `zod` 스키마로 검증, partial 마이그레이션(새 필드는 default로). 모든 페이지가 같은 schema 공유.
- 옵션 페이지(`src/options/main.tsx`)는 변경을 즉시 UI에 반영하되 `storage.sync.set`은 **250ms 디바운스** (color/slider 입력으로 분당 120회 quota에 안 걸리게).
- `src/content/index.ts:241-255`: `chrome.storage.onChanged` 수신 → settings 전체 reload → `applySettings`. `RETRANSLATE_KEYS = {targetLang, backend, geminiModel, mindlogicModel}` 중 하나가 바뀌면 현재 영상 자동 재번역(재조립된 `lastSentences` 보관 덕분 — 섹션 13). `sourceLang`은 A62(섹션 38)에서 제거 — 원문 언어는 영상마다 자동 감지라 사용자가 바꿀 설정이 없음.

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
- `styles.ts`: 사용자 조절 값은 모두 CSS 변수로 `:root`에 박아 `:fullscreen` / `[data-mode="shorts"]` 보정까지 한 번에 적용. native YouTube 자막은 `html[data-ydt-active="true"] .ytp-caption-window-container { display: none !important }`로 숨김 — **A62(섹션 38)부터 조건부**: 듀얼자막이 켜져 있을 때만 숨기고, 꺼두면 네이티브 자막이 그대로 보임.
- **드래그 UX**: DOM 핸들 없음(A13에서 제거). `.ydt-container` 자체가 `pointerdown` 타겟이고, `::before`(`inset: -6px`)가 hit-area 확장 + cyan halo 시각 affordance 둘 다 담당. 텍스트 선택이 1순위라 `e.target`이 `.ydt-cue-text` 또는 `.ydt-history`(누적 윗줄) 안이면 pointerdown은 early-return — native 선택에 완전 양보. 같은 두 셀렉터에 `cursor: text`도 매칭. 드래그 가능 영역은 행 padding + 두 행 사이 4px gap + 외곽 6px halo 띠. `clampPosition`은 좌우 대칭(예전 `HANDLE_MARGIN_PX` 없음). **위치(%) 좌표계 기준은 컨테이너의 CSS offset parent(= mount host `#movie_player`)이지 `video` 요소가 아니다(A28)** — YouTube는 레터박스(상하 검은 띠) 영상에서 `<video>`를 콘텐츠 크기로 축소·중앙배치해 player보다 세로로 작고 위치가 다른데, CSS `left/bottom %`는 offset parent 기준으로 풀리므로 드래그/clamp 계산도 같은 박스를 써야 한다. `positioningRect()`(`offsetParent ?? host`)가 `clampPosition`·`onPointerDown`·`onMove` 공통 기준. 옛 코드가 `video` rect를 써서 폭은 우연히 일치(좌우 정상)하나 세로가 어긋나 레터박스 영상 맨 아래에서 세로 드래그가 0에 고착되던 버그를 수정.
- **누적(rolling) 윈도우**(A14): 싱글 자막 모드(translation-only / source-only / 모국어 영상)에서만 현재 cue(=문장) 위에 직전 `singleContextLines-1`개 cue(=문장)를 쌓아 맥락 보강. 듀얼 모드는 두 줄 이미 보이므로 누적 안 함. 행마다 `.ydt-history` div가 텍스트 span 위에 자리. `isRollingActive()`로 게이트, `renderHistory(idx)`가 윈도우 그림. Sticky gap-fill: 발화 사이 공백에서 cue가 -1이어도 직전 윈도우 유지(`update()`의 sticky 분기). `historyLayout: 'stacked'`는 cue마다 한 줄, `'inline'`은 현재 줄과 한 문단 흐름. `dimHistory`는 stacked일 때만 컨테이너 opacity로 적용 (inline은 한 문단 흐름이라 흐려지면 가독성↓ — A18에서 분기 추가). 번역 줄에서 history cue의 번역 아직 미도착이면 원문으로 임시 대체(setTargetTexts 도착 시 그 범위 번역이 바뀌었으면 윗줄만 제자리 재구성 — 원문 DOM은 안 건드림, 섹션 47).

### 9. SPA navigation race

YouTube는 `yt-navigate-finish` 이벤트로 영상 전환을 알림. 단순히 매 navigate마다 cue를 비우면 새 cue가 동시에 도착할 때 파괴됨. 해결: `mountedVideoId`에 현재 cue가 어느 영상 것인지 기록해두고, navigate 시 `currentVideoId() !== mountedVideoId`일 때만 `clearCues`(`content/index.ts:201-207`). 번역 mid-flight 응답도 `currentVideoId()` 비교로 drop(같은 파일의 `translateCues`). 쇼츠 넘기기는 반대로 자막 응답이 주소 변경보다 먼저 와서, `v`가 현재 주소와 다른 응답은 주소가 따라잡을 때까지 보류한다(섹션 52).

### 10. 'C'·듀얼자막 토글 키 완전 분리

**A62(섹션 38)부터 네이티브 자막과 듀얼자막은 완전히 독립된 컨트롤이다.**

- `'C'` 단독: 더 이상 가로채지 않는다. YouTube native `'c'` 핸들러에 그대로 맡겨 **네이티브 CC만** on/off(우리 `subtitlesEnabled` 무관).
- **듀얼자막 토글 키**(`settings.subtitlesToggleKey`, 기본값 `'g'`, 옵션 페이지에서 사용자 재지정 가능 — A69/섹션 45. 그 전엔 A63~A68 구간 하드코딩 `V`, A62~A62 구간 `Alt+C`였다): **듀얼자막만** on/off(`subtitlesEnabled` 토글). 네이티브 CC 버튼은 건드리지 않음. 수정키(Alt/Ctrl/Shift/Meta)가 하나라도 눌려 있으면 통과 — 저장된 키가 우연히 `v`면 `Ctrl+V`(붙여넣기) 등과 충돌 방지.

키 판별은 물리 키 `ev.code === 'KeyC'`(토글 키는 `Key${toggleKey.toUpperCase()}`, 섹션 45) 우선(+ `ev.key` 폴백) — `ev.key`만 보면 CapsLock 시 대문자, 한글 IME 시 자음으로 바뀌어 새는 문제를 방지(같은 견고성 패턴을 토글 키 핸들러도 공유). input/textarea/contenteditable focus 시는 통과(검색창 입력 보호).

A16~A61까지는 `'C'`가 `subtitlesEnabled`를 토글하면서 CC 버튼도 프로그램적으로 `click()`해 시각 동기했다(옛 방식 — 지금은 없음). 분리 이유: 네이티브 자막이 꺼진 채였던 이유는 섹션 8의 강제숨김 CSS가 `subtitlesEnabled` 조건부로 바뀌어(A62), 듀얼자막을 꺼두면 네이티브 CC를 `'C'`로 직접 켜서 원래 자막을 볼 수 있게 하기 위함 — 하나의 키로 묶여 있으면 이게 불가능했다.

### 11. 마지막 번역 백엔드 표시 (A21)

production build는 `console.log`를 strip하므로(`vite.config.ts:12`) F12/SW devtools에서 성공 로그가 안 보인다. 사용자가 "지금 어느 백엔드로 동작 중인지" 확인하기 어려운 문제를 팝업 한 줄로 해결.

- `secrets.ts:setLastBackend({ used, preferred, at })`: background가 매 성공 호출 후 `chrome.storage.local`에 기록. fire-and-forget.
- 팝업(`popup/main.tsx`): 열릴 때 `getLastBackend()` 호출. **A75(섹션 48)부터 평소엔 안 보이고**, preferred ≠ used(fallback)이면서 30분 이내일 때만 주황 경고 카드("Gemini 실패 · 지금은 Google 무료 사용 중")로 노출. (옛 "최근 번역: Gemini · 2분 전" 상시 줄·모델명 표기(섹션 40)는 제거.)
- 왜 storage.sync 아닌 local: 휘발성 런타임 상태(다른 기기와 공유 가치 없음) + sync 쿼터 절약. 키 분리 패턴과 같은 storage area 공유.

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

## 기능 노트 색인 — 섹션 12·14~53 (전문은 `docs/FEATURE_NOTES.md`)

코드 주석의 「섹션 N」은 이 번호다. **그 기능을 고치기 전에 `docs/FEATURE_NOTES.md`의 해당 섹션 전문을 읽을 것** — 설계 근거·기각한 대안·검증 상태가 거기 있다. 아래는 매 세션 알고 있어야 할 함정만 추린 것.

- **12** (제거됨, A62) CC 버튼 → `subtitlesEnabled` 동기. 섹션 10의 「네이티브 자막과 듀얼자막은 완전히 독립」 원칙과 충돌해 삭제 — 되살리지 말 것.
- **14** 해설(드래그 → AI 영어 선생님): 번역 router·캐시를 안 거치는 단발 chat. 백엔드는 gemini/mindlogic만. LLM 출력은 innerHTML 금지 — `markdown.ts`가 element 생성 + textContent로만 렌더(XSS 차단).
- **15** Notion 저장: 제목 = 선택 단어가 든 자막 한 문장(100자 이하) → 해설의 첫 인라인 백틱 예문 → 단어. 📋 복사 헤딩(`explain-ui.ts:pickTitle`)과 `notion.ts:pickNotionTitle`, `notion-blocks.ts`와 `markdown.ts`는 각각 평행 구현이라 같이 고칠 것. DB URL에서는 **첫** 32hex가 DB id(마지막은 view id).
- **16** 폰트 크기: 휠은 번역 줄 위면 번역만, 그 외엔 둘 다. 범위 8~72(스키마와 동일). 팝업 스테퍼 ±2px.
- **17** 해설 모델은 번역 모델과 분리(`explainGeminiModel`/`explainMindlogicModel`). 형광펜은 **DOM이 진실** — 텍스트 노드마다 `<code class=ydt-user-mark>`로 감싸고 내보낼 때만 `domToMarkdown`. markdown 문자열 매칭 방식으로 되돌리지 말 것(반복 어구에서 깨졌음).
- **18** Shorts 기본 위치 30%(18%는 쇼츠 하단 오버레이 아래 깔려 포인터까지 먹힘). 기본값을 바꿔도 이미 저장된 값은 안 바뀐다 — 팝업 「처음 자리로」가 탈출구.
- **19** 자유 질문은 `questionSystemPrompt`. 입력칸은 본문(`bodyEl`) **밖**에 둬야 복사·Notion·형광펜이 답변만 대상으로 한다.
- **20** 해설 탭 누적 + 최소화: 탭은 메모리 only(content script는 SPA 이동에 안 죽음). 비동기 결과 가드는 `tabs.includes(tab)`, 버튼 갱신은 활성 탭일 때만. `.ydt-explain-body`의 `min-height:0`이 없으면 중첩 flex에서 스크롤이 안 된다.
- **21** Gemini 동적 모델: 모델 스키마는 자유 문자열(enum이면 목록 밖 선택 시 default로 리셋). 옛 별칭은 `resolveGeminiModelId`가 변환(번역·해설 공용).
- **22** 해설 본문 드래그도 툴바 대상(형광펜 모드 ON이면 마킹용이라 제외). Shift+백틱(`~`) = 형광펜 토글. 형광펜 OFF에선 칠한 곳 클릭해도 해제 안 함.
- **23** 렌더러의 프로그램적 DOM 교체는 `selectionchange`를 신뢰성 있게 안 쏜다 → cue 전환 시 `onCueChange`로 툴바를 닫는다. 새 탭은 맨 왼쪽(unshift).
- **24** gemini·mindlogic은 **문장당 1요청**(`PER_SENTENCE_BACKENDS`). 배치로 보내면 모델이 문장을 합치고 개수만 중복으로 맞춰 반환해 길이 검증으로 못 잡는다. mindlogic의 `%%`·few-shot 방어는 그래서 사실상 안 쓰임.
- **25** 패널 제목 3줄 클램프는 `overflow: clip`(hidden·line-clamp는 BFC를 만들어 float 래핑이 깨짐) + JS 이진탐색 트림. 생략부호는 ASCII `...`(CJK 폰트가 `…`를 줄 가운데 찍음).
- **26** 패널·미니버튼은 위치 하나(`panelPos`)를 공유, 메모리 only. 표시 시점에 각자 크기로 다시 클램프.
- **27** 탭스트립을 notice 줄 **위**에 둬 탭의 세로 위치를 고정. 저장된 탭 칩에 ✓.
- **28** Alt+Q 직접 질문은 커스텀 커맨드 `open-ask`. 드래그해 둔 글자는 입력창에 미리 채운다(`fromSelection`, Alt+Q 경로만 — A85). 후속 질문 = 부모 `turns`를 상속한 새 탭, user 턴은 background가 실제 보낸 `userMessage`를 저장. **Enter 처리엔 IME 조합 가드(`isComposing || keyCode 229`) 필수** — 없으면 한글 마지막 글자로 한 번 더 전송된다.
- **29** 패널 액션 줄의 「새 질문」 버튼(팝업 버튼은 섹션 50에서 입력칸으로 대체).
- **30** `openAsk`는 rAF로 한 번 더 focus(같은 틱 focus가 씹힘). 새 질문 진입 시 공용 입력칸을 비운다.
- **31** 옵션 IA: 제공자 설정 섹션은 `backend` 또는 `explainBackend`가 그 제공자일 때만 표시. 해설 AI는 번역 AI를 따라가고, 번역이 Google/Chrome일 때만 칩으로 고른다. `explainEnabled`/`notionEnabled`는 미래 결제 게이트용 예약 필드(지금은 안 읽음).
- **32** 직접 질문의 **첫 턴만** 해설 프롬프트(`isAsk`), 후속·선택 질문은 질문 프롬프트.
- **33** 툴바 형광펜은 답이 도착한 해설 본문 선택에만. 제자리 클릭(이동 4px 미만, `detail<2`)은 툴바를 숨긴다. 🖍️는 U+FE0F가 있어야 컬러.
- **34** Notion 재저장 = 새 페이지 생성 + 옛 페이지 `archived:true`(Notion엔 본문 통째 교체 API가 없음). 제목은 첫 저장 것을 재사용, DB가 바뀌었으면 옛 페이지는 안 건드림, archive 404는 성공 취급, 실패하면 `oldKept`. `Notion-Version: 2022-06-28`이라 필드명이 `archived`(최신 버전은 `in_trash`). **pageId가 저장마다 바뀐다** — Eng Shorts가 그래서 제목을 카드 키로 쓴다.
- **35** 탭 클릭 시 활성 칩만 가로스크롤(`scrollChipIntoView` — `scrollIntoView`는 유튜브 페이지까지 움직여 금지). 닫기 ✕는 활성 탭에만(옆 탭의 보이는 쪽이 ✕라 넘기려다 닫힘).
- **36** 자막 '사용 안 함' 영상: direct fetch는 **페이지가 그 영상의 timedtext를 한 번 fetch해야** 성립한다(`pot`은 영상 바인딩 — 다른 영상 것 이식 불가, 실측 확정). MAIN의 `settingsKnown`/`pendingEnable`로 부팅 레이스 해소, 워치독 `FORCE_BOOT` 전에 `requestedDirectFetchVideoIds.delete`. 듀얼자막이 켜져 있으면 유튜브 자막이 강제로 켜지는 건 구조적 대가.
- **37** 게이트웨이 Base URL은 사용자 입력(기본값 없음). 새 조직 도메인은 manifest `host_permissions` 추가 + 재배포가 필요하다.
- **38** 영상 언어 자동감지 — `sourceLang` 설정은 제거됐고 번역 `src`는 `currentTrackLang`. 네이티브 자막 숨김 CSS는 `html[data-ydt-active="true"]`일 때만.
- **39** 자막이 꺼진 채 시작한 영상에서 켜면(cue 0개일 때) `requestForceBoot`를 즉시 호출(워치독 틱을 안 기다림).
- **40** `LastBackendInfo.model`은 저장만 되고 읽는 곳 없음. 게이트웨이 모델 추천 문구는 라인업이 자주 바뀌어 제거.
- **41** ask-anywhere(유튜브 밖 Alt+Q): `activeTab` + `executeScript` 온디맨드 주입. crxjs 해시 경로를 얻으려고 `content_scripts`에 `.invalid` 도메인으로 등록. 그 그룹의 `web_accessible_resources`는 `scripts/patch-manifest.mjs`가 `<all_urls>`로 넓힌다(그룹을 못 찾으면 빌드 실패). 유튜브 탭엔 주입 안 함(ExplainUI 중복). ⚠ 일부 코드 주석은 이 섹션을 「섹션 40」으로 적고 있다.
- **42** 게이트웨이 크레딧 `GET {baseUrl}/credits/`. 404는 「그 게이트웨이 버전엔 없음」으로 따로 안내.
- **43** 다른 사이트의 `text-indent:-14000px; overflow:hidden` 버튼 리셋(한국 포털에 흔함)이 이모지 버튼을 숨긴다 → `text-indent:0; overflow:visible !important`. 검증은 가상 HTML이 아니라 실제 사이트에서.
- **44** 옵션 🧪 테스트 = 키 테스트 + 모델 목록 + 크레딧을 `Promise.all`로 모아 **한 번에** setState(따로 반영하면 줄이 점프).
- **45** 듀얼자막 토글 키 `subtitlesToggleKey`(기본 `g`, 소문자 알파벳만 — 숫자는 YouTube seek 키라 제외). 레코더 UI는 옵션 페이지.
- **46** UI 언어(i18n): `chrome.i18n`은 런타임 전환이 안 돼 자체 사전(`shared/i18n.ts`, `KO: Record<MsgKey,string>`). React는 렌더 전에 동기로 `setUiLang`, 이미 만든 DOM은 `ExplainUI.relabel()`, 라벨 상수는 함수로(모듈 로드 시점 언어로 굳음). **화면 문자열로 제어 흐름을 분기하지 말 것**(`code` 필드 사용). AI 답변 언어는 `{answerLang}` = `targetLang`. 새 설치 시드는 `onInstalled` install에서만 — `DEFAULT_SETTINGS`를 바꾸면 기존 사용자 값이 조용히 바뀐다. manifest 이름·설명·커맨드는 `_locales`(브라우저 언어).
- **47** 자막 드래그 선택: 번역 도착 시 번역 줄만 제자리 갱신(전체 재렌더하면 선택이 풀림). 박스 밖으로 번지는 선택은 포인터 좌표를 박스 안으로 clamp해 `caretRangeFromPoint`로 `sel.extend`(`user-select: contain`은 Chrome 미지원). 선택 중엔 자막을 그 문장에 고정.
- **48** 팝업: 자막 켜기·표시 모드·내 언어·글자 크기·위치만. fallback 경고 카드는 30분 이내일 때만. 색 역할은 섹션 49와 같다.
- **49** 옵션 페이지: 주황 `--brand` = 섹션 제목, 파랑 `--accent` = 켜짐·선택. `t()`/`tl()`은 `??` — KO의 의도적 빈 조각 `''`을 영어로 대체하지 않게.
- **50** 우클릭 해설 + 팝업 질문 입력칸: `default_popup`이 있으면 `action.onClicked`는 안 불린다. 단축키·우클릭·팝업 공용 진입점 `openAskInTab`. crxjs 로더는 동적 import라 재주입해도 모듈 최상위가 다시 안 돈다 → ask-anywhere는 `onMessage`(`OPEN_ASK`)로 받는다.
- **51** 🔊 듣기는 `speechSynthesis` — **반드시 클릭 핸들러 안에서** 호출(사용자 제스처 없으면 무음). 원문 줄은 트랙 언어, 그 외는 글자 체계로 언어 추정.
- **52** 쇼츠는 자막 응답이 주소 변경보다 먼저 온다 → 응답의 `v`가 현재 주소와 다르면 `earlyResponse`에 보류. cue를 지울 때 `lastProcessedTrackKey`도 비울 것. 자동 더빙 영상의 원래 언어는 `isAutoDubbed`가 아닌 음성 트랙에서. 테스트 Chromium은 `--disable-blink-features=AutomationControlled` 없이 띄우면 timedtext가 빈 응답.
- **53** 제목 글자는 드래그 선택 가능(툴바 대상) + 제목 끝 🔊(전체 `term` 읽기, 다시 누르면 멈춤). 이동 핸들은 헤더·액션 줄의 **빈 곳**만 — `enableDrag` guard에 제목 글자·버튼. `Tab.speakLang`이 `null`이면 제목이 내 질문이라 🔊 숨김. `setTitle`은 넘침을 제목 전체(글자+🔊)로 재고 글자 span만 줄인다 — 🔊를 키우면 3줄 제목이 잘린다.

## 비명백한 주의사항

- **코드를 바꾸면 `npm run build` 필수**. Chrome은 `dist/`만 본다. 옵션 페이지가 변경 안 보이면 99% 빌드 안 했거나 확장 ↻ 안 했거나 옵션 탭 안 새로고침함.
- **번역 백엔드별 호출 모델이 다르다**. `google-free`는 batch 1회 GET, `chrome-builtin`은 N회 순차, `gemini`·`mindlogic`은 **문장당 1요청(per-sentence, batch size 1 — A44/섹션 24)** 으로 원문↔번역 정렬 보장(gemini는 Gemini native API + JSON schema 강제, mindlogic은 OpenAI 호환 chat/completions + `%%` 구분자·temp 0 — 단 입력이 1문장이라 합침 방어는 vestigial). 배치 크기 분기는 `content/index.ts:translateCues`의 `PER_SENTENCE_BACKENDS`. 새 백엔드 추가 시 `router.ts`의 fallback 로직과 `idb-cache`의 key 포맷, `settings.BackendIdSchema`+`translators/types.ts:BackendId` 두 곳, `lang-options.ts:backends()` 모두 동기 갱신(라벨은 `shared/i18n.ts`에 en/ko 두 벌 추가 — 섹션 46). BYOK면 `secrets.ts`에 키 getter/setter + 옵션 페이지 키 입력 UI + `background/index.ts`의 `TEST_<backend>` 메시지 핸들러 + manifest `host_permissions`까지 추가.
- **BYOK 비밀값은 `secrets.ts` + `chrome.storage.local`** — settings(storage.sync)와 의도적으로 분리. 새 BYOK 백엔드 추가 시 같은 패턴 따를 것. 옵션 페이지에서 키 입력은 별도 디바운스 저장 + "테스트" 클릭 시 보류 저장 flush.
- **웹스토어 배포 권한 사유**: `generativelanguage.googleapis.com`은 "사용자 본인 Gemini API 키로 자막 번역/해설", `factchat-cloud.mindlogic.ai`·`factchat.mindlogic-kr-api.com`(사용자가 옵션 페이지에서 입력하는 base URL — 조직마다 다름, 섹션 37)은 "학교/조직 발급 OpenAI 호환 게이트웨이 키로 자막 번역/해설", `api.notion.com`은 "사용자 본인 Notion integration 토큰으로 해설을 본인 DB에 저장" 용도. 모두 자체 키 미포함(BYOK), 익스텐션 코드에 비밀값 없음. 제출 시 manifest justification에 그대로 사용 가능.
- **개인정보처리방침 정본은 영문 `docs/PRIVACY.md`**(공개 repo에 커밋, 그 GitHub blob URL을 웹스토어 "개인정보 보호" 탭의 개인정보처리방침 URL에 사용 — 글로벌 목록 기준). 루트 `PRIVACY.md`는 한국어판이고 두 파일이 서로 링크돼 있다 — 데이터 처리가 바뀌면 둘 다 갱신. 웹스토어 "사용자 데이터 사용"에서 "웹사이트 콘텐츠"(자막 텍스트가 번역/해설을 위해 외부 API로 전송됨)를 체크하면 필수가 되는 필드 — BYOK 백엔드가 추가/변경되면 이 파일의 "자막 텍스트의 처리" 절도 함께 갱신.
- **`world: 'MAIN'` 스크립트는 HMR 제약**이 있다. 빌드 로그에 `Some content-scripts don't support HMR because the world is MAIN: /src/content/inject-main.ts` 경고가 나오는 게 정상 — `inject-main.ts`를 바꾸면 확장 ↻로 새로 로드해야 함.
- **`offscreen` 문서는 manifest entry가 아니다**. `vite.config.ts:14-17`에서 별도로 rollup input에 등록되어 있음. 새 offscreen 페이지 추가 시 같은 패턴 따를 것.
- **`web_accessible_resources.matches`는 대부분 `youtube.com`으로 좁혀져 있음** (`manifest.ts`). offscreen HTML은 익스텐션 내부 호출(`chrome.offscreen.createDocument`)로만 띄워지므로 외부 origin 화이트리스트는 좁아도 동작에 영향 없음. **예외는 ask-anywhere(섹션 41) 그룹 하나뿐** — `<all_urls>`로 넓혀야 하는 구조적 이유가 있고, 그 값은 `manifest.ts`가 아니라 빌드 후 `scripts/patch-manifest.mjs`가 `dist/manifest.json`을 직접 고쳐서 만든다(crxjs가 자동 생성하는 값은 유튜브로 좁게 나옴). 새 web_accessible_resources 그룹을 추가할 땐 기본은 이 좁힌 패턴을 따르고, `<all_urls>`가 필요한 근본 이유(그 스크립트가 "임의 페이지"에 온디맨드 주입되는가)가 있을 때만 이 예외 패턴을 반복한다.
- **`npm run build`는 이제 `vite build` 다음에 `node scripts/patch-manifest.mjs`도 돈다**(`package.json`). `vite build`만 직접 돌리면 위 ask-anywhere `web_accessible_resources` 그룹이 좁은 matches로 남아 다른 사이트에서 조용히 깨진다 — `vite build`를 직접 호출하는 스크립트·CI가 있다면 이 후처리 단계를 빠뜨리지 않게 주의.

## 커밋 메시지 컨벤션 (관찰된 패턴)

`git log` 기준: `M1`~`M7`은 마일스톤, `A1`~`A3`는 부가/알고리즘 작업으로 보인다. 형식: `<태그>: <변경 요약>`. 영어, 짧고 함축적. 예: `A3: C-key shortcut toggles dual subtitles` / `M7: options page, live restyle, language/backend retranslate`.
