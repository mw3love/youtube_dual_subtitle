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
  // 컨테이너가 append되는 host(= CSS offset parent, 보통 #movie_player). 위치/드래그 계산의 기준.
  private host: HTMLElement | null = null;
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

  // 표시 cue가 바뀔 때(다음 cue 등장 또는 자막 사라짐) 호출 — 떠 있는 해설/질문 툴바를 닫는 데
  // 쓴다. 드래그로 띄운 툴바는 그 선택이 가리키던 자막이 넘어가면 stale이므로.
  private onCueChange: (() => void) | null = null;

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

  // 번역은 per-sentence 백엔드면 문장마다 도착해 영상 전체 번역 내내 호출된다. 예전처럼
  // lastIdx=-2로 강제 재렌더하면 원문 DOM까지 갈아엎어 드래그 중 선택이 풀리고 onCueChange가
  // 툴바도 닫았다 → 표시 중인 cue의 번역 줄(과 번역 누적 윗줄)만, 실제로 바뀐 경우에만 제자리 갱신.
  setTargetTexts(texts: string[]): void {
    const prev = this.targetTexts;
    this.targetTexts = texts;
    console.log(TAG, 'target texts set:', texts.length, '/', this.cues.length);
    const idx = this.lastIdx;
    // -2(강제 첫 업데이트)·-1(자막 없음)은 다음 cue 진입 때 update()가 새 targetTexts로 그린다.
    if (idx < 0 || idx >= this.cues.length || !this.targetTextEl) return;
    const fallback = this.displayMode === 'dual' ? '' : this.cues[idx].text;
    const next = texts[idx] || fallback;
    if (this.targetTextEl.textContent !== next) this.targetTextEl.textContent = next;
    if (this.isRollingActive() && this.visibleSingleRow() === 'target') {
      const start = Math.max(0, idx - (this.singleContextLines - 1));
      for (let k = start; k < idx; k++) {
        if (prev[k] !== texts[k]) {
          this.renderHistory(idx);
          break;
        }
      }
    }
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
    this.host = target.host;
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
    this.endTextSelect();
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
    this.host = null;
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

  setOnCueChange(cb: () => void): void {
    this.onCueChange = cb;
  }

  // 위치(%)의 기준 박스 = 컨테이너의 CSS offset parent(보통 #movie_player). CSS는
  // left/bottom %를 이 박스 기준으로 푼다. video 요소는 레터박스(상하 검은 띠) 영상에서
  // 콘텐츠 크기로 축소·중앙배치돼 player보다 작고 위치가 달라, 위치/드래그 계산에 video
  // rect를 쓰면 세로 좌표계가 CSS와 어긋난다(가로는 폭이 같아 우연히 맞음) → 세로 드래그 불가.
  private positioningRect(): DOMRect | null {
    const parent = (this.container?.offsetParent as HTMLElement | null) ?? this.host;
    return parent ? parent.getBoundingClientRect() : null;
  }

  // 컨테이너가 플레이어 영역 안에 남도록 위치를 보정한다.
  // 컨테이너 폭이 결정되기 전(첫 cue 도착 전)엔 pRect/cRect width가 0이라 보정 불가 → 원본 그대로.
  // widthOverride: 드래그 중 wrap feedback loop(cRect.width가 줄면 maxX가 커져 더 우측으로
  // 가고, 다시 wrap이 깊어지는 무한 진행) 방지용으로 드래그 시작 시점의 폭을 고정해 전달.
  private clampPosition(pos: Position, widthOverride?: number): Position {
    if (!this.container) return pos;
    const pRect = this.positioningRect();
    if (!pRect) return pos;
    const cRect = this.container.getBoundingClientRect();
    const cWidth = widthOverride ?? cRect.width;
    const cHeight = cRect.height;
    if (pRect.width === 0 || cWidth === 0) return pos;
    const halfWidthPct = ((cWidth / 2) / pRect.width) * 100;
    const minX = halfWidthPct;
    const maxX = 100 - halfWidthPct;
    // y는 bottom 기준 %. 위쪽으로 갈수록 yPercent가 커진다. 컨테이너 윗변이 player 위로
    // 삐져나가지 않으려면 yPercent + (height/playerHeight)% <= 100. player가 컨테이너보다
    // 작은 극단(작은 Shorts viewport 등)에서 maxY가 음수가 될 수 있어 0 floor.
    const heightPct = pRect.height > 0 ? (cHeight / pRect.height) * 100 : 0;
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

    // 자막 텍스트를 드래그 중이거나 그 선택이 남아 있으면 현재 문장에 고정(영상은 계속 재생).
    // 문장이 넘어가면 DOM 교체로 선택이 사라져 해설/질문 툴바를 띄울 수 없기 때문.
    // 선택이 풀리면(바깥 클릭 등) 다음 프레임에 현재 시각으로 따라잡는다.
    if (this.lastIdx >= 0 && this.lastIdx < this.cues.length && this.isHoldingSelection()) {
      return;
    }

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
      // 표시 자막이 바뀌었다 → 드래그로 떠 있던 해설/질문 툴바는 stale이므로 닫는다.
      this.onCueChange?.();
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

    // 흐림은 stacked 레이아웃에서만 적용 — inline은 현재 줄과 한 문단처럼 흐르므로 흐려지면 가독성↓.
    histEl.style.opacity =
      this.dimHistory && this.historyLayout === 'stacked' ? '0.5' : '';

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
    // 누적(롤링) 윗줄(.ydt-history)도 텍스트라 같이 양보 — 안 그러면 윗줄에서 선택이 막힌다.
    const target = ev.target as HTMLElement | null;
    if (target?.closest('.ydt-cue-text, .ydt-history')) {
      this.beginTextSelect();
      return;
    }

    const parentRect = this.positioningRect();
    if (!parentRect || parentRect.width === 0 || parentRect.height === 0) return;

    ev.preventDefault();
    ev.stopPropagation();

    const cRect = this.container.getBoundingClientRect();
    const startCenterX = cRect.left + cRect.width / 2 - parentRect.left;
    const startBottomGap = parentRect.bottom - cRect.bottom;
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
      const pRect = this.positioningRect();
      if (!pRect || pRect.width === 0 || pRect.height === 0) return;
      const raw = {
        xPercent: ((startCenterX + dx) / pRect.width) * 100,
        yPercent: ((startBottomGap - dy) / pRect.height) * 100,
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

  // ─── 자막 텍스트 선택 보호 ───
  // 텍스트에서 시작한 드래그가 박스 밖으로 나가면 native 선택이 페이지의 다른 텍스트(Shorts 제목·
  // 채널명 오버레이 등)까지 번져, 선택 공통조상이 .ydt-container 밖이 돼 해설 툴바가 안 뜬다.
  // 드래그 동안 selectionchange마다 focus를 박스 경계로 되돌려 선택을 박스 안에 가둔다.
  // (CSS user-select: contain은 Chrome 미지원.)
  private selecting = false;
  private lastPointer: { x: number; y: number } | null = null;

  private trackPointer = (e: PointerEvent): void => {
    this.lastPointer = { x: e.clientX, y: e.clientY };
  };

  private beginTextSelect(): void {
    if (this.selecting) return;
    this.selecting = true;
    this.lastPointer = null;
    document.addEventListener('pointermove', this.trackPointer, true);
    document.addEventListener('selectionchange', this.clampSelection);
    document.addEventListener('pointerup', this.endTextSelect, true);
    document.addEventListener('pointercancel', this.endTextSelect, true);
    window.addEventListener('blur', this.endTextSelect);
  }

  private endTextSelect = (): void => {
    if (!this.selecting) return;
    this.selecting = false;
    document.removeEventListener('pointermove', this.trackPointer, true);
    document.removeEventListener('selectionchange', this.clampSelection);
    document.removeEventListener('pointerup', this.endTextSelect, true);
    document.removeEventListener('pointercancel', this.endTextSelect, true);
    window.removeEventListener('blur', this.endTextSelect);
    this.clampSelection();
  };

  private clampSelection = (): void => {
    const c = this.container;
    const sel = window.getSelection();
    if (!c || !sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return;
    if (!c.contains(sel.anchorNode)) return; // 자막에서 시작한 선택만 관여
    const box = document.createRange();
    box.selectNodeContents(c);
    // -1: focus가 박스보다 앞, 1: 뒤, 0: 안.
    const cmp = box.comparePoint(sel.focusNode, sel.focusOffset);
    if (cmp === 0) return;
    // DOM 순서는 화면 방향과 무관하다(오른쪽으로 끌어도 focus가 DOM상 앞쪽 헤더로 튈 수 있음).
    // 그래서 포인터 좌표를 박스 안으로 끌어와 그 지점의 caret으로 붙인다 — 오른쪽 밖이면 그 줄 끝.
    const p = this.lastPointer;
    if (p) {
      const r = c.getBoundingClientRect();
      const x = Math.min(Math.max(p.x, r.left + 2), r.right - 2);
      const y = Math.min(Math.max(p.y, r.top + 2), r.bottom - 2);
      const caret = document.caretRangeFromPoint?.(x, y);
      if (caret && c.contains(caret.startContainer) && caret.startContainer.nodeType === Node.TEXT_NODE) {
        sel.extend(caret.startContainer, caret.startOffset);
        return;
      }
    }
    const texts = visibleTextNodes(c);
    const edge = cmp < 0 ? texts[0] : texts[texts.length - 1];
    if (!edge) return;
    sel.extend(edge, cmp < 0 ? 0 : edge.length);
  };

  // 드래그 중이거나, 자막 안에서 시작한 비어있지 않은 선택이 남아 있는가.
  private isHoldingSelection(): boolean {
    if (this.selecting) return true;
    const c = this.container;
    const sel = window.getSelection();
    return !!c && !!sel && !sel.isCollapsed && !!sel.anchorNode && c.contains(sel.anchorNode);
  }

  // ─── 휠 폰트 크기 조절 ───
  // 자막 컨테이너 위에서 휠 → 폰트 크기를 1px씩 ±. passive:false로 페이지 스크롤 차단.
  // 범위는 settings 스키마와 동일(8~72). 한쪽이 bound에 닿아도 다른 쪽이 움직일 수 있으면 진행.
  // 행 분기: 번역 행(targetEl) 위에서 굴리면 번역만, 그 외(원문 행·행 사이 여백·외곽 halo)는
  // 원문+번역 둘 다. 원문을 크게 보는 사용 패턴상 원문 행이 호버하기 쉬워 "둘 다"의 기본 타겟이 됨.
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
    const clamp = (v: number): number =>
      Math.max(this.FONT_SIZE_MIN, Math.min(this.FONT_SIZE_MAX, v));
    // 번역 행 위 → 번역만. 원문 행·여백·halo → 둘 다.
    const targetOnly = !!this.targetEl && this.targetEl.contains(target);
    const nextTarget = clamp(this.targetFontSize + step);
    const nextSource = targetOnly ? this.sourceFontSize : clamp(this.sourceFontSize + step);
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

// 화면에 실제로 그려진(숨김 행·빈 윗줄 제외) 텍스트 노드 — 선택 경계 클램프 기준점.
function visibleTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      const el = n.parentElement;
      return el && el.getClientRects().length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const out: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}
