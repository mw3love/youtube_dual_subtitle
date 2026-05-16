// CSS injection — native YouTube 자막 숨김 + 자체 자막 스타일.
// 사용자가 바꿀 수 있는 값은 모두 CSS 변수로 — applyStyleSettings로 :root에 박는다.

import type { CueStyle } from '../../shared/settings';

const STYLES = `
/* native 자막 숨김 — 사용자 측에서 자동/수동으로 켜졌어도 우리 것만 보이도록 */
.ytp-caption-window-container { display: none !important; }

.ydt-container {
  position: absolute;
  left: 50%;
  bottom: var(--ydt-bottom, 10%);
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  max-width: 90%;
  text-align: center;
  pointer-events: auto;
  user-select: text;
  font-family: "YouTube Sans", "Roboto", "Noto Sans KR", sans-serif;
}

.ydt-cue {
  padding: 4px 10px;
  background: rgba(0, 0, 0, 0.75);
  border-radius: 4px;
  user-select: text;
  line-height: 1.3;
}

.ydt-source {
  color: var(--ydt-source-color, #ffffff);
  font-size: var(--ydt-source-size, 22px);
  font-weight: var(--ydt-source-weight, 500);
}

.ydt-target {
  color: var(--ydt-target-color, #cccccc);
  font-size: var(--ydt-target-size, 18px);
  font-weight: var(--ydt-target-weight, 400);
}

/* Fullscreen 보정 — 변수 기준으로 ~1.4배 */
:fullscreen .ydt-source { font-size: calc(var(--ydt-source-size, 22px) * 1.4); }
:fullscreen .ydt-target { font-size: calc(var(--ydt-target-size, 18px) * 1.4); }

/* Shorts 보정 — 약간 작게 */
.ydt-container[data-mode="shorts"] {
  bottom: 18%;
}
.ydt-container[data-mode="shorts"] .ydt-source { font-size: calc(var(--ydt-source-size, 22px) * 0.72); }
.ydt-container[data-mode="shorts"] .ydt-target { font-size: calc(var(--ydt-target-size, 18px) * 0.72); }
`;

let injected = false;

export function injectStyles(): void {
  if (injected) return;
  const inject = (): void => {
    if (document.getElementById('ydt-styles')) {
      injected = true;
      return;
    }
    const style = document.createElement('style');
    style.id = 'ydt-styles';
    style.textContent = STYLES;
    (document.head ?? document.documentElement).appendChild(style);
    injected = true;
  };
  if (document.head) inject();
  else document.addEventListener('DOMContentLoaded', inject, { once: true });
}

// :root에 CSS 변수로 박아서 :fullscreen / [data-mode="shorts"]까지 한 번에 반영.
export function applyStyleSettings(opts: {
  sourceStyle: CueStyle;
  targetStyle: CueStyle;
  bottomOffsetPercent: number;
}): void {
  const root = document.documentElement.style;
  root.setProperty('--ydt-source-color', opts.sourceStyle.color);
  root.setProperty('--ydt-source-size', `${opts.sourceStyle.fontSize}px`);
  root.setProperty('--ydt-source-weight', String(opts.sourceStyle.fontWeight));
  root.setProperty('--ydt-target-color', opts.targetStyle.color);
  root.setProperty('--ydt-target-size', `${opts.targetStyle.fontSize}px`);
  root.setProperty('--ydt-target-weight', String(opts.targetStyle.fontWeight));
  root.setProperty('--ydt-bottom', `${opts.bottomOffsetPercent}%`);
}
