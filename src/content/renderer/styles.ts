// CSS injection — native YouTube 자막 숨김 + 자체 자막 스타일.
// 사용자가 바꿀 수 있는 값은 모두 CSS 변수로 — applyStyleSettings로 :root에 박는다.

import type { CueStyle } from '../../shared/settings';

const STYLES = `
/* native 자막 숨김 — 사용자 측에서 자동/수동으로 켜졌어도 우리 것만 보이도록 */
.ytp-caption-window-container { display: none !important; }

.ydt-container {
  position: absolute;
  /* x는 컨테이너 중앙 기준 (translate(-50%, 0))이라 left가 영상의 어느 비율에 있든 중앙이 그 점. */
  left: var(--ydt-x, 50%);
  bottom: var(--ydt-y, 10%);
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  /* width: max-content는 핵심 — absolute element의 width auto는 spec상
     'containing block 폭 - left'로 shrink-to-fit이 되어, 우측으로 드래그할수록
     컨테이너가 자동 wrap된다. max-content로 자연 폭을 고정해야 한다.
     max-width 90%는 매우 긴 cue의 경우만 wrap 유도. */
  width: max-content;
  max-width: 90%;
  text-align: center;
  pointer-events: auto;
  user-select: text;
  font-family: "YouTube Sans", "Roboto", "Noto Sans KR", sans-serif;
  cursor: move;
}
/* 텍스트 위에선 텍스트 커서. 드래그는 6px threshold로 텍스트 선택과 공존.
   누적(롤링) 윗줄(.ydt-history*)도 텍스트라 같은 규칙 적용 — 안 그러면 move cursor + 컨테이너 드래그가 발화돼 텍스트 선택이 막힌다. */
.ydt-cue-text, .ydt-word, .ydt-history, .ydt-history-line {
  cursor: text;
}

/* hit 영역 확장 + halo 채움 — 컨테이너 외곽 6px 띠를 가상 요소로 만들어
   드래그 가능 영역을 넓히고 hover/dragging 시 cyan tint로 채운다. 가상 요소가
   .ydt-cue 행 뒤에 있어 행 본체 가독성에는 영향 없고, 행 사이 4px gap에는
   tint가 비쳐 두 자막이 한 패널처럼 묶여 보인다.
   e.target은 여전히 .ydt-container라 핸들러 로직 그대로. */
.ydt-container::before {
  content: '';
  position: absolute;
  inset: -6px;
  pointer-events: auto;
  background: transparent;
  border-radius: 6px;
  transition: background 120ms ease;
}
.ydt-container:hover::before {
  background: rgba(62, 166, 255, 0.2);
}
.ydt-container.is-dragging::before {
  background: rgba(62, 166, 255, 0.4);
}

.ydt-cue {
  position: relative;
  padding: 4px 10px;
  background: rgba(0, 0, 0, var(--ydt-bg-opacity, 0.75));
  border-radius: 4px;
  user-select: text;
  line-height: var(--ydt-line-height, 1.3);
}

.ydt-source {
  color: var(--ydt-source-color, #ffffff);
  font-size: var(--ydt-source-size, 22px);
  font-weight: var(--ydt-source-weight, 500);
}

/* 단어 단위 reveal — 영어 자막에만 적용. 음성에 맞춰 unrevealed → revealed로 opacity fade. */
.ydt-source .ydt-word {
  opacity: 0.25;
  transition: opacity 80ms linear;
}
.ydt-source .ydt-word.is-revealed {
  opacity: 1;
}

.ydt-target {
  color: var(--ydt-target-color, #cccccc);
  font-size: var(--ydt-target-size, 18px);
  font-weight: var(--ydt-target-weight, 400);
}

/* 누적(롤링) 모드 히스토리 영역 — 표시 여부·레이아웃(블록/인라인)·흐림(opacity)은
   renderer가 동적으로 제어. 색/크기는 부모 .ydt-cue에서 그대로 상속. */

/* Fullscreen 보정 — 변수 기준으로 ~1.4배 */
:fullscreen .ydt-source { font-size: calc(var(--ydt-source-size, 22px) * 1.4); }
:fullscreen .ydt-target { font-size: calc(var(--ydt-target-size, 18px) * 1.4); }

/* Shorts 보정 — 폰트 스케일만. bottom 위치는 일반 룰의 --ydt-y로 통일 처리
   (applyCurrentPosition이 mode별 storage 값을 박음 — Shorts default 18%). */
.ydt-container[data-mode="shorts"] .ydt-source { font-size: calc(var(--ydt-source-size, 22px) * var(--ydt-shorts-scale, 1)); }
.ydt-container[data-mode="shorts"] .ydt-target { font-size: calc(var(--ydt-target-size, 18px) * var(--ydt-shorts-scale, 1)); }

/* ─── 단어/표현 해설 (드래그 선택 → AI 설명) ─── */
/* 선택 위에 뜨는 작은 트리거 버튼 — fixed라 뷰포트 기준, 전체화면 host에 붙어도 동작. */
.ydt-explain-btn {
  position: fixed;
  z-index: 2147483646;
  display: none;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 600;
  font-family: "YouTube Sans", "Roboto", "Noto Sans KR", sans-serif;
  color: #fff;
  background: #3ea6ff;
  border: none;
  border-radius: 14px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
  cursor: pointer;
  line-height: 1.2;
}
.ydt-explain-btn:hover { background: #5cb3ff; }

/* 해설 패널 — 우상단 사이드 패널. 영상 중앙을 가리지 않게. */
.ydt-explain-panel {
  position: fixed;
  z-index: 2147483646;
  top: 72px;
  right: 24px;
  width: 420px;
  max-width: calc(100vw - 48px);
  max-height: 72vh;
  display: flex;
  flex-direction: column;
  background: #1a1a1a;
  color: #e8e8e8;
  border: 1px solid #333;
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  font-family: "Noto Sans KR", "YouTube Sans", "Roboto", sans-serif;
  font-size: 14px;
  line-height: 1.6;
  overflow: hidden;
}
.ydt-explain-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  background: #232323;
  border-bottom: 1px solid #333;
  flex: 0 0 auto;
}
.ydt-explain-term {
  font-weight: 700;
  color: #ffa200;
  font-size: 14px;
  word-break: break-word;
}
.ydt-explain-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.ydt-explain-action {
  padding: 4px 9px;
  font-size: 12px;
  font-weight: 600;
  font-family: "Noto Sans KR", "YouTube Sans", "Roboto", sans-serif;
  color: #ddd;
  background: #333;
  border: 1px solid #444;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.ydt-explain-action:hover:not(:disabled) { background: #3f3f3f; color: #fff; }
.ydt-explain-action:disabled { opacity: 0.45; cursor: default; }
/* 형광펜 모드 ON — 켜진 상태를 또렷이. 켜진 동안 패널 본문 커서도 text로. */
.ydt-explain-action.active {
  background: #2e6f86;
  border-color: #4aa3c4;
  color: #fff;
}
.ydt-explain-body.highlighting { cursor: text; }
.ydt-explain-close {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  padding: 0;
  font-size: 13px;
  color: #ccc;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.ydt-explain-close:hover { background: #383838; color: #fff; }
.ydt-explain-body {
  padding: 12px 16px 16px;
  overflow-y: auto;
}
.ydt-explain-loading { color: #999; font-size: 13px; padding: 8px 0; }
.ydt-explain-model { color: #9ee7ff; font-weight: 600; }
.ydt-explain-error { color: #ff8a8a; font-size: 13px; }

/* 패널 내부 markdown 요소 — 패널 안에서만 스코프(.ydt-explain-body 하위). */
.ydt-explain-body h3, .ydt-explain-body h4, .ydt-explain-body h5, .ydt-explain-body h6 {
  margin: 14px 0 6px;
  color: #ffd28a;
  font-size: 14px;
  font-weight: 700;
}
.ydt-explain-body h3 { font-size: 15px; }
.ydt-explain-body p { margin: 6px 0; }
.ydt-explain-body ul, .ydt-explain-body ol { margin: 6px 0; padding-left: 20px; }
.ydt-explain-body li { margin: 3px 0; }
.ydt-explain-body code {
  font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
  font-size: 13px;
  color: #9ee7ff;
  background: #0f2630;
  padding: 1px 5px;
  border-radius: 4px;
  word-break: break-word;
  /* 공부용 강조 — 형광펜으로 밑줄 친 느낌. 인라인 코드(주로 영어 예문)가 눈에 띄게. */
  border-bottom: 2px solid #2e6f86;
}
/* 내가 수동으로 표시한 백틱 — AI 예문 백틱과 구분되게 빨강(패널 안에서만, Notion엔 동일 백틱). */
.ydt-explain-body code.ydt-user-mark { color: #ff8a8a; border-bottom-color: #a33; }
.ydt-explain-body pre {
  background: #0f2630;
  border-radius: 6px;
  padding: 10px 12px;
  overflow-x: auto;
  margin: 8px 0;
}
.ydt-explain-body pre code { background: transparent; padding: 0; color: #cfeaff; border-bottom: none; }
.ydt-explain-body hr { border: none; border-top: 1px solid #3a4a55; margin: 12px 0; }
.ydt-explain-body strong { color: #fff; font-weight: 700; }
.ydt-explain-body table {
  border-collapse: collapse;
  width: 100%;
  margin: 8px 0;
  font-size: 13px;
}
.ydt-explain-body th, .ydt-explain-body td {
  border: 1px solid #3a3a3a;
  padding: 5px 9px;
  text-align: left;
  vertical-align: top;
}
.ydt-explain-body th { background: #2a2a2a; color: #ffd28a; font-weight: 700; }
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
// 위치(--ydt-x, --ydt-y)는 renderer가 모드에 따라 직접 갱신.
export function applyStyleSettings(opts: {
  sourceStyle: CueStyle;
  targetStyle: CueStyle;
  shortsFontScale: number;
  backgroundOpacity: number;
  lineHeight: number;
}): void {
  const root = document.documentElement.style;
  root.setProperty('--ydt-source-color', opts.sourceStyle.color);
  root.setProperty('--ydt-source-size', `${opts.sourceStyle.fontSize}px`);
  root.setProperty('--ydt-source-weight', String(opts.sourceStyle.fontWeight));
  root.setProperty('--ydt-target-color', opts.targetStyle.color);
  root.setProperty('--ydt-target-size', `${opts.targetStyle.fontSize}px`);
  root.setProperty('--ydt-target-weight', String(opts.targetStyle.fontWeight));
  root.setProperty('--ydt-shorts-scale', String(opts.shortsFontScale));
  root.setProperty('--ydt-bg-opacity', String(opts.backgroundOpacity));
  root.setProperty('--ydt-line-height', String(opts.lineHeight));
}

// 자막 위치를 CSS 변수로 박는다. renderer가 모드별로 호출.
export function applySubtitlePosition(xPercent: number, yPercent: number): void {
  const root = document.documentElement.style;
  root.setProperty('--ydt-x', `${xPercent}%`);
  root.setProperty('--ydt-y', `${yPercent}%`);
}
