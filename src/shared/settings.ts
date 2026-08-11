import { z } from 'zod';

// zod로 검증해 손상된 storage 값이 runtime을 부수지 않게 한다.
// 새 필드는 default가 있어서 옛 사용자의 storage에도 안전하게 마이그레이션됨.

export const BackendIdSchema = z.enum(['chrome-builtin', 'google-free', 'gemini', 'mindlogic']);
export type BackendId = z.infer<typeof BackendIdSchema>;

// Gemini API 모델 ID. Mindlogic과 같은 이유로 고정 enum이 아니라 자유 문자열:
// 옵션 페이지가 Gemini /v1beta/models로 동적 목록을 가져와 보여주고(모델이 주기적으로
// 추가/폐기되므로 코드 고정 목록은 금방 낡음), 사용자가 그중 무엇을 골라도 검증 통과한다
// (enum이면 목록 밖 값이 default로 리셋됨). 실제 유효성은 Gemini API가 판정.
// lang-options의 GEMINI_MODELS는 추천 힌트가 붙은 "알려진" 부분집합(새로고침 전 fallback).
// 옛 사용자의 별칭값('flash'/'flash-lite'/'3.5-flash')은 gemini.ts:resolveGeminiModelId가
// 실제 ID로 변환해 하위 호환. API key는 storage.local에 별도(secrets.ts).
export const GeminiModelSchema = z.string().min(1);
export type GeminiModel = z.infer<typeof GeminiModelSchema>;

// Mindlogic API Gateway는 OpenAI/Anthropic/Gemini 등을 단일 endpoint로 통과시킨다.
// 학교/조직 계정 통합 크레딧 방식이라 가성비/저가 라인만 노출 — flagship/codex/reasoning은
// 자막 번역(짧은 cue × N)에 비용 대비 가치가 낮음. 모델 ID는 gateway가 upstream에 그대로
// 전달하므로 ID 변경/추가는 이 enum 갱신으로 처리.
// Mindlogic 모델 ID는 게이트웨이가 그대로 upstream에 전달 — 유효성은 게이트웨이가 판정한다.
// 따라서 고정 enum이 아니라 자유 문자열: 옵션 페이지가 게이트웨이 /models로 동적 목록을 가져와
// 보여주고, 사용자가 그중 무엇을 골라도 검증 통과(enum이면 목록 밖 값이 default로 리셋됨).
// lang-options의 MINDLOGIC_MODELS는 추천/힌트가 붙은 "알려진" 부분집합(새로고침 전 기본 목록).
export const MindlogicModelSchema = z.string().min(1);
export type MindlogicModel = z.infer<typeof MindlogicModelSchema>;

export const DisplayModeSchema = z.enum(['dual', 'translation-only', 'source-only']);
export type DisplayMode = z.infer<typeof DisplayModeSchema>;

// 단어/표현 "해설" 기능(드래그 선택 → AI 영어 선생님 설명)의 백엔드.
// 번역 백엔드(BackendId)와 별개 — google-free/chrome-builtin은 자유서술 해설을 못 하므로
// 자유 프롬프트 chat이 가능한 BYOK 백엔드(gemini/mindlogic)만 노출. 키는 secrets.ts 재사용.
export const ExplainBackendSchema = z.enum(['gemini', 'mindlogic']);
export type ExplainBackend = z.infer<typeof ExplainBackendSchema>;

// 해설 기본 프롬프트 — 사용자의 Gemini "영어 선생님" Gem 프롬프트를 기본값으로 박는다.
// 옵션 페이지에서 자유 편집 가능(explainPrompt). system 메시지로 그대로 전달된다.
export const DEFAULT_EXPLAIN_PROMPT = `너는 나의 영어 선생님이야. 내가 영어를 잘 할 수 있도록 최선을 다해. 답변할 때 정보 전달 외 불필요한 인삿말은 하지 마.

답변은 다음과 같이 할것
- 답변은 한국말로
- 답변 최상단에는 질문에 적합한 영어예문을 인라인 코드로 작성
- 예문 아래에 한글 해석 작성
- 영어 예문들만 인라인 코드로 작성할것
- 관용어(idiom)의 경우 어원 설명
- 표로 만들 수 있는건 되도록 표로 제작
- 의미가 다양할 경우 관통하는 하나의 이미지 표현을 제시, 유연하게 해석할 수 있도록 한다.`;

// 질문 전용 시스템 프롬프트 — "❓ 질문" 경로에서 쓴다(해설 프롬프트와 분리).
// 해설은 고정 표 형식의 "영어 선생님"이라 "who 빼면 이상한가?" 같은 자유 질문엔 형식이
// 끼어들어 어색하다. 질문은 형식 강제 없이 자막 문맥을 참고해 핵심만 답하는 가벼운 튜터로.
// (사용자 편집 대상 아님 — 코드 상수. 자유 질문이라 영어/한글 영상 모두 동작.)
export const QUESTION_SYSTEM_PROMPT = `너는 나의 언어 학습 도우미야. 사용자가 자막에서 고른 표현과 그 문맥을 참고해 사용자의 질문에 답해.
- 답변은 한국어로, 핵심만 간결하게.
- 영어 예문이나 단어는 인라인 코드(\`backtick\`)로 표시.
- 표로 정리하는 게 더 명확하면 표로.
- 정보 전달 외 불필요한 인삿말은 하지 마.`;

// 누적 표시 레이아웃 — cue마다 한 줄(stacked) vs 한 문단처럼 이어 흘림(inline).
export const HistoryLayoutSchema = z.enum(['stacked', 'inline']);
export type HistoryLayout = z.infer<typeof HistoryLayoutSchema>;

export const TargetLangSchema = z.enum(['ko', 'en', 'ja', 'zh', 'es', 'fr', 'de']);
export type TargetLang = z.infer<typeof TargetLangSchema>;

// 한 줄 스타일 — 영어/한글 줄을 각각 다르게 꾸미는 게 핵심 가치.
export const CueStyleSchema = z.object({
  fontSize: z.number().int().min(8).max(72),
  color: z.string(), // #rrggbb 또는 css color
  fontWeight: z.union([z.literal(400), z.literal(500), z.literal(700)]),
});
export type CueStyle = z.infer<typeof CueStyleSchema>;

// 자막 위치 — 영상 영역 좌하단 기준 백분율.
// xPercent: 영상 폭의 N% 지점에 컨테이너 중앙이 위치
// yPercent: 영상 하단에서 N% 위에 컨테이너 하단이 위치
export const PositionSchema = z.object({
  xPercent: z.number().min(0).max(100),
  yPercent: z.number().min(0).max(95),
});
export type Position = z.infer<typeof PositionSchema>;

export const SettingsSchema = z.object({
  subtitlesEnabled: z.boolean(),
  backend: BackendIdSchema,
  geminiModel: GeminiModelSchema,
  // Mindlogic 게이트웨이 base URL — 조직마다 도메인이 다름(예: 전북대 vs KBS). 기본값을 특정
  // 조직 URL로 박으면 웹스토어 공개 배포 시 그 조직과 무관한 사용자에게 남의 인프라 주소가
  // 노출되므로 빈 문자열이 기본값 — 사용자가 자기 조직 URL을 직접 입력해야 동작.
  mindlogicBaseUrl: z.string(),
  mindlogicModel: MindlogicModelSchema,
  targetLang: TargetLangSchema,
  displayMode: DisplayModeSchema,
  sourceStyle: CueStyleSchema,
  targetStyle: CueStyleSchema,
  // 영어(원문) 자막을 단어 단위로 음성에 맞춰 점진 표시. 한글 줄은 영향 없음.
  wordRevealEnabled: z.boolean(),
  // 싱글 자막(번역만/원문만/모국어 영상) 모드에서 현재 줄 + 직전 줄을 누적 표시.
  // 1=현재 줄만(기존 동작), 2~3=누적 + 공백 구간 sticky 유지. 듀얼 모드에는 영향 없음.
  singleContextLines: z.number().int().min(1).max(3),
  // 누적 표시 시 직전 줄을 흐리게 처리해 지금 말하는 줄과 구분.
  dimHistory: z.boolean(),
  // 누적 표시 레이아웃 — 'stacked'는 cue마다 한 줄, 'inline'은 한 문단처럼 이어 흘림.
  historyLayout: HistoryLayoutSchema,
  // 쇼츠 모드 자막 크기 배율. 좁은 세로 화면에서 일반 영상과 다르게 보정하고 싶을 때.
  // 1.0이면 옵션 폰트 크기 그대로 적용. 좁은 폭 보정용으로 보통 1.0 초과가 자연스러움.
  shortsFontScale: z.number().min(0.5).max(1.8),
  // 자막 박스 배경 투명도 (0=완전 투명, 1=완전 불투명).
  backgroundOpacity: z.number().min(0).max(1),
  // 자막 줄 높이 — 원문/번역 두 줄 간격에 영향.
  lineHeight: z.number().min(1.0).max(2.0),
  // 자막 위치 — 일반 영상과 쇼츠 각각 별도 저장. 마우스 드래그로 조정.
  subtitlePosition: z.object({
    normal: PositionSchema,
    shorts: PositionSchema,
  }),
  // 단어/표현 해설 — 자막 텍스트를 드래그 선택하면 작은 버튼으로 AI 해설 패널 호출.
  // explainEnabled: 현재는 항상 true(옵션 UI 토글 제거, 해설/질문 버튼 상시 표시). 미래 결제
  // 게이트용 예약 필드 — 유료화 시 "해설 호출" 단계에서 이 값을 검사(버튼은 무료도 계속 노출).
  explainEnabled: z.boolean(),
  explainBackend: ExplainBackendSchema,
  // 해설 모델 — 번역 모델(geminiModel/mindlogicModel)과 별개로 선택. 번역은 자막 수백 줄 ×N이라
  // 가성비, 해설은 누를 때 1회라 품질 우선 — 호출 프로필이 정반대라 분리.
  explainGeminiModel: GeminiModelSchema,
  explainMindlogicModel: MindlogicModelSchema,
  explainPrompt: z.string(),
  // 해설 패널을 Notion DB에 저장 (BYOK — 토큰은 secrets.ts, DB ID는 여기).
  // notionEnabled: 현재는 항상 표시(옵션 UI 토글 제거, 📝 버튼 상시 노출). explainEnabled와 같은
  // 미래 결제 게이트용 예약 필드 — 유료화 시 "저장 호출" 단계에서 검사(버튼은 무료도 계속 노출).
  notionEnabled: z.boolean(),
  notionDatabaseId: z.string(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  subtitlesEnabled: true,
  backend: 'google-free',
  geminiModel: 'gemini-2.5-flash',
  mindlogicBaseUrl: '',
  mindlogicModel: 'gemini-2.5-flash',
  targetLang: 'ko',
  displayMode: 'dual',
  sourceStyle: { fontSize: 22, color: '#ffa200', fontWeight: 500 },
  targetStyle: { fontSize: 18, color: '#cccccc', fontWeight: 400 },
  wordRevealEnabled: true,
  singleContextLines: 2,
  dimHistory: true,
  historyLayout: 'stacked',
  shortsFontScale: 1.2,
  backgroundOpacity: 0.75,
  lineHeight: 1.3,
  subtitlePosition: {
    normal: { xPercent: 50, yPercent: 10 },
    // Shorts 하단 30% — YouTube Shorts 자체 하단 오버레이(scrim+채널/제목/음악 메타데이터)
    // 띠를 벗어나 깨끗한 영상 구간에 두기 위함. 18%였을 땐 세로 모니터에서 자막이 그 오버레이
    // 아래로 깔려 흐릿+드래그/휠 불가였고, "위치 초기화"가 이 값으로 되돌려 탈출구가 된다.
    shorts: { xPercent: 50, yPercent: 30 },
  },
  explainEnabled: true,
  explainBackend: 'gemini',
  explainGeminiModel: 'gemini-3.5-flash',
  explainMindlogicModel: 'claude-sonnet-4-6',
  explainPrompt: DEFAULT_EXPLAIN_PROMPT,
  notionEnabled: false,
  notionDatabaseId: '',
};

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  // 손상된 값이 들어와도 default로 회복 — partial 갱신은 마이그레이션처럼 동작.
  const parsed = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...raw });
  if (!parsed.success) {
    console.warn('[YDT/settings] invalid, falling back to defaults:', parsed.error.message);
    return DEFAULT_SETTINGS;
  }
  return parsed.data;
}

// mindlogic.ts(번역)·explain.ts(해설) 공용 — 매 호출마다 fresh read해서 옵션 페이지의
// 디바운스 저장과 race 회피(API 키와 동일 패턴). trailing slash 제거해 사용자가
// ".../v1/gateway/"처럼 슬래시를 붙여도 "//chat/completions"가 되지 않게.
export async function getMindlogicBaseUrl(): Promise<string> {
  const r = await chrome.storage.sync.get({ mindlogicBaseUrl: '' });
  const v = typeof r.mindlogicBaseUrl === 'string' ? r.mindlogicBaseUrl.trim() : '';
  return v.replace(/\/+$/, '');
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}
