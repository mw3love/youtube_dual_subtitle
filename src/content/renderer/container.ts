// 영상 모드별 컨테이너 mount 위치 결정.
// 일반/Theater: #movie_player
// Shorts: ytd-reel-video-renderer[is-active]
// Fullscreen: M3-7에서 별도 portal 처리 (현재는 #movie_player 안에 있으면 자연 따라감)

export type Mode = 'normal' | 'shorts';

export interface MountTarget {
  host: HTMLElement;
  video: HTMLVideoElement;
  mode: Mode;
}

export function findMountTarget(): MountTarget | null {
  // Shorts 활성 reel 우선 (URL이 /shorts/* 이면 무조건 reel 모드)
  const shortsHost = document.querySelector<HTMLElement>(
    'ytd-reel-video-renderer[is-active] #shorts-player',
  );
  if (shortsHost) {
    const video = shortsHost.querySelector<HTMLVideoElement>('video');
    if (video) return { host: shortsHost, video, mode: 'shorts' };
  }

  // 일반/Theater — #movie_player가 video를 감싸는 player 컨테이너
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
} {
  const container = document.createElement('div');
  container.className = 'ydt-container';
  container.dataset.mode = mode;
  container.style.visibility = 'hidden';

  const sourceEl = document.createElement('div');
  sourceEl.className = 'ydt-cue ydt-source';

  const targetEl = document.createElement('div');
  targetEl.className = 'ydt-cue ydt-target';

  container.appendChild(sourceEl);
  container.appendChild(targetEl);
  return { container, sourceEl, targetEl };
}
