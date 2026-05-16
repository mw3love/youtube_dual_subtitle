import { z } from 'zod';

// zod로 검증해 손상된 storage 값이 runtime을 부수지 않게 한다.
// 새 필드는 default가 있어서 옛 사용자의 storage에도 안전하게 마이그레이션됨.

export const BackendIdSchema = z.enum(['chrome-builtin', 'google-free']);
export type BackendId = z.infer<typeof BackendIdSchema>;

export const DisplayModeSchema = z.enum(['dual', 'translation-only', 'source-only']);
export type DisplayMode = z.infer<typeof DisplayModeSchema>;

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

export const SettingsSchema = z.object({
  subtitlesEnabled: z.boolean(),
  backend: BackendIdSchema,
  sourceLang: SourceLangSchema,
  targetLang: TargetLangSchema,
  displayMode: DisplayModeSchema,
  sourceStyle: CueStyleSchema,
  targetStyle: CueStyleSchema,
  // 자막 컨테이너 세로 위치 — bottom: N% (광고나 UI에 가릴 때 조정)
  bottomOffsetPercent: z.number().int().min(0).max(50),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  subtitlesEnabled: true,
  backend: 'google-free',
  sourceLang: 'en',
  targetLang: 'ko',
  displayMode: 'dual',
  sourceStyle: { fontSize: 22, color: '#ffffff', fontWeight: 500 },
  targetStyle: { fontSize: 18, color: '#cccccc', fontWeight: 400 },
  bottomOffsetPercent: 10,
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
