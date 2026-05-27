import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type BackendId,
  type CueStyle,
  type DisplayMode,
  type GeminiModel,
  type HistoryLayout,
  type MindlogicModel,
  type Settings,
  type SourceLang,
  type TargetLang,
} from '../shared/settings';
import { DISPLAY_MODES, SOURCE_LANGS, TARGET_LANGS } from '../shared/lang-options';
import { clearCache, getCacheStats } from '../shared/cache/idb-cache';
import {
  getGeminiApiKey,
  getMindlogicApiKey,
  setGeminiApiKey,
  setMindlogicApiKey,
} from '../shared/secrets';

// Mindlogic gateway가 통과시키는 모델 중 자막 번역에 가성비 좋은 라인만.
// 통합 크레딧 방식이라 flagship/reasoning은 자막 cue 수백 개에 비효율 — 경량/저가만 노출.
// gateway는 ID를 그대로 upstream에 전달하므로 학교/조직 계정에 권한 없는 모델은 401/403으로
// 떨어진 뒤 router가 google-free로 fallback.
const MINDLOGIC_MODELS: Array<{ value: MindlogicModel; label: string; hint: string }> = [
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', hint: '균형 (추천)' },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', hint: '최저가' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', hint: '자연스러움' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini', hint: 'OpenAI 경량' },
  { value: 'gpt-5.4-nano', label: 'GPT-5.4 nano', hint: 'OpenAI 초경량' },
];

const WEIGHTS: Array<{ value: 400 | 500 | 700; label: string }> = [
  { value: 400, label: '보통' },
  { value: 500, label: '약간 굵게' },
  { value: 700, label: '굵게' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2
        style={{
          fontSize: 16,
          margin: '0 0 12px',
          paddingBottom: 6,
          borderBottom: '1px solid #2e2e2e',
          color: '#ffa200',
          fontWeight: 700,
        }}
      >
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
      <div
        style={{
          alignSelf: 'flex-start',
          fontSize: 11,
          fontWeight: 700,
          color: '#bbb',
          background: '#262626',
          padding: '3px 10px',
          borderRadius: 10,
          letterSpacing: '0.3px',
        }}
      >
        {label}
      </div>
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

// 미리보기 샘플 — 실제 cue처럼 보이도록 짧은 문장 3개씩(같은 의미를 각 언어로).
// history는 위에서부터 오래된 → 직전, 맨 아래가 현재 cue.
// sourceLang === 'auto'이거나 lookup 실패 시 영어로 fallback.
const SAMPLES: Record<string, string[]> = {
  en: ['First, listen carefully.', 'Let me show you a preview.', 'Now you can see how it works.'],
  ko: ['먼저 잘 들어보세요.', '미리보기를 보여드릴게요.', '이제 어떻게 작동하는지 보여요.'],
  ja: ['まず、よく聞いてください。', 'プレビューをお見せします。', 'これで動作が分かりますね。'],
  zh: ['首先,请仔细听。', '让我给你看一个预览。', '现在你能看到它是怎么工作的了。'],
  es: ['Primero, escucha con atención.', 'Déjame mostrarte una vista previa.', 'Ahora puedes ver cómo funciona.'],
  fr: ["D'abord, écoute attentivement.", 'Laisse-moi te montrer un aperçu.', 'Maintenant, tu vois comment ça marche.'],
  de: ['Hör zuerst aufmerksam zu.', 'Lass mich dir eine Vorschau zeigen.', 'Jetzt siehst du, wie es funktioniert.'],
};
const getSample = (lang: string): string[] => SAMPLES[lang] ?? SAMPLES.en;

function HistoryBlock({
  texts,
  layout,
  dim,
}: {
  texts: string[];
  layout: HistoryLayout;
  dim: boolean;
}) {
  if (texts.length === 0) return null;
  if (layout === 'inline') {
    // 인라인은 현재 줄과 한 문단처럼 흐르므로 흐림 적용 안 함 (가독성 저하).
    return <span>{texts.join(' ')} </span>;
  }
  return (
    <div style={{ opacity: dim ? 0.5 : 1 }}>
      {texts.map((t, i) => (
        <div key={i}>{t}</div>
      ))}
    </div>
  );
}

// 미리보기 한 박스 — displayMode를 caller가 결정 (외국어 박스 = settings.displayMode,
// 모국어 박스 = 항상 'source-only', source 줄에 targetLang 텍스트 들어감).
// 노래방 reveal 애니메이션은 source 줄이 보일 때만 발화.
function PreviewBox({ settings, displayMode }: { settings: Settings; displayMode: DisplayMode }) {
  const {
    sourceStyle,
    targetStyle,
    backgroundOpacity,
    lineHeight,
    wordRevealEnabled,
    singleContextLines,
    dimHistory,
    historyLayout,
    sourceLang,
    targetLang,
  } = settings;
  const cueBg = `rgba(0,0,0,${backgroundOpacity})`;
  const sourceFontSize = sourceStyle.fontSize;
  const targetFontSize = targetStyle.fontSize;

  // 모국어 영상(source-only) 케이스에서 source 줄은 사실 targetLang(=모국어) 텍스트가 들어감.
  // dual / source-only 외 케이스는 source = sourceLang.
  // 'auto'면 영어 fallback(getSample 내부).
  const sourceSample =
    displayMode === 'source-only'
      ? getSample(targetLang)
      : getSample(sourceLang === 'auto' ? 'en' : sourceLang);
  const targetSample = getSample(targetLang);

  const singleRow: 'source' | 'target' | null =
    displayMode === 'translation-only'
      ? 'target'
      : displayMode === 'source-only'
        ? 'source'
        : null;
  const showHistory = singleRow !== null && singleContextLines >= 2;
  const historyCount = Math.max(0, singleContextLines - 1);
  const sourceHistoryTexts =
    showHistory && singleRow === 'source' ? sourceSample.slice(-1 - historyCount, -1) : [];
  const targetHistoryTexts =
    showHistory && singleRow === 'target' ? targetSample.slice(-1 - historyCount, -1) : [];

  const sourceCurrent = sourceSample[sourceSample.length - 1];
  const targetCurrent = targetSample[targetSample.length - 1];
  const sourceWords = sourceCurrent.split(' ');

  // 노래방 reveal 애니메이션 — source 줄이 보이고 wordReveal이 켜진 박스에서만.
  // -1: 전부 흐림 → words.length-1: 전부 또렷 → 잠시 머묾 → -1로 리셋.
  const animateReveal = wordRevealEnabled && displayMode !== 'translation-only';
  const [revealUpTo, setRevealUpTo] = useState<number>(sourceWords.length - 1);
  useEffect(() => {
    if (!animateReveal) {
      setRevealUpTo(sourceWords.length - 1);
      return;
    }
    let i = -1;
    setRevealUpTo(i);
    const id = window.setInterval(() => {
      i = i >= sourceWords.length + 1 ? -1 : i + 1;
      setRevealUpTo(i);
    }, 300);
    return () => window.clearInterval(id);
  }, [animateReveal, sourceWords.length]);

  const renderSourceCurrent = (): React.ReactNode => {
    if (!wordRevealEnabled || displayMode === 'translation-only') return sourceCurrent;
    return sourceWords.map((w, i) => (
      <span
        key={i}
        style={{
          opacity: i <= revealUpTo ? 1 : 0.25,
          transition: 'opacity 80ms linear',
        }}
      >
        {w}
        {i < sourceWords.length - 1 ? ' ' : ''}
      </span>
    ));
  };

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, #1c2a3a 0%, #050a14 100%)',
        padding: '0 12px 12px',
        borderRadius: 6,
        border: '1px solid #2e2e2e',
        aspectRatio: '16 / 9',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 4,
        fontFamily: '"YouTube Sans","Roboto","Noto Sans KR",sans-serif',
        overflow: 'hidden',
      }}
    >
      {displayMode !== 'translation-only' && (
        <div
          style={{
            background: cueBg,
            padding: '4px 10px',
            borderRadius: 4,
            color: sourceStyle.color,
            fontSize: sourceFontSize,
            fontWeight: sourceStyle.fontWeight,
            lineHeight,
            textAlign: 'center',
            maxWidth: '90%',
          }}
        >
          <HistoryBlock texts={sourceHistoryTexts} layout={historyLayout} dim={dimHistory} />
          {renderSourceCurrent()}
        </div>
      )}
      {displayMode !== 'source-only' && (
        <div
          style={{
            background: cueBg,
            padding: '4px 10px',
            borderRadius: 4,
            color: targetStyle.color,
            fontSize: targetFontSize,
            fontWeight: targetStyle.fontWeight,
            lineHeight,
            textAlign: 'center',
            maxWidth: '90%',
          }}
        >
          <HistoryBlock texts={targetHistoryTexts} layout={historyLayout} dim={dimHistory} />
          {targetCurrent}
        </div>
      )}
    </div>
  );
}

function Preview({ settings }: { settings: Settings }) {
  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    color: '#999',
    fontWeight: 600,
    marginBottom: 4,
    letterSpacing: '0.3px',
  };
  const hintStyle: React.CSSProperties = {
    fontSize: 10,
    color: '#666',
    marginLeft: 6,
    fontWeight: 400,
    letterSpacing: 0,
  };
  return (
    <>
      <div style={{ fontSize: 10, color: '#666', marginBottom: 8, letterSpacing: '0.3px' }}>
        실제 옵션이 적용된 모습
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={labelStyle}>
            외국어 콘텐츠
            <span style={hintStyle}>원문 + 번역 (표시 모드 반영)</span>
          </div>
          <PreviewBox settings={settings} displayMode={settings.displayMode} />
        </div>
        <div>
          <div style={labelStyle}>
            모국어 콘텐츠
            <span style={hintStyle}>한 줄만 — 누적/줄 수/스타일 반영</span>
          </div>
          <PreviewBox settings={settings} displayMode="source-only" />
        </div>
      </div>
    </>
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

  // BYOK API 키 — settings(storage.sync)와 분리된 storage.local에서 관리.
  // Gemini와 Mindlogic 각각 독립적으로 입력/테스트.
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const keySaveTimerRef = useRef<number | null>(null);
  const [mindlogicApiKey, setMindlogicApiKeyState] = useState('');
  const [showMindlogicKey, setShowMindlogicKey] = useState(false);
  const mindlogicKeySaveTimerRef = useRef<number | null>(null);
  type TestState =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'ok'; translation: string }
    | { kind: 'err'; error: string };
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  const [mindlogicTestState, setMindlogicTestState] = useState<TestState>({ kind: 'idle' });

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
    void getCacheStats().then((s) => setCacheCount(s.count));
    void getGeminiApiKey().then((k) => setApiKey(k ?? ''));
    void getMindlogicApiKey().then((k) => setMindlogicApiKeyState(k ?? ''));
  }, []);

  // API 키 입력은 settings와 다른 storage area라 별도 디바운스 저장.
  // 300ms — 빠른 paste/타이핑 도중 부분 키 저장 방지.
  const onApiKeyChange = (v: string): void => {
    setApiKey(v);
    setTestState({ kind: 'idle' });
    if (keySaveTimerRef.current !== null) clearTimeout(keySaveTimerRef.current);
    keySaveTimerRef.current = window.setTimeout(() => {
      keySaveTimerRef.current = null;
      void setGeminiApiKey(v.trim() || null);
    }, 300);
  };

  const onTestGemini = async (): Promise<void> => {
    // 디바운스로 보류 중인 키 저장이 있으면 먼저 flush — 테스트 결과의 일관성 확보.
    if (keySaveTimerRef.current !== null) {
      clearTimeout(keySaveTimerRef.current);
      keySaveTimerRef.current = null;
      await setGeminiApiKey(apiKey.trim() || null);
    }
    setTestState({ kind: 'pending' });
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'TEST_GEMINI',
        apiKey: apiKey.trim(),
        model: settings.geminiModel,
      })) as { ok: true; translation: string } | { ok: false; error: string } | undefined;
      if (!res) setTestState({ kind: 'err', error: '백그라운드 응답 없음 — 확장 재로드' });
      else if (res.ok) setTestState({ kind: 'ok', translation: res.translation });
      else setTestState({ kind: 'err', error: res.error });
    } catch (e) {
      setTestState({ kind: 'err', error: e instanceof Error ? e.message : String(e) });
    }
  };

  const onMindlogicKeyChange = (v: string): void => {
    setMindlogicApiKeyState(v);
    setMindlogicTestState({ kind: 'idle' });
    if (mindlogicKeySaveTimerRef.current !== null) clearTimeout(mindlogicKeySaveTimerRef.current);
    mindlogicKeySaveTimerRef.current = window.setTimeout(() => {
      mindlogicKeySaveTimerRef.current = null;
      void setMindlogicApiKey(v.trim() || null);
    }, 300);
  };

  const onTestMindlogic = async (): Promise<void> => {
    if (mindlogicKeySaveTimerRef.current !== null) {
      clearTimeout(mindlogicKeySaveTimerRef.current);
      mindlogicKeySaveTimerRef.current = null;
      await setMindlogicApiKey(mindlogicApiKey.trim() || null);
    }
    setMindlogicTestState({ kind: 'pending' });
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'TEST_MINDLOGIC',
        apiKey: mindlogicApiKey.trim(),
        model: settings.mindlogicModel,
      })) as { ok: true; translation: string } | { ok: false; error: string } | undefined;
      if (!res)
        setMindlogicTestState({ kind: 'err', error: '백그라운드 응답 없음 — 확장 재로드' });
      else if (res.ok) setMindlogicTestState({ kind: 'ok', translation: res.translation });
      else setMindlogicTestState({ kind: 'err', error: res.error });
    } catch (e) {
      setMindlogicTestState({
        kind: 'err',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

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
    if (!confirm('저장된 번역을 모두 비울까요? 다음에 같은 영상을 봐도 다시 번역됨.')) return;
    const n = await clearCache();
    setCacheCount(0);
    alert(`${n}개 영상의 번역을 비움.`);
  };

  const onResetSettings = async (): Promise<void> => {
    if (!confirm('모든 옵션을 처음으로 되돌릴까요? 저장된 번역은 그대로 유지됨.')) return;
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

  // 슬라이더 값(퍼센트/배수)을 폰트 크기 'px' 값과 시각적으로 구분.
  // accent 색 + monospace로 "조절된 값"임을 한눈에 인식.
  const sliderValueStyle: React.CSSProperties = {
    fontSize: 12,
    color: '#ffa200',
    fontWeight: 600,
    fontFamily: 'ui-monospace, "Cascadia Code", Menlo, Consolas, monospace',
    minWidth: 44,
    display: 'inline-block',
  };

  if (!loaded) return <div style={{ padding: 24 }}>옵션 불러오는 중…</div>;

  return (
    <div
      style={{
        maxWidth: 1140,
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
      <p style={{ color: '#999', fontSize: 12, margin: '0 0 24px' }}>
        v{chrome.runtime.getManifest().version} · 여기서 바꾸면 YouTube 화면에 바로 적용됨
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 360px',
          gap: 32,
          alignItems: 'start',
        }}
      >
        <div>

      <Section title="자막 표시">
        <Row label="자막 켜기" hint="단축키 'C'">
          <input
            type="checkbox"
            checked={settings.subtitlesEnabled}
            onChange={(e) => update({ subtitlesEnabled: e.target.checked })}
          />
        </Row>
        <Row label="언어" hint="원문 → 번역문">
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
          <span style={{ color: '#777', fontSize: 13 }}>→</span>
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
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <label style={{ minWidth: 140, fontSize: 13, marginTop: 2 }}>번역 방식</label>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
              <input
                type="radio"
                checked={settings.backend === 'google-free'}
                onChange={() => update({ backend: 'google-free' as BackendId })}
                style={{ marginTop: 2 }}
              />
              <span>
                <div>
                  Google 무료{' '}
                  <span style={{ fontSize: 11, color: '#3ea6ff', marginLeft: 2 }}>추천</span>
                </div>
                <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
                  온라인 번역. 너무 자주 쓰면 잠깐 끊길 수 있음
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
                  오프라인 번역. 긴 문장은 살짝 어색할 수 있음
                </div>
              </span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
              <input
                type="radio"
                checked={settings.backend === 'gemini'}
                onChange={() => update({ backend: 'gemini' as BackendId })}
                style={{ marginTop: 2 }}
              />
              <span>
                <div>
                  Gemini (내 API 키){' '}
                  <span style={{ fontSize: 11, color: '#9eff9e', marginLeft: 2 }}>AI 번역</span>
                </div>
                <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
                  자연스러운 AI 번역. 본인 키 필요 (무료 한도 있음)
                </div>
              </span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
              <input
                type="radio"
                checked={settings.backend === 'mindlogic'}
                onChange={() => update({ backend: 'mindlogic' as BackendId })}
                style={{ marginTop: 2 }}
              />
              <span>
                <div>
                  Mindlogic Gateway (학교/조직 키){' '}
                  <span style={{ fontSize: 11, color: '#9eff9e', marginLeft: 2 }}>AI 번역</span>
                </div>
                <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
                  한 키로 Claude/GPT/Gemini 등 모델 선택 가능. 학교/조직 발급 키 필요
                </div>
              </span>
            </label>
          </div>
        </div>
        <Row label="노래방 모드 (원문 줄에 적용)">
          <input
            type="checkbox"
            checked={settings.wordRevealEnabled}
            onChange={(e) => update({ wordRevealEnabled: e.target.checked })}
          />
          <span style={{ fontSize: 12, color: '#999' }}>
            노래방처럼 실시간 자막 표시
          </span>
        </Row>
      </Section>

      {settings.backend === 'gemini' && (
        <Section title="Gemini 설정">
          <p style={{ fontSize: 12, color: '#999', margin: '-4px 0 4px' }}>
            본인 API 키로 동작.{' '}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer"
              style={{ color: '#3ea6ff' }}
            >
              Google AI Studio
            </a>
            에서 무료 발급 (가입만 하면 됨, 신용카드 불필요). 키는 이 PC에만 저장됨.
          </p>
          <Row label="API 키">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
              placeholder="AIza..."
              style={{ width: 280, fontFamily: 'monospace', fontSize: 12 }}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              onClick={() => setShowKey((v) => !v)}
              style={{ padding: '4px 10px', fontSize: 12 }}
              type="button"
            >
              {showKey ? '숨김' : '보기'}
            </button>
            {!apiKey.trim() && (
              <span style={{ fontSize: 11, color: '#ff7777' }}>
                키 없으면 Google 무료로 자동 fallback
              </span>
            )}
          </Row>
          <Row label="모델">
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input
                type="radio"
                checked={settings.geminiModel === 'flash'}
                onChange={() => update({ geminiModel: 'flash' as GeminiModel })}
              />
              <span>Flash (품질 우선)</span>
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer', marginLeft: 8 }}>
              <input
                type="radio"
                checked={settings.geminiModel === 'flash-lite'}
                onChange={() => update({ geminiModel: 'flash-lite' as GeminiModel })}
              />
              <span>Flash-Lite (한도·속도 우선)</span>
            </label>
          </Row>
          <Row label="키 확인">
            <button
              onClick={() => void onTestGemini()}
              disabled={!apiKey.trim() || testState.kind === 'pending'}
              style={{ padding: '4px 10px' }}
              type="button"
            >
              {testState.kind === 'pending' ? '테스트 중…' : '테스트'}
            </button>
            {testState.kind === 'ok' && (
              <span style={{ fontSize: 12, color: '#9eff9e' }}>
                ✓ 동작함 (예: "Hello, world." → "{testState.translation}")
              </span>
            )}
            {testState.kind === 'err' && (
              <span style={{ fontSize: 12, color: '#ff7777' }}>✗ {testState.error}</span>
            )}
          </Row>
        </Section>
      )}

      {settings.backend === 'mindlogic' && (
        <Section title="Mindlogic Gateway 설정">
          <p style={{ fontSize: 12, color: '#999', margin: '-4px 0 4px' }}>
            학교/조직 계정으로 발급된 키 하나로 Claude · GPT · Gemini 등 여러 모델을 쓸 수 있는
            게이트웨이. 키는 이 PC에만 저장됨.
          </p>
          <Row label="API 키">
            <input
              type={showMindlogicKey ? 'text' : 'password'}
              value={mindlogicApiKey}
              onChange={(e) => onMindlogicKeyChange(e.target.value)}
              placeholder="sk-... 또는 발급받은 키"
              style={{ width: 280, fontFamily: 'monospace', fontSize: 12 }}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              onClick={() => setShowMindlogicKey((v) => !v)}
              style={{ padding: '4px 10px', fontSize: 12 }}
              type="button"
            >
              {showMindlogicKey ? '숨김' : '보기'}
            </button>
            {!mindlogicApiKey.trim() && (
              <span style={{ fontSize: 11, color: '#ff7777' }}>
                키 없으면 Google 무료로 자동 fallback
              </span>
            )}
          </Row>
          <Row label="모델">
            <select
              value={settings.mindlogicModel}
              onChange={(e) =>
                update({ mindlogicModel: e.target.value as MindlogicModel })
              }
            >
              {MINDLOGIC_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label} — {m.hint}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 11, color: '#999' }}>
              계정에 권한 없으면 해당 모델은 인증 실패 → Google 무료로 fallback
            </span>
          </Row>
          <Row label="키 확인">
            <button
              onClick={() => void onTestMindlogic()}
              disabled={!mindlogicApiKey.trim() || mindlogicTestState.kind === 'pending'}
              style={{ padding: '4px 10px' }}
              type="button"
            >
              {mindlogicTestState.kind === 'pending' ? '테스트 중…' : '테스트'}
            </button>
            {mindlogicTestState.kind === 'ok' && (
              <span style={{ fontSize: 12, color: '#9eff9e' }}>
                ✓ 동작함 (예: "Hello, world." → "{mindlogicTestState.translation}")
              </span>
            )}
            {mindlogicTestState.kind === 'err' && (
              <span style={{ fontSize: 12, color: '#ff7777' }}>
                ✗ {mindlogicTestState.error}
              </span>
            )}
          </Row>
        </Section>
      )}

      <Section title="Single Subtitle (한 줄만 보일 때 적용)">
        <p style={{ fontSize: 12, color: '#999', margin: '-4px 0 4px' }}>
          모국어 영상이나 '번역만' / '원문만' 모드에서 — 직전 자막도 계속 보여줘서 흐름이 끊기지 않음
        </p>
        <Row label="이전 자막 포함한 전체줄 수">
          <select
            value={settings.singleContextLines}
            onChange={(e) => update({ singleContextLines: Number(e.target.value) })}
          >
            <option value={1}>한 줄만</option>
            <option value={2}>두 줄 (지금 + 바로 앞)</option>
            <option value={3}>세 줄 (지금 + 앞 두 줄)</option>
          </select>
        </Row>
        {settings.singleContextLines > 1 && (
          <>
            <Row label="쌓는 방식">
              <select
                value={settings.historyLayout}
                onChange={(e) => update({ historyLayout: e.target.value as HistoryLayout })}
              >
                <option value="stacked">줄로 쌓기</option>
                <option value="inline">한 문단처럼 이어 보기</option>
              </select>
            </Row>
            {settings.historyLayout === 'stacked' && (
              <Row label="지난 줄 흐리게 표시">
                <input
                  type="checkbox"
                  checked={settings.dimHistory}
                  onChange={(e) => update({ dimHistory: e.target.checked })}
                />
                <span style={{ fontSize: 12, color: '#999' }}>
                  지금 말하는 줄이 더 잘 보이게 설정
                </span>
              </Row>
            )}
          </>
        )}
      </Section>

      <Section title="자막 스타일">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <StyleEditor
              label="1. 원문 자막"
              style={settings.sourceStyle}
              onChange={(sourceStyle) => update({ sourceStyle })}
            />
            <StyleEditor
              label="2. 번역 자막"
              style={settings.targetStyle}
              onChange={(targetStyle) => update({ targetStyle })}
            />
            {/* 위 두 StyleEditor와 아래 슬라이더 그룹을 시각적으로 분리.
                슬라이더 값은 monospace + accent 색으로 표시해 폰트 크기(px)와 구분. */}
            <div
              style={{
                height: 1,
                background: '#2e2e2e',
                margin: '6px 0 2px',
              }}
            />
            <Row label="쇼츠 자막 크기" hint="100%면 일반 영상이랑 같음">
              <input
                type="range"
                min={0.5}
                max={1.8}
                step={0.05}
                value={settings.shortsFontScale}
                onChange={(e) => update({ shortsFontScale: Number(e.target.value) })}
                style={{ width: 200 }}
              />
              <span style={sliderValueStyle}>
                {Math.round(settings.shortsFontScale * 100)}%
              </span>
            </Row>
            <Row label="자막 배경 진하기" hint="올릴수록 진해짐">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.backgroundOpacity}
                onChange={(e) => update({ backgroundOpacity: Number(e.target.value) })}
                style={{ width: 200 }}
              />
              <span style={sliderValueStyle}>
                {Math.round(settings.backgroundOpacity * 100)}%
              </span>
            </Row>
            <Row label="원문과 번역 사이">
              <input
                type="range"
                min={1}
                max={2}
                step={0.05}
                value={settings.lineHeight}
                onChange={(e) => update({ lineHeight: Number(e.target.value) })}
                style={{ width: 200 }}
              />
              <span style={sliderValueStyle}>{settings.lineHeight.toFixed(2)}</span>
            </Row>
            {/* 자막 위치 — Row 컴포넌트 대신 수동 레이아웃.
                라벨·Reset이 두 줄 설명의 세로 중앙(두 줄 사이)에 위치하도록 alignItems: center. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <label style={{ minWidth: 140, fontSize: 13 }}>자막 위치</label>
              <button
                onClick={() =>
                  update({ subtitlePosition: DEFAULT_SETTINGS.subtitlePosition })
                }
                style={{ padding: '4px 10px' }}
              >
                Reset
              </button>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  fontSize: 11,
                  color: '#999',
                }}
              >
                <div>· 자막 드래그 = 이동</div>
                <div>· 마우스 휠 = 크기 조절</div>
              </div>
            </div>
        </div>
      </Section>

      <Section title="관리">
        <Row label="저장된 번역">
          <button onClick={onClearCache} style={{ padding: '4px 10px' }}>
            비우기
          </button>
          <span style={{ fontSize: 12, color: '#999' }}>
            현재 {cacheCount ?? '…'}개 영상 저장
          </span>
        </Row>
        <div
          style={{
            marginTop: 8,
            paddingTop: 12,
            borderTop: '1px dashed #3a2a2a',
          }}
        >
          <Row label="옵션 초기화" hint="모든 옵션 초기화">
            <button onClick={onResetSettings} style={dangerButtonStyle}>
              초기화
            </button>
          </Row>
        </div>
      </Section>
        </div>
        <div style={{ position: 'sticky', top: 24 }}>
          <div style={{ fontSize: 12, color: '#999', marginBottom: 6 }}>미리보기</div>
          <Preview settings={settings} />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
