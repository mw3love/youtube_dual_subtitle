# Release-readiness 감사 결과

날짜: 2026-05-27
범위: src/ 전체, manifest, vite.config, package.json, README, docs/PRIVACY, docs/STORE_LISTING, CLAUDE.md
방법: 1패스 정적 읽기 + npm audit + tsc --noEmit. **수정 0건**.

## 0단계 기계 통과

- `npm run typecheck` ✅ clean
- `npm audit`: 4건 (high 2, moderate 2) — 모두 *dev* 의존성(vite, esbuild, rollup, @crxjs). 빌드 산출물에 미포함. fix는 모두 major 업그레이드(@crxjs 2 → 1, vite 5 → 8).

## Blocker 기준 (사전 합의된 정의)

- **Y (blocker)**: 스토어 정책 위반 / 사용자 데이터 노출 / 데이터 손실 / 사용자 신뢰 깎는 가시 결함
- **N (권장)**: 알려진 race·edge case, 코드 중복, 마이크로 최적화, doc 동기화
- **노이즈**: 미세 리팩터링 — 본 표에 포함 안 함

## Finding 표

| ID | Cat | 발견 | 파일:줄 | 크기 | Blocker | Known/New |
|---|---|---|---|---|---|---|
| F1 | 정합 | google-free line mismatch 시 throw 없이 어긋난 결과 반환 → router fallback 트리거 안 됨. 호출 측 length check만 부분 방어 | google-free.ts:38-46 | S | N | New |
| F2 | 정합 | inject-main `subtitlesEnabled` 초기값 `true` → SUBTITLES_ENABLED 메시지 도착 전 자동 CC 토글 1회 발화 가능 (자막 off 사용자가 새 영상 진입 시) | inject-main.ts:15 | S | N | New |
| F3 | 정합 | router fallback chain에 chrome-builtin 포함하지만 모델 다운로드 필요한 첫 사용자엔 실효 없음 — 코멘트도 인정. fallback이 실제로는 google-free 단일로 동작 | router.ts:24-29 | S | N | New |
| F4 | 보안 | manifest `web_accessible_resources` matches: `<all_urls>` — offscreen HTML이 모든 origin에서 fetch 가능. createDocument는 web_accessible 없이도 동작하므로 좁히거나 제거 가능. 스토어 최소권한 원칙 위배 잠재 | manifest.ts:49-54 | S | **Y** | New |
| F5 | 보안 | content script postMessage listener가 origin 검증 안 함 (source === window만). 페이지 코드가 source: 'YDT_MAIN' 위조 시 처리됨. 현재 YouTube라 신뢰하지만 방어 차원 부재 | content/index.ts:104-114 | S | N | New |
| F6 | 죽은코드 | CLAUDE.md "비명백한 주의사항"에 dead permission `factchat-cloud.mindlogic.ai` 언급 — 실제 manifest엔 없음. doc stale | CLAUDE.md | S | N | Known(stale) |
| F7 | 죽은코드 | `getVideoId` 함수가 content/index.ts와 inject-main.ts에 동일 정의 중복 | content/index.ts:67-72, inject-main.ts:177-182 | S | N | New |
| F8 | 죽은코드 | `forceToggleCaptions`와 `tryEnableCaptions` 토글 로직 상당 부분 중복 | inject-main.ts:259-286, 313-389 | M | N | New |
| F9 | 성능 | `setInterval` × 3개 매 1초 polling 영구 (ccObserver, watchdog, pathname-change). 단일 polling으로 합칠 수 있음 | content/index.ts:541, 626 + inject-main.ts:591 | M | N | New |
| F10 | 성능 | document 전역 capture phase `loadeddata`/`emptied` 두 군데에서 — page의 모든 video 이벤트에 매번 발화 | inject-main.ts:548, content/index.ts:433 | S | N | New |
| F11 | 가시 | google-free mismatch가 console.warn — 사용자 콘솔 노이즈 (production warn 유지). 정상 발생도 종종 있을 영역인데 사용자 보면 오해 | google-free.ts:40-45 | S | N | New |
| F12 | 가시 | Gemini 에러 메시지가 한국어+영어 섞임 ("Gemini API 키 인증 실패 (HTTP 403)" 등). 일관성 미흡 | gemini.ts:185, 188, 193, 195 | S | N | New |
| F13 | 가시 | popup의 chrome.tabs.sendMessage 응답 구조 unsanitized — `res.subtitlesEnabled` 등 접근 전 검증 없음. 응답 구조 변경 시 unhandled rejection 가능 | popup/main.tsx:174-181 | S | N | New |
| F14 | 가시 | chrome-builtin 첫 사용 시 모델 다운로드 진행률이 console.log만 — 사용자 UI에 안 보임. 첫 사용자가 "멈춘" 줄 알 수 있음 | offscreen/index.ts:62-69 | M | N | New |
| F15 | 호환 | `setOption('captions','translationLanguage', null)` 미공식 API. YouTube 변경 시 silent fail (try/catch로 보호됨) | inject-main.ts:411-426 | — | N | Known(CLAUDE.md) |
| F16 | 호환 | npm audit: vite 5.x / esbuild / rollup / @crxjs 4건. dev only — 빌드 산출물 무영향. fix는 major 업그레이드 (회귀 위험 있음) | package.json | M | N | New |
| F17 | 배포 | README.md 권한 표에 `generativelanguage.googleapis.com` (Gemini host) 누락 — PRIVACY와 STORE_LISTING엔 있음. 문서 간 불일치 | README.md:50-60 | S | **Y** | New |
| F18 | 배포 | README.md "Chrome Web Store _등록 후 링크 추가 예정_" — release 직전 채워야 | README.md:23-26 | S | N | New |
| F19 | 메타 | 테스트 프레임워크 없음 (CLAUDE.md 명시). release 직전 critical path 수동 시나리오 문서라도 권장 | — | M | N | Known |

## 카테고리별 카운트

- 정합/버그: 3
- 보안/프라이버시: 2 (그중 **blocker 1**)
- 죽은 코드/중복: 3
- 성능/리소스: 2
- 사용자 가시성: 4
- 호환성: 2
- 배포 자료: 2 (그중 **blocker 1**)
- 메타: 1

총 19개. blocker 2개 (F4 manifest web_accessible_resources, F17 README 권한 누락).

## 작업량별

- S(작음, < 30분): F1, F2, F3, F5, F6, F7, F10, F11, F12, F13, F17, F18 — 12개
- M(중간, 30분~2h): F8, F9, F14, F16, F19 — 5개
- L: 없음

## 제안 묶음 (단계별 plan 모드 후보)

1. **블로커 픽스** (F4, F17) — 스토어 제출 전 필수. ~30분.
2. **신뢰성 개선** (F1, F2, F3) — 번역 alignment + capture race 개선. ~1h.
3. **노이즈 정리** (F11, F12) — 사용자 콘솔/오류 메시지 일관성. ~20분.
4. **구조 정리** (F7, F8, F9) — 중복 함수 + polling 통합. ~1h.
5. **호환·의존성** (F16) — major 업그레이드 회귀 위험 평가. ~1~2h.
6. **수동 테스트 시나리오 문서** (F19) — 일반/Shorts/sticky/race/Gemini 키 잘못 입력 등 critical path. ~30분.
7. **CLAUDE.md 동기화** (F6) — stale 문구 제거. ~5분.

## 감사 진행 중 발견한 새 카테고리

- **메타** (테스트 부재 자체) — 사전 계획에 명시 안 됐으나 release-readiness에 영향 큼.

## 감사 단계에서 *내가* 안 한 것 (다음 단계 위임)

- 실제 브라우저 동작 검증 (CC 토글 race 재현, manifest 권한 좁힘 후 offscreen 동작 확인)
- 의존성 major 업그레이드 후 빌드/실행 회귀 확인
- 수동 테스트 시나리오 매트릭스 실행
