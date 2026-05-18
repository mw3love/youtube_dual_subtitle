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
import { DISPLAY_MODES, SOURCE_LANGS, TARGET_LANGS } from '../shared/lang-options';
import { clearCache, getCacheStats } from '../shared/cache/idb-cache';

const WEIGHTS: Array<{ value: 400 | 500 | 700; label: string }> = [
  { value: 400, label: '보통' },
  { value: 500, label: '약간 굵게' },
  { value: 700, label: '굵게' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 12px', borderBottom: '1px solid #2e2e2e', paddingBottom: 6 }}>
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
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {children}
        {hint && <span style={{ fontSize: 11, color: '#999', marginLeft: 2 }}>{hint}</span>}
      </div>
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
        <span style={{ fontSize: 12, color: '#999' }}>px</span>
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
  const { sourceStyle, targetStyle, displayMode, backgroundOpacity, lineHeight } = settings;
  const cueBg = `rgba(0,0,0,${backgroundOpacity})`;
  return (
    <div
      style={{
        background: '#000',
        padding: 24,
        borderRadius: 6,
        border: '1px solid #2e2e2e',
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
            background: cueBg,
            padding: '4px 10px',
            borderRadius: 4,
            color: sourceStyle.color,
            fontSize: sourceStyle.fontSize,
            fontWeight: sourceStyle.fontWeight,
            lineHeight,
          }}
        >
          Sample English subtitle
        </div>
      )}
      {displayMode !== 'source-only' && (
        <div
          style={{
            background: cueBg,
            padding: '4px 10px',
            borderRadius: 4,
            color: targetStyle.color,
            fontSize: targetStyle.fontSize,
            fontWeight: targetStyle.fontWeight,
            lineHeight,
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
  const [saveState, setSaveState] = useState<'idle' | 'pending' | 'saved'>('idle');
  // color picker / slider처럼 빠르게 변하는 입력은 매 onChange마다 storage.sync.set을
  // 부르면 분당 120회 throttle에 걸려 결국 저장 실패. UI는 즉시 갱신하되 저장만 디바운스.
  const pendingPatchRef = useRef<Partial<Settings>>({});
  const saveTimerRef = useRef<number | null>(null);
  const savedFadeTimerRef = useRef<number | null>(null);

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
    setSaveState('pending');
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(async () => {
      const toSave = pendingPatchRef.current;
      pendingPatchRef.current = {};
      saveTimerRef.current = null;
      await saveSettings(toSave);
      setSaveState('saved');
      if (savedFadeTimerRef.current !== null) clearTimeout(savedFadeTimerRef.current);
      savedFadeTimerRef.current = window.setTimeout(() => setSaveState('idle'), 2000);
    }, 250);
  };

  const onClearCache = async (): Promise<void> => {
    if (!confirm('번역 캐시를 모두 비웁니다. 다음 영상 재생 시 다시 번역됩니다.')) return;
    const n = await clearCache();
    setCacheCount(0);
    alert(`${n}개 캐시 항목을 삭제했습니다.`);
  };

  const onResetSettings = async (): Promise<void> => {
    if (!confirm('모든 설정을 기본값으로 되돌립니다. 번역 캐시는 그대로 유지됩니다. 계속할까요?'))
      return;
    // 보류 중인 디바운스 저장이 있다면 리셋 직후 덮어쓰지 못하도록 취소.
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingPatchRef.current = {};
    setSettings(DEFAULT_SETTINGS);
    await saveSettings(DEFAULT_SETTINGS);
    setSaveState('saved');
    if (savedFadeTimerRef.current !== null) clearTimeout(savedFadeTimerRef.current);
    savedFadeTimerRef.current = window.setTimeout(() => setSaveState('idle'), 2000);
  };

  const dangerButtonStyle: React.CSSProperties = {
    padding: '4px 10px',
    borderColor: '#6b2a2a',
    color: '#ffb3b3',
  };

  if (!loaded) return <div style={{ padding: 24 }}>설정 불러오는 중…</div>;

  return (
    <div
      style={{
        maxWidth: 900,
        margin: '40px auto',
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
        color: '#e8e8e8',
      }}
    >
      <h1 style={{ fontSize: 22, margin: '0 0 4px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span>YouTube Dual Subtitle</span>
        {saveState === 'pending' && (
          <span style={{ fontSize: 11, color: '#888', fontWeight: 400 }}>저장 중…</span>
        )}
        {saveState === 'saved' && (
          <span style={{ fontSize: 11, color: '#3ea6ff', fontWeight: 400 }}>● 저장됨</span>
        )}
      </h1>
      <p style={{ color: '#999', fontSize: 12, margin: '0 0 24px' }}>v0.1.0 · 변경 즉시 모든 YouTube 탭에 반영됩니다.</p>

      <Section title="기본">
        <Row label="자막 표시" hint="단축키: C (YouTube 페이지에서)">
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
        <Row label="단어 단위 표시">
          <input
            type="checkbox"
            checked={settings.wordRevealEnabled}
            onChange={(e) => update({ wordRevealEnabled: e.target.checked })}
          />
          <span style={{ fontSize: 12, color: '#999' }}>
            음성에 맞춰 영어 단어가 점진 표시 (한글은 줄 단위). 자동자막에서 가장 정확.
          </span>
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
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <label style={{ minWidth: 140, fontSize: 13, marginTop: 2 }}>엔진</label>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
              <input
                type="radio"
                checked={settings.backend === 'google-free'}
                onChange={() => update({ backend: 'google-free' as BackendId })}
                style={{ marginTop: 2 }}
              />
              <span>
                <div>Google 무료</div>
                <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
                  클라우드 번역. 영↔한 등 주요 페어 품질 상위. 빈번 호출 시 잠시 차단될 수 있음.
                </div>
              </span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
              <input
                type="radio"
                checked={settings.backend === 'chrome-builtin'}
                onChange={() => update({ backend: 'chrome-builtin' as BackendId })}
                style={{ marginTop: 2 }}
              />
              <span>
                <div>Chrome 내장 (오프라인)</div>
                <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
                  로컬 모델. 오프라인·차단 없음·자막 외부 전송 없음. 긴 문장은 약간 어색할 수 있음.
                </div>
              </span>
            </label>
          </div>
        </div>
        <div
          style={{
            marginLeft: 152,
            marginTop: 8,
            padding: '8px 12px',
            background: '#222',
            borderLeft: '3px solid #3ea6ff',
            borderRadius: 3,
            fontSize: 12,
            color: '#bbb',
          }}
        >
          Tip — 처음엔 Google 무료, 차단·오프라인 상황엔 Chrome 내장으로 전환 권장.
        </div>
      </Section>

      <Section title="스타일">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 280px',
            gap: 24,
            alignItems: 'start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
            <Row label="쇼츠 자막 크기 배율" hint="100%이면 일반 영상과 동일">
              <input
                type="range"
                min={0.5}
                max={1.8}
                step={0.05}
                value={settings.shortsFontScale}
                onChange={(e) => update({ shortsFontScale: Number(e.target.value) })}
                style={{ width: 200 }}
              />
              <span style={{ fontSize: 12, color: '#999' }}>
                {Math.round(settings.shortsFontScale * 100)}%
              </span>
            </Row>
            <Row label="자막 배경 투명도" hint="높을수록 박스 진함">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.backgroundOpacity}
                onChange={(e) => update({ backgroundOpacity: Number(e.target.value) })}
                style={{ width: 200 }}
              />
              <span style={{ fontSize: 12, color: '#999' }}>
                {Math.round(settings.backgroundOpacity * 100)}%
              </span>
            </Row>
            <Row label="자막 줄 높이" hint="원문/번역 두 줄 사이 간격">
              <input
                type="range"
                min={1}
                max={2}
                step={0.05}
                value={settings.lineHeight}
                onChange={(e) => update({ lineHeight: Number(e.target.value) })}
                style={{ width: 200 }}
              />
              <span style={{ fontSize: 12, color: '#999' }}>
                {settings.lineHeight.toFixed(2)}
              </span>
            </Row>
            <Row label="자막 위치" hint="영상 위에서 좌측 ⋮⋮ 핸들을 드래그">
              <button
                onClick={() =>
                  update({ subtitlePosition: DEFAULT_SETTINGS.subtitlePosition })
                }
                style={{ padding: '4px 10px' }}
              >
                기본 위치로 되돌리기
              </button>
              <span style={{ fontSize: 11, color: '#777' }}>
                일반: {Math.round(settings.subtitlePosition.normal.xPercent)}% /{' '}
                {Math.round(settings.subtitlePosition.normal.yPercent)}% · 쇼츠:{' '}
                {Math.round(settings.subtitlePosition.shorts.xPercent)}% /{' '}
                {Math.round(settings.subtitlePosition.shorts.yPercent)}%
              </span>
            </Row>
          </div>
          <div style={{ position: 'sticky', top: 16 }}>
            <div style={{ fontSize: 12, color: '#999', marginBottom: 6 }}>미리보기</div>
            <Preview settings={settings} />
          </div>
        </div>
      </Section>

      <Section title="관리">
        <Row label="번역 캐시">
          <button onClick={onClearCache} style={dangerButtonStyle}>
            비우기
          </button>
          <span style={{ fontSize: 12, color: '#999' }}>
            현재 {cacheCount ?? '…'}개 영상
          </span>
        </Row>
        <Row label="설정 초기화" hint="번역 캐시는 영향 없음">
          <button onClick={onResetSettings} style={dangerButtonStyle}>
            기본값으로 되돌리기
          </button>
        </Row>
      </Section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
