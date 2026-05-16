import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type BackendId,
  type CueStyle,
  type DisplayMode,
  type Settings,
  type SourceLang,
  type TargetLang,
} from '../shared/settings';
import { clearCache, getCacheStats } from '../shared/cache/idb-cache';

const SOURCE_LANGS: Array<{ value: SourceLang; label: string }> = [
  { value: 'en', label: '영어 (English)' },
  { value: 'ja', label: '일본어 (日本語)' },
  { value: 'zh', label: '중국어 (中文)' },
  { value: 'es', label: '스페인어 (Español)' },
  { value: 'fr', label: '프랑스어 (Français)' },
  { value: 'de', label: '독일어 (Deutsch)' },
  { value: 'auto', label: '자동 감지 (백엔드에 따라 동작 다를 수 있음)' },
];

const TARGET_LANGS: Array<{ value: TargetLang; label: string }> = [
  { value: 'ko', label: '한국어' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'zh', label: '中文' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
];

const DISPLAY_MODES: Array<{ value: DisplayMode; label: string }> = [
  { value: 'dual', label: '듀얼 (원문 + 번역)' },
  { value: 'translation-only', label: '번역만' },
  { value: 'source-only', label: '원문만' },
];

const WEIGHTS: Array<{ value: 400 | 500 | 700; label: string }> = [
  { value: 400, label: '보통' },
  { value: 500, label: '약간 굵게' },
  { value: 700, label: '굵게' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 12px', borderBottom: '1px solid #eee', paddingBottom: 6 }}>
        {title}
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
    </section>
  );
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <label style={{ minWidth: 140, fontSize: 13 }}>{label}</label>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>{children}</div>
      {hint && <span style={{ fontSize: 11, color: '#888' }}>{hint}</span>}
    </div>
  );
}

function StyleEditor({
  label,
  style,
  onChange,
}: {
  label: string;
  style: CueStyle;
  onChange: (s: CueStyle) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
      <Row label="크기">
        <input
          type="number"
          min={8}
          max={72}
          value={style.fontSize}
          onChange={(e) => onChange({ ...style, fontSize: Number(e.target.value) || 22 })}
          style={{ width: 70 }}
        />
        <span style={{ fontSize: 12, color: '#888' }}>px</span>
      </Row>
      <Row label="색">
        <input
          type="color"
          value={style.color}
          onChange={(e) => onChange({ ...style, color: e.target.value })}
        />
        <input
          type="text"
          value={style.color}
          onChange={(e) => onChange({ ...style, color: e.target.value })}
          style={{ width: 100, fontFamily: 'monospace' }}
        />
      </Row>
      <Row label="굵기">
        <select
          value={style.fontWeight}
          onChange={(e) =>
            onChange({ ...style, fontWeight: Number(e.target.value) as CueStyle['fontWeight'] })
          }
        >
          {WEIGHTS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
      </Row>
    </div>
  );
}

function Preview({ settings }: { settings: Settings }) {
  const { sourceStyle, targetStyle, displayMode } = settings;
  return (
    <div
      style={{
        background: '#222',
        padding: 24,
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        fontFamily: '"YouTube Sans","Roboto","Noto Sans KR",sans-serif',
      }}
    >
      {displayMode !== 'translation-only' && (
        <div
          style={{
            background: 'rgba(0,0,0,0.75)',
            padding: '4px 10px',
            borderRadius: 4,
            color: sourceStyle.color,
            fontSize: sourceStyle.fontSize,
            fontWeight: sourceStyle.fontWeight,
            lineHeight: 1.3,
          }}
        >
          Sample English subtitle
        </div>
      )}
      {displayMode !== 'source-only' && (
        <div
          style={{
            background: 'rgba(0,0,0,0.75)',
            padding: '4px 10px',
            borderRadius: 4,
            color: targetStyle.color,
            fontSize: targetStyle.fontSize,
            fontWeight: targetStyle.fontWeight,
            lineHeight: 1.3,
          }}
        >
          샘플 한국어 자막
        </div>
      )}
    </div>
  );
}

function Options() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [cacheCount, setCacheCount] = useState<number | null>(null);
  // color picker / slider처럼 빠르게 변하는 입력은 매 onChange마다 storage.sync.set을
  // 부르면 분당 120회 throttle에 걸려 결국 저장 실패. UI는 즉시 갱신하되 저장만 디바운스.
  const pendingPatchRef = useRef<Partial<Settings>>({});
  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
    void getCacheStats().then((s) => setCacheCount(s.count));
  }, []);

  const update = (patch: Partial<Settings>): void => {
    setSettings((prev) => ({ ...prev, ...patch }));
    pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      const toSave = pendingPatchRef.current;
      pendingPatchRef.current = {};
      saveTimerRef.current = null;
      void saveSettings(toSave);
    }, 250);
  };

  const onClearCache = async (): Promise<void> => {
    if (!confirm('번역 캐시를 모두 비웁니다. 다음 영상 재생 시 다시 번역됩니다.')) return;
    const n = await clearCache();
    setCacheCount(0);
    alert(`${n}개 캐시 항목을 삭제했습니다.`);
  };

  if (!loaded) return <div style={{ padding: 24 }}>설정 불러오는 중…</div>;

  return (
    <div
      style={{
        maxWidth: 720,
        margin: '40px auto',
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
        color: '#222',
      }}
    >
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>YouTube Dual Subtitle</h1>
      <p style={{ color: '#888', fontSize: 12, margin: '0 0 24px' }}>v0.1.0 · 변경 즉시 모든 YouTube 탭에 반영됩니다.</p>

      <Section title="기본">
        <Row label="자막 표시">
          <input
            type="checkbox"
            checked={settings.subtitlesEnabled}
            onChange={(e) => update({ subtitlesEnabled: e.target.checked })}
          />
        </Row>
        <Row label="표시 모드">
          <select
            value={settings.displayMode}
            onChange={(e) => update({ displayMode: e.target.value as DisplayMode })}
          >
            {DISPLAY_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Row>
      </Section>

      <Section title="언어">
        <Row label="원문 언어" hint="영상 자막에서 이 언어를 우선 선택">
          <select
            value={settings.sourceLang}
            onChange={(e) => update({ sourceLang: e.target.value as SourceLang })}
          >
            {SOURCE_LANGS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="번역 언어">
          <select
            value={settings.targetLang}
            onChange={(e) => update({ targetLang: e.target.value as TargetLang })}
          >
            {TARGET_LANGS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </Row>
      </Section>

      <Section title="번역 백엔드">
        <Row label="엔진">
          <label style={{ display: 'flex', gap: 6, fontSize: 13 }}>
            <input
              type="radio"
              checked={settings.backend === 'google-free'}
              onChange={() => update({ backend: 'google-free' as BackendId })}
            />
            Google 무료
          </label>
          <label style={{ display: 'flex', gap: 6, fontSize: 13 }}>
            <input
              type="radio"
              checked={settings.backend === 'chrome-builtin'}
              onChange={() => update({ backend: 'chrome-builtin' as BackendId })}
            />
            Chrome 내장 (오프라인)
          </label>
        </Row>
        <Row label="캐시">
          <button onClick={onClearCache} style={{ padding: '4px 10px' }}>
            비우기
          </button>
          <span style={{ fontSize: 12, color: '#666' }}>
            현재 {cacheCount ?? '…'}개 영상
          </span>
        </Row>
      </Section>

      <Section title="스타일">
        <StyleEditor
          label="원문 (영어 등)"
          style={settings.sourceStyle}
          onChange={(sourceStyle) => update({ sourceStyle })}
        />
        <StyleEditor
          label="번역 (한국어 등)"
          style={settings.targetStyle}
          onChange={(targetStyle) => update({ targetStyle })}
        />
        <Row label="화면 하단 여백">
          <input
            type="range"
            min={0}
            max={50}
            value={settings.bottomOffsetPercent}
            onChange={(e) => update({ bottomOffsetPercent: Number(e.target.value) })}
            style={{ width: 200 }}
          />
          <span style={{ fontSize: 12, color: '#666' }}>{settings.bottomOffsetPercent}%</span>
        </Row>
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>미리보기</div>
          <Preview settings={settings} />
        </div>
      </Section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
