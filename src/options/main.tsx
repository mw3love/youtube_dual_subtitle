import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

function Options() {
  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h1>YouTube Dual Subtitle — 설정</h1>
      <p style={{ color: '#666' }}>설정 UI는 다음 마일스톤에서 추가됩니다.</p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
