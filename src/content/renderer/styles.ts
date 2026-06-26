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

/* ─── 단어/표현 해설 (드래그 선택 → AI 설명/질문) ─── */
/* 선택 위에 뜨는 트리거 툴바(💡 해설 + ❓ 질문) — fixed라 뷰포트 기준, 전체화면 host에 붙어도 동작. */
.ydt-explain-toolbar {
  position: fixed;
  z-index: 2147483647;
  display: none;
  gap: 6px;
  align-items: center;
}
.ydt-explain-btn {
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
  white-space: nowrap;
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
/* 📝 Notion — 내용을 정리해 내보내는 마지막 액션이라 녹색으로 구별(복사·형광펜은 중립 회색).
   저장 후 ✓/실패 ✗ 상태는 textContent만 바뀌고 클래스는 유지돼 색이 그대로 남는다. */
.ydt-explain-action.ydt-explain-action-notion {
  background: #244b34;
  border-color: #3a6e4d;
  color: #cdebd6;
}
.ydt-explain-action.ydt-explain-action-notion:hover:not(:disabled) {
  background: #2d5d40;
  color: #fff;
}
.ydt-explain-body.highlighting { cursor: text; }

/* Notion 저장 결과 알림 줄 — 헤더 아래, 저장된 제목 표시. */
.ydt-explain-notice {
  flex: 0 0 auto;
  padding: 6px 14px;
  background: #1f3326;
  color: #b8f0c8;
  font-size: 12px;
  line-height: 1.5;
  border-bottom: 1px solid #2c4a36;
  word-break: break-word;
}
.ydt-explain-notice a { color: #7fd0ff; text-decoration: none; }
.ydt-explain-notice a:hover { text-decoration: underline; }

/* 탭 스트립 — 탭 2개 이상일 때만(렌더 측 hidden 토글). 가로 스크롤·라벨 ellipsis. */
.ydt-explain-tabs {
  display: flex;
  gap: 4px;
  padding: 6px 8px;
  background: #1f1f1f;
  border-bottom: 1px solid #333;
  overflow-x: auto;
  flex: 0 0 auto;
}
.ydt-explain-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 150px;
  padding: 3px 4px 3px 8px;
  background: #2a2a2a;
  border: 1px solid #3a3a3a;
  border-radius: 6px;
  cursor: pointer;
  flex: 0 0 auto;
}
.ydt-explain-tab:hover { background: #333; }
.ydt-explain-tab.active { background: #2e6f86; border-color: #4aa3c4; }
.ydt-explain-tab-label {
  font-size: 12px;
  color: #ddd;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 116px;
}
.ydt-explain-tab.active .ydt-explain-tab-label { color: #fff; }
.ydt-explain-tab-close {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  padding: 0;
  font-size: 11px;
  line-height: 1;
  color: #aaa;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.ydt-explain-tab-close:hover { background: rgba(255, 255, 255, 0.15); color: #fff; }

/* 탭 콘텐츠 컨테이너 — 활성 탭(contentEl)만 display, 본문은 그 안에서 스크롤. */
.ydt-explain-tabsbody {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.ydt-explain-tabcontent {
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

/* 최소화 핸들 — 패널을 접으면 우상단에 작게. 클릭하면 복원(탭 보존). */
.ydt-explain-fab {
  position: fixed;
  z-index: 2147483646;
  top: 72px;
  right: 24px;
  display: none;
  align-items: center;
  gap: 4px;
  padding: 8px 13px;
  background: #2e6f86;
  color: #fff;
  border: 1px solid #4aa3c4;
  border-radius: 20px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  font-family: "Noto Sans KR", "YouTube Sans", "Roboto", sans-serif;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.ydt-explain-fab:hover { background: #357f99; }
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
  /* 탭 콘텐츠(flex column) 안에서 남은 높이를 채우고 그 안에서 스크롤. */
  flex: 1 1 auto;
  min-height: 0;
}
.ydt-explain-loading { color: #999; font-size: 13px; padding: 8px 0; }
.ydt-explain-model { color: #9ee7ff; font-weight: 600; }
.ydt-explain-error { color: #ff8a8a; font-size: 13px; }

/* 질문 입력칸 — 헤더와 본문 사이. 답이 와도 남아 재질문 가능. */
.ydt-explain-qform {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  background: #1f1f1f;
  border-bottom: 1px solid #333;
  flex: 0 0 auto;
}
.ydt-explain-qinput {
  flex: 1 1 auto;
  resize: vertical;
  min-height: 36px;
  padding: 6px 8px;
  font-size: 13px;
  line-height: 1.4;
  color: #e8e8e8;
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 6px;
  font-family: "Noto Sans KR", "YouTube Sans", "Roboto", sans-serif;
}
.ydt-explain-qinput:focus { outline: none; border-color: #3ea6ff; }
.ydt-explain-qinput::placeholder { color: #777; }
.ydt-explain-qsend {
  flex: 0 0 auto;
  align-self: stretch;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  background: #3ea6ff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-family: "Noto Sans KR", "YouTube Sans", "Roboto", sans-serif;
}
.ydt-explain-qsend:hover { background: #5cb3ff; }

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
