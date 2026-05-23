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

function Popup() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<TabStatus>({ kind: 'loading' });

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });

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
