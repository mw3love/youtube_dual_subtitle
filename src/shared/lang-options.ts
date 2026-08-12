import type {
  BackendId,
  DisplayMode,
  ExplainBackend,
  GeminiModel,
  MindlogicModel,
  TargetLang,
} from './settings';

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
  { value: 'mindlogic', label: 'Mindlogic Gateway (학교/조직)' },
];

// 모델 선택지 — 옵션 페이지(드롭다운/라디오)와 content(해설 로딩 라벨)가 공유.
// transHint=번역 관점, explainHint=해설 관점 추천 마커. 번역(자막 수백 cue)과 해설(드래그 1회)은
// 가성비/품질 기준이 정반대라 추천 모델이 다르다.
export interface ModelOption<V> {
  value: V;
  label: string;
  transHint?: string;
  explainHint?: string;
}

// Gemini 직접 API. 2.5 세대는 번역 가성비, 3.5 Flash는 최신 세대로 자유서술 해설 품질이 큼.
// value는 실제 모델 ID — 옵션 페이지가 /models 동적 목록(같은 id)에 이 힌트를 오버레이하고,
// 새로고침 전 fallback 목록으로도 쓴다(Mindlogic의 MINDLOGIC_MODELS와 동일 역할).
export const GEMINI_MODELS: Array<ModelOption<GeminiModel>> = [
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', transHint: '균형 (번역 추천)' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', transHint: '한도·속도' },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', transHint: '최신·고품질', explainHint: '해설 추천' },
];

// Mindlogic gateway. gateway가 ID를 그대로 upstream에 전달하므로 권한 없는 모델은 401/403
// (번역은 router가 google-free로 fallback, 해설은 fallback 없이 에러 → 모델 바꾸면 됨).
// transHint/explainHint 없음 — 모델 라인업이 자주 바뀌어 "자연스러움/고품질" 같은 고정 추천 문구가
// 금방 낡음(A64). 필요하면 GEMINI_MODELS처럼 다시 달 수 있으나 유지보수 부담 대비 가치가 낮아 제거.
export const MINDLOGIC_MODELS: Array<ModelOption<MindlogicModel>> = [
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { value: 'gpt-5.4-nano', label: 'GPT-5.4 nano' },
];

// 해설에 쓰이는 모델의 사람용 표시 이름 — 로딩 메시지 "…로 해설 생성 중"에 사용.
// 목록에 없는(옛 storage) 값이면 raw 값 그대로 fallback.
export function explainModelLabel(
  backend: ExplainBackend,
  geminiModel: GeminiModel,
  mindlogicModel: MindlogicModel,
): string {
  if (backend === 'gemini') {
    return GEMINI_MODELS.find((m) => m.value === geminiModel)?.label ?? geminiModel;
  }
  const label = MINDLOGIC_MODELS.find((m) => m.value === mindlogicModel)?.label ?? mindlogicModel;
  return `${label} · Mindlogic`;
}
