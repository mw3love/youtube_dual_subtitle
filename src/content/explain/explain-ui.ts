// 단어/표현 해설 UI — 자막 텍스트를 드래그 선택하면 작은 "해설" 버튼이 뜨고,
// 클릭하면 AI 해설(markdown)을 사이드 패널에 렌더한다.
//
// 자막 컨테이너(.ydt-container) 안의 선택만 대상으로 한다(페이지 다른 텍스트는 무시). 선택은
// 이미 native로 동작함 — 렌더러의 pointerdown이 .ydt-cue-text 위에서 양보하기 때문(섹션 8).
// 여기서는 그 native 선택 결과(window.getSelection)를 mouseup 시점에 읽기만 한다.
//
// 버튼/패널은 document.fullscreenElement(전체화면 시 #movie_player) 또는 body에 붙인다 —
// fixed 요소가 전체화면에서도 보이도록 fullscreen 컨테이너 안에 둬야 하기 때문.
//
// 패널 헤더에는 해설을 외부로 보내는 액션 둘: 📋 클립보드 복사(무설정 — markdown을 복사해
// Notion에 붙여넣으면 자동 리치 변환), 📝 Notion 저장(BYOK — background가 Notion API로 DB에 페이지 생성).

import { renderMarkdown } from './markdown';

const TAG = '[YDT/explain]';

export type ExplainResult = { ok: true; markdown: string } | { ok: false; error: string };
export type NotionSaveResult = { ok: true; url?: string } | { ok: false; error: string };

export class ExplainUI {
  private enabled = true;
  private notionEnabled = false;
  private button: HTMLButtonElement | null = null;
  private panel: HTMLElement | null = null;
  // 버튼 클릭 시점에 넘길 선택 텍스트/문맥 — 선택이 사라져도 유지.
  private pending: { text: string; context: string } | null = null;
  // 현재 패널에 표시 중인 해설 결과 — 복사/Notion 저장이 참조.
  private lastResult: { term: string; markdown: string; context: string } | null = null;
  // 패널 헤더 액션 버튼 — 결과 도착 시 활성화.
  private copyBtn: HTMLButtonElement | null = null;
  private notionBtn: HTMLButtonElement | null = null;
  // Notion 저장 상태 — 저장 후 버튼을 다시 누르면 재저장(중복) 대신 페이지를 연다.
  private notionSaved = false;
  private notionPageUrl: string | null = null;

  constructor(
    private readonly requestExplain: (text: string, context: string) => Promise<ExplainResult>,
    private readonly requestNotionSave: (
      term: string,
      markdown: string,
      context: string,
    ) => Promise<NotionSaveResult>,
  ) {
    document.addEventListener('mouseup', this.onMouseUp, true);
    document.addEventListener('mousedown', this.onMouseDown, true);
    document.addEventListener('selectionchange', this.onSelectionChange);
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.hideButton();
      this.closePanel();
    }
  }

  // Notion 저장 버튼 노출 여부. 설정 변경 시 호출되며, 떠 있는 패널의 버튼도 즉시 토글.
  setNotionEnabled(enabled: boolean): void {
    this.notionEnabled = enabled;
    if (this.notionBtn) this.notionBtn.style.display = enabled ? '' : 'none';
  }

  private host(): HTMLElement {
    return (document.fullscreenElement as HTMLElement | null) ?? document.body;
  }

  // ─── 선택 감지 ───
  private onMouseUp = (ev: MouseEvent): void => {
    if (!this.enabled) return;
    // 우리 버튼/패널 클릭으로 끝난 mouseup은 무시(선택 평가 안 함).
    const t = ev.target as HTMLElement | null;
    if (t && (t.closest('.ydt-explain-btn') || t.closest('.ydt-explain-panel'))) return;
    // 선택 평가는 다음 tick에 — mouseup 직후 selection이 확정됨.
    window.setTimeout(() => this.evaluateSelection(), 0);
  };

  private evaluateSelection(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.hideButton();
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      this.hideButton();
      return;
    }
    const range = sel.getRangeAt(0);
    const container = closestContainer(range.commonAncestorContainer);
    if (!container) {
      this.hideButton();
      return;
    }
    // 문맥 = 같은 자막 박스의 원문(영어) 줄 전체. 없으면 컨테이너 전체 텍스트.
    const sourceText = container.querySelector('.ydt-source .ydt-cue-text')?.textContent?.trim();
    const context = sourceText || container.textContent?.trim() || text;
    this.pending = { text, context };
    this.showButton(range.getBoundingClientRect());
  }

  private onSelectionChange = (): void => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) this.hideButton();
  };

  private onMouseDown = (ev: MouseEvent): void => {
    const t = ev.target as HTMLElement | null;
    if (t && (t.closest('.ydt-explain-btn') || t.closest('.ydt-explain-panel'))) return;
    // 새 클릭 시작 → 기존 버튼 숨김(패널은 명시적 닫기 전까지 유지).
    this.hideButton();
  };

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && this.panel) {
      ev.stopPropagation();
      this.closePanel();
    }
  };

  private onFullscreenChange = (): void => {
    // 전체화면 진입/이탈 시 부모가 바뀌므로 떠 있는 패널/버튼을 새 host로 옮긴다.
    const h = this.host();
    if (this.panel && this.panel.parentElement !== h) h.appendChild(this.panel);
    if (this.button && this.button.parentElement !== h) h.appendChild(this.button);
  };

  // ─── 트리거 버튼 ───
  private showButton(rect: DOMRect): void {
    if (!this.button) {
      this.button = document.createElement('button');
      this.button.className = 'ydt-explain-btn';
      this.button.type = 'button';
      this.button.textContent = '💡 해설';
      // mousedown 기본 동작(선택 collapse·포커스 이동)을 막아 click 직전에 선택이 사라지며
      // 버튼이 hide→click 미발화되는 것을 방지. 툴바-오버-선택의 표준 패턴.
      this.button.addEventListener('mousedown', (e) => e.preventDefault());
      this.button.addEventListener('click', this.onButtonClick);
    }
    const host = this.host();
    if (this.button.parentElement !== host) host.appendChild(this.button);
    // 선택 위에 배치, 화면 밖이면 아래로. 좌우는 뷰포트 안으로 clamp.
    const BTN_W = 78;
    const BTN_H = 30;
    let top = rect.top - BTN_H - 6;
    if (top < 4) top = rect.bottom + 6;
    let left = rect.left + rect.width / 2 - BTN_W / 2;
    left = Math.max(4, Math.min(window.innerWidth - BTN_W - 4, left));
    this.button.style.top = `${Math.round(top)}px`;
    this.button.style.left = `${Math.round(left)}px`;
    this.button.style.display = 'block';
  }

  private hideButton(): void {
    if (this.button) this.button.style.display = 'none';
  }

  private onButtonClick = (ev: MouseEvent): void => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!this.pending) return;
    const { text, context } = this.pending;
    this.hideButton();
    this.openPanel(text);
    void this.runExplain(text, context);
  };

  private async runExplain(text: string, context: string): Promise<void> {
    let res: ExplainResult;
    try {
      res = await this.requestExplain(text, context);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    // 패널이 그 사이 닫혔거나 다른 단어로 교체됐으면 무시.
    if (!this.panel || this.panel.dataset.term !== text) return;
    const body = this.panel.querySelector('.ydt-explain-body');
    if (!body) return;
    body.textContent = '';
    if (res.ok) {
      body.appendChild(renderMarkdown(res.markdown));
      this.lastResult = { term: text, markdown: res.markdown, context };
      this.enableActions(true);
    } else {
      const err = document.createElement('div');
      err.className = 'ydt-explain-error';
      err.textContent = `해설을 불러오지 못했어요: ${res.error}`;
      body.appendChild(err);
      console.warn(TAG, 'explain error:', res.error);
    }
  }

  // ─── 패널 ───
  private openPanel(term: string): void {
    this.closePanel();
    this.lastResult = null;
    this.notionSaved = false;
    this.notionPageUrl = null;
    const panel = document.createElement('div');
    panel.className = 'ydt-explain-panel';
    panel.dataset.term = term;

    const header = document.createElement('div');
    header.className = 'ydt-explain-header';
    const title = document.createElement('div');
    title.className = 'ydt-explain-term';
    title.textContent = term;

    const actions = document.createElement('div');
    actions.className = 'ydt-explain-actions';

    // 📋 클립보드 복사 — 무설정. 결과 도착 전엔 비활성.
    this.copyBtn = document.createElement('button');
    this.copyBtn.className = 'ydt-explain-action';
    this.copyBtn.type = 'button';
    this.copyBtn.textContent = '📋 복사';
    this.copyBtn.disabled = true;
    this.copyBtn.addEventListener('click', () => void this.onCopy());

    // 📝 Notion 저장 — BYOK. notionEnabled일 때만 표시.
    this.notionBtn = document.createElement('button');
    this.notionBtn.className = 'ydt-explain-action';
    this.notionBtn.type = 'button';
    this.notionBtn.textContent = '📝 Notion';
    this.notionBtn.disabled = true;
    this.notionBtn.style.display = this.notionEnabled ? '' : 'none';
    // 단일 핸들러: 이미 저장됐으면 그 페이지를 열고, 아니면 저장. (addEventListener +
    // onclick 이중 등록은 저장된 버튼 재클릭 시 중복 페이지를 만든다 — 한 핸들러로 분기.)
    this.notionBtn.addEventListener('click', () => void this.onNotionClick());

    const close = document.createElement('button');
    close.className = 'ydt-explain-close';
    close.type = 'button';
    close.textContent = '✕';
    close.addEventListener('click', () => this.closePanel());

    actions.appendChild(this.copyBtn);
    actions.appendChild(this.notionBtn);
    actions.appendChild(close);
    header.appendChild(title);
    header.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'ydt-explain-body';
    const loading = document.createElement('div');
    loading.className = 'ydt-explain-loading';
    loading.textContent = '해설 생성 중…';
    body.appendChild(loading);

    panel.appendChild(header);
    panel.appendChild(body);
    this.host().appendChild(panel);
    this.panel = panel;
  }

  private enableActions(enabled: boolean): void {
    if (this.copyBtn) this.copyBtn.disabled = !enabled;
    if (this.notionBtn) this.notionBtn.disabled = !enabled;
  }

  private async onCopy(): Promise<void> {
    if (!this.lastResult || !this.copyBtn) return;
    const { term, markdown, context } = this.lastResult;
    const parts = [`## ${term}`, '', markdown];
    if (context && context !== term) parts.push('', `> 자막: ${context}`);
    const text = parts.join('\n');
    const btn = this.copyBtn;
    try {
      await navigator.clipboard.writeText(text);
      flash(btn, '✓ 복사됨', '📋 복사');
    } catch (e) {
      console.warn(TAG, 'clipboard failed:', e);
      flash(btn, '✗ 실패', '📋 복사');
    }
  }

  private async onNotionClick(): Promise<void> {
    // 이미 저장됨 → 재저장(중복) 대신 페이지 열기.
    if (this.notionSaved) {
      if (this.notionPageUrl) window.open(this.notionPageUrl, '_blank', 'noopener');
      return;
    }
    if (!this.lastResult || !this.notionBtn) return;
    const { term, markdown, context } = this.lastResult;
    const btn = this.notionBtn;
    btn.disabled = true;
    btn.textContent = '저장 중…';
    let res: NotionSaveResult;
    try {
      res = await this.requestNotionSave(term, markdown, context);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    // 그 사이 패널이 닫혔으면 무시.
    if (this.notionBtn !== btn) return;
    if (res.ok) {
      this.notionSaved = true;
      this.notionPageUrl = res.url ?? null;
      btn.textContent = this.notionPageUrl ? '✓ 저장됨 ↗' : '✓ 저장됨';
      btn.disabled = false;
      btn.title = this.notionPageUrl ? 'Notion에서 열기' : '';
    } else {
      btn.textContent = '✗ 저장 실패';
      btn.disabled = false;
      btn.title = res.error;
      console.warn(TAG, 'notion save error:', res.error);
      // 잠시 후 다시 시도할 수 있게 원복.
      window.setTimeout(() => {
        if (this.notionBtn === btn && !this.notionSaved) {
          btn.textContent = '📝 Notion';
          btn.title = '';
        }
      }, 2500);
    }
  }

  private closePanel(): void {
    this.panel?.remove();
    this.panel = null;
    this.copyBtn = null;
    this.notionBtn = null;
    this.lastResult = null;
    this.notionSaved = false;
    this.notionPageUrl = null;
  }
}

// 버튼 라벨을 잠깐 바꿨다 원복(피드백용).
function flash(btn: HTMLButtonElement, temp: string, restore: string): void {
  btn.textContent = temp;
  window.setTimeout(() => {
    btn.textContent = restore;
  }, 1500);
}

function closestContainer(node: Node): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : node.parentElement;
  return el?.closest('.ydt-container') ?? null;
}
