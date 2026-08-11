# 수동 테스트 매트릭스

Chrome Web Store 제출 전 critical path 점검용. 테스트 프레임워크가 없는 환경에서 회귀를 잡기 위한 체크리스트.

매 release 전 1회, 큰 리팩터링 후 1회 실행 권장.

**준비**: `npm run build` → `chrome://extensions` → 이 확장 ↻ → 옵션/팝업 탭 새로고침.

---

## 1. 자막 capture (핵심 기능)

| # | 시나리오 | 통과 기준 |
|---|---|---|
| 1.1 | 영어 영상 (manual 자막) | 원문(영어) + 번역(한국어) 두 줄 표시. `[YDT]` 로그에 chosen=en/manual |
| 1.2 | 영어 영상 (ASR 자막) | 자동자막 단어별 reveal 동작. cue 경계 부드러움 |
| 1.3 | 한국어 영상 (모국어) | 한 줄만 표시 (suppress target). 번역 호출 skip 로그 확인 |
| 1.4 | 자막 없는 영상 | 팝업에 "이 영상에는 자막 없음". 8s/38s 워치독 발화 후 포기 |
| 1.5 | Shorts (자막 있음) | 자막 표시 + Shorts 폰트 배율 적용. CC 버튼 없는 환경 |
| 1.6 | Shorts swipe 연속 | 다음 reel 자막이 1~2초 내 표시. 이전 자막 잔상 없음 |

## 2. 트랙 선택 sticky 회귀 (A16)

| # | 시나리오 | 통과 기준 |
|---|---|---|
| 2.1 | 영어 영상 → 영어 영상 | 두 번째도 영어 manual 잡힘 (tlang sticky로 자동번역 fetch X) |
| 2.2 | 영어 영상 → 한국어 영상 | 두 번째는 한국어 트랙. 영어+자동번역 sticky 발화 X |
| 2.3 | 한국어 영상 → 영어 영상 | 두 번째는 영어 트랙 (한국어 manual 잘못 잡지 않음) |
| 2.4 | 일본어(또는 기타 비영어) 영상, 여러 언어 자막이 같이 있는 경우 포함 | 설정 없이 영상 원본 언어(ASR lang) 트랙이 항상 우선 잡힘 (A62: sourceLang 설정 제거, 완전 자동감지) |

## 3. 토글·UI

| # | 시나리오 | 통과 기준 |
|---|---|---|
| 3.1 | `C` 키 토글 (A62부터 네이티브 전용) | YouTube 네이티브 자막만 on/off. 우리 듀얼자막 상태 무관 |
| 3.1b | `Alt+C` 토글 (A62 신규) | 듀얼자막만 on/off. native CC 버튼 상태 무관 |
| 3.2 | 검색창에 'c' 입력 | 자막 토글 발화 X (input focus 보호, Alt+C 핸들러 대상) |
| 3.3 | 팝업 자막 ON/OFF | 즉시 반영. 다른 탭에도 storage.onChanged 통해 적용 |
| 3.4 | 팝업 표시 모드 변경 (dual/번역만/원문만) | 즉시 반영 |
| 3.5 | 팝업 백엔드 변경 | 즉시 재번역. F12 로그에 새 backend 사용 확인 |
| 3.6 | native CC 버튼 직접 클릭으로 끔 (듀얼자막 켜진 채) | 우리 듀얼자막은 계속 표시, native만 꺼짐 (A62: 완전 독립, sync 없음) |
| 3.7 | native CC 버튼으로 켬 (듀얼자막 꺼둔 상태에서) | 우리 듀얼자막은 계속 꺼진 채. native 자막만 켜져서 그대로 보임 (A62: 강제숨김 CSS가 subtitlesEnabled 조건부) |

## 4. 자막 위치·스타일

| # | 시나리오 | 통과 기준 |
|---|---|---|
| 4.1 | 자막 드래그 | 위치 변경. 영상 영역 밖으로 나가지 않음 (clamp) |
| 4.2 | 자막 위에서 휠 | 폰트 크기 ±1px. 8~72 범위 |
| 4.3 | 텍스트 선택 (드래그 시작점이 텍스트) | native selection 동작. 드래그 발화 X |
| 4.4 | 일반 영상 위치 / Shorts 위치 별도 저장 | 일반에서 옮긴 위치가 Shorts에 안 영향, 역도 |
| 4.5 | 옵션 페이지 색/크기/굵기 변경 | 즉시 반영 (CSS 변수). 새로고침 후에도 유지 |
| 4.6 | 옵션 페이지 슬라이더 빠르게 휙휙 | "저장 중…" → "저장됨" 표시. storage 쿼터 에러 X |

## 5. 번역 백엔드

| # | 시나리오 | 통과 기준 |
|---|---|---|
| 5.1 | Google 무료 정상 호출 | 자막 표시. 팝업 "최근 번역: Google 무료" |
| 5.2 | Chrome 내장 (첫 사용 — 모델 다운로드) | 다운로드 진행 로그 → 자막 표시. (현재 UI에 진행률 표시 안 됨 — F14 미해결) |
| 5.3 | Chrome 내장 (모델 다운로드 후) | 즉시 자막 |
| 5.4 | Gemini 키 미설정 | 옵션 페이지 안내 → google-free fallback. 팝업에 ⚠ fallback 표시 |
| 5.5 | Gemini 키 잘못된 값 | 옵션 페이지 "테스트" 클릭 시 "✗ Gemini API 키 인증 실패 (HTTP 403)" |
| 5.6 | Gemini 한도 초과 (429) | 60초 cooldown. 다음 batch는 즉시 google-free fallback. 팝업에 ⚠ |
| 5.7 | Gemini 정상 → 모델 변경 (flash → flash-lite) | 즉시 재번역. 캐시 key 분리 (`gemini:flash` vs `gemini:flash-lite`) |

## 6. 캐시

| # | 시나리오 | 통과 기준 |
|---|---|---|
| 6.1 | 같은 영상 재시청 | 캐시 hit 로그 (`cache hit (backend): N translations`). 번역 호출 0회 |
| 6.2 | 옵션에서 캐시 비우기 | 확인 다이얼로그 → "N개 영상의 번역을 비움". 다시 보면 재번역 |
| 6.3 | 30일 경과 entry | (시뮬레이션 어려움) `idb-keyval`로 entry의 createdAt 수동 변경 후 재방문 → 재번역 |
| 6.4 | 캐시 200개 초과 (200+ 영상 시청 누적) | 새 entry 추가 시 5% 확률로 prune 로그. 가장 오래된 것부터 제거 |

## 7. 옵션 페이지

| # | 시나리오 | 통과 기준 |
|---|---|---|
| 7.1 | 옵션 페이지 로드 | settings 모든 항목 표시. "옵션 불러오는 중…" 잠깐 보이고 사라짐 |
| 7.2 | 미리보기 박스 | 외국어 박스 = displayMode 반영. 모국어 박스 = source-only |
| 7.3 | 옵션 초기화 | 확인 → 모든 값 default. 캐시는 유지 |
| 7.4 | Gemini 섹션은 backend=gemini 일 때만 노출 | google-free 선택 시 Gemini 섹션 숨김 |
| 7.5 | 단축키 'Alt+C' 표시 | "자막 켜기" 라벨 옆에 표시 |

## 8. 자가복구 (Watchdog)

| # | 시나리오 | 통과 기준 |
|---|---|---|
| 8.1 | 첫 영상 capture 실패 시뮬레이션 | F12 콘솔에 watchdog 8s 발화 로그. FORCE_BOOT 후 재시도 |
| 8.2 | 8s/38s/98s 누적 실패 후 cue 도착 | watchdog 자동 해제 |

(재현 어려운 시나리오 — release blocker 아님. 자연 발생 시 동작 확인용)

## 9. 팝업 상태

| # | 시나리오 | 통과 기준 |
|---|---|---|
| 9.1 | YouTube 아닌 탭에서 팝업 | "YouTube 화면이 아님" |
| 9.2 | YouTube 메인 (영상 아님) | "이 영상에는 자막 없음" 또는 "자막 꺼짐" |
| 9.3 | 영상 + 자막 활성 | "자막 켜짐 · N줄" |
| 9.4 | 영상 + 자막 off | "자막 꺼짐" |
| 9.5 | 페이지 reload 직후 팝업 (content script 늦음) | "페이지에 연결할 수 없음 · 새로고침 필요" |
| 9.6 | "최근 번역" 한 줄 표시 | preferred=used면 파란색, 다르면 ⚠ + 주황색. 30분 경과면 흐림 |

## 10. 권한·보안

| # | 시나리오 | 통과 기준 |
|---|---|---|
| 10.1 | manifest 권한 정당화 (제출용) | docs/STORE_LISTING.md "권한 사용 정당화" 표 그대로 사용 가능 |
| 10.2 | Gemini 키가 storage.sync에 안 들어감 | 옵션에서 키 입력 → DevTools `chrome.storage.sync.get(null)` 확인 → 키 부재. `chrome.storage.local.get('geminiApiKey')`에만 존재 |
| 10.3 | 옵션 페이지 키 표시/숨김 토글 | 기본은 password 마스크. "보기" 클릭 시 text |
| 10.4 | host_permissions 외 origin에 요청 X | DevTools Network 탭 확인 — youtube.com / translate.googleapis.com / generativelanguage.googleapis.com 외 요청 없음 |

## 11. 빌드·배포

| # | 시나리오 | 통과 기준 |
|---|---|---|
| 11.1 | `npm run build` | clean exit. dist/manifest.json 권한 정확 |
| 11.2 | production console.log strip | F12에 `[YDT]` 로그 없음. warn/error만 보임 |
| 11.3 | dist/ 압축해제 로드 | 에러 없이 로드. action icon 표시 |
| 11.4 | 사용 안 한 host_permissions | dist/manifest.json에 youtube + translate + generativelanguage 3개만 |

---

## release 전 최종 점검

- [ ] 모든 시나리오 한 번씩 통과 (또는 명시적으로 known limitation으로 표기)
- [ ] `npm audit` 결과 dev only 확인 (prod 의존성 vuln 0)
- [ ] manifest version 갱신
- [ ] PRIVACY.md Last updated 갱신
- [ ] STORE_LISTING.md "등록 전 마지막 점검" 체크리스트 완료
- [ ] zip은 dist/ 폴더 *안의 파일들*이 루트 (dist/ 자체가 아닌)

---

## Known limitation (시나리오는 통과시켜도 의도된 동작)

- 6.3 (30일 만료): 시뮬레이션 어렵고 자연 발생 시 동작 — 별도 검증 안 함
- 8.1/8.2 (watchdog): 재현 어려운 가장자리 케이스 — 자연 발생 시 로그로 확인
- F14 (chrome-builtin 다운로드 진행률 UI 부재): 알려진 finding, 별도 작업으로 수정 예정
