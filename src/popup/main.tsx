import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

function Popup() {
  return (
    <div style={{ minWidth: 240, padding: 12, fontFamily: 'system-ui, sans-serif' }}>
      <h3 style={{ margin: '0 0 8px' }}>YouTube Dual Subtitle</h3>
      <p style={{ margin: 0, fontSize: 12, color: '#666' }}>
        v0.1.0 — scaffold OK
      </p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
