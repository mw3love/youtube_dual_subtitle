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
import type { ChatTurn } from '../../shared/types';

const TAG = '[YDT/explain]';

// userMessage: background가 실제로 보낸 user 메시지 — 대화 기록(turns)에 넣어 후속 질문의 history로 재전송.
export type ExplainResult =
  | { ok: true; markdown: string; userMessage?: string }
  | { ok: false; error: string };
// pageId/dbId는 다음 재저장 때 옛 페이지를 휴지통으로 보내기 위해 탭에 보관한다.
// oldKept = 재저장인데 옛 페이지를 못 치웠음(권한 부족·수동 삭제·DB 변경) → 알림 줄에 표기.
export type NotionSaveResult =
  | { ok: true; url?: string; title?: string; pageId?: string; dbId?: string; oldKept?: boolean }
  | { ok: false; error: string };

// 한 해설/질문 = 한 탭. 탭별 상태는 여기에 보관(전환은 contentEl 표시/숨김).
interface Tab {
  term: string; // 선택 표현 — 탭 라벨·헤더 제목·복사/Notion 제목
  context: string; // 자막 문맥(원문 줄) — 백엔드 disambiguation + 복사/저장 인용
  isQuestion: boolean; // ❓ 질문/직접질문 탭이면 답이 오기 전 안내 문구를 본문에 둔다
  isAsk: boolean; // 자막 선택 없이 Alt+Q로 연 "직접 질문" 탭 — 백엔드에 선택 텍스트 미전송
  isFollowup: boolean; // 다른 탭의 답에서 "이어서 질문"으로 파생된 탭 — 라벨에 ↳ 표시
  contentEl: HTMLElement; // 탭 콘텐츠 wrapper(= body) — 활성 탭만 display
  bodyEl: HTMLElement; // .ydt-explain-body — 렌더된 답변 DOM(형광펜이 라이브로 보존됨)
  turns: ChatTurn[]; // 이 탭의 누적 대화(멀티턴). 후속 질문 시 새 탭이 복사해 상속 → 문맥 유지.
  result: { term: string; markdown: string; context: string } | null; // 도착한 답변(복사/Notion 참조)
  notionSaved: boolean; // 지금 본문 그대로 저장돼 있나 (형광펜을 고치면 false — markEdited)
  notionPageUrl: string | null;
  notionTitle: string | null; // Notion에 실제 저장된 제목 — 저장 후 알림 줄에 표시 + 재저장 시 재사용
  // 아래 둘은 markEdited가 지우지 않는다 — 재저장 시 옛 페이지를 휴지통으로 보낼 실마리.
  notionPageId: string | null;
  notionDbId: string | null; // 저장 당시 DB id. 지금 DB와 다르면 옛 페이지를 안 건드린다.
  notionOldKept: boolean; // 마지막 재저장에서 옛 페이지가 남았나 — 알림 줄 표기용
}

export class ExplainUI {
  private enabled = true;
  private notionEnabled = false;
  // 선택 위에 뜨는 툴바(🖍 형광펜 + 💡 해설 + ❓ 질문). 형광펜은 해설 본문 선택일 때만 표시.
  private toolbar: HTMLElement | null = null;
  private hlToolbarBtn: HTMLButtonElement | null = null; // 툴바의 🖍 형광펜(본문 선택 시에만 표시)
  // mousedown 시작 좌표 — mouseup에서 이동거리로 "드래그 선택 vs 제자리 클릭"을 구분(툴바 재표시 판단).
  private downX = 0;
  private downY = 0;
  // 패널 셸(헤더 + 탭스트립 + 탭 콘텐츠 컨테이너) — 탭이 있는 동안 1개 유지·재사용.
  private panel: HTMLElement | null = null;
  // 최소화 시 뜨는 작은 핸들(💡 N) — 클릭하면 패널 복원. 탭은 메모리에 보존.
  private fab: HTMLElement | null = null;
  // 패널·미니버튼이 공유하는 위치(뷰포트 기준 px, 좌상단 기준). 둘 중 어느 쪽을 끌든
  // 갱신돼, 접으면 그 자리에 미니버튼·펼치면 그 자리에 패널이 뜬다. 메모리 only —
  // 영상 전환·전체화면 가로질러 유지, F5/✕(닫기)로 초기화. null이면 CSS 기본값.
  private panelPos: { left: number; top: number } | null = null;
  // 버튼 클릭 시점에 넘길 선택 텍스트/문맥 — 선택이 사라져도 유지.
  private pending: { text: string; context: string } | null = null;

  // ─── 탭 상태 ───
  private tabs: Tab[] = [];
  private active = -1; // 활성 탭 인덱스 (-1 = 탭 없음)
  private tabsContainer: HTMLElement | null = null; // contentEl들이 사는 영역

  // 패널 헤더 요소(활성 탭 기준으로 동작).
  private titleEl: HTMLElement | null = null;
  private noticeEl: HTMLElement | null = null; // Notion 저장 결과 알림 줄(헤더 아래)
  private tabstripEl: HTMLElement | null = null;
  private chatInput: HTMLTextAreaElement | null = null; // 맨 아래 "이어서 질문" 입력창(패널 공용, 활성 탭 대상)
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
      history: ChatTurn[],
      isAsk: boolean,
    ) => Promise<ExplainResult>,
    private readonly requestNotionSave: (
      term: string,
      markdown: string,
      context: string,
      // 이미 저장한 탭을 다시 저장할 때 — 새 페이지를 만든 뒤 이 페이지를 휴지통으로.
      prev?: { pageId: string; dbId: string; title: string },
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
    const t = ev.target as HTMLElement | null;
    // 툴바/핸들 클릭으로 끝난 mouseup은 무시.
    if (t && (t.closest('.ydt-explain-toolbar') || t.closest('.ydt-explain-fab'))) return;
    // 패널 안이라도 **본문(.ydt-explain-body)** 선택은 "그 표현 다시 해설/질문"용으로 평가한다.
    // 본문 외 패널 영역(헤더·질문 입력칸 등) 선택은 무시.
    const inBody = !!t && !!t.closest('.ydt-explain-body');
    if (t && t.closest('.ydt-explain-panel') && !inBody) return;
    // 형광펜 모드면 본문 드래그는 마킹용 mouseup이라 툴바 평가 skip(applyHighlight가 처리).
    if (inBody && this.highlightMode) return;
    // 제자리 클릭(드래그 아님·더블클릭 아님)이면 툴바를 띄우지 않고 닫는다 — 드래그로 남은 선택이
    // 클릭으로 collapse되지 않을 때(어떤 핸들러가 mousedown 기본동작을 막은 경우) stale 선택의 rect로
    // 툴바가 엉뚱한 위치에 다시 뜨는 것 방지. 더블클릭(detail≥2) 단어선택은 이동 없어도 허용.
    const moved = Math.hypot(ev.clientX - this.downX, ev.clientY - this.downY);
    if (moved < 4 && ev.detail < 2) {
      this.hideToolbar();
      return;
    }
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
    const node = range.commonAncestorContainer;
    // 1) 자막 박스(.ydt-container) 안 선택 — 문맥 = 원문(영어) 줄 전체. 없으면 컨테이너 전체 텍스트.
    const container = closestContainer(node);
    if (container) {
      const sourceText = container.querySelector('.ydt-source .ydt-cue-text')?.textContent?.trim();
      const context = sourceText || container.textContent?.trim() || text;
      this.pending = { text, context };
      // 자막 선택 — 형광펜 대상 아님(마킹은 해설 답변 본문에만). 해설/질문만.
      this.showToolbar(range.getBoundingClientRect(), false);
      return;
    }
    // 2) 해설 본문 안 선택 — 그 표현을 새 탭에서 다시 해설/질문. 문맥 = 선택이 든 블록 텍스트.
    const body = closestExplainBody(node);
    if (body) {
      const block = closestBlock(node, body);
      const context = (block?.textContent || body.textContent || text).trim();
      this.pending = { text, context };
      // 답변이 도착한 탭이면 형광펜도 노출(로딩/에러 텍스트엔 마킹 무의미 — 헤더 버튼 게이트와 동일).
      this.showToolbar(range.getBoundingClientRect(), !!this.activeTab()?.result);
      return;
    }
    this.hideToolbar();
  }

  private onSelectionChange = (): void => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) this.hideToolbar();
  };

  private onMouseDown = (ev: MouseEvent): void => {
    // 이동거리 측정 기준점 — mouseup에서 드래그/클릭 판별에 사용.
    this.downX = ev.clientX;
    this.downY = ev.clientY;
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
      return;
    }

    // Shift+백틱(~) — 헤더 ✏️ 백틱 버튼과 동일 토글. 본문에 선택이 있으면 그 선택을 마킹(+모드 ON),
    // 없으면 형광펜 모드 자체를 on/off. 물리 키 Backquote 기준(IME/레이아웃 무관, CLAUDE.md 섹션 10
    // 패턴) + ev.key === '~' 폴백. 패널이 떠 있고 활성 탭에 답이 있을 때만(버튼 disabled 조건과 동일).
    if ((ev.code === 'Backquote' && ev.shiftKey) || ev.key === '~') {
      // 질문 입력칸/검색창 등에 포커스 중이면 ~ 입력을 보호(가로채지 않음).
      const el = ev.target as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return;
      if (!this.panel || this.panel.style.display === 'none') return;
      if (!this.activeTab()?.result) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.onHighlightClick();
    }
  };

  private onFullscreenChange = (): void => {
    // 전체화면 진입/이탈 시 부모가 바뀌므로 떠 있는 패널/툴바/핸들을 새 host로 옮긴다.
    const h = this.host();
    if (this.panel && this.panel.parentElement !== h) h.appendChild(this.panel);
    if (this.toolbar && this.toolbar.parentElement !== h) h.appendChild(this.toolbar);
    if (this.fab && this.fab.parentElement !== h) h.appendChild(this.fab);
    // 뷰포트 크기가 바뀌므로 보이는 쪽 위치를 새 크기로 재클램프(화면 밖 이탈 방지).
    if (this.fab && this.fab.style.display !== 'none') this.applyPos(this.fab);
    else if (this.panel && this.panel.style.display !== 'none') this.applyPos(this.panel);
  };

  // ─── 트리거 툴바 ───
  // canHighlight=true(해설 답변 본문 선택)면 맨 앞에 🖍 형광펜을 노출. 위치는 선택(드래그) 위
  // 중앙 정렬(형광펜 유무와 무관 — 버튼 수에 따라 폭이 달라 실측 후 중앙 배치).
  private showToolbar(rect: DOMRect, canHighlight: boolean): void {
    if (!this.toolbar) {
      this.toolbar = document.createElement('div');
      this.toolbar.className = 'ydt-explain-toolbar';
      // mousedown 기본 동작(선택 collapse·포커스 이동)을 막아 click 직전에 선택이 사라지며
      // 버튼이 hide→click 미발화되는 것을 방지. 툴바-오버-선택의 표준 패턴.
      this.toolbar.addEventListener('mousedown', (e) => e.preventDefault());
      // 🖍 형광펜 — 맨 앞(형광펜·해설·질문 순). 클릭 시 그 선택을 마킹하고 형광펜 모드 ON(유지).
      // 본문 선택일 때만 display로 노출. 이모지 뒤 U+FE0F는 컬러 표현 강제(크레용 기본 흑백 회피).
      const hlBtn = document.createElement('button');
      hlBtn.className = 'ydt-explain-btn';
      hlBtn.type = 'button';
      hlBtn.textContent = '🖍️ 형광펜';
      hlBtn.addEventListener('click', this.onToolbarHighlightClick);
      this.hlToolbarBtn = hlBtn;
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
      this.toolbar.append(hlBtn, explainBtn, questionBtn);
    }
    if (this.hlToolbarBtn) this.hlToolbarBtn.style.display = canHighlight ? '' : 'none';
    const host = this.host();
    if (this.toolbar.parentElement !== host) host.appendChild(this.toolbar);
    // 먼저 표시해 실제 폭을 측정(버튼 수에 따라 폭이 달라 중앙 정렬에 필요). 계산 중엔 안 보이게.
    this.toolbar.style.visibility = 'hidden';
    this.toolbar.style.display = 'flex';
    const TB_W = this.toolbar.offsetWidth || 150;
    const TB_H = this.toolbar.offsetHeight || 30;
    // 선택(드래그) 위에 중앙 정렬. 위 여백이 없으면 아래로. 좌우는 뷰포트 안으로 clamp.
    let top = rect.top - TB_H - 6;
    if (top < 4) top = rect.bottom + 6;
    let left = rect.left + rect.width / 2 - TB_W / 2;
    left = Math.max(4, Math.min(window.innerWidth - TB_W - 4, left));
    this.toolbar.style.top = `${Math.round(top)}px`;
    this.toolbar.style.left = `${Math.round(left)}px`;
    this.toolbar.style.visibility = 'visible';
  }

  // public — 자막 cue가 바뀌면 content가 호출(렌더러 onCueChange). 드래그로 띄운 툴바는
  // 그 선택이 가리키던 자막이 넘어가면 stale이므로 닫는다.
  hideToolbar(): void {
    if (this.toolbar) this.toolbar.style.display = 'none';
  }

  // public — Alt+Q(content/index.ts)가 호출. 자막 선택 없이 빈 질문 탭을 열어 곧장 입력칸에
  // 포커스(자막에 안 뜨는 표현을 따로 물어보기 — 별도 AI 사전 대체). 해설 꺼져 있으면 무시.
  // term='직접 질문'은 표시 라벨일 뿐, isAsk=true라 백엔드엔 선택 텍스트를 안 보낸다(제출 시 라벨은 질문으로 교체).
  openAsk(): void {
    if (!this.enabled) return;
    this.openTab('직접 질문', '', true, true);
    // 새 질문은 빈 입력창으로 시작 — 입력창은 패널 공용(§28)이라 이전 탭의 미제출 초안이
    // 남는데, 새로 물으려고 연 탭엔 잔여 텍스트가 혼란스러워 비운다(탭 전환 시 draft 공유는 유지).
    if (this.chatInput) this.chatInput.value = '';
    // Alt+Q(chrome.commands)/팝업 버튼으로 열릴 땐 패널을 방금 표시·재배치한 직후라
    // 동기 focus()가 씹힌다(레이아웃 전·문서 포커스 복귀 전). 다음 프레임에 다시 포커스해
    // 마우스 클릭 없이 곧장 타이핑되게 한다.
    const input = this.chatInput;
    input?.focus();
    requestAnimationFrame(() => input?.focus());
  }

  // 툴바 🖍 형광펜: 헤더 버튼과 동일(onHighlightClick) — 현재 본문 선택을 백틱 마킹하고
  // 형광펜 모드 ON(유지). 이후 드래그는 자동 마킹(모드 중엔 툴바 안 뜸), 헤더 🖍 버튼도 active로.
  // 툴바 mousedown preventDefault로 선택이 살아있어 그 선택을 그대로 감싼다.
  private onToolbarHighlightClick = (ev: MouseEvent): void => {
    ev.preventDefault();
    ev.stopPropagation();
    this.hideToolbar();
    this.onHighlightClick();
  };

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
    // 선택 텍스트를 문맥으로 든 빈 질문 탭 → 맨 아래 입력창에 포커스(첫 질문 입력).
    this.openTab(text, context, true);
    this.chatInput?.focus();
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

    // ➕ 새 질문 — 자막 선택 없이 빈 질문 탭 열기(Alt+Q와 동일 경로). 항상 활성(결과 유무 무관).
    // 형광펜/복사/Notion과 달리 "새 탭 생성" 액션이라 왼쪽으로 분리(margin-right:auto).
    const newQBtn = document.createElement('button');
    newQBtn.className = 'ydt-explain-action ydt-explain-action-newq';
    newQBtn.type = 'button';
    newQBtn.textContent = '➕ 새 질문';
    newQBtn.title = '자막 선택 없이 새 질문 탭 열기 (단축키 Alt+Q)';
    newQBtn.addEventListener('click', () => this.openAsk());

    // ✏️ 형광펜(백틱) — 모드 토글. 결과 도착 전엔 비활성.
    this.highlightBtn = document.createElement('button');
    this.highlightBtn.className = 'ydt-explain-action';
    this.highlightBtn.type = 'button';
    this.highlightBtn.textContent = '🖍️ 형광펜';
    this.highlightBtn.disabled = true;
    this.highlightBtn.title =
      '드래그 후 누르면 그 부분을 형광펜 표시. 선택 없이 누르면 모드 ON(이후 드래그마다 자동). 단축키 Shift+`';
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
    // 내용을 다 읽고 정리해 내보내는 "마지막" 액션이라 전용 클래스로 색을 분리(녹색).
    this.notionBtn = document.createElement('button');
    this.notionBtn.className = 'ydt-explain-action ydt-explain-action-notion';
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

    // 헤더(제목바)엔 제목 + 우상단 구석의 – 최소화 · ✕ 닫기만. 백틱·복사·Notion은 아래 별도 툴바로.
    const corner = document.createElement('div');
    corner.className = 'ydt-explain-corner';
    corner.append(min, close);

    actions.append(newQBtn, this.highlightBtn, this.copyBtn, this.notionBtn);
    // float(corner)을 제목보다 먼저 배치 — 제목 1줄째만 corner 옆으로 좁아지고 2·3줄은 전폭.
    header.append(corner, title);

    // 헤더(제목바)를 드래그 핸들로 — 패널 전체를 옮긴다. 우상단 –/✕(corner) 클릭은
    // 드래그 시작 안 함(버튼 동작 보존). 위치는 미니버튼과 공유(panelPos).
    this.enableDrag(panel, header, (t) => !!t.closest('.ydt-explain-corner'), null);

    // Notion 저장 결과 알림 줄 — 저장 후 실제 제목을 보여줌(어떤 제목으로 들어갔는지 바로 확인).
    const notice = document.createElement('div');
    notice.className = 'ydt-explain-notice';
    notice.hidden = true;
    this.noticeEl = notice;

    // 탭스트립 — 탭 2개 이상일 때만 표시(renderTabstrip이 hidden 토글).
    const tabstrip = document.createElement('div');
    tabstrip.className = 'ydt-explain-tabs';
    tabstrip.hidden = true;
    this.tabstripEl = tabstrip;

    const tabsContainer = document.createElement('div');
    tabsContainer.className = 'ydt-explain-tabsbody';
    this.tabsContainer = tabsContainer;

    // 맨 아래 "이어서 질문" 입력창 — 패널 공용(활성 탭 대상). 답 있는 탭에서 제출하면 후속 질문이
    // 새 탭으로 뜨고(부모 대화 상속), 답이 아직 없는 빈 질문/직접질문 탭이면 그 탭을 첫 답으로 채움.
    const chatbar = document.createElement('div');
    chatbar.className = 'ydt-explain-chatbar';
    const cinput = document.createElement('textarea');
    cinput.className = 'ydt-explain-qinput';
    cinput.rows = 1;
    cinput.placeholder = '이어서 질문… (예: 더 쉽게, 예문 보여줘)';
    cinput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submitChat();
      }
    });
    const csend = document.createElement('button');
    csend.className = 'ydt-explain-qsend';
    csend.type = 'button';
    // 후속 탭 앞 마커와 같은 ⏎(return) 기호로 통일.
    csend.textContent = '⏎';
    csend.title = '보내기 (Enter)';
    csend.addEventListener('click', () => this.submitChat());
    chatbar.append(cinput, csend);
    this.chatInput = cinput;

    // actions(백틱·복사·Notion 툴바)를 헤더 바로 아래·본문 위에 — 읽다가 위로 올려 누르는 동선.
    // 탭스트립을 notice 위로 — notice는 탭별로 켜졌다 꺼져(refreshActions) 아래에 두면 탭 위치가
    // 세로로 튀어 탭 전환이 불편했음. header+actions(둘 다 고정) 바로 아래라 탭 위치 불변.
    // chatbar는 맨 아래 고정(본문 스크롤과 무관하게 항상 보임).
    panel.append(header, actions, tabstrip, notice, tabsContainer, chatbar);
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
  private openTab(
    term: string,
    context: string,
    question: boolean,
    isAsk = false,
    isFollowup = false,
  ): Tab {
    this.ensureShell();
    this.restore(); // 최소화돼 있었으면 펼침

    const contentEl = document.createElement('div');
    contentEl.className = 'ydt-explain-tabcontent';
    // 본문 형광펜 동작 — 드래그(mouseup) 백틱 감싸기, 코드 칩 클릭 해제. 탭별로 부착(활성 탭만 보임).
    contentEl.addEventListener('mouseup', () => window.setTimeout(() => this.applyHighlight(), 0));
    contentEl.addEventListener('click', (e) => this.onPanelClick(e));

    const body = document.createElement('div');
    body.className = 'ydt-explain-body';
    if (isFollowup) {
      // 후속 질문 탭 — 곧바로 실행되므로 로딩 표시.
      body.appendChild(this.loadingEl('답변 생성 중…'));
    } else if (question) {
      // 빈 질문/직접질문 탭 — 맨 아래 입력창에 첫 질문을 기다린다.
      const hint = document.createElement('div');
      hint.className = 'ydt-explain-loading';
      hint.append('맨 아래 입력창에 질문을 입력하고 Enter.');
      body.appendChild(hint);
    } else {
      body.appendChild(this.loadingEl('해설 생성 중…'));
    }
    contentEl.appendChild(body);

    const tab: Tab = {
      term,
      context,
      isQuestion: question,
      isAsk,
      isFollowup,
      contentEl,
      bodyEl: body,
      turns: [],
      result: null,
      notionSaved: false,
      notionPageUrl: null,
      notionTitle: null,
      notionPageId: null,
      notionDbId: null,
      notionOldKept: false,
    };
    this.tabsContainer!.appendChild(contentEl);
    // 최신 탭을 맨 앞(왼쪽)에 — 새 탭은 곧 활성화되므로 활성 탭이 항상 같은 위치(맨 왼쪽)에
    // 와 reachable. 계속 해설/질문해 탭이 쌓여도 최신이 오른쪽으로 밀려나지 않는다.
    // contentEl은 display로 show/hide돼 tabsContainer 내 순서는 무관(탭 배열 순서만이 칩 순서).
    this.tabs.unshift(tab);
    this.activateTab(0);
    return tab;
  }

  private activateTab(i: number): void {
    if (i < 0 || i >= this.tabs.length) return;
    this.active = i;
    this.tabs.forEach((t, j) => {
      t.contentEl.style.display = j === i ? 'flex' : 'none';
    });
    const tab = this.tabs[i];
    this.setTitle(tab.term);
    // 형광펜 모드는 탭마다 독립 — 전환 시 off.
    this.highlightMode = false;
    this.highlightBtn?.classList.remove('active');
    this.tabs.forEach((t) => t.bodyEl.classList.remove('highlighting'));
    this.refreshActions();
    this.renderTabstrip();
  }

  // 제목을 넣되 3줄(max-height)을 넘치면 들어오는 최대 길이까지 줄이고 '…'을 붙인다.
  // 멀티라인 + float 계단 래핑이라 -webkit-line-clamp(=display:-webkit-box로 래핑이 깨짐)를 못 써
  // JS로 트림한다. 전체 term은 title 툴팁에 남겨 호버로 확인.
  private setTitle(text: string): void {
    const el = this.titleEl;
    if (!el) return;
    el.title = text;
    el.textContent = text;
    // 최소화 중(숨김)이면 측정 불가 → 트림 보류, restore에서 재적용.
    if (el.clientHeight === 0) return;
    // 안 넘치면 그대로(짧은 term엔 생략부호 안 붙임).
    if (el.scrollHeight <= el.clientHeight + 1) return;
    // 생략부호는 한 글자 '…'(U+2026) 대신 ASCII 마침표 세 개 — CJK 폰트(Noto Sans KR)가 '…'을
    // 줄 세로 중앙에 찍어 떠 보이는 걸 피하고 baseline(아래)에 깔리게 한다.
    const ELLIPSIS = '...';
    // 이진 탐색: 생략부호를 붙여도 max-height 안에 들어오는 최대 prefix 길이.
    let lo = 0;
    let hi = text.length;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      el.textContent = text.slice(0, mid).trimEnd() + ELLIPSIS;
      if (el.scrollHeight <= el.clientHeight + 1) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    el.textContent = text.slice(0, best).trimEnd() + ELLIPSIS;
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
      chip.className =
        'ydt-explain-tab' +
        (i === this.active ? ' active' : '') +
        (t.notionSaved ? ' saved' : '');
      // Notion 저장된 탭엔 ✓ 표시 — 탭을 눌러 열어보지 않아도 저장 여부 확인.
      if (t.notionSaved) {
        const mark = document.createElement('span');
        mark.className = 'ydt-explain-tab-saved';
        mark.textContent = '✓';
        mark.title = 'Notion 저장됨';
        chip.appendChild(mark);
      }
      const label = document.createElement('span');
      label.className = 'ydt-explain-tab-label';
      // 후속(파생) 탭은 ⏎, 첫 질문 탭은 ❓, 해설 탭은 아이콘 없음.
      label.textContent = (t.isFollowup ? '⏎ ' : t.isQuestion ? '❓ ' : '') + t.term;
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
    // 맨 아래 입력창 안내 — 답이 있으면 "이어서 질문", 아직 없으면(빈 질문 탭) 첫 질문 안내.
    if (this.chatInput) {
      this.chatInput.placeholder = has
        ? '이어서 질문… (예: 더 쉽게, 예문 보여줘)'
        : '질문을 입력하고 Enter…';
    }
    if (this.copyBtn) this.copyBtn.disabled = !has;
    if (this.highlightBtn) this.highlightBtn.disabled = !has;
    if (this.notionBtn) {
      this.notionBtn.style.display = this.notionEnabled ? '' : 'none';
      this.notionBtn.disabled = !has;
      if (tab?.notionSaved) {
        this.notionBtn.textContent = tab.notionPageUrl ? '✓ 저장됨 ↗' : '✓ 저장됨';
        this.notionBtn.title = tab.notionPageUrl ? 'Notion에서 열기' : '';
      } else if (tab?.notionPageId) {
        // 저장했다가 형광펜을 고친 탭 — 누르면 새 페이지로 갈아끼운다(옛 페이지는 휴지통).
        this.notionBtn.textContent = '♻ 업데이트';
        this.notionBtn.title = 'Notion 페이지를 지금 내용으로 갈아끼우기';
      } else {
        this.notionBtn.textContent = '📝 Notion';
        this.notionBtn.title = '';
      }
    }
    // 알림 줄은 저장된 탭에서만 표시(탭 전환 시에도 그 탭 기준으로 따라옴).
    if (tab?.notionSaved && tab.notionTitle) {
      this.showNotice(tab.notionTitle, tab.notionPageUrl, tab.notionOldKept);
    } else this.hideNotice();
  }

  // Notion 저장 결과를 헤더 아래 한 줄로 — 어떤 제목으로 저장됐는지 바로 확인.
  // oldKept면 옛 페이지가 안 지워졌다는 뜻 — 조용히 중복이 쌓이지 않게 그 사실을 표기한다.
  private showNotice(title: string, url: string | null, oldKept = false): void {
    const el = this.noticeEl;
    if (!el) return;
    const suffix = oldKept ? ' · ⚠ 옛 페이지 남음' : '';
    el.replaceChildren(document.createTextNode(`📝 Notion 저장됨: 「${title}」${suffix}`));
    if (url) {
      el.append('  ');
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '열기 ↗';
      el.append(a);
    }
    el.hidden = false;
  }

  private hideNotice(): void {
    if (this.noticeEl) this.noticeEl.hidden = true;
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
      // 표시·텍스트로 실제 크기가 잡힌 뒤 위치 재적용(폭 0 상태 오클램프 방지).
      this.applyPos(this.fab);
    }
  }

  private ensureFab(): void {
    if (this.fab) {
      if (this.fab.parentElement !== this.host()) this.host().appendChild(this.fab);
      this.applyPos(this.fab);
      return;
    }
    const fab = document.createElement('div');
    fab.className = 'ydt-explain-fab';
    fab.title = '해설 패널 펼치기 (드래그로 이동)';
    // 미니버튼은 전체가 드래그 핸들. 안 움직이고 떼면 클릭 = 펼치기.
    this.enableDrag(fab, fab, null, () => this.restore());
    this.fab = fab;
    this.host().appendChild(fab);
    this.applyPos(fab);
  }

  // 드래그(이동) vs 클릭(탭) 분기를 element에 부여. panel·fab가 공유하는 panelPos를 갱신.
  //   el     : 실제로 움직일 요소(위치/클램프 기준)
  //   handle : 드래그를 시작하는 요소(el과 같거나 그 일부, 예: 패널 헤더)
  //   guard  : target이 이 조건이면 드래그 시작 안 함(버튼 등 — null이면 항상 시작)
  //   onTap  : 임계값 미만 이동으로 끝나면 호출(클릭 동작 — fab의 펼치기)
  private enableDrag(
    el: HTMLElement,
    handle: HTMLElement,
    guard: ((t: HTMLElement) => boolean) | null,
    onTap: (() => void) | null,
  ): void {
    const THRESHOLD = 4; // px — 이만큼 안 움직이면 클릭(탭)
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;
    let dragging = false;

    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < THRESHOLD) return;
      dragging = true;
      this.panelPos = this.clampPos(baseLeft + dx, baseTop + dy, el);
      this.applyPos(el);
    };
    const onUp = (ev: PointerEvent): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        /* capture가 이미 풀렸으면 무시 */
      }
      el.classList.remove('ydt-dragging');
      if (!dragging && onTap) onTap(); // 움직임 없었으면 클릭
    };

    handle.addEventListener('pointerdown', (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      const t = ev.target as HTMLElement | null;
      if (guard && t && guard(t)) return; // 버튼 등 — 드래그 시작 안 함(클릭 그대로)
      const rect = el.getBoundingClientRect();
      startX = ev.clientX;
      startY = ev.clientY;
      baseLeft = rect.left;
      baseTop = rect.top;
      dragging = false;
      el.classList.add('ydt-dragging');
      handle.setPointerCapture(ev.pointerId);
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      ev.preventDefault();
    });
  }

  // 뷰포트 안으로 클램프(8px 여백). el 크기는 렌더 후 offsetWidth/Height로 측정.
  private clampPos(left: number, top: number, el: HTMLElement): { left: number; top: number } {
    const M = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const maxLeft = Math.max(M, window.innerWidth - w - M);
    const maxTop = Math.max(M, window.innerHeight - h - M);
    return {
      left: Math.min(Math.max(left, M), maxLeft),
      top: Math.min(Math.max(top, M), maxTop),
    };
  }

  // panelPos를 el에 적용(좌상단 px + 기본 right 무력화). null이면 CSS 기본값 사용.
  // 패널·미니버튼은 크기가 달라 표시 시점에 각자 크기로 다시 클램프(화면 밖 방지).
  private applyPos(el: HTMLElement): void {
    if (!this.panelPos) {
      el.style.left = '';
      el.style.top = '';
      el.style.right = '';
      return;
    }
    const { left, top } = this.clampPos(this.panelPos.left, this.panelPos.top, el);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.right = 'auto';
  }

  private restore(): void {
    if (this.fab) this.fab.style.display = 'none';
    if (this.panel) {
      this.panel.style.display = 'flex';
      if (this.panel.parentElement !== this.host()) this.host().appendChild(this.panel);
      this.applyPos(this.panel); // 미니버튼을 끌어둔 자리에서 펼침(공유 위치)
    }
    // 최소화 중 열린 탭은 측정 불가로 트림이 보류됐을 수 있어, 보이게 된 지금 재적용.
    const tab = this.tabs[this.active];
    if (tab) this.setTitle(tab.term);
  }

  private closePanel(): void {
    this.panel?.remove();
    this.fab?.remove();
    this.panel = null;
    this.fab = null;
    this.panelPos = null;
    this.tabs = [];
    this.active = -1;
    this.tabsContainer = null;
    this.titleEl = null;
    this.noticeEl = null;
    this.tabstripEl = null;
    this.chatInput = null;
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
      // 대화 기록 시드 — 이 해설 탭에서 "이어서 질문"하면 이 해설을 문맥으로 갖게 한다.
      tab.turns = [
        { role: 'user', text: res.userMessage ?? text },
        { role: 'model', text: res.markdown },
      ];
      if (this.activeTab() === tab) this.refreshActions();
    } else {
      const err = document.createElement('div');
      err.className = 'ydt-explain-error';
      err.textContent = `해설을 불러오지 못했어요: ${res.error}`;
      body.appendChild(err);
      console.warn(TAG, 'explain error:', res.error);
    }
  }

  // 맨 아래 "이어서 질문" 입력창 제출. 활성 탭에 답이 있으면 후속 질문을 새 탭으로(부모 대화 상속),
  // 아직 답이 없는 빈 질문/직접질문 탭이면 그 탭을 첫 답으로 채운다. 해설 로딩 중 탭은 무시.
  private submitChat(): void {
    const input = this.chatInput;
    const tab = this.activeTab();
    if (!input || !tab) return;
    const q = input.value.trim();
    if (!q) return;

    if (tab.result) {
      // 후속 질문 → 새 탭. 부모 turns를 상속해 "더 쉽게" 등이 직전 답을 문맥으로 갖는다(§24 멀티턴).
      input.value = '';
      const parentTurns = tab.turns;
      const child = this.openTab(q, '', true, false, true);
      // 후속 user 메시지는 질문만(text/context 비움) — 이전 대화가 history로 문맥을 준다.
      void this.runQuestion(child, '', '', q, parentTurns);
    } else if (tab.isQuestion) {
      // 빈 질문/직접질문 탭의 첫 질문 → 현재 탭 채움. 직접질문(isAsk)은 선택 텍스트 없이 질문만,
      // 선택에서 연 ❓탭은 term(선택 텍스트)을 문맥으로 보냄. 라벨(제목·탭칩)은 질문으로 교체.
      input.value = '';
      const text = tab.isAsk ? '' : tab.term;
      tab.term = q;
      this.setTitle(q);
      this.renderTabstrip();
      void this.runQuestion(tab, text, tab.context, q, []);
    }
    // 해설 로딩 중(!result && !isQuestion) 탭에선 무시.
  }

  private async runQuestion(
    tab: Tab,
    text: string,
    context: string,
    question: string,
    history: ChatTurn[],
  ): Promise<void> {
    const body = tab.bodyEl;
    body.textContent = '';
    body.appendChild(this.loadingEl('답변 생성 중…'));
    if (this.activeTab() === tab) this.setActionsBusy();

    let res: ExplainResult;
    try {
      // 직접 질문(Alt+Q) 탭의 첫 질문만 isAsk=true → background가 해설 프롬프트로 풍부하게 답한다.
      // 후속(child 탭, isAsk=false)·선택 ❓질문 탭(isAsk=false)은 가벼운 질문 프롬프트 유지.
      res = await this.requestQuestion(text, context, question, history, tab.isAsk);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!this.tabs.includes(tab)) return;
    body.textContent = '';
    if (res.ok) {
      // 질문을 답 위에 함께 렌더 → 패널에 Q/A가 같이 보이고, 복사/Notion에도 질문이 포함됨.
      const md = `**질문:** ${question}\n\n${res.markdown}`;
      body.appendChild(renderMarkdown(md));
      // 복사/Notion 제목엔 표시 라벨(tab.term)을 쓴다 — 선택 탭은 text와 동일, 직접 질문 탭은 질문 텍스트.
      tab.result = { term: tab.term, markdown: md, context };
      // 대화 기록 누적 — user 턴은 background가 실제 보낸 메시지(userMessage), model 턴은 원문 답(markdown,
      // "질문:" 접두어 없는 순수 답). 후속 탭이 이 turns를 상속해 다음 질문이 대화 전체를 문맥으로 갖는다.
      tab.turns = [
        ...history,
        { role: 'user', text: res.userMessage ?? question },
        { role: 'model', text: res.markdown },
      ];
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

  // 빨간 칩(내가 표시한 백틱) 클릭 → 해제. 단 **형광펜 모드 ON일 때만** — OFF에선 칠한 단어를
  // 클릭/드래그해도 해제 안 하고 그냥 선택(재해설 등)에 양보한다. AI 예문 백틱은 대상 아님.
  private onPanelClick(ev: MouseEvent): void {
    if (!this.highlightMode) return;
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
  // notionPageId/notionDbId/notionTitle은 **남긴다**: 다음 저장이 그 페이지를 휴지통으로 보내고
  // 같은 제목을 재사용해야 하므로. 버튼은 refreshActions가 '♻ 업데이트'로 바꾼다.
  private markEdited(): void {
    const tab = this.activeTab();
    if (!tab || !tab.notionSaved) return;
    tab.notionSaved = false;
    tab.notionPageUrl = null;
    this.refreshActions(); // 알림 줄 숨김 + 버튼 라벨 갱신
    this.renderTabstrip(); // ✓ 저장 표시 제거(stale)
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
    // 이 탭을 전에 저장한 적 있으면(형광펜 수정 후 재저장) 옛 페이지를 갈아끼운다.
    const prev =
      tab.notionPageId && tab.notionDbId
        ? { pageId: tab.notionPageId, dbId: tab.notionDbId, title: tab.notionTitle ?? '' }
        : undefined;
    btn.disabled = true;
    btn.textContent = prev ? '업데이트 중…' : '저장 중…';
    let res: NotionSaveResult;
    try {
      res = await this.requestNotionSave(term, markdown, context, prev);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    // 그 사이 탭이 닫혔으면 무시. 살아있으면 결과는 탭에 저장하고, 활성 탭일 때만 버튼 갱신.
    if (!this.tabs.includes(tab)) return;
    if (res.ok) {
      tab.notionSaved = true;
      tab.notionPageUrl = res.url ?? null;
      tab.notionTitle = res.title?.trim() || term;
      // 새 페이지 id로 교체(재저장이면 옛 페이지는 이미 휴지통). id가 안 오면 옛 값을 유지하지
      // 않는다 — 그 페이지는 방금 archive됐으므로 다음 저장이 또 지우려 들면 404가 난다.
      tab.notionPageId = res.pageId ?? null;
      tab.notionDbId = res.dbId ?? null;
      tab.notionOldKept = res.oldKept ?? false;
      if (this.activeTab() === tab) {
        btn.textContent = tab.notionPageUrl ? '✓ 저장됨 ↗' : '✓ 저장됨';
        btn.disabled = false;
        btn.title = tab.notionPageUrl ? 'Notion에서 열기' : '';
        this.showNotice(tab.notionTitle, tab.notionPageUrl, tab.notionOldKept);
      }
      this.renderTabstrip(); // 탭 칩에 ✓ 저장 표시 반영
    } else {
      console.warn(TAG, 'notion save error:', res.error);
      if (this.activeTab() === tab) {
        btn.textContent = '✗ 저장 실패';
        btn.disabled = false;
        btn.title = res.error;
        // 잠시 후 다시 시도할 수 있게 원복(재저장 대기 중이면 '♻ 업데이트'로).
        window.setTimeout(() => {
          if (this.activeTab() === tab && !tab.notionSaved) this.refreshActions();
        }, 2500);
      }
    }
  }
}

// 제목 길이 상한 — 넘으면(구두점 없는 ASR 런온 등) AI 예문으로. notion.ts:TITLE_MAX_LEN과 동일.
const TITLE_MAX_LEN = 100;

// 복사/Notion 제목 — 단어보다 "예문"이 복습에 유용. ① 자막 문장(context) 중 **선택 단어가 든 한
// 문장**이 적당한 길이면 그것, ② 없거나 너무 길면(런온) 답변의 첫 인라인 백틱 예문, ③ 없으면 단어.
// background/notion.ts:pickNotionTitle과 같은 로직의 평행 구현(섹션 15의 평행 구현과 동일 사유).
function pickTitle(term: string, context: string | undefined, markdown: string): string {
  const t = term.trim();
  const ctx = (context ?? '').trim();
  const example = markdown.match(/`([^`\n]+)`/)?.[1]?.trim();
  if (ctx && ctx.toLowerCase() !== t.toLowerCase() && ctx.length > t.length) {
    const sentence = pickContextSentence(ctx, t);
    if (sentence.length <= TITLE_MAX_LEN) return sentence;
    if (example) return example;
    return sentence;
  }
  if (example) return example;
  return t || '(제목 없음)';
}

// 여러 문장일 수 있는 자막 문맥에서 선택 표현(term)이 든 한 문장만 고른다(없으면 첫 문장).
function pickContextSentence(context: string, term: string): string {
  const sentences = splitSentences(context);
  if (sentences.length <= 1) return context.trim();
  const t = term.trim().toLowerCase();
  const hit = t ? sentences.find((s) => s.toLowerCase().includes(t)) : undefined;
  return (hit ?? sentences[0]).trim();
}

// 종결부호(.?!…。！？) 뒤에서 문장 분할(부호 + 뒤따르는 닫는 따옴표/괄호는 앞 문장에 포함).
function splitSentences(text: string): string[] {
  const parts = text.trim().match(/[^.?!…。！？]+[.?!…。！？]*["'”’)\]】」』]*\s*/g);
  if (!parts) return [text.trim()].filter(Boolean);
  return parts.map((s) => s.trim()).filter(Boolean);
}

// 노드가 속한 해설 본문(.ydt-explain-body) 찾기 — 패널 안 드래그 재해설용.
function closestExplainBody(node: Node): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : node.parentElement;
  return el?.closest('.ydt-explain-body') ?? null;
}

// 선택이 든 가장 가까운 블록(문단/목록/셀/헤딩/인용)의 요소 — 그 텍스트를 재해설 문맥으로.
function closestBlock(node: Node, root: HTMLElement): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : node.parentElement;
  const block = el?.closest('p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,pre') as HTMLElement | null;
  return block && root.contains(block) ? block : null;
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
