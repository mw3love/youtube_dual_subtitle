// CSS injection — native YouTube 자막 숨김 + 자체 자막 스타일.
// M7에서 사용자 커스터마이즈 들어올 때까지 하드코딩.

const STYLES = `
/* 1. native 자막 숨김 — 사용자 측에서 자동/수동으로 켜졌어도 우리 것만 보이도록 */
.ytp-caption-window-container { display: none !important; }

/* 2. 자체 자막 컨테이너 */
.ydt-container {
  position: absolute;
  left: 50%;
  bottom: 10%;
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
  color: #ffffff;
  font-size: 22px;
  font-weight: 500;
}

.ydt-target {
  color: #cccccc;
  font-size: 18px;
  font-weight: 400;
}

/* Fullscreen 보정 */
:fullscreen .ydt-source { font-size: 32px; }
:fullscreen .ydt-target { font-size: 26px; }

/* Shorts 보정 — 컨트롤 UI 위쪽 영역에 표시, 폰트 작게 */
.ydt-container[data-mode="shorts"] {
  bottom: 18%;
}
.ydt-container[data-mode="shorts"] .ydt-source { font-size: 16px; }
.ydt-container[data-mode="shorts"] .ydt-target { font-size: 13px; }
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
