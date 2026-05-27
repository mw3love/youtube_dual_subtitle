import { z } from 'zod';

// zod로 검증해 손상된 storage 값이 runtime을 부수지 않게 한다.
// 새 필드는 default가 있어서 옛 사용자의 storage에도 안전하게 마이그레이션됨.

export const BackendIdSchema = z.enum(['chrome-builtin', 'google-free', 'gemini', 'mindlogic']);
export type BackendId = z.infer<typeof BackendIdSchema>;

// Gemini API 모델 — Flash는 품질, Flash-Lite는 속도/한도 우선.
// API key는 storage.sync(설정) 아니라 storage.local에 별도(secrets.ts) — 웹스토어 배포 시 키가
// Google 계정 동기화로 전파되지 않도록.
export const GeminiModelSchema = z.enum(['flash', 'flash-lite']);
export type GeminiModel = z.infer<typeof GeminiModelSchema>;

// Mindlogic API Gateway는 OpenAI/Anthropic/Gemini 등을 단일 endpoint로 통과시킨다.
// 학교/조직 계정 통합 크레딧 방식이라 가성비/저가 라인만 노출 — flagship/codex/reasoning은
// 자막 번역(짧은 cue × N)에 비용 대비 가치가 낮음. 모델 ID는 gateway가 upstream에 그대로
// 전달하므로 ID 변경/추가는 이 enum 갱신으로 처리.
export const MindlogicModelSchema = z.enum([
  'gpt-5.4-nano',
  'gpt-5.4-mini',
  'claude-haiku-4-5-20251001',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
]);
export type MindlogicModel = z.infer<typeof MindlogicModelSchema>;

export const DisplayModeSchema = z.enum(['dual', 'translation-only', 'source-only']);
export type DisplayMode = z.infer<typeof DisplayModeSchema>;

// 누적 표시 레이아웃 — cue마다 한 줄(stacked) vs 한 문단처럼 이어 흘림(inline).
export const HistoryLayoutSchema = z.enum(['stacked', 'inline']);
export type HistoryLayout = z.infer<typeof HistoryLayoutSchema>;

// 자주 보는 소스 언어만. 더 필요하면 사용자가 'auto' 선택 가능 (M5+ 백엔드가 감지).
export const SourceLangSchema = z.enum(['en', 'ja', 'zh', 'es', 'fr', 'de', 'auto']);
export type SourceLang = z.infer<typeof SourceLangSchema>;

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
  mindlogicModel: MindlogicModelSchema,
  sourceLang: SourceLangSchema,
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
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  subtitlesEnabled: true,
  backend: 'google-free',
  geminiModel: 'flash',
  mindlogicModel: 'gemini-2.5-flash',
  sourceLang: 'en',
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
    shorts: { xPercent: 50, yPercent: 18 },
  },
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

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}
