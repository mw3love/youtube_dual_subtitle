import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type BackendId,
  type Settings,
} from '../shared/settings';

function Popup() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  const toggleSubtitles = (): void => {
    const next = { ...settings, subtitlesEnabled: !settings.subtitlesEnabled };
    setSettings(next);
    void saveSettings({ subtitlesEnabled: next.subtitlesEnabled });
  };

  const setBackend = (backend: BackendId): void => {
    const next = { ...settings, backend };
    setSettings(next);
    void saveSettings({ backend });
  };

  return (
    <div style={{ minWidth: 280, padding: 14, fontFamily: 'system-ui, sans-serif' }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>YouTube Dual Subtitle</h3>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 0',
          cursor: loaded ? 'pointer' : 'default',
          opacity: loaded ? 1 : 0.5,
        }}
      >
        <span style={{ fontSize: 13 }}>자막 표시</span>
        <input
          type="checkbox"
          checked={settings.subtitlesEnabled}
          onChange={toggleSubtitles}
          disabled={!loaded}
        />
      </label>

      <div style={{ padding: '8px 0', opacity: loaded ? 1 : 0.5 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>번역 백엔드</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <label style={{ display: 'flex', gap: 6, cursor: loaded ? 'pointer' : 'default' }}>
            <input
              type="radio"
              name="backend"
              checked={settings.backend === 'google-free'}
              onChange={() => setBackend('google-free')}
              disabled={!loaded}
            />
            Google 무료 (빠름, 비공식)
          </label>
          <label style={{ display: 'flex', gap: 6, cursor: loaded ? 'pointer' : 'default' }}>
            <input
              type="radio"
              name="backend"
              checked={settings.backend === 'chrome-builtin'}
              onChange={() => setBackend('chrome-builtin')}
              disabled={!loaded}
            />
            Chrome 내장 (오프라인, 첫 사용 시 모델 다운로드)
          </label>
        </div>
      </div>

      <p style={{ margin: '8px 0 0', fontSize: 11, color: '#888' }}>
        v0.1.0 · 백엔드 변경 시 캐시 분리. 페이지 새로고침 권장.
      </p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
