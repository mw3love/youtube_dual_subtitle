import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../shared/settings';

function Popup() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  const toggle = (): void => {
    const next = { ...settings, subtitlesEnabled: !settings.subtitlesEnabled };
    setSettings(next);
    void saveSettings({ subtitlesEnabled: next.subtitlesEnabled });
  };

  const openOptions = (): void => {
    chrome.runtime.openOptionsPage();
    window.close();
  };

  return (
    <div style={{ minWidth: 240, padding: 14, fontFamily: 'system-ui, sans-serif' }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>YouTube Dual Subtitle</h3>

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
          onChange={toggle}
          disabled={!loaded}
        />
      </label>

      <button
        onClick={openOptions}
        style={{
          width: '100%',
          marginTop: 6,
          padding: '6px',
          fontSize: 12,
          cursor: 'pointer',
          background: '#f5f5f5',
          border: '1px solid #ddd',
          borderRadius: 4,
        }}
      >
        설정 페이지 열기
      </button>

      <p style={{ margin: '8px 0 0', fontSize: 11, color: '#888' }}>v0.1.0</p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
