# Chrome Web Store 등록 체크리스트

심사 통과를 위해 본인이 준비해야 할 자료와 권장 문구 모음.

## 1. 단일 목적 (Single Purpose) 선언

Web Store는 확장이 **단일 목적**을 가져야 합니다. 심사 시 입력란에 한 줄로:

> 한: "YouTube 영상에 원문+번역 듀얼 자막을 표시하고, 자막 속 단어·표현을 AI로 해설해 어학 학습을 돕는다."
> EN: "Display dual-language (source + translation) subtitles on YouTube videos, with AI explanations of words and phrases to support language learning."

(Notion 내보내기·여러 BYOK 백엔드 권한은 모두 이 "자막 기반 어학 학습" 하나의 목적 아래 있다는 것을 심사관이 알 수 있게, 문구에 해설 기능을 명시.)

## 1-b. 확장 이름 검토 (YouTube 상표 리스크)

현재 `manifest.ts`의 `name`은 `'YouTube Dual Subtitle'` — Google 자사 상표(`YouTube`)를 이름 맨 앞에 그대로 씁니다. 완전 금지는 아니지만(비슷한 패턴의 확장이 다수 통과), "공식 제휴처럼 보이지 않는가"가 심사관 재량 판단이라 리네임 요청을 받을 가능성이 있습니다.

| 후보 | 장점 | 단점 |
|---|---|---|
| **`Dual Subtitle for YouTube`**(추천) | 상표가 뒤로 가고 `for`로 비공식임이 명확 — 통과 가능성 가장 높음. 영문 검색 노출 유지 | 국문 사용자에게는 살짝 덜 직관적 |
| `YouTube Dual Subtitle`(현재 유지) | 검색어 매칭 최상단(앞자리 일치) | 상표 리스크 잔존 — 심사관에 따라 수정 요청 가능 |
| `듀얼 자막` (YouTube 단어 제거) | 상표 리스크 최소 | 검색 노출 가장 약함(사용자가 "youtube 자막"으로 검색해도 안 걸릴 수 있음) |

**추천:** `Dual Subtitle for YouTube` — 리스크와 검색 노출의 균형이 가장 낫습니다. 결정되면 `manifest.ts`의 `name` 필드와 이 문서 전체의 표기를 함께 바꿔야 합니다(아직 미적용).

## 2. 카테고리

권장:
- 1순위: **Productivity**
- 대안: **Accessibility** (자막 보조 도구 측면)

## 3. 설명 (Description)

### 짧은 설명 (~132자, Search snippet)

**한**: "YouTube 영상에 원문+번역 듀얼 자막. AI 단어·표현 해설, 노래방 자막, 위치 드래그, Shorts 지원. Chrome 내장 번역으로 오프라인도."

**EN**: "Dual-language YouTube subtitles: source + translation, plus AI word/phrase explanations. Draggable, Shorts support, offline option."

### 긴 설명 (~16000자, Description)

```
YouTube Dual Subtitle은 영상에 원문 자막과 번역 자막을 동시에 표시합니다. 외국어 영상을 보면서 모르는 단어만 번역으로 확인하고 싶을 때, 또는 어학 학습용으로 적합합니다.

■ 주요 기능
- 듀얼 자막: 원문(영어 등) + 번역(한국어 등) 두 줄 동시 표시
- 싱글 자막 누적 표시: 번역만/원문만/모국어 영상 모드에서 직전 줄을 현재 줄 위에 함께 쌓아 맥락 보강 (1~3줄, 줄 스택 or 한 문단 흐름)
- 노래방 모드(단어 단위 점진 표시): 음성에 맞춰 단어가 하나씩 또렷해짐 (자동자막 영상에서 가장 정확)
- 자막 위치 드래그: 영상에서 자막을 직접 드래그해 광고나 UI 가림 회피. 일반 영상과 Shorts 위치 별도 저장
- 번역 엔진 4종
  • Google 무료: 클라우드 번역, 품질 상위 (사용량 많으면 일시 차단 가능)
  • Chrome 내장: 로컬 모델, 오프라인·차단 없음·자막 외부 전송 없음
  • Gemini (내 키): Google AI Studio에서 본인 키 발급 후 입력, AI 번역으로 가장 자연스러운 한국어. Flash·Flash-Lite 모델 선택
  • Mindlogic Gateway (내 키): 학교/조직 발급 키로 Claude Haiku · GPT-5.4 mini/nano · Gemini Flash 등 가성비 라인 선택
- 자막 스타일: 폰트 크기·색·굵기·줄 높이·배경 투명도 모두 조정
- Shorts 자막 크기 배율 별도 조정 (좁은 세로 화면 대응)
- 번역 캐시: 같은 영상 다시 볼 때 즉시 표시. 30일 / 200개 자동 정리
- 단축키로 듀얼자막 켜기/끄기(기본 G, 옵션에서 원하는 키로 재지정 가능). C는 YouTube 네이티브 자막 그대로 두어 서로 완전히 독립
- 💡 단어·표현 해설: 자막을 드래그하면 예문·어원·뉘앙스까지 AI가 설명 (내 Gemini/Mindlogic 키 필요)
- ❓ 자유 질문 + Alt+Q 어디서나 질문: 궁금한 부분을 직접 물어보기. Alt+Q는 YouTube뿐 아니라 어느 웹사이트에서도 동작
- 📝 Notion 저장: 해설/답변을 내 Notion 데이터베이스에 한 번에 정리 (내 Notion 연동 토큰 필요)

■ 데이터·프라이버시
- 광고, 분석, 트래커 없음
- 사용자 설정은 Chrome 동기화(Google 계정)에만 저장
- 번역 캐시는 로컬 IndexedDB
- 자세한 내용은 Privacy Policy 참고

■ 지원 영상
- 일반 YouTube 영상 (https://www.youtube.com/watch?v=...)
- YouTube Shorts
- 자동자막(ASR)·수동 자막 모두 지원

■ 시스템 요구
- Chrome 138+ (Chrome 내장 번역 사용 시)
- 그 외에는 Chrome 88+ (Manifest V3 기준)
```

영문 버전도 같은 구조로 작성. 필요 시 자동 번역 후 수동 검수.

## 4. 권한 사용 정당화 (Permission justification)

심사관이 권한별 사유를 요구할 수 있습니다. 각각 한 줄로:

| 권한 | 정당화 |
|---|---|
| `storage` | Save user preferences (languages, styles, subtitle position) to chrome.storage.sync and cache translations in IndexedDB. |
| `scripting` | Listed in `content_scripts` to inject the subtitle renderer into YouTube pages. |
| `offscreen` | The Chrome Built-in Translator API requires a DOM context; we host it in an offscreen document. |
| `host_permissions: https://www.youtube.com/*` | Intercept YouTube caption track responses and overlay our dual subtitle container on the player. |
| `host_permissions: https://translate.googleapis.com/*` | Call the user-selected Google free translation endpoint. Not used when Chrome Built-in backend is selected. |
| `host_permissions: https://generativelanguage.googleapis.com/*` | Call the Gemini API with the user's own API key (BYOK) when the Gemini backend is selected. The extension does not ship any key — the user enters theirs from Google AI Studio. |
| `host_permissions: https://factchat-cloud.mindlogic.ai/*`, `https://factchat.mindlogic-kr-api.com/*` | Call the Mindlogic API Gateway (at the base URL the user configures in Options) with the user's own school/organization-issued key (BYOK) when the Mindlogic backend is selected. The extension does not ship any key — the user enters theirs from their institution. |
| `host_permissions: https://api.notion.com/*` | Save an AI explanation/answer to the user's own Notion database when they click the Notion export button and have entered their own Notion integration token. |
| `activeTab` | Let the `Alt+Q` shortcut open the "Ask AI" panel on the active tab, on any website, scoped to that one keypress — no standing access to other tabs or sites. |

## 5. 아이콘

✓ 완료 — `public/icons/`에 16/32/48/128 4종 모두 있고 `manifest.ts`의 `icons`/`action.default_icon`에도 등록돼 있음(`npm run icons`로 재생성 가능).

## 6. 스크린샷

필요 사양: 1280×800 또는 640×400 (PNG/JPG), 최소 1장 최대 5장.

권장 구성:
1. 일반 영상에 듀얼 자막 표시 (원문/번역 시각적 강조)
2. Shorts에서 자막 표시
3. 단어 단위 점진 표시 효과 (가능하면 GIF→PNG 시리즈)
4. 옵션 페이지 — 스타일 미리보기 함께 보이는 화면
5. 팝업 — 토글·언어·엔진 옵션

## 7. 홍보 이미지 (선택)

- 소형 타일: 440×280
- 마키 타일: 1400×560 (Featured 후보 시)

## 8. 호스팅할 페이지

- **Privacy Policy URL**: `docs/PRIVACY.md`를 GitHub Pages, Gist, 또는 본인 사이트에 호스팅 후 URL 입력. Web Store 필수 항목.
- **Support URL**: GitHub 이슈 트래커 URL.
- **Homepage URL**: GitHub repo URL.

## 9. 등록 전 마지막 점검

- [ ] manifest version, description, default_locale 확인
- [ ] dist를 zip으로 압축 (dist 폴더 자체가 아닌 그 안의 파일들이 zip 루트)
- [x] 개발자 계정 등록 완료
- [ ] Privacy Policy URL 호스팅 완료 (`docs/PRIVACY.md` → GitHub Pages 등)
- [ ] 스크린샷 5장 준비
- [x] 아이콘 4종 (16/32/48/128) — `public/icons/`에 이미 존재
- [x] 단일 목적 문구 작성 완료 (위 1번)
- [ ] 카테고리 / 언어 / 지역 선택
- [x] 권한별 정당화 작성 완료 (위 4번)
- [ ] 확장 이름 최종 결정 (`YouTube` 상표 리스크 검토 — 아래 별도 메모)

## 10. 등록 후 심사

- 보통 1~3 영업일.
- 거절 시 메일로 사유 옴 — 수정 후 재제출 가능.
- 자주 거절되는 사유: 사용하지 않는 권한(이미 정리 완료), Privacy Policy URL 부재, 단일 목적 위반, 사용자 데이터 명세 부실.
