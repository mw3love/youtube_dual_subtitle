import type { Cue, Word } from '../../shared/types';
import type { DisplayMode, HistoryLayout, Position } from '../../shared/settings';
import { createContainer, findMountTarget, type Mode } from './container';
import { applySubtitlePosition, injectStyles } from './styles';

const TAG = '[YDT/renderer]';

// rAF 루프 안에서 매 프레임 cue를 찾는다. video.timeupdate 이벤트는 ~250ms 간격이라
// 자막 onset/offset이 끊겨 보일 수 있어 부적합.
// word reveal 모드에서는 같은 cue 내에서도 매 프레임 진행도가 바뀌므로 lastIdx 캐시
// 빠른 경로 다음에 word 진행도 갱신을 추가 처리한다.

export class SubtitleRenderer {
  private cues: Cue[] = [];
  private targetTexts: string[] = []; // 번역 결과. cues와 같은 인덱스. 없으면 placeholder(영어)
  private container: HTMLElement | null = null;
  private sourceEl: HTMLElement | null = null;
  private targetEl: HTMLElement | null = null;
  // 행 내부의 텍스트 전용 span. 콘텐츠 wipe가 형제 노드를 휩쓸지 않도록 분리.
  private sourceTextEl: HTMLElement | null = null;
  private targetTextEl: HTMLElement | null = null;
  // 누적(롤링) 모드에서 직전 cue들이 쌓이는 영역 — 현재 줄 위. 행마다 하나씩.
  private sourceHistoryEl: HTMLElement | null = null;
  private targetHistoryEl: HTMLElement | null = null;
  private video: HTMLVideoElement | null = null;
  private mode: Mode = 'normal';
  private rafId: number | null = null;
  private lastIdx = -2; // -1은 "no cue", -2는 "강제 첫 업데이트"
  // 사용자가 native CC 버튼을 직접 끄면 우리 자막도 같이 숨긴다.
  // visibility(cue 단위)와 별개 차원이므로 display를 쓴다.
  private userHidden = false;
  // 원본 언어와 번역 언어가 같을 때(예: 한국어 영상 + 번역=한국어) target 줄을 숨긴다.
  // displayMode와 별개 — 사용자 설정은 유지하되 모국어 paraphrase 노출만 차단.
  private suppressTarget = false;
  private displayMode: DisplayMode = 'dual';
  private wordRevealEnabled = true;
  private wordSpans: HTMLSpanElement[] = [];
  private lastWordRevealed = -1;
  // 싱글 자막 모드에서 화면에 함께 쌓을 줄 수(현재 줄 포함). 1이면 누적 없음(기존 동작).
  private singleContextLines = 2;
  // 누적 표시 시 직전 줄을 흐리게 할지(현재 줄 구분), 누적 레이아웃(줄 스택/한 줄 연결).
  private dimHistory = true;
  private historyLayout: HistoryLayout = 'stacked';

  // 자막 위치 — 일반/쇼츠 각각. 드래그로 갱신.
  private positions: { normal: Position; shorts: Position } = {
    normal: { xPercent: 50, yPercent: 10 },
    shorts: { xPercent: 50, yPercent: 18 },
  };
  // 드래그로 위치 변경 시 호출되는 콜백 — content script가 storage에 저장.
  private onPositionChange: ((mode: Mode, pos: Position) => void) | null = null;
  private dragHandlers: { move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null =
    null;

  // 휠로 폰트 크기 조절 시 현재값을 알아야 step 적용 가능 — applySettings 시점에 동기화.
  // 렌더링 자체에는 안 쓰임(CSS var로 처리). 휠 delta 계산용 캐시.
  private sourceFontSize = 22;
  private targetFontSize = 18;
  private onFontSizeChange: ((source: number, target: number) => void) | null = null;

  constructor() {
    injectStyles();
  }

  setCues(cues: Cue[]): void {
    this.cues = cues;
    this.targetTexts = []; // 새 cue 들어오면 이전 번역 무효
    this.lastIdx = -2;
    console.log(TAG, 'cues set:', cues.length);
    this.mount();
  }

  setTargetTexts(texts: string[]): void {
    this.targetTexts = texts;
    this.lastIdx = -2; // 다음 update에서 target 갱신
    console.log(TAG, 'target texts set:', texts.length, '/', this.cues.length);
  }

  // host/video가 아직 없을 수 있어 retry.
  private mountRetries = 0;
  private mountRetryTimer: number | null = null;
  private readonly MOUNT_RETRY_DELAYS = [0, 300, 600, 1200, 2400];

  mount(): void {
    // 이전 retry가 보류 중이면 취소 — 다음 retry가 이 호출에서 다시 결정.
    if (this.mountRetryTimer !== null) {
      clearTimeout(this.mountRetryTimer);
      this.mountRetryTimer = null;
    }
    const target = findMountTarget();
    if (!target) {
      if (this.mountRetries + 1 < this.MOUNT_RETRY_DELAYS.length) {
        this.mountRetries++;
        this.mountRetryTimer = window.setTimeout(
          () => this.mount(),
          this.MOUNT_RETRY_DELAYS[this.mountRetries],
        );
      } else {
        console.warn(TAG, 'mount: no host/video found after retries');
      }
      return;
    }
    this.mountRetries = 0;

    // 이미 mount된 게 있고 같은 video면 패스
    if (this.container && this.video === target.video && document.contains(this.container)) {
      return;
    }

    // 다른 video거나 stale이면 재구성
    this.unmount();

    const {
      container,
      sourceEl,
      targetEl,
      sourceTextEl,
      targetTextEl,
      sourceHistoryEl,
      targetHistoryEl,
    } = createContainer(target.mode);
    target.host.appendChild(container);

    this.container = container;
    this.sourceEl = sourceEl;
    this.targetEl = targetEl;
    this.sourceTextEl = sourceTextEl;
    this.targetTextEl = targetTextEl;
    this.sourceHistoryEl = sourceHistoryEl;
    this.targetHistoryEl = targetHistoryEl;
    this.video = target.video;
    this.mode = target.mode;

    if (this.userHidden) container.style.display = 'none';
    this.applyDisplayMode();
    this.applyCurrentPosition();
    this.attachDragHandlers();
    this.attachWheelHandler();

    console.log(TAG, 'mounted (mode:', this.mode, ')');
    this.startLoop();

    // 첫 cue 도착 전엔 컨테이너 폭이 0이라 clamp가 no-op. 짧은 지연 후 한 번 더 시도해
    // 사용자가 이전에 좌측 끝까지 드래그해 핸들이 화면 밖이 된 storage 위치를 자동 복구.
    setTimeout(() => this.applyCurrentPosition(), 300);
  }

  unmount(): void {
    this.stopLoop();
    this.detachDragHandlers();
    this.detachWheelHandler();
    if (this.mountRetryTimer !== null) {
      clearTimeout(this.mountRetryTimer);
      this.mountRetryTimer = null;
    }
    this.container?.remove();
    this.container = null;
    this.sourceEl = null;
    this.targetEl = null;
    this.sourceTextEl = null;
    this.targetTextEl = null;
    this.sourceHistoryEl = null;
    this.targetHistoryEl = null;
    this.video = null;
    this.lastIdx = -2;
    this.wordSpans = [];
    this.lastWordRevealed = -1;
  }

  // cue만 비우고 container/loop는 유지. SPA navigate처럼 새 영상으로 가는 도중
  // unmount하면 직후 도착한 새 cue가 파괴되는 race가 있어 이걸 쓴다.
  clearCues(): void {
    this.cues = [];
    this.lastIdx = -2;
    this.wordSpans = [];
    this.lastWordRevealed = -1;
    if (this.sourceTextEl) this.sourceTextEl.textContent = '';
    if (this.targetTextEl) this.targetTextEl.textContent = '';
    this.clearHistory();
    if (this.container) this.container.style.visibility = 'hidden';
  }

  setUserVisible(visible: boolean): void {
    this.userHidden = !visible;
    if (this.container) this.container.style.display = visible ? '' : 'none';
  }

  setDisplayMode(mode: DisplayMode): void {
    const changed = this.displayMode !== mode;
    this.displayMode = mode;
    this.applyDisplayMode();
    // 듀얼↔싱글 전환 시 누적 윈도우가 즉시 나타나거나 사라지도록 다음 update를 강제.
    if (changed) this.lastIdx = -2;
  }

  setSuppressTarget(suppress: boolean): void {
    if (this.suppressTarget === suppress) return;
    this.suppressTarget = suppress;
    this.applyDisplayMode();
    // suppress 전환은 보이는 줄(원문↔번역)을 바꾸므로 누적 윈도우도 재구성.
    this.lastIdx = -2;
  }

  setWordRevealEnabled(enabled: boolean): void {
    if (this.wordRevealEnabled === enabled) return;
    this.wordRevealEnabled = enabled;
    this.lastIdx = -2; // 다음 update에서 source 재구성
  }

  // 싱글 자막 모드에서 함께 쌓을 줄 수(현재 줄 포함). 1이면 누적 없음.
  setSingleContextLines(n: number): void {
    if (this.singleContextLines === n) return;
    this.singleContextLines = n;
    this.lastIdx = -2; // 다음 update에서 누적 윈도우 재구성
  }

  setDimHistory(dim: boolean): void {
    if (this.dimHistory === dim) return;
    this.dimHistory = dim;
    this.lastIdx = -2; // 다음 update에서 누적 윈도우 재렌더
  }

  setHistoryLayout(layout: HistoryLayout): void {
    if (this.historyLayout === layout) return;
    this.historyLayout = layout;
    this.lastIdx = -2; // 다음 update에서 누적 윈도우 재렌더
  }

  setPositions(positions: { normal: Position; shorts: Position }): void {
    this.positions = positions;
    this.applyCurrentPosition();
  }

  setOnPositionChange(cb: (mode: Mode, pos: Position) => void): void {
    this.onPositionChange = cb;
  }

  // 휠 핸들러가 새 크기를 계산할 수 있도록 현재값을 알려준다. applySettings마다 호출.
  setFontSizes(sourceSize: number, targetSize: number): void {
    this.sourceFontSize = sourceSize;
    this.targetFontSize = targetSize;
  }

  setOnFontSizeChange(cb: (source: number, target: number) => void): void {
    this.onFontSizeChange = cb;
  }

  // 컨테이너가 영상 영역 안에 남도록 위치를 보정한다.
  // 컨테이너 폭이 결정되기 전(첫 cue 도착 전)엔 vRect/cRect width가 0이라 보정 불가 → 원본 그대로.
  // widthOverride: 드래그 중 wrap feedback loop(cRect.width가 줄면 maxX가 커져 더 우측으로
  // 가고, 다시 wrap이 깊어지는 무한 진행) 방지용으로 드래그 시작 시점의 폭을 고정해 전달.
  private clampPosition(pos: Position, widthOverride?: number): Position {
    if (!this.container || !this.video) return pos;
    const vRect = this.video.getBoundingClientRect();
    const cRect = this.container.getBoundingClientRect();
    const cWidth = widthOverride ?? cRect.width;
    const cHeight = cRect.height;
    if (vRect.width === 0 || cWidth === 0) return pos;
    const halfWidthPct = ((cWidth / 2) / vRect.width) * 100;
    const minX = halfWidthPct;
    const maxX = 100 - halfWidthPct;
    // y는 bottom 기준 %. 위쪽으로 갈수록 yPercent가 커진다. 컨테이너 윗변이 영상 위로
    // 삐져나가지 않으려면 yPercent + (height/videoHeight)% <= 100. 영상이 컨테이너보다
    // 작은 극단(작은 Shorts viewport 등)에서 maxY가 음수가 될 수 있어 0 floor.
    const heightPct = vRect.height > 0 ? (cHeight / vRect.height) * 100 : 0;
    const maxY = Math.max(0, 100 - heightPct);
    return {
      xPercent: Math.max(minX, Math.min(maxX, pos.xPercent)),
      yPercent: Math.max(0, Math.min(maxY, pos.yPercent)),
    };
  }

  private applyCurrentPosition(): void {
    const pos = this.positions[this.mode];
    const clamped = this.clampPosition(pos);
    // 화면 밖이었던 저장 위치를 다시 화면 안으로 복구 — storage도 함께 갱신.
    if (clamped.xPercent !== pos.xPercent || clamped.yPercent !== pos.yPercent) {
      this.positions[this.mode] = clamped;
      this.onPositionChange?.(this.mode, clamped);
    }
    applySubtitlePosition(clamped.xPercent, clamped.yPercent);
  }

  private applyDisplayMode(): void {
    if (!this.sourceEl || !this.targetEl) return;
    if (this.suppressTarget) {
      // 모국어 자막 케이스 — displayMode와 무관하게 source만 표시.
      this.sourceEl.style.display = '';
      this.targetEl.style.display = 'none';
    } else {
      this.sourceEl.style.display = this.displayMode === 'translation-only' ? 'none' : '';
      this.targetEl.style.display = this.displayMode === 'source-only' ? 'none' : '';
    }
  }

  private startLoop(): void {
    this.stopLoop();
    const tick = (): void => {
      this.update();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private update(): void {
    if (
      !this.video ||
      !this.sourceEl ||
      !this.targetEl ||
      !this.sourceTextEl ||
      !this.targetTextEl ||
      !this.container
    )
      return;

    // Shorts swipe 감지: 다음 reel이 preload 상태면 loadeddata가 swipe 시점에
    // 발화되지 않아 broadcast 경로가 누락된다. video element 자체가 viewport
    // 밖으로 사라진 것을 직접 감지해 즉시 재마운트.
    if (this.mode === 'shorts') {
      const r = this.video.getBoundingClientRect();
      const offscreen =
        !this.video.isConnected ||
        r.width < 100 ||
        r.bottom <= 0 ||
        r.top >= window.innerHeight;
      if (offscreen) {
        console.log(TAG, 'active video offscreen — clearing cues and remounting');
        this.clearCues();
        this.mount();
        return;
      }
    }

    const t = this.video.currentTime;
    const idx = this.findCueIndex(t);
    const rolling = this.isRollingActive();

    // 누적 모드 sticky: 발화 사이 공백(직전 cue 종료 후 다음 cue 시작 전)에는 직전 윈도우를
    // 그대로 둬 자막이 깜빡이며 사라지지 않게 한다. 되감기로 직전 cue 시작 이전까지 간
    // 경우(t < 직전 cue end)는 제외 — 일반 경로로 떨어져 숨김 처리된다.
    if (
      idx === -1 &&
      rolling &&
      this.lastIdx >= 0 &&
      this.lastIdx < this.cues.length &&
      t >= this.cues[this.lastIdx].end
    ) {
      return;
    }

    if (idx !== this.lastIdx) {
      this.lastIdx = idx;
      if (idx === -1) {
        this.container.style.visibility = 'hidden';
        this.sourceTextEl.textContent = '';
        this.targetTextEl.textContent = '';
        this.clearHistory();
        this.wordSpans = [];
        this.lastWordRevealed = -1;
        return;
      }
      const cue = this.cues[idx];
      this.renderSource(cue);
      // dual 모드는 위에 source가 이미 보이므로 번역이 아직 없으면 빈 줄로 둔다
      // (영어 fallback이 깜빡이며 한글로 바뀌는 현상 방지). source/translation-only는
      // 한 줄만 보이므로 번역 미도착 시 source를 보여주는 게 빈 화면보다 낫다.
      const fallback = this.displayMode === 'dual' ? '' : cue.text;
      this.targetTextEl.textContent = this.targetTexts[idx] || fallback;
      // 싱글 자막 모드에서는 직전 cue들을 현재 줄 위에 누적 표시해 맥락을 넓힌다.
      if (rolling) this.renderHistory(idx);
      else this.clearHistory();
      this.container.style.visibility = 'visible';
      this.lastWordRevealed = -1;
    }

    if (this.wordRevealEnabled && this.wordSpans.length > 0 && this.lastIdx >= 0) {
      const words = this.cues[this.lastIdx].words;
      if (words) this.advanceWordReveal(words, t);
    }
  }

  // lastWordRevealed에서 forward/backward로 한 칸씩 이동해 새 revealed 위치를 찾는다.
  // 정주행은 보통 0–1회 비교로 끝나고 seek/rewind 시에만 여러 칸 이동.
  private advanceWordReveal(words: Word[], t: number): void {
    let revealed = this.lastWordRevealed;
    while (revealed + 1 < words.length && t >= words[revealed + 1].start) {
      revealed++;
    }
    while (revealed >= 0 && t < words[revealed].start) {
      revealed--;
    }
    if (revealed === this.lastWordRevealed) return;
    if (revealed > this.lastWordRevealed) {
      for (let i = this.lastWordRevealed + 1; i <= revealed; i++) {
        this.wordSpans[i]?.classList.add('is-revealed');
      }
    } else {
      for (let i = this.lastWordRevealed; i > revealed; i--) {
        this.wordSpans[i]?.classList.remove('is-revealed');
      }
    }
    this.lastWordRevealed = revealed;
  }

  private renderSource(cue: Cue): void {
    if (!this.sourceTextEl) return;
    if (!this.wordRevealEnabled || !cue.words || cue.words.length === 0) {
      this.sourceTextEl.textContent = cue.text;
      this.wordSpans = [];
      return;
    }
    this.sourceTextEl.textContent = '';
    const spans: HTMLSpanElement[] = [];
    for (let i = 0; i < cue.words.length; i++) {
      const span = document.createElement('span');
      span.className = 'ydt-word';
      span.textContent = cue.words[i].text;
      this.sourceTextEl.appendChild(span);
      if (i < cue.words.length - 1) {
        this.sourceTextEl.appendChild(document.createTextNode(' '));
      }
      spans.push(span);
    }
    this.wordSpans = spans;
  }

  // ─── 누적(롤링) 윈도우 ───
  // 싱글 자막(번역만 / 원문만 / 모국어 영상) 모드에서만 직전 cue를 현재 줄 위에 쌓는다.
  // 듀얼 모드는 두 줄이 모두 보이므로 누적하지 않는다(공부용 — 한 조각 단위가 적절).

  // 화면에 한 줄만 보이는 경우 그 줄이 원문인지 번역인지. 듀얼이면 null.
  private visibleSingleRow(): 'source' | 'target' | null {
    if (this.suppressTarget) return 'source'; // 모국어 영상 — 원문 줄만
    if (this.displayMode === 'translation-only') return 'target';
    if (this.displayMode === 'source-only') return 'source';
    return null; // dual — 두 줄 모두 표시
  }

  private isRollingActive(): boolean {
    return this.singleContextLines >= 2 && this.visibleSingleRow() !== null;
  }

  // 현재 cue 위에 직전 (singleContextLines - 1)개 cue를 누적 표시한다.
  // 보이는 줄이 번역 줄이면 번역 텍스트를, 원문 줄이면 원문 텍스트를 쓴다.
  // 레이아웃: 'stacked'는 cue마다 한 줄, 'inline'은 현재 줄과 한 문단처럼 이어 흘림.
  private renderHistory(currentIdx: number): void {
    const row = this.visibleSingleRow();
    const histEl = row === 'target' ? this.targetHistoryEl : this.sourceHistoryEl;
    // 보이지 않는 행의 history는 비워둔다 — 모드 전환 잔상 방지.
    const otherEl = row === 'target' ? this.sourceHistoryEl : this.targetHistoryEl;
    if (otherEl) {
      otherEl.textContent = '';
      otherEl.style.display = 'none';
    }
    if (!histEl) return;

    const start = Math.max(0, currentIdx - (this.singleContextLines - 1));
    const texts: string[] = [];
    for (let k = start; k < currentIdx; k++) {
      // 번역 줄인데 해당 cue 번역이 아직 도착 전이면 원문으로 임시 대체.
      // (대부분 직전 cue라 이미 번역돼 있고, setTargetTexts가 오면 재렌더된다.)
      texts.push(
        row === 'target' ? this.targetTexts[k] || this.cues[k].text : this.cues[k].text,
      );
    }

    // 흐림은 history 컨테이너 전체에 opacity로 — 스택/인라인 레이아웃 모두 동일 적용.
    histEl.style.opacity = this.dimHistory ? '0.5' : '';

    if (texts.length === 0) {
      histEl.textContent = '';
      histEl.style.display = 'none';
      return;
    }

    if (this.historyLayout === 'inline') {
      // 한 줄 연결 — 직전 자막들을 이어붙이고 끝에 공백 하나로 현재 줄과 분리.
      // display:inline이라 뒤따르는 현재 줄 span과 한 문단처럼 흐른다(폭 초과 시 자연 줄바꿈).
      histEl.textContent = `${texts.join(' ')} `;
      histEl.style.display = 'inline';
    } else {
      // 줄 스택 — cue마다 한 줄(블록).
      const lines = texts.map((t) => {
        const line = document.createElement('div');
        line.className = 'ydt-history-line';
        line.textContent = t;
        return line;
      });
      histEl.replaceChildren(...lines);
      histEl.style.display = '';
    }
  }

  private clearHistory(): void {
    for (const el of [this.sourceHistoryEl, this.targetHistoryEl]) {
      if (!el) continue;
      el.textContent = '';
      el.style.display = 'none';
    }
  }

  // ─── 드래그 핸들러 ───
  // pointerdown on 컨테이너 → 텍스트 위면 native 선택에 양보(드래그 안 함),
  // 여백/gap/halo 띠에서 시작하면 즉시 드래그.
  // 좌표 계산: 영상 element의 boundingClientRect 기준, %로 환산.
  private attachDragHandlers(): void {
    if (!this.container) return;
    this.container.addEventListener('pointerdown', this.onPointerDown);
  }

  private detachDragHandlers(): void {
    if (this.container) {
      this.container.removeEventListener('pointerdown', this.onPointerDown);
    }
    if (this.dragHandlers) {
      document.removeEventListener('pointermove', this.dragHandlers.move);
      document.removeEventListener('pointerup', this.dragHandlers.up);
      this.dragHandlers = null;
    }
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return; // left button only
    if (!this.container || !this.video) return;

    // 텍스트 위 down은 native 선택에 전적으로 양보. 드래그는 행 padding/gap/halo 띠에서만.
    const target = ev.target as HTMLElement | null;
    if (target?.closest('.ydt-cue-text')) return;

    const videoRect = this.video.getBoundingClientRect();
    if (videoRect.width === 0 || videoRect.height === 0) return;

    ev.preventDefault();
    ev.stopPropagation();

    const cRect = this.container.getBoundingClientRect();
    const startCenterX = cRect.left + cRect.width / 2 - videoRect.left;
    const startBottomGap = videoRect.bottom - cRect.bottom;
    const startMouseX = ev.clientX;
    const startMouseY = ev.clientY;

    try {
      this.container.setPointerCapture(ev.pointerId);
    } catch {
      // some browsers
    }
    this.container.classList.add('is-dragging');

    const onMove = (e: PointerEvent): void => {
      if (!this.container || !this.video) return;
      const dx = e.clientX - startMouseX;
      const dy = e.clientY - startMouseY;
      const vRect = this.video.getBoundingClientRect();
      const raw = {
        xPercent: ((startCenterX + dx) / vRect.width) * 100,
        yPercent: ((startBottomGap - dy) / vRect.height) * 100,
      };
      const clamped = this.clampPosition(raw);
      this.positions[this.mode] = clamped;
      applySubtitlePosition(clamped.xPercent, clamped.yPercent);
    };

    const onUp = (_e: PointerEvent): void => {
      if (!this.dragHandlers) return;
      document.removeEventListener('pointermove', this.dragHandlers.move);
      document.removeEventListener('pointerup', this.dragHandlers.up);
      this.dragHandlers = null;
      this.container?.classList.remove('is-dragging');
      this.onPositionChange?.(this.mode, this.positions[this.mode]);
    };

    this.dragHandlers = { move: onMove, up: onUp };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  // ─── 휠 폰트 크기 조절 ───
  // 자막 컨테이너 위에서 휠 → source/target 폰트 크기를 1px씩 ±. passive:false로 페이지 스크롤 차단.
  // 범위는 settings 스키마와 동일(8~72). 한쪽이 bound에 닿아도 다른 쪽이 움직일 수 있으면 진행.
  // YouTube player가 wheel을 자체 핸들러로 가로채는 경우가 있어 document에 capture phase로
  // 부착하고 target이 컨테이너 안일 때만 처리한다 — 일반 listener는 YouTube보다 늦게 발화 가능.
  private readonly FONT_SIZE_MIN = 8;
  private readonly FONT_SIZE_MAX = 72;

  private attachWheelHandler(): void {
    document.addEventListener('wheel', this.onWheel, { passive: false, capture: true });
  }

  private detachWheelHandler(): void {
    document.removeEventListener('wheel', this.onWheel, { capture: true } as EventListenerOptions);
  }

  private onWheel = (ev: WheelEvent): void => {
    if (!this.container) return;
    const target = ev.target as Node | null;
    if (!target || !this.container.contains(target)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const step = ev.deltaY < 0 ? 1 : -1;
    const nextSource = Math.max(
      this.FONT_SIZE_MIN,
      Math.min(this.FONT_SIZE_MAX, this.sourceFontSize + step),
    );
    const nextTarget = Math.max(
      this.FONT_SIZE_MIN,
      Math.min(this.FONT_SIZE_MAX, this.targetFontSize + step),
    );
    if (nextSource === this.sourceFontSize && nextTarget === this.targetFontSize) return;
    this.sourceFontSize = nextSource;
    this.targetFontSize = nextTarget;
    this.onFontSizeChange?.(nextSource, nextTarget);
  };

  // cue 수십~수백 개 + rAF 60fps. 선형이면 ~10k cmp/sec — 무시 가능.
  // 대신 lastIdx부터 시작해 일반 재생 시 ~1회 비교로 끝남.
  private findCueIndex(t: number): number {
    const cues = this.cues;
    if (cues.length === 0) return -1;

    // 빠른 경로 1: 같은 cue 안에 있는가?
    if (this.lastIdx >= 0 && this.lastIdx < cues.length) {
      const c = cues[this.lastIdx];
      if (t >= c.start && t < c.end) return this.lastIdx;
    }

    // 빠른 경로 2: 다음 cue로 넘어갔나? (정주행 케이스)
    const nextIdx = this.lastIdx + 1;
    if (nextIdx >= 0 && nextIdx < cues.length) {
      const c = cues[nextIdx];
      if (t >= c.start && t < c.end) return nextIdx;
    }

    // 폴백: 선형. 빨리감기/되감기 시 발생.
    for (let i = 0; i < cues.length; i++) {
      if (t < cues[i].start) return -1; // 첫 cue 전 또는 cue 사이 공백
      if (t < cues[i].end) return i;
    }
    return -1;
  }
}
