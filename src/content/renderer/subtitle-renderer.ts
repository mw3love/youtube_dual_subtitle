import type { Cue, Word } from '../../shared/types';
import type { DisplayMode, Position } from '../../shared/settings';
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
  private handleEl: HTMLElement | null = null;
  private video: HTMLVideoElement | null = null;
  private mode: Mode = 'normal';
  private rafId: number | null = null;
  private lastIdx = -2; // -1은 "no cue", -2는 "강제 첫 업데이트"
  // 사용자가 native CC 버튼을 직접 끄면 우리 자막도 같이 숨긴다.
  // visibility(cue 단위)와 별개 차원이므로 display를 쓴다.
  private userHidden = false;
  private displayMode: DisplayMode = 'dual';
  private wordRevealEnabled = true;
  private wordSpans: HTMLSpanElement[] = [];
  private lastWordRevealed = -1;

  // 자막 위치 — 일반/쇼츠 각각. 드래그로 갱신.
  private positions: { normal: Position; shorts: Position } = {
    normal: { xPercent: 50, yPercent: 10 },
    shorts: { xPercent: 50, yPercent: 18 },
  };
  // 드래그로 위치 변경 시 호출되는 콜백 — content script가 storage에 저장.
  private onPositionChange: ((mode: Mode, pos: Position) => void) | null = null;
  private dragHandlers: { move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null =
    null;

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

    const { container, sourceEl, targetEl, handleEl } = createContainer(target.mode);
    target.host.appendChild(container);

    this.container = container;
    this.sourceEl = sourceEl;
    this.targetEl = targetEl;
    this.handleEl = handleEl;
    this.video = target.video;
    this.mode = target.mode;

    if (this.userHidden) container.style.display = 'none';
    this.applyDisplayMode();
    this.applyCurrentPosition();
    this.attachDragHandlers();

    console.log(TAG, 'mounted (mode:', this.mode, ')');
    this.startLoop();
  }

  unmount(): void {
    this.stopLoop();
    this.detachDragHandlers();
    if (this.mountRetryTimer !== null) {
      clearTimeout(this.mountRetryTimer);
      this.mountRetryTimer = null;
    }
    this.container?.remove();
    this.container = null;
    this.sourceEl = null;
    this.targetEl = null;
    this.handleEl = null;
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
    if (this.sourceEl) this.sourceEl.textContent = '';
    if (this.targetEl) this.targetEl.textContent = '';
    if (this.container) this.container.style.visibility = 'hidden';
  }

  setUserVisible(visible: boolean): void {
    this.userHidden = !visible;
    if (this.container) this.container.style.display = visible ? '' : 'none';
  }

  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
    this.applyDisplayMode();
  }

  setWordRevealEnabled(enabled: boolean): void {
    if (this.wordRevealEnabled === enabled) return;
    this.wordRevealEnabled = enabled;
    this.lastIdx = -2; // 다음 update에서 source 재구성
  }

  setPositions(positions: { normal: Position; shorts: Position }): void {
    this.positions = positions;
    this.applyCurrentPosition();
  }

  setOnPositionChange(cb: (mode: Mode, pos: Position) => void): void {
    this.onPositionChange = cb;
  }

  private applyCurrentPosition(): void {
    const pos = this.positions[this.mode];
    applySubtitlePosition(pos.xPercent, pos.yPercent);
  }

  private applyDisplayMode(): void {
    if (!this.sourceEl || !this.targetEl) return;
    this.sourceEl.style.display = this.displayMode === 'translation-only' ? 'none' : '';
    this.targetEl.style.display = this.displayMode === 'source-only' ? 'none' : '';
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
    if (!this.video || !this.sourceEl || !this.targetEl || !this.container) return;

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

    if (idx !== this.lastIdx) {
      this.lastIdx = idx;
      if (idx === -1) {
        this.container.style.visibility = 'hidden';
        this.sourceEl.textContent = '';
        this.targetEl.textContent = '';
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
      this.targetEl.textContent = this.targetTexts[idx] || fallback;
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
    if (!this.sourceEl) return;
    if (!this.wordRevealEnabled || !cue.words || cue.words.length === 0) {
      this.sourceEl.textContent = cue.text;
      this.wordSpans = [];
      return;
    }
    this.sourceEl.textContent = '';
    const spans: HTMLSpanElement[] = [];
    for (let i = 0; i < cue.words.length; i++) {
      const span = document.createElement('span');
      span.className = 'ydt-word';
      span.textContent = cue.words[i].text;
      this.sourceEl.appendChild(span);
      if (i < cue.words.length - 1) {
        this.sourceEl.appendChild(document.createTextNode(' '));
      }
      spans.push(span);
    }
    this.wordSpans = spans;
  }

  // ─── 드래그 핸들러 ───
  // pointerdown on 핸들 → pointermove로 위치 갱신 → pointerup으로 종료 + 저장.
  // 좌표 계산: 영상 element의 boundingClientRect 기준, %로 환산.
  private attachDragHandlers(): void {
    if (!this.handleEl) return;
    this.handleEl.addEventListener('pointerdown', this.onPointerDown);
  }

  private detachDragHandlers(): void {
    if (this.handleEl) {
      this.handleEl.removeEventListener('pointerdown', this.onPointerDown);
    }
    if (this.dragHandlers) {
      document.removeEventListener('pointermove', this.dragHandlers.move);
      document.removeEventListener('pointerup', this.dragHandlers.up);
      this.dragHandlers = null;
    }
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return; // left button only
    if (!this.container || !this.video || !this.handleEl) return;
    ev.preventDefault();
    ev.stopPropagation();

    const videoRect = this.video.getBoundingClientRect();
    if (videoRect.width === 0 || videoRect.height === 0) return;

    // 시작 시점의 컨테이너 중앙 좌표 (영상 내 px)
    const cRect = this.container.getBoundingClientRect();
    const startCenterX = cRect.left + cRect.width / 2 - videoRect.left;
    const startBottomGap = videoRect.bottom - cRect.bottom; // 영상 하단과 컨테이너 하단 사이 거리

    const startMouseX = ev.clientX;
    const startMouseY = ev.clientY;

    this.container.classList.add('is-dragging');
    try {
      this.handleEl.setPointerCapture(ev.pointerId);
    } catch {
      // some browsers
    }

    const onMove = (e: PointerEvent): void => {
      if (!this.container || !this.video) return;
      const dx = e.clientX - startMouseX;
      const dy = e.clientY - startMouseY;
      const vRect = this.video.getBoundingClientRect();
      let xPercent = ((startCenterX + dx) / vRect.width) * 100;
      let yPercent = ((startBottomGap - dy) / vRect.height) * 100;
      // 화면 밖 못 나가도록 살짝 clamp. 너무 좁히면 의도 위치 못 가니 5~95 정도.
      xPercent = Math.max(5, Math.min(95, xPercent));
      yPercent = Math.max(0, Math.min(95, yPercent));
      this.positions[this.mode] = { xPercent, yPercent };
      applySubtitlePosition(xPercent, yPercent);
    };

    const onUp = (_e: PointerEvent): void => {
      if (!this.dragHandlers) return;
      document.removeEventListener('pointermove', this.dragHandlers.move);
      document.removeEventListener('pointerup', this.dragHandlers.up);
      this.dragHandlers = null;
      this.container?.classList.remove('is-dragging');
      // 마지막 위치 저장
      this.onPositionChange?.(this.mode, this.positions[this.mode]);
    };

    this.dragHandlers = { move: onMove, up: onUp };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
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
