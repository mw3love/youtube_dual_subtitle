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
  const isShortsUrl = location.pathname.startsWith('/shorts/');

  if (isShortsUrl) {
    // YouTube가 Shorts player DOM을 자주 바꾸므로 후보 셀렉터를 여러 개 시도.
    const candidates = [
      'ytd-reel-video-renderer[is-active] #shorts-player',
      'ytd-reel-video-renderer[is-active]',
      '#shorts-player',
      '#movie_player', // Shorts에서도 결국 #movie_player를 쓰는 경우
    ];
    for (const sel of candidates) {
      const host = document.querySelector<HTMLElement>(sel);
      if (host) {
        const video = host.querySelector<HTMLVideoElement>('video');
        if (video) {
          console.log('[YDT/container] shorts host:', sel);
          return { host, video, mode: 'shorts' };
        }
      }
    }
    console.warn('[YDT/container] shorts: no host matched');
    return null;
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
