// 단어/표현 해설 UI — 자막 텍스트를 드래그 선택하면 작은 "해설/질문" 툴바가 뜨고,
// 클릭하면 AI 해설(markdown)을 사이드 패널에 렌더한다.
//
// 자막 컨테이너(.ydt-container) 안의 선택만 대상으로 한다(페이지 다른 텍스트는 무시). 선택은
// 이미 native로 동작함 — 렌더러의 pointerdown이 .ydt-cue-text 위에서 양보하기 때문(섹션 8).
// 여기서는 그 native 선택 결과(window.getSelection)를 mouseup 시점에 읽기만 한다.
//
// 버튼/패널은 document.fullscreenElement(전체화면 시 #movie_player) 또는 body에 붙인다 —
// fixed 요소가 전체화면에서도 보이도록 fullscreen 컨테이너 안에 둬야 하기 때문.
//
// 패널 헤더에는 해설을 외부로 보내는 액션: 📋 클립보드 복사(무설정 — markdown을 복사해 Notion에
// 붙여넣으면 자동 리치 변환), 📝 Notion 저장(BYOK — background가 Notion API로 DB에 페이지 생성),
// ✏️ 백틱(형광펜), – 최소화, ✕ 닫기.
//
// 탭(섹션 20): 새 해설/질문을 띄워도 기존 패널을 파괴하지 않고 탭으로 누적한다. 각 탭은 렌더된
// 본문 DOM·결과·Notion 저장 여부를 따로 들고, 전환은 contentEl show/hide로 한다. 상태는 메모리
// only — SPA 이동·영상 전환은 가로질러 살아남고, 전체 새로고침/탭 닫기에서만 초기화. ✕(또는 Esc)는
// 패널을 없애지 않고 최소화(💡 핸들)해 탭을 보존하고, 핸들 클릭으로 복원한다.

import { renderMarkdown, domToMarkdown } from './markdown';

const TAG = '[YDT/explain]';

export type ExplainResult = { ok: true; markdown: string } | { ok: false; error: string };
export type NotionSaveResult = { ok: true; url?: string } | { ok: false; error: string };

// 한 해설/질문 = 한 탭. 탭별 상태는 여기에 보관(전환은 contentEl 표시/숨김).
interface Tab {
  term: string; // 선택 표현 — 탭 라벨·헤더 제목·복사/Notion 제목
  context: string; // 자막 문맥(원문 줄) — 백엔드 disambiguation + 복사/저장 인용
  isQuestion: boolean; // ❓ 질문 탭이면 입력칸(qform)을 가짐
  contentEl: HTMLElement; // 탭 콘텐츠 wrapper([qform?] + body) — 활성 탭만 display
  bodyEl: HTMLElement; // .ydt-explain-body — 렌더된 답변 DOM(형광펜이 라이브로 보존됨)
  qInput: HTMLTextAreaElement | null; // 질문 탭의 입력칸(재질문 가능)
  result: { term: string; markdown: string; context: string } | null; // 도착한 답변(복사/Notion 참조)
  notionSaved: boolean;
  notionPageUrl: string | null;
}

export class ExplainUI {
  private enabled = true;
  private notionEnabled = false;
  // 선택 위에 뜨는 툴바(💡 해설 + ❓ 질문).
  private toolbar: HTMLElement | null = null;
  // 패널 셸(헤더 + 탭스트립 + 탭 콘텐츠 컨테이너) — 탭이 있는 동안 1개 유지·재사용.
  private panel: HTMLElement | null = null;
  // 최소화 시 뜨는 작은 핸들(💡 N) — 클릭하면 패널 복원. 탭은 메모리에 보존.
  private fab: HTMLElement | null = null;
  // 버튼 클릭 시점에 넘길 선택 텍스트/문맥 — 선택이 사라져도 유지.
  private pending: { text: string; context: string } | null = null;

  // ─── 탭 상태 ───
  private tabs: Tab[] = [];
  private active = -1; // 활성 탭 인덱스 (-1 = 탭 없음)
  private tabsContainer: HTMLElement | null = null; // contentEl들이 사는 영역

  // 패널 헤더 요소(활성 탭 기준으로 동작).
  private titleEl: HTMLElement | null = null;
  private tabstripEl: HTMLElement | null = null;
  private copyBtn: HTMLButtonElement | null = null;
  private notionBtn: HTMLButtonElement | null = null;
  private highlightBtn: HTMLButtonElement | null = null;
  // 형광펜(백틱) 모드 — 활성 탭 본문 대상. 탭 전환 시 off로 리셋.
  private highlightMode = false;

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

  private activeTab(): Tab | null {
    return this.active >= 0 && this.active < this.tabs.length ? this.tabs[this.active] : null;
  }

  // ─── 선택 감지 ───
  private onMouseUp = (ev: MouseEvent): void => {
    if (!this.enabled) return;
    // 우리 툴바/패널/핸들 클릭으로 끝난 mouseup은 무시(선택 평가 안 함).
    const t = ev.target as HTMLElement | null;
    if (
      t &&
      (t.closest('.ydt-explain-toolbar') ||
        t.closest('.ydt-explain-panel') ||
        t.closest('.ydt-explain-fab'))
    )
      return;
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
    if (
      t &&
      (t.closest('.ydt-explain-toolbar') ||
        t.closest('.ydt-explain-panel') ||
        t.closest('.ydt-explain-fab'))
    )
      return;
    // 새 클릭 시작 → 기존 툴바 숨김(패널은 명시적 닫기/최소화 전까지 유지).
    this.hideToolbar();
  };

  private onKeyDown = (ev: KeyboardEvent): void => {
    // Esc는 패널을 닫지 않고 최소화 — 탭을 보존하고, 전체화면 Esc 탈출과도 충돌 안 함.
    if (ev.key === 'Escape' && this.panel && this.panel.style.display !== 'none') {
      ev.stopPropagation();
      this.minimize();
    }
  };

  private onFullscreenChange = (): void => {
    // 전체화면 진입/이탈 시 부모가 바뀌므로 떠 있는 패널/툴바/핸들을 새 host로 옮긴다.
    const h = this.host();
    if (this.panel && this.panel.parentElement !== h) h.appendChild(this.panel);
    if (this.toolbar && this.toolbar.parentElement !== h) h.appendChild(this.toolbar);
    if (this.fab && this.fab.parentElement !== h) h.appendChild(this.fab);
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
    const tab = this.openTab(text, context, false);
    void this.runExplain(tab, text, context);
  };

  // ❓ 질문: 탭을 열되 입력칸을 띄운다. 답은 입력칸 아래 본문에 렌더(입력칸은 남아 재질문 가능).
  private onQuestionClick = (ev: MouseEvent): void => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!this.pending) return;
    const { text, context } = this.pending;
    this.hideToolbar();
    this.openTab(text, context, true);
  };

  // ─── 패널 셸 ───
  // 헤더(제목·액션·최소화·닫기) + 탭스트립 + 탭 콘텐츠 컨테이너를 1회 생성. 이후 탭은 여기 누적.
  private ensureShell(): void {
    if (this.panel) return;
    const panel = document.createElement('div');
    panel.className = 'ydt-explain-panel';

    const header = document.createElement('div');
    header.className = 'ydt-explain-header';
    const title = document.createElement('div');
    title.className = 'ydt-explain-term';
    this.titleEl = title;

    const actions = document.createElement('div');
    actions.className = 'ydt-explain-actions';

    // ✏️ 형광펜(백틱) — 모드 토글. 결과 도착 전엔 비활성.
    this.highlightBtn = document.createElement('button');
    this.highlightBtn.className = 'ydt-explain-action';
    this.highlightBtn.type = 'button';
    this.highlightBtn.textContent = '✏️ 백틱';
    this.highlightBtn.disabled = true;
    this.highlightBtn.title =
      '드래그 후 누르면 그 부분을 백틱 표시. 선택 없이 누르면 모드 ON(이후 드래그마다 자동)';
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
    this.notionBtn.addEventListener('click', () => void this.onNotionClick());

    // – 최소화: 패널을 접어 💡 핸들로(탭 보존). ✕ 닫기: 패널·모든 탭 제거.
    const min = document.createElement('button');
    min.className = 'ydt-explain-close';
    min.type = 'button';
    min.textContent = '–';
    min.title = '최소화 (탭 유지)';
    min.addEventListener('click', () => this.minimize());

    const close = document.createElement('button');
    close.className = 'ydt-explain-close';
    close.type = 'button';
    close.textContent = '✕';
    close.title = '패널 닫기 (모든 탭)';
    close.addEventListener('click', () => this.closePanel());

    actions.append(this.highlightBtn, this.copyBtn, this.notionBtn, min, close);
    header.append(title, actions);

    // 탭스트립 — 탭 2개 이상일 때만 표시(renderTabstrip이 hidden 토글).
    const tabstrip = document.createElement('div');
    tabstrip.className = 'ydt-explain-tabs';
    tabstrip.hidden = true;
    this.tabstripEl = tabstrip;

    const tabsContainer = document.createElement('div');
    tabsContainer.className = 'ydt-explain-tabsbody';
    this.tabsContainer = tabsContainer;

    panel.append(header, tabstrip, tabsContainer);
    this.host().appendChild(panel);
    this.panel = panel;
  }

  // 로딩/모델 라벨 한 줄 생성(해설·질문 공용).
  private loadingEl(text: string): HTMLElement {
    const loading = document.createElement('div');
    loading.className = 'ydt-explain-loading';
    loading.append(text);
    // 어떤 AI 모델로 생성 중인지 한눈에 — 백엔드/모델 바꿔가며 비교할 때 유용.
    const label = this.modelLabel();
    if (label) {
      const m = document.createElement('span');
      m.className = 'ydt-explain-model';
      m.textContent = label;
      loading.append(' · ', m);
    }
    return loading;
  }

  // ─── 탭 ───
  // 새 탭을 만들어 활성화. question=true면 입력칸(qform)을 본문 위에 둔다(섹션 19).
  private openTab(term: string, context: string, question: boolean): Tab {
    this.ensureShell();
    this.restore(); // 최소화돼 있었으면 펼침

    const contentEl = document.createElement('div');
    contentEl.className = 'ydt-explain-tabcontent';
    // 본문 형광펜 동작 — 드래그(mouseup) 백틱 감싸기, 코드 칩 클릭 해제. 탭별로 부착(활성 탭만 보임).
    contentEl.addEventListener('mouseup', () => window.setTimeout(() => this.applyHighlight(), 0));
    contentEl.addEventListener('click', (e) => this.onPanelClick(e));

    let qInput: HTMLTextAreaElement | null = null;
    if (question) {
      const qform = document.createElement('div');
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
      contentEl.appendChild(qform);
      qInput = input;
    }

    const body = document.createElement('div');
    body.className = 'ydt-explain-body';
    if (question) {
      const hint = document.createElement('div');
      hint.className = 'ydt-explain-loading';
      hint.append('질문을 입력하고 Enter(또는 "질문") 누르기.');
      body.appendChild(hint);
    } else {
      body.appendChild(this.loadingEl('해설 생성 중…'));
    }
    contentEl.appendChild(body);

    const tab: Tab = {
      term,
      context,
      isQuestion: question,
      contentEl,
      bodyEl: body,
      qInput,
      result: null,
      notionSaved: false,
      notionPageUrl: null,
    };
    this.tabsContainer!.appendChild(contentEl);
    this.tabs.push(tab);
    this.activateTab(this.tabs.length - 1);
    return tab;
  }

  private activateTab(i: number): void {
    if (i < 0 || i >= this.tabs.length) return;
    this.active = i;
    this.tabs.forEach((t, j) => {
      t.contentEl.style.display = j === i ? 'flex' : 'none';
    });
    const tab = this.tabs[i];
    if (this.titleEl) this.titleEl.textContent = tab.term;
    // 형광펜 모드는 탭마다 독립 — 전환 시 off.
    this.highlightMode = false;
    this.highlightBtn?.classList.remove('active');
    this.tabs.forEach((t) => t.bodyEl.classList.remove('highlighting'));
    this.refreshActions();
    this.renderTabstrip();
    tab.qInput?.focus();
  }

  // 닫은 탭이 마지막이면 패널 전체 닫기. 아니면 인덱스 보정 후 이웃 탭 활성화.
  private closeTab(i: number): void {
    if (i < 0 || i >= this.tabs.length) return;
    this.tabs[i].contentEl.remove();
    this.tabs.splice(i, 1);
    if (this.tabs.length === 0) {
      this.closePanel();
      return;
    }
    let next = this.active;
    if (i < this.active) next = this.active - 1;
    else if (i === this.active) next = Math.min(this.active, this.tabs.length - 1);
    this.activateTab(next);
  }

  private renderTabstrip(): void {
    const strip = this.tabstripEl;
    if (!strip) return;
    if (this.tabs.length < 2) {
      strip.hidden = true;
      strip.replaceChildren();
      return;
    }
    strip.hidden = false;
    strip.replaceChildren();
    this.tabs.forEach((t, i) => {
      const chip = document.createElement('div');
      chip.className = 'ydt-explain-tab' + (i === this.active ? ' active' : '');
      const label = document.createElement('span');
      label.className = 'ydt-explain-tab-label';
      label.textContent = (t.isQuestion ? '❓ ' : '') + t.term;
      label.addEventListener('click', () => this.activateTab(i));
      const close = document.createElement('button');
      close.className = 'ydt-explain-tab-close';
      close.type = 'button';
      close.textContent = '✕';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(i);
      });
      chip.append(label, close);
      strip.appendChild(chip);
    });
  }

  // 활성 탭 상태(결과 유무·Notion 저장 여부)를 헤더 버튼에 반영.
  private refreshActions(): void {
    const tab = this.activeTab();
    const has = !!tab?.result;
    if (this.copyBtn) this.copyBtn.disabled = !has;
    if (this.highlightBtn) this.highlightBtn.disabled = !has;
    if (this.notionBtn) {
      this.notionBtn.style.display = this.notionEnabled ? '' : 'none';
      this.notionBtn.disabled = !has;
      if (tab?.notionSaved) {
        this.notionBtn.textContent = tab.notionPageUrl ? '✓ 저장됨 ↗' : '✓ 저장됨';
        this.notionBtn.title = tab.notionPageUrl ? 'Notion에서 열기' : '';
      } else {
        this.notionBtn.textContent = '📝 Notion';
        this.notionBtn.title = '';
      }
    }
  }

  // 로딩 중 액션 비활성(활성 탭일 때만 — 다른 탭 보고 있으면 그 탭 버튼은 건드리지 않음).
  private setActionsBusy(): void {
    if (this.copyBtn) this.copyBtn.disabled = true;
    if (this.notionBtn) this.notionBtn.disabled = true;
    if (this.highlightBtn) this.highlightBtn.disabled = true;
  }

  // ─── 최소화 / 복원 / 닫기 ───
  private minimize(): void {
    if (!this.panel) return;
    this.panel.style.display = 'none';
    this.ensureFab();
    if (this.fab) {
      this.fab.style.display = 'flex';
      this.fab.textContent = `💡 ${this.tabs.length}`;
    }
  }

  private ensureFab(): void {
    if (this.fab) {
      if (this.fab.parentElement !== this.host()) this.host().appendChild(this.fab);
      return;
    }
    const fab = document.createElement('div');
    fab.className = 'ydt-explain-fab';
    fab.title = '해설 패널 펼치기';
    fab.addEventListener('click', () => this.restore());
    this.fab = fab;
    this.host().appendChild(fab);
  }

  private restore(): void {
    if (this.fab) this.fab.style.display = 'none';
    if (this.panel) {
      this.panel.style.display = 'flex';
      if (this.panel.parentElement !== this.host()) this.host().appendChild(this.panel);
    }
  }

  private closePanel(): void {
    this.panel?.remove();
    this.fab?.remove();
    this.panel = null;
    this.fab = null;
    this.tabs = [];
    this.active = -1;
    this.tabsContainer = null;
    this.titleEl = null;
    this.tabstripEl = null;
    this.copyBtn = null;
    this.notionBtn = null;
    this.highlightBtn = null;
    this.highlightMode = false;
  }

  // ─── 해설/질문 실행 ───
  private async runExplain(tab: Tab, text: string, context: string): Promise<void> {
    let res: ExplainResult;
    try {
      res = await this.requestExplain(text, context);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    // 그 사이 탭이 닫혔으면 무시(탭은 비활성이어도 살아있으면 채운다).
    if (!this.tabs.includes(tab)) return;
    const body = tab.bodyEl;
    body.textContent = '';
    if (res.ok) {
      body.appendChild(renderMarkdown(res.markdown));
      tab.result = { term: text, markdown: res.markdown, context };
      if (this.activeTab() === tab) this.refreshActions();
    } else {
      const err = document.createElement('div');
      err.className = 'ydt-explain-error';
      err.textContent = `해설을 불러오지 못했어요: ${res.error}`;
      body.appendChild(err);
      console.warn(TAG, 'explain error:', res.error);
    }
  }

  // 활성 탭의 질문을 제출 — 답은 본문에 렌더(입력칸은 그대로 남아 재질문 가능).
  private submitQuestion(): void {
    const tab = this.activeTab();
    if (!tab || !tab.qInput) return;
    const q = tab.qInput.value.trim();
    if (!q) {
      tab.qInput.focus();
      return;
    }
    void this.runQuestion(tab, tab.term, tab.context, q);
  }

  private async runQuestion(
    tab: Tab,
    text: string,
    context: string,
    question: string,
  ): Promise<void> {
    const body = tab.bodyEl;
    body.textContent = '';
    body.appendChild(this.loadingEl('답변 생성 중…'));
    if (this.activeTab() === tab) this.setActionsBusy();

    let res: ExplainResult;
    try {
      res = await this.requestQuestion(text, context, question);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!this.tabs.includes(tab)) return;
    body.textContent = '';
    if (res.ok) {
      // 질문을 답 위에 함께 렌더 → 패널에 Q/A가 같이 보이고, 복사/Notion에도 질문이 포함됨.
      const md = `**질문:** ${question}\n\n${res.markdown}`;
      body.appendChild(renderMarkdown(md));
      tab.result = { term: text, markdown: md, context };
      if (this.activeTab() === tab) this.refreshActions();
    } else {
      const err = document.createElement('div');
      err.className = 'ydt-explain-error';
      err.textContent = `답변을 불러오지 못했어요: ${res.error}`;
      body.appendChild(err);
      // 에러 시 액션은 비활성 유지(setActionsBusy 상태 그대로) — 본문이 에러라 복사/저장 대상 없음.
      // 해설 에러 경로와 동일. refreshActions를 부르면 옛 result로 버튼이 켜져 에러 텍스트를 복사하게 됨.
      console.warn(TAG, 'question error:', res.error);
    }
  }

  // ─── 형광펜(백틱) 모드 ───
  // 버튼 클릭: 본문에 선택이 있으면 그 선택을 바로 감싼다(드래그 먼저 → 버튼 OK, 순서 무관).
  // 선택이 없으면 자동-감쌈 모드를 토글(켜진 동안 드래그마다 mouseup에서 자동 감쌈).
  private onHighlightClick(): void {
    const tab = this.activeTab();
    if (!tab) return;
    const sel = window.getSelection();
    const body = tab.bodyEl;
    const hasBodySel =
      !!sel &&
      !sel.isCollapsed &&
      sel.rangeCount > 0 &&
      !!sel.toString().trim() &&
      body.contains(sel.getRangeAt(0).commonAncestorContainer);
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
    this.activeTab()?.bodyEl.classList.toggle('highlighting', this.highlightMode);
  }

  // 자동-감쌈 모드일 때 본문 드래그(mouseup)에서 호출.
  private applyHighlight(): void {
    if (this.highlightMode) this.toggleMarkSelection();
  }

  // 현재 선택을 백틱(코드)으로 토글. DOM이 source of truth — 선택된 텍스트 노드마다 그 부분만
  // surroundContents로 <code class=ydt-user-mark>로 감싼다(노드 경계 걸침 회피). 선택 전체가
  // 이미 한 마크 안이면 해제. markdown은 내보낼 때 domToMarkdown으로 직렬화(섹션 17). 레퍼런스
  // (Chrome Annotation 프로젝트)의 검증된 방식 차용 — 옛 markdown 문자열 매칭의 드래그 불안정 해결.
  private toggleMarkSelection(): void {
    const tab = this.activeTab();
    if (!tab) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const body = tab.bodyEl;
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

  // 내보낼 markdown — 활성 탭 본문 DOM을 직렬화(사용자 표시 백틱 포함).
  private currentMarkdown(): string {
    const tab = this.activeTab();
    return tab ? domToMarkdown(tab.bodyEl) : '';
  }

  // 본문이 수정되면(백틱 추가/해제) 이미 한 Notion 저장은 stale — 다시 저장할 수 있게 상태 원복.
  private markEdited(): void {
    const tab = this.activeTab();
    if (!tab || !tab.notionSaved) return;
    tab.notionSaved = false;
    tab.notionPageUrl = null;
    if (this.notionBtn) {
      this.notionBtn.textContent = '📝 Notion';
      this.notionBtn.title = '';
    }
  }

  private async onCopy(): Promise<void> {
    const tab = this.activeTab();
    if (!tab?.result || !this.copyBtn) return;
    const { term, context } = tab.result;
    const markdown = this.currentMarkdown();
    // 제목은 Notion과 동일하게 "예문"(자막 문장) 우선 → degenerate면 AI 첫 백틱 → 단어.
    const title = pickTitle(term, context, markdown);
    const parts = [`## ${title}`, '', markdown];
    if (context && context.trim() !== term.trim() && context.trim() !== title.trim())
      parts.push('', `> 자막: ${context}`);
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
    const tab = this.activeTab();
    if (!tab) return;
    // 이미 저장됨 → 재저장(중복) 대신 페이지 열기.
    if (tab.notionSaved) {
      if (tab.notionPageUrl) window.open(tab.notionPageUrl, '_blank', 'noopener');
      return;
    }
    if (!tab.result || !this.notionBtn) return;
    const { term, context } = tab.result;
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
    // 그 사이 탭이 닫혔으면 무시. 살아있으면 결과는 탭에 저장하고, 활성 탭일 때만 버튼 갱신.
    if (!this.tabs.includes(tab)) return;
    if (res.ok) {
      tab.notionSaved = true;
      tab.notionPageUrl = res.url ?? null;
      if (this.activeTab() === tab) {
        btn.textContent = tab.notionPageUrl ? '✓ 저장됨 ↗' : '✓ 저장됨';
        btn.disabled = false;
        btn.title = tab.notionPageUrl ? 'Notion에서 열기' : '';
      }
    } else {
      console.warn(TAG, 'notion save error:', res.error);
      if (this.activeTab() === tab) {
        btn.textContent = '✗ 저장 실패';
        btn.disabled = false;
        btn.title = res.error;
        // 잠시 후 다시 시도할 수 있게 원복.
        window.setTimeout(() => {
          if (this.activeTab() === tab && !tab.notionSaved) {
            btn.textContent = '📝 Notion';
            btn.title = '';
          }
        }, 2500);
      }
    }
  }
}

// 복사/Notion 제목 — 단어보다 "예문"이 복습에 유용. ① 자막 문장(context)이 의미있으면 그걸,
// ② degenerate면 답변의 첫 인라인 백틱 예문, ③ 없으면 단어. background/notion.ts:pickNotionTitle과
// 같은 로직의 평행 구현(content/background 분리 — 섹션 15의 markdown 평행 구현과 동일 사유).
function pickTitle(term: string, context: string | undefined, markdown: string): string {
  const t = term.trim();
  const ctx = (context ?? '').trim();
  if (ctx && ctx.toLowerCase() !== t.toLowerCase() && ctx.length > t.length) return ctx;
  const example = markdown.match(/`([^`\n]+)`/)?.[1]?.trim();
  if (example) return example;
  return t || '(제목 없음)';
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
