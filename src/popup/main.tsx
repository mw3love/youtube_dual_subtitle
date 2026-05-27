import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type BackendId,
  type DisplayMode,
  type Settings,
  type SourceLang,
  type TargetLang,
} from '../shared/settings';
import { BACKENDS, DISPLAY_MODES, SOURCE_LANGS, TARGET_LANGS } from '../shared/lang-options';
import { getGeminiApiKey, getLastBackend, type LastBackendInfo } from '../shared/secrets';

// 현재 탭 상태 — 팝업이 열렸을 때 한 번 조회.
type TabStatus =
  | { kind: 'loading' }
  | { kind: 'not-youtube' }
  | { kind: 'unreachable' }
  | { kind: 'subtitles-off' }
  | { kind: 'no-cues' }
  | { kind: 'active'; cueCount: number };

function statusDot(color: string): React.CSSProperties {
  return {
    display: 'inline-block',
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: color,
    marginRight: 7,
    verticalAlign: 'middle',
  };
}

function StatusLine({ status }: { status: TabStatus }) {
  let color = '#888';
  let text = '';
  switch (status.kind) {
    case 'loading':
      color = '#666';
      text = '확인 중…';
      break;
    case 'not-youtube':
      color = '#888';
      text = 'YouTube 화면이 아님';
      break;
    case 'unreachable':
      color = '#aa6633';
      text = '페이지에 연결할 수 없음 · 새로고침 필요';
      break;
    case 'subtitles-off':
      color = '#888';
      text = '자막 꺼짐';
      break;
    case 'no-cues':
      color = '#aa6633';
      text = '이 영상에는 자막 없음';
      break;
    case 'active':
      color = '#3ea6ff';
      text = `자막 켜짐 · ${status.cueCount}줄`;
      break;
  }
  return (
    <div
      style={{
        fontSize: 11,
        padding: '6px 8px',
        background: '#222',
        borderRadius: 3,
        marginBottom: 10,
        color: '#bbb',
      }}
    >
      <span style={statusDot(color)} />
      {text}
    </div>
  );
}

// 백엔드 식별자 → 사용자에게 보여줄 짧은 이름.
const BACKEND_LABEL: Record<BackendId, string> = {
  'google-free': 'Google 무료',
  'chrome-builtin': 'Chrome 내장',
  gemini: 'Gemini',
};

function formatAgo(at: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}

// "최근 번역" 한 줄 — preferred ≠ used면 fallback 발생을 빨갛게 노출.
function LastBackendLine({ info, preferred }: { info: LastBackendInfo; preferred: BackendId }) {
  const fellBack = info.used !== info.preferred;
  // 사용자가 popup 열어둔 동안 시간 흐름 반영 (1분 단위).
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const stale = Date.now() - info.at > 30 * 60 * 1000; // 30분 이상이면 흐리게
  return (
    <p
      style={{
        margin: '6px 0 0',
        padding: '5px 8px',
        fontSize: 11,
        color: fellBack ? '#ffb37a' : stale ? '#888' : '#aac8ff',
        background: '#1f1f1f',
        border: '1px solid #2e2e2e',
        borderRadius: 3,
        opacity: stale ? 0.7 : 1,
      }}
      title={
        fellBack
          ? `${BACKEND_LABEL[info.preferred]} 호출 실패 → ${BACKEND_LABEL[info.used]}로 자동 fallback`
          : `${BACKEND_LABEL[info.used]}로 처리 완료`
      }
    >
      최근 번역: {BACKEND_LABEL[info.used]} · {formatAgo(info.at)}
      {fellBack && (
        <span style={{ marginLeft: 6, fontSize: 10 }}>
          ⚠ {BACKEND_LABEL[preferred]} 실패 → fallback
        </span>
      )}
    </p>
  );
}

function Popup() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<TabStatus>({ kind: 'loading' });
  // Gemini 키 설정 여부 — backend === 'gemini'인데 키 없을 때만 안내 표시.
  const [geminiKeySet, setGeminiKeySet] = useState<boolean | null>(null);
  // 마지막 번역 호출 결과 — preferred ≠ used면 fallback 발생을 사용자에게 노출.
  const [lastBackend, setLastBackendState] = useState<LastBackendInfo | null>(null);

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
    void getGeminiApiKey().then((k) => setGeminiKeySet(!!k));
    void getLastBackend().then((b) => setLastBackendState(b));

    // 현재 탭 상태 조회.
    void (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url) {
          setStatus({ kind: 'not-youtube' });
          return;
        }
        if (!tab.url.startsWith('https://www.youtube.com')) {
          setStatus({ kind: 'not-youtube' });
          return;
        }
        let res: {
          hasCues: boolean;
          cueCount: number;
          subtitlesEnabled: boolean;
        };
        try {
          res = (await chrome.tabs.sendMessage(tab.id, { type: 'YDT_GET_STATUS' })) as typeof res;
        } catch {
          setStatus({ kind: 'unreachable' });
          return;
        }
        if (!res.subtitlesEnabled) setStatus({ kind: 'subtitles-off' });
        else if (!res.hasCues) setStatus({ kind: 'no-cues' });
        else setStatus({ kind: 'active', cueCount: res.cueCount });
      } catch {
        setStatus({ kind: 'not-youtube' });
      }
    })();
  }, []);

  const update = (patch: Partial<Settings>): void => {
    setSettings((prev) => ({ ...prev, ...patch }));
    void saveSettings(patch);
  };

  const openOptions = (): void => {
    chrome.runtime.openOptionsPage();
    window.close();
  };

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 0',
    fontSize: 13,
    gap: 10,
  };

  const selectStyle: React.CSSProperties = { fontSize: 12, padding: '2px 4px', maxWidth: 170 };

  return (
    <div
      style={{
        minWidth: 270,
        padding: 14,
        fontFamily: 'system-ui, sans-serif',
        opacity: loaded ? 1 : 0.5,
      }}
    >
      <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>YouTube Dual Subtitle</h3>

      <StatusLine status={status} />

      <label style={rowStyle}>
        <span>
          자막 켜기
          <span style={{ fontSize: 10, color: '#888', marginLeft: 6 }}>단축키 C</span>
        </span>
        <input
          type="checkbox"
          checked={settings.subtitlesEnabled}
          onChange={(e) => update({ subtitlesEnabled: e.target.checked })}
          disabled={!loaded}
        />
      </label>

      <label style={rowStyle} title="노래방처럼 말하는 단어가 또렷해짐 (영어 자막)">
        <span>노래방 모드</span>
        <input
          type="checkbox"
          checked={settings.wordRevealEnabled}
          onChange={(e) => update({ wordRevealEnabled: e.target.checked })}
          disabled={!loaded}
        />
      </label>

      <label style={rowStyle}>
        <span>표시 모드</span>
        <select
          value={settings.displayMode}
          onChange={(e) => update({ displayMode: e.target.value as DisplayMode })}
          disabled={!loaded}
          style={selectStyle}
        >
          {DISPLAY_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <label style={rowStyle} title="영상 자막에서 우선 고를 언어">
        <span>영상 자막</span>
        <select
          value={settings.sourceLang}
          onChange={(e) => update({ sourceLang: e.target.value as SourceLang })}
          disabled={!loaded}
          style={selectStyle}
        >
          {SOURCE_LANGS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </label>

      <label style={rowStyle}>
        <span>바꿀 언어</span>
        <select
          value={settings.targetLang}
          onChange={(e) => update({ targetLang: e.target.value as TargetLang })}
          disabled={!loaded}
          style={selectStyle}
        >
          {TARGET_LANGS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </label>

      <label style={rowStyle}>
        <span>번역 방식</span>
        <select
          value={settings.backend}
          onChange={(e) => update({ backend: e.target.value as BackendId })}
          disabled={!loaded}
          style={selectStyle}
        >
          {BACKENDS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </label>

      {settings.backend === 'gemini' && geminiKeySet === false && (
        <p
          style={{
            margin: '4px 0 0',
            padding: '6px 8px',
            fontSize: 11,
            color: '#ffcfa6',
            background: '#3a2a1a',
            border: '1px solid #5a3a1a',
            borderRadius: 3,
          }}
        >
          Gemini API 키가 설정되지 않음 — 옵션에서 키 입력 필요 (안 하면 Google 무료로 fallback)
        </p>
      )}

      {lastBackend && <LastBackendLine info={lastBackend} preferred={settings.backend} />}

      <button
        onClick={openOptions}
        style={{
          width: '100%',
          marginTop: 10,
          padding: '6px',
          fontSize: 12,
        }}
      >
        자세히 설정하기
      </button>

      <p style={{ margin: '8px 0 0', fontSize: 11, color: '#999' }}>
        v{chrome.runtime.getManifest().version}
      </p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
