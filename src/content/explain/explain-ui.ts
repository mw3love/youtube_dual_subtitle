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

import { renderMarkdown, domToMarkdown } from './markdown';

const TAG = '[YDT/explain]';

export type ExplainResult = { ok: true; markdown: string } | { ok: false; error: string };
export type NotionSaveResult = { ok: true; url?: string } | { ok: false; error: string };

export class ExplainUI {
  private enabled = true;
  private notionEnabled = false;
  // 선택 위에 뜨는 툴바(💡 해설 + ❓ 질문) — 둘 다 같은 pending 선택을 쓴다.
  private toolbar: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  // 버튼 클릭 시점에 넘길 선택 텍스트/문맥 — 선택이 사라져도 유지.
  private pending: { text: string; context: string } | null = null;
  // 질문 패널의 입력칸 + 그 패널이 다루는 선택(재질문 시 재사용).
  private qInput: HTMLTextAreaElement | null = null;
  private questionCtx: { text: string; context: string } | null = null;
  // 현재 패널에 표시 중인 해설 결과 — 복사/Notion 저장이 참조.
  private lastResult: { term: string; markdown: string; context: string } | null = null;
  // 패널 헤더 액션 버튼 — 결과 도착 시 활성화.
  private copyBtn: HTMLButtonElement | null = null;
  private notionBtn: HTMLButtonElement | null = null;
  // 형광펜(백틱) 모드 — 켜면 패널 본문에서 드래그한 부분이 백틱으로 감싸지고(코드 칩),
  // 칩을 클릭하면 해제. lastResult.markdown을 직접 수정하므로 복사/Notion에 그대로 반영.
  private highlightBtn: HTMLButtonElement | null = null;
  private highlightMode = false;
  // Notion 저장 상태 — 저장 후 버튼을 다시 누르면 재저장(중복) 대신 페이지를 연다.
  private notionSaved = false;
  private notionPageUrl: string | null = null;

  constructor(
    private readonly requestExplain: (text: string, context: string) => Promise<ExplainResult>,
    private readonly requestQuestion: (
      text: string,
      context: string,
      question: string,
    ) => Promise<ExplainResult>,
    private readonly requestNotionSave: (
      term: string,
      markdown: string,
      context: string,
    ) => Promise<NotionSaveResult>,
    // 로딩 메시지에 띄울 현재 해설 모델 이름 (content가 settings에서 계산해 넘김).
    private readonly modelLabel: () => string,
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
      this.hideToolbar();
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
    // 우리 툴바/패널 클릭으로 끝난 mouseup은 무시(선택 평가 안 함).
    const t = ev.target as HTMLElement | null;
    if (t && (t.closest('.ydt-explain-toolbar') || t.closest('.ydt-explain-panel'))) return;
    // 선택 평가는 다음 tick에 — mouseup 직후 selection이 확정됨.
    window.setTimeout(() => this.evaluateSelection(), 0);
  };

  private evaluateSelection(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.hideToolbar();
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      this.hideToolbar();
      return;
    }
    const range = sel.getRangeAt(0);
    const container = closestContainer(range.commonAncestorContainer);
    if (!container) {
      this.hideToolbar();
      return;
    }
    // 문맥 = 같은 자막 박스의 원문(영어) 줄 전체. 없으면 컨테이너 전체 텍스트.
    const sourceText = container.querySelector('.ydt-source .ydt-cue-text')?.textContent?.trim();
    const context = sourceText || container.textContent?.trim() || text;
    this.pending = { text, context };
    this.showToolbar(range.getBoundingClientRect());
  }

  private onSelectionChange = (): void => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) this.hideToolbar();
  };

  private onMouseDown = (ev: MouseEvent): void => {
    const t = ev.target as HTMLElement | null;
    if (t && (t.closest('.ydt-explain-toolbar') || t.closest('.ydt-explain-panel'))) return;
    // 새 클릭 시작 → 기존 툴바 숨김(패널은 명시적 닫기 전까지 유지).
    this.hideToolbar();
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
    if (this.toolbar && this.toolbar.parentElement !== h) h.appendChild(this.toolbar);
  };

  // ─── 트리거 툴바 ───
  private showToolbar(rect: DOMRect): void {
    if (!this.toolbar) {
      this.toolbar = document.createElement('div');
      this.toolbar.className = 'ydt-explain-toolbar';
      // mousedown 기본 동작(선택 collapse·포커스 이동)을 막아 click 직전에 선택이 사라지며
      // 버튼이 hide→click 미발화되는 것을 방지. 툴바-오버-선택의 표준 패턴.
      this.toolbar.addEventListener('mousedown', (e) => e.preventDefault());
      const explainBtn = document.createElement('button');
      explainBtn.className = 'ydt-explain-btn';
      explainBtn.type = 'button';
      explainBtn.textContent = '💡 해설';
      explainBtn.addEventListener('click', this.onExplainClick);
      const questionBtn = document.createElement('button');
      questionBtn.className = 'ydt-explain-btn';
      questionBtn.type = 'button';
      questionBtn.textContent = '❓ 질문';
      questionBtn.addEventListener('click', this.onQuestionClick);
      this.toolbar.appendChild(explainBtn);
      this.toolbar.appendChild(questionBtn);
    }
    const host = this.host();
    if (this.toolbar.parentElement !== host) host.appendChild(this.toolbar);
    // 선택 위에 배치, 화면 밖이면 아래로. 좌우는 뷰포트 안으로 clamp.
    const TB_W = 150; // 두 버튼 합 대략치 (clamp용)
    const TB_H = 30;
    let top = rect.top - TB_H - 6;
    if (top < 4) top = rect.bottom + 6;
    let left = rect.left + rect.width / 2 - TB_W / 2;
    left = Math.max(4, Math.min(window.innerWidth - TB_W - 4, left));
    this.toolbar.style.top = `${Math.round(top)}px`;
    this.toolbar.style.left = `${Math.round(left)}px`;
    this.toolbar.style.display = 'flex';
  }

  private hideToolbar(): void {
    if (this.toolbar) this.toolbar.style.display = 'none';
  }

  private onExplainClick = (ev: MouseEvent): void => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!this.pending) return;
    const { text, context } = this.pending;
    this.hideToolbar();
    this.openPanel(text, context, false);
    void this.runExplain(text, context);
  };

  // ❓ 질문: 패널을 열되 입력칸을 띄운다. 답은 입력칸 아래 본문에 렌더(입력칸은 남아 재질문 가능).
  private onQuestionClick = (ev: MouseEvent): void => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!this.pending) return;
    const { text, context } = this.pending;
    this.hideToolbar();
    this.openPanel(text, context, true);
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
  // question=true면 헤더 아래 입력칸(qform)을 띄우고 본문은 비워 둔다(답은 제출 시 채움).
  private openPanel(term: string, context: string, question: boolean): void {
    this.closePanel();
    this.lastResult = null;
    this.notionSaved = false;
    this.notionPageUrl = null;
    this.highlightMode = false;
    this.qInput = null;
    this.questionCtx = question ? { text: term, context } : null;
    const panel = document.createElement('div');
    panel.className = 'ydt-explain-panel';
    panel.dataset.term = term;
    // 형광펜 모드 동작 — 본문 드래그(mouseup)는 백틱 감싸기, 코드 칩 클릭은 해제.
    panel.addEventListener('mouseup', () => window.setTimeout(() => this.applyHighlight(), 0));
    panel.addEventListener('click', (e) => this.onPanelClick(e));

    const header = document.createElement('div');
    header.className = 'ydt-explain-header';
    const title = document.createElement('div');
    title.className = 'ydt-explain-term';
    title.textContent = term;

    const actions = document.createElement('div');
    actions.className = 'ydt-explain-actions';

    // ✏️ 형광펜(백틱) — 모드 토글. 결과 도착 전엔 비활성.
    this.highlightBtn = document.createElement('button');
    this.highlightBtn.className = 'ydt-explain-action';
    this.highlightBtn.type = 'button';
    this.highlightBtn.textContent = '✏️ 백틱';
    this.highlightBtn.disabled = true;
    this.highlightBtn.title = '드래그 후 누르면 그 부분을 백틱 표시. 선택 없이 누르면 모드 ON(이후 드래그마다 자동)';
    // mousedown 기본 동작(본문 선택 collapse)을 막아야 "드래그 후 버튼 클릭"에서 선택이 살아있음.
    this.highlightBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.highlightBtn.addEventListener('click', () => this.onHighlightClick());

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

    actions.appendChild(this.highlightBtn);
    actions.appendChild(this.copyBtn);
    actions.appendChild(this.notionBtn);
    actions.appendChild(close);
    header.appendChild(title);
    header.appendChild(actions);

    // 질문 모드: 헤더와 본문 사이에 입력칸. 비질문(해설) 모드: 바로 로딩.
    let qform: HTMLElement | null = null;
    if (question) {
      qform = document.createElement('div');
      qform.className = 'ydt-explain-qform';
      const input = document.createElement('textarea');
      input.className = 'ydt-explain-qinput';
      input.rows = 2;
      input.placeholder = '이 표현에 대해 물어보기… (예: 반대말 알려줘 / who 빼면 이상해?)';
      // Enter 전송, Shift+Enter 줄바꿈.
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.submitQuestion();
        }
      });
      const send = document.createElement('button');
      send.className = 'ydt-explain-qsend';
      send.type = 'button';
      send.textContent = '질문';
      send.addEventListener('click', () => this.submitQuestion());
      qform.appendChild(input);
      qform.appendChild(send);
      this.qInput = input;
    }

    const body = document.createElement('div');
    body.className = 'ydt-explain-body';
    if (question) {
      // 답 도착 전 안내. 제출 시 교체됨.
      const hint = document.createElement('div');
      hint.className = 'ydt-explain-loading';
      hint.append('질문을 입력하고 Enter(또는 "질문") 누르기.');
      body.appendChild(hint);
    } else {
      const loading = document.createElement('div');
      loading.className = 'ydt-explain-loading';
      loading.append('해설 생성 중…');
      // 어떤 AI 모델로 생성 중인지 한눈에 — 백엔드/모델 바꿔가며 비교할 때 유용.
      const label = this.modelLabel();
      if (label) {
        const m = document.createElement('span');
        m.className = 'ydt-explain-model';
        m.textContent = label;
        loading.append(' · ', m);
      }
      body.appendChild(loading);
    }

    panel.appendChild(header);
    if (qform) panel.appendChild(qform);
    panel.appendChild(body);
    this.host().appendChild(panel);
    this.panel = panel;
    this.qInput?.focus();
  }

  // 입력칸의 질문을 제출 — 답은 본문에 렌더(입력칸은 그대로 남아 재질문 가능).
  private submitQuestion(): void {
    if (!this.qInput || !this.questionCtx) return;
    const q = this.qInput.value.trim();
    if (!q) {
      this.qInput.focus();
      return;
    }
    void this.runQuestion(this.questionCtx.text, this.questionCtx.context, q);
  }

  private async runQuestion(text: string, context: string, question: string): Promise<void> {
    const body = this.panel?.querySelector('.ydt-explain-body');
    if (!body) return;
    body.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'ydt-explain-loading';
    loading.append('답변 생성 중…');
    const label = this.modelLabel();
    if (label) {
      const m = document.createElement('span');
      m.className = 'ydt-explain-model';
      m.textContent = label;
      loading.append(' · ', m);
    }
    body.appendChild(loading);
    this.enableActions(false);

    let res: ExplainResult;
    try {
      res = await this.requestQuestion(text, context, question);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!this.panel || this.panel.dataset.term !== text) return;
    const body2 = this.panel.querySelector('.ydt-explain-body');
    if (!body2) return;
    body2.textContent = '';
    if (res.ok) {
      // 질문을 답 위에 함께 렌더 → 패널에 Q/A가 같이 보이고, 복사/Notion에도 질문이 포함됨.
      const md = `**질문:** ${question}\n\n${res.markdown}`;
      body2.appendChild(renderMarkdown(md));
      this.lastResult = { term: text, markdown: md, context };
      this.enableActions(true);
    } else {
      const err = document.createElement('div');
      err.className = 'ydt-explain-error';
      err.textContent = `답변을 불러오지 못했어요: ${res.error}`;
      body2.appendChild(err);
      console.warn(TAG, 'question error:', res.error);
    }
  }

  private enableActions(enabled: boolean): void {
    if (this.copyBtn) this.copyBtn.disabled = !enabled;
    if (this.notionBtn) this.notionBtn.disabled = !enabled;
    if (this.highlightBtn) this.highlightBtn.disabled = !enabled;
  }

  // ─── 형광펜(백틱) 모드 ───
  // 버튼 클릭: 본문에 선택이 있으면 그 선택을 바로 감싼다(드래그 먼저 → 버튼 OK, 순서 무관).
  // 선택이 없으면 자동-감쌈 모드를 토글(켜진 동안 드래그마다 mouseup에서 자동 감쌈).
  private onHighlightClick(): void {
    const sel = window.getSelection();
    const body = this.panel?.querySelector('.ydt-explain-body');
    const hasBodySel =
      !!sel &&
      !sel.isCollapsed &&
      sel.rangeCount > 0 &&
      !!sel.toString().trim() &&
      !!body?.contains(sel.getRangeAt(0).commonAncestorContainer);
    if (hasBodySel) {
      this.toggleMarkSelection();
      // 선택을 처리한 뒤 모드를 켠 채로 유지 — 이후 드래그마다 자동 백틱(매번 버튼 안 눌러도 됨).
      if (!this.highlightMode) this.toggleHighlight();
    } else {
      this.toggleHighlight();
    }
  }

  private toggleHighlight(): void {
    this.highlightMode = !this.highlightMode;
    this.highlightBtn?.classList.toggle('active', this.highlightMode);
    this.panel?.querySelector('.ydt-explain-body')?.classList.toggle('highlighting', this.highlightMode);
  }

  // 자동-감쌈 모드일 때 본문 드래그(mouseup)에서 호출.
  private applyHighlight(): void {
    if (this.highlightMode) this.toggleMarkSelection();
  }

  // 현재 선택을 백틱(코드)으로 토글. DOM이 source of truth — 선택된 텍스트 노드마다 그 부분만
  // surroundContents로 <code class=ydt-user-mark>로 감싼다(노드 경계 걸침 회피). 선택 전체가
  // 이미 한 마크 안이면 해제. markdown은 내보낼 때 domToMarkdown으로 직렬화(섹션 14). 레퍼런스
  // (Chrome Annotation 프로젝트)의 검증된 방식 차용 — 옛 markdown 문자열 매칭의 드래그 불안정 해결.
  private toggleMarkSelection(): void {
    if (!this.panel) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const body = this.panel.querySelector('.ydt-explain-body') as HTMLElement | null;
    if (!body) return;
    const range = sel.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) return;
    const sm = closestUserMark(range.startContainer);
    if (sm && sm === closestUserMark(range.endContainer)) {
      unwrapMark(sm); // 선택이 이미 한 마크 안 → 해제
    } else {
      for (const node of textNodesInRange(body, range)) {
        if (node.parentElement?.closest('code')) continue; // 이미 코드(AI/내 표시) 안이면 skip
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : (node.nodeValue?.length ?? 0);
        if (start >= end) continue;
        const r = document.createRange();
        r.setStart(node, start);
        r.setEnd(node, end);
        const code = document.createElement('code');
        code.className = 'ydt-user-mark';
        try {
          r.surroundContents(code);
        } catch {
          /* 경계 걸치면 그 노드는 skip */
        }
      }
    }
    sel.removeAllRanges();
    this.markEdited();
  }

  // 빨간 칩(내가 표시한 백틱) 클릭 → 해제. AI 예문 백틱은 대상 아님.
  private onPanelClick(ev: MouseEvent): void {
    const t = ev.target as HTMLElement | null;
    const code = t?.closest('.ydt-explain-body code.ydt-user-mark') as HTMLElement | null;
    if (!code) return;
    unwrapMark(code);
    this.markEdited();
  }

  // 내보낼 markdown — 패널 DOM을 직렬화(사용자 표시 백틱 포함). 패널 없으면 원본 fallback.
  private currentMarkdown(): string {
    const body = this.panel?.querySelector('.ydt-explain-body') as HTMLElement | null;
    if (body) return domToMarkdown(body);
    return this.lastResult?.markdown ?? '';
  }

  // 본문이 수정되면(백틱 추가/해제) 이미 한 Notion 저장은 stale — 다시 저장할 수 있게 상태 원복.
  private markEdited(): void {
    if (!this.notionSaved) return;
    this.notionSaved = false;
    this.notionPageUrl = null;
    if (this.notionBtn) {
      this.notionBtn.textContent = '📝 Notion';
      this.notionBtn.title = '';
    }
  }

  private async onCopy(): Promise<void> {
    if (!this.lastResult || !this.copyBtn) return;
    const { term, context } = this.lastResult;
    const markdown = this.currentMarkdown();
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
    const { term, context } = this.lastResult;
    const markdown = this.currentMarkdown();
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
    this.highlightBtn = null;
    this.highlightMode = false;
    this.lastResult = null;
    this.notionSaved = false;
    this.notionPageUrl = null;
    this.qInput = null;
    this.questionCtx = null;
  }
}

// 버튼 라벨을 잠깐 바꿨다 원복(피드백용).
function flash(btn: HTMLButtonElement, temp: string, restore: string): void {
  btn.textContent = temp;
  window.setTimeout(() => {
    btn.textContent = restore;
  }, 1500);
}

// 노드가 속한 사용자 마크(code.ydt-user-mark) 찾기.
function closestUserMark(node: Node): HTMLElement | null {
  const el = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
  return el ? el.closest('code.ydt-user-mark') : null;
}

// 마크 해제 — code의 자식을 부모로 옮기고 code 제거 후 인접 텍스트 노드 병합.
function unwrapMark(code: HTMLElement): void {
  const p = code.parentNode;
  if (!p) return;
  while (code.firstChild) p.insertBefore(code.firstChild, code);
  p.removeChild(code);
  (p as Element).normalize?.();
}

// range와 겹치는 텍스트 노드들(부분 겹침 포함)을 순서대로 반환.
function textNodesInRange(root: HTMLElement, range: Range): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      const r = document.createRange();
      r.selectNodeContents(n);
      const hit =
        range.compareBoundaryPoints(Range.END_TO_START, r) < 0 &&
        range.compareBoundaryPoints(Range.START_TO_END, r) > 0;
      return hit ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const out: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

function closestContainer(node: Node): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : node.parentElement;
  return el?.closest('.ydt-container') ?? null;
}
