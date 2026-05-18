// 영상 모드별 컨테이너 mount 위치 결정.
// YouTube DOM이 자주 바뀌므로 셀렉터 의존 줄이고 video element 기반으로 탐지.

export type Mode = 'normal' | 'shorts';

export interface MountTarget {
  host: HTMLElement;
  video: HTMLVideoElement;
  mode: Mode;
}

// 화면에 보이고 충분히 큰 video element 중 가장 큰 것. Shorts에 여러 reel video가
// 동시에 DOM에 있을 때 active 한 것만 고른다.
function findActiveVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
  const candidates = videos.filter((v) => {
    const r = v.getBoundingClientRect();
    return (
      r.width > 100 &&
      r.height > 100 &&
      r.top < window.innerHeight &&
      r.bottom > 0 &&
      r.left < window.innerWidth &&
      r.right > 0
    );
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const aR = a.getBoundingClientRect();
    const bR = b.getBoundingClientRect();
    return bR.width * bR.height - aR.width * aR.height;
  });
  return candidates[0];
}

export function findMountTarget(): MountTarget | null {
  const isShortsUrl = location.pathname.startsWith('/shorts/');

  if (isShortsUrl) {
    const video = findActiveVideo();
    if (!video) {
      console.warn('[YDT/container] shorts: no visible video found');
      return null;
    }
    // host = video를 감싸는 가장 가까운 player container.
    // Shorts에서 `[is-active]` 속성이 없는 경우가 있어 video의 부모 chain으로 탐색.
    const host =
      video.closest<HTMLElement>('#shorts-player') ??
      video.closest<HTMLElement>('ytd-reel-video-renderer') ??
      video.closest<HTMLElement>('#movie_player') ??
      (video.parentElement as HTMLElement | null);
    if (!host) {
      console.warn('[YDT/container] shorts: video has no suitable host parent');
      return null;
    }
    console.log(
      '[YDT/container] shorts host:',
      host.tagName.toLowerCase(),
      host.id ? `#${host.id}` : `.${host.className.split(' ')[0] ?? ''}`,
    );
    return { host, video, mode: 'shorts' };
  }

  // 일반/Theater
  const player = document.querySelector<HTMLElement>('#movie_player');
  if (player) {
    const video = player.querySelector<HTMLVideoElement>('video');
    if (video) return { host: player, video, mode: 'normal' };
  }
  return null;
}

export function createContainer(mode: Mode): {
  container: HTMLElement;
  sourceEl: HTMLElement;
  targetEl: HTMLElement;
  handleEl: HTMLElement;
} {
  const container = document.createElement('div');
  container.className = 'ydt-container';
  container.dataset.mode = mode;
  container.style.visibility = 'hidden';

  const handleEl = document.createElement('div');
  handleEl.className = 'ydt-handle';
  handleEl.title = '드래그하여 자막 위치 이동';
  handleEl.textContent = '⋮⋮';

  const sourceEl = document.createElement('div');
  sourceEl.className = 'ydt-cue ydt-source';

  const targetEl = document.createElement('div');
  targetEl.className = 'ydt-cue ydt-target';

  container.appendChild(handleEl);
  container.appendChild(sourceEl);
  container.appendChild(targetEl);
  return { container, sourceEl, targetEl, handleEl };
}
