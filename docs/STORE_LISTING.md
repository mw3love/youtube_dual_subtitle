# Chrome Web Store 등록 체크리스트

심사 통과를 위해 본인이 준비해야 할 자료와 권장 문구 모음.

## 1. 단일 목적 (Single Purpose) 선언

Web Store는 확장이 **단일 목적**을 가져야 합니다. 심사 시 입력란에 한 줄로:

> 한: "YouTube 영상에 원문과 번역 자막을 동시에 표시한다."
> EN: "Display dual-language (source + translation) subtitles on YouTube videos."

## 2. 카테고리

권장:
- 1순위: **Productivity**
- 대안: **Accessibility** (자막 보조 도구 측면)

## 3. 설명 (Description)

### 짧은 설명 (~132자, Search snippet)

**한**: "YouTube 영상에 원문과 번역 자막을 듀얼로. 단어 단위 노래방 자막, 위치 드래그, Shorts 지원. Chrome 내장 번역으로 오프라인도."

**EN**: "Dual-language subtitles on YouTube — source + translation. Karaoke-style word reveal, draggable position, Shorts support, optional offline translation."

### 긴 설명 (~16000자, Description)

```
YouTube Dual Subtitle은 영상에 원문 자막과 번역 자막을 동시에 표시합니다. 외국어 영상을 보면서 모르는 단어만 번역으로 확인하고 싶을 때, 또는 어학 학습용으로 적합합니다.

■ 주요 기능
- 듀얼 자막: 원문(영어 등) + 번역(한국어 등) 두 줄 동시 표시
- 단어 단위 점진 표시: 음성에 맞춰 단어가 하나씩 또렷해짐 (자동자막 영상에서 가장 정확)
- 자막 위치 드래그: 영상에서 자막을 직접 드래그해 광고나 UI 가림 회피. 일반 영상과 Shorts 위치 별도 저장
- 번역 엔진 2종
  • Google 무료: 클라우드 번역, 품질 상위 (사용량 많으면 일시 차단 가능)
  • Chrome 내장: 로컬 모델, 오프라인·차단 없음·자막 외부 전송 없음
- 자막 스타일: 폰트 크기·색·굵기·줄 높이·배경 투명도 모두 조정
- Shorts 자막 크기 배율 별도 조정 (좁은 세로 화면 대응)
- 번역 캐시: 같은 영상 다시 볼 때 즉시 표시. 30일 / 200개 자동 정리
- 단축키 C로 자막 토글

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

## 5. 아이콘

필요 사이즈 (PNG, 투명 배경 권장):
- 16×16, 32×32, 48×48, 128×128
- Web Store 등록용 추가: 128×128 PNG, 스토어 페이지 대표 이미지

위치: `public/icons/` 디렉토리 만들고 manifest의 `icons` 필드 추가 권장.

```ts
// manifest.ts 추가 예시
icons: {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
},
action: {
  default_popup: 'src/popup/index.html',
  default_icon: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
},
```

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
- [ ] 개발자 계정 1회성 $5 등록비 결제 확인
- [ ] Privacy Policy URL 호스팅 완료
- [ ] 스크린샷 5장 준비
- [ ] 아이콘 4종 (16/32/48/128) 준비
- [ ] 단일 목적 문구 작성
- [ ] 카테고리 / 언어 / 지역 선택
- [ ] 권한별 정당화 작성

## 10. 등록 후 심사

- 보통 1~3 영업일.
- 거절 시 메일로 사유 옴 — 수정 후 재제출 가능.
- 자주 거절되는 사유: 사용하지 않는 권한(이미 정리 완료), Privacy Policy URL 부재, 단일 목적 위반, 사용자 데이터 명세 부실.
