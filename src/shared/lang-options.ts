import type { BackendId, DisplayMode, SourceLang, TargetLang } from './settings';

export const SOURCE_LANGS: Array<{ value: SourceLang; label: string }> = [
  { value: 'en', label: '영어 (English)' },
  { value: 'ja', label: '일본어 (日本語)' },
  { value: 'zh', label: '중국어 (中文)' },
  { value: 'es', label: '스페인어 (Español)' },
  { value: 'fr', label: '프랑스어 (Français)' },
  { value: 'de', label: '독일어 (Deutsch)' },
  { value: 'auto', label: '자동으로 골라줘요' },
];

export const TARGET_LANGS: Array<{ value: TargetLang; label: string }> = [
  { value: 'ko', label: '한국어' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'zh', label: '中文' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
];

export const DISPLAY_MODES: Array<{ value: DisplayMode; label: string }> = [
  { value: 'dual', label: '원문 + 번역 같이' },
  { value: 'translation-only', label: '번역만' },
  { value: 'source-only', label: '원문만' },
];

export const BACKENDS: Array<{ value: BackendId; label: string }> = [
  { value: 'google-free', label: 'Google 무료 (추천)' },
  { value: 'chrome-builtin', label: 'Chrome 내장 (오프라인)' },
  { value: 'gemini', label: 'Gemini (내 키)' },
];
