import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DEFAULT_EXPLAIN_PROMPT,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type BackendId,
  type CueStyle,
  type DisplayMode,
  type HistoryLayout,
  type Settings,
  type SourceLang,
  type TargetLang,
} from '../shared/settings';
import {
  DISPLAY_MODES,
  GEMINI_MODELS,
  MINDLOGIC_MODELS,
  SOURCE_LANGS,
  TARGET_LANGS,
} from '../shared/lang-options';
import { clearCache, getCacheStats } from '../shared/cache/idb-cache';
import {
  getGeminiApiKey,
  getMindlogicApiKey,
  getNotionToken,
  setGeminiApiKey,
  setMindlogicApiKey,
  setNotionToken,
} from '../shared/secrets';

const WEIGHTS: Array<{ value: 400 | 500 | 700; label: string }> = [
  { value: 400, label: '보통' },
  { value: 500, label: '약간 굵게' },
  { value: 700, label: '굵게' },
];

// 하위 항목 계층 마커. 옛 `·`(middle dot)는 13px 텍스트에 껴서 안 보여 `•`(bullet)로 키움.
function Bullet() {
  return <span style={{ color: '#9a9a9a', marginRight: 6, fontSize: 15 }}>•</span>;
}

// 섹션별 초기화 대상 키 — 해당 섹션 값만 default로 되돌리고 나머지(언어/백엔드/해설 등)는 유지.
// "자막 스타일" = 원문/번역 텍스트 스타일(크기·색·굵기).
const TEXT_STYLE_KEYS = [
  'sourceStyle',
  'targetStyle',
] as const satisfies readonly (keyof Settings)[];
// "자막 배치 · 배경" = 쇼츠 크기·배경 진하기·줄 간격·자막 위치.
const LAYOUT_KEYS = [
  'shortsFontScale',
  'backgroundOpacity',
  'lineHeight',
  'subtitlePosition',
] as const satisfies readonly (keyof Settings)[];

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
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
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span>{title}</span>
        {action}
      </h2>
      {/* 하위 항목은 들여쓰기 + 행 앞 불릿(·, Row 내부)으로 제목과 시각 구분. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 10 }}>
        {children}
      </div>
    </section>
  );
}

// 섹션 제목 옆 초기화 아이콘 — 해당 섹션의 값만 기본값으로 되돌린다. title 속성으로 무엇을
// 되돌리는지 툴팁 안내. 노란 제목 옆에 두는 게 "이 섹션을 초기화"임이 직관적(전역 옵션
// 초기화는 맨 아래 별도 버튼).
function ResetIcon({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      type="button"
      style={{
        fontSize: 13,
        lineHeight: 1,
        padding: '3px 8px',
        color: '#bbb',
        background: 'transparent',
        border: '1px solid #3a3a3a',
        borderRadius: 6,
        cursor: 'pointer',
        fontWeight: 400,
      }}
    >
      ↻ 초기화
    </button>
  );
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {/* 라벨 앞 불릿(·)으로 "제목의 하위 항목"임을 표시. 빈 라벨(힌트 전용 행)은 불릿 생략. */}
      <label style={{ minWidth: 140, fontSize: 13 }}>
        {label && <Bullet />}
        {label}
      </label>
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
      {/* 크기·색·굵기는 위 그룹 라벨(1.원문/2.번역)의 하위 — 한 단계 더 들여쓰기(각 행 앞 불릿). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 24 }}>
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
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={labelStyle}>이중 자막</div>
          <PreviewBox settings={settings} displayMode={settings.displayMode} />
        </div>
        <div>
          <div style={labelStyle}>이중 자막이 아닐때</div>
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

  // Notion integration 토큰 — storage.local(secrets). DB ID는 settings(storage.sync).
  const [notionToken, setNotionTokenState] = useState('');
  const [showNotionToken, setShowNotionToken] = useState(false);
  const notionTokenSaveTimerRef = useRef<number | null>(null);
  type NotionTestState =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'ok'; dbTitle: string }
    | { kind: 'err'; error: string };
  const [notionTestState, setNotionTestState] = useState<NotionTestState>({ kind: 'idle' });

  // 동적 모델 목록 — 제공자 /models로 가져와 storage.local에 캐시(설정 아님 — 휘발성 런타임
  // 데이터). null=아직 안 가져옴(하드코딩 추천 목록으로 fallback). Mindlogic·Gemini 동일 패턴.
  type ModelInfo = { id: string; ownedBy: string };
  const [mindlogicModels, setMindlogicModels] = useState<ModelInfo[] | null>(null);
  const [geminiModels, setGeminiModels] = useState<ModelInfo[] | null>(null);
  type ModelsFetch =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'ok'; count: number }
    | { kind: 'err'; error: string };
  const [modelsFetch, setModelsFetch] = useState<ModelsFetch>({ kind: 'idle' });
  const [geminiModelsFetch, setGeminiModelsFetch] = useState<ModelsFetch>({ kind: 'idle' });

  useEffect(() => {
    void loadSettings().then((s) => {
      // 해설 백엔드는 번역 방식(AI)을 따라감(라디오 제거) — 저장값이 어긋나 있으면 정규화.
      const aiBackend: 'gemini' | 'mindlogic' | null =
        s.backend === 'gemini' ? 'gemini' : s.backend === 'mindlogic' ? 'mindlogic' : null;
      const norm = aiBackend && s.explainBackend !== aiBackend ? { ...s, explainBackend: aiBackend } : s;
      setSettings(norm);
      if (norm !== s) void saveSettings({ explainBackend: norm.explainBackend });
      setLoaded(true);
    });
    void getCacheStats().then((s) => setCacheCount(s.count));
    void getGeminiApiKey().then((k) => setApiKey(k ?? ''));
    void getMindlogicApiKey().then((k) => setMindlogicApiKeyState(k ?? ''));
    void getNotionToken().then((k) => setNotionTokenState(k ?? ''));
    void chrome.storage.local.get(['ydtMindlogicModels', 'ydtGeminiModels']).then((r) => {
      if (Array.isArray(r.ydtMindlogicModels)) setMindlogicModels(r.ydtMindlogicModels);
      if (Array.isArray(r.ydtGeminiModels)) setGeminiModels(r.ydtGeminiModels);
    });
  }, []);

  // 제공자에서 사용 가능한 모델 목록을 가져와 캐시. 키 저장이 보류 중이면 먼저 flush.
  // Mindlogic·Gemini가 같은 흐름(메시지 타입·키·캐시 키만 다름)이라 한 함수로 묶음.
  const refreshModels = async (
    provider: 'mindlogic' | 'gemini',
  ): Promise<void> => {
    const isGemini = provider === 'gemini';
    const apiKeyVal = isGemini ? apiKey : mindlogicApiKey;
    const keyTimerRef = isGemini ? keySaveTimerRef : mindlogicKeySaveTimerRef;
    const setKey = isGemini ? setGeminiApiKey : setMindlogicApiKey;
    const setFetch = isGemini ? setGeminiModelsFetch : setModelsFetch;
    const setModels = isGemini ? setGeminiModels : setMindlogicModels;
    const msgType = isGemini ? 'GEMINI_LIST_MODELS' : 'MINDLOGIC_LIST_MODELS';
    const cacheKey = isGemini ? 'ydtGeminiModels' : 'ydtMindlogicModels';

    if (keyTimerRef.current !== null) {
      clearTimeout(keyTimerRef.current);
      keyTimerRef.current = null;
      await setKey(apiKeyVal.trim() || null);
    }
    setFetch({ kind: 'pending' });
    try {
      const res = (await chrome.runtime.sendMessage({
        type: msgType,
        apiKey: apiKeyVal.trim(),
      })) as { ok: true; models: ModelInfo[] } | { ok: false; error: string } | undefined;
      if (!res) setFetch({ kind: 'err', error: '백그라운드 응답 없음 — 확장 재로드' });
      else if (res.ok) {
        await chrome.storage.local.set({ [cacheKey]: res.models });
        setModels(res.models);
        setFetch({ kind: 'ok', count: res.models.length });
      } else setFetch({ kind: 'err', error: res.error });
    } catch (e) {
      setFetch({ kind: 'err', error: e instanceof Error ? e.message : String(e) });
    }
  };

  // 모델 <select> — 동적 목록(있으면) 또는 하드코딩 추천 목록을 owner별 그룹으로 렌더.
  // forExplain=true면 해설 추천 마커, false면 번역 추천 마커. 현재 선택값이 목록에 없으면 추가.
  // Mindlogic·Gemini 공용(curated 힌트 목록 + 동적 목록만 주입 차이).
  const renderModelSelect = (
    value: string,
    onChange: (v: string) => void,
    forExplain: boolean,
    dynamic: ModelInfo[] | null,
    curated: Array<{ value: string; transHint: string; explainHint?: string }>,
  ): React.ReactNode => {
    const known = new Map(curated.map((m) => [m.value, m]));
    let base: ModelInfo[] =
      dynamic && dynamic.length
        ? dynamic
        : curated.map((m) => ({ id: m.value, ownedBy: '추천' }));
    if (!base.some((x) => x.id === value)) base = [{ id: value, ownedBy: '현재' }, ...base];
    const groups = new Map<string, ModelInfo[]>();
    for (const it of base) {
      const arr = groups.get(it.ownedBy) ?? [];
      arr.push(it);
      groups.set(it.ownedBy, arr);
    }
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {[...groups.entries()].map(([owner, items]) => (
          <optgroup key={owner} label={owner}>
            {items.map((it) => {
              const hint = forExplain ? known.get(it.id)?.explainHint : known.get(it.id)?.transHint;
              return (
                <option key={it.id} value={it.id}>
                  {it.id}
                  {hint ? ` — ${hint}` : ''}
                </option>
              );
            })}
          </optgroup>
        ))}
      </select>
    );
  };
  const renderMindlogicSelect = (
    value: string,
    onChange: (v: string) => void,
    forExplain: boolean,
  ): React.ReactNode =>
    renderModelSelect(value, onChange, forExplain, mindlogicModels, MINDLOGIC_MODELS);
  const renderGeminiSelect = (
    value: string,
    onChange: (v: string) => void,
    forExplain: boolean,
  ): React.ReactNode => renderModelSelect(value, onChange, forExplain, geminiModels, GEMINI_MODELS);

  // 모델 새로고침 버튼 + 결과 표시(번역/해설 모델 행에서 재사용).
  const modelRefreshControls = (
    provider: 'mindlogic' | 'gemini',
  ): React.ReactNode => {
    const isGemini = provider === 'gemini';
    const apiKeyVal = isGemini ? apiKey : mindlogicApiKey;
    const fetchState = isGemini ? geminiModelsFetch : modelsFetch;
    return (
      <>
        <button
          onClick={() => void refreshModels(provider)}
          disabled={!apiKeyVal.trim() || fetchState.kind === 'pending'}
          style={{ padding: '4px 10px', fontSize: 12 }}
          type="button"
          title="제공자에서 사용 가능한 모델 목록을 다시 가져옵니다"
        >
          {fetchState.kind === 'pending' ? '불러오는 중…' : '↻ 모델 새로고침'}
        </button>
        {fetchState.kind === 'ok' && (
          <span style={{ fontSize: 11, color: '#9eff9e' }}>✓ {fetchState.count}개</span>
        )}
        {fetchState.kind === 'err' && (
          <span style={{ fontSize: 11, color: '#ff7777' }}>✗ {fetchState.error}</span>
        )}
      </>
    );
  };

  // 번역 모델 설명 — 해설 모델 설명(renderExplainBlock 내 <p>)과 짝을 이루는 안내.
  // 자막 전체를 번역하는 용도라 "많은 문장 = 가성비" 관점을 강조. Gemini/Mindlogic 공용.
  const transModelHint = (
    <p style={{ fontSize: 12, color: '#999', margin: '2px 0 4px 152px' }}>
      영상 자막 전체를 번역할 때 쓰는 모델이에요. 문장이 많으니 빠르고 저렴한 모델이 잘 맞아요.
    </p>
  );

  // 해설 모델 + 해설 프롬프트 블록 — 활성 provider(Gemini/Mindlogic) 섹션 하단에 붙여
  // "번역 모델 바로 아래 해설 모델"로 연계. 프롬프트(공용 explainPrompt)도 여기서 편집.
  // provider마다 렌더되지만 화면엔 활성 섹션 하나만 떠서 중복 노출 없음.
  const renderExplainBlock = (provider: 'gemini' | 'mindlogic'): React.ReactNode => (
    <>
      <Row label="해설 모델">
        {provider === 'gemini'
          ? renderGeminiSelect(
              settings.explainGeminiModel,
              (v) => update({ explainGeminiModel: v }),
              true,
            )
          : renderMindlogicSelect(
              settings.explainMindlogicModel,
              (v) => update({ explainMindlogicModel: v }),
              true,
            )}
      </Row>
      <p style={{ fontSize: 12, color: '#999', margin: '2px 0 4px 152px' }}>
        영상에서 자막을 드래그하면 <b style={{ color: '#3ea6ff' }}>💡 해설</b> ·{' '}
        <b style={{ color: '#3ea6ff' }}>❓ 질문</b> 버튼이 떠요. 가끔 한 번씩만 부르니 조금 느려도 똑똑한 모델이 잘 맞아요.
      </p>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <label style={{ minWidth: 140, fontSize: 13, marginTop: 2 }}>
          <Bullet />해설 프롬프트
        </label>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            value={settings.explainPrompt}
            onChange={(e) => update({ explainPrompt: e.target.value })}
            rows={9}
            spellCheck={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontFamily: 'inherit',
              fontSize: 12,
              lineHeight: 1.5,
              color: '#e8e8e8',
              background: '#1c1c1c',
              border: '1px solid #333',
              borderRadius: 6,
              padding: 8,
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => update({ explainPrompt: DEFAULT_EXPLAIN_PROMPT })}
              disabled={settings.explainPrompt === DEFAULT_EXPLAIN_PROMPT}
              style={{ padding: '4px 10px', fontSize: 12 }}
              type="button"
            >
              기본값으로
            </button>
          </div>
        </div>
      </div>
    </>
  );

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

  const onNotionTokenChange = (v: string): void => {
    setNotionTokenState(v);
    setNotionTestState({ kind: 'idle' });
    if (notionTokenSaveTimerRef.current !== null) clearTimeout(notionTokenSaveTimerRef.current);
    notionTokenSaveTimerRef.current = window.setTimeout(() => {
      notionTokenSaveTimerRef.current = null;
      void setNotionToken(v.trim() || null);
    }, 300);
  };

  const onTestNotion = async (): Promise<void> => {
    // 보류 중인 토큰 저장 flush — 테스트는 background가 secrets에서 토큰을 읽지 않고
    // 메시지로 받은 token을 직접 검증하므로 입력값을 그대로 보냄(저장은 동기화만).
    if (notionTokenSaveTimerRef.current !== null) {
      clearTimeout(notionTokenSaveTimerRef.current);
      notionTokenSaveTimerRef.current = null;
      await setNotionToken(notionToken.trim() || null);
    }
    setNotionTestState({ kind: 'pending' });
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'TEST_NOTION',
        token: notionToken.trim(),
        databaseId: settings.notionDatabaseId.trim(),
      })) as { ok: true; dbTitle: string } | { ok: false; error: string } | undefined;
      if (!res) setNotionTestState({ kind: 'err', error: '백그라운드 응답 없음 — 확장 재로드' });
      else if (res.ok) setNotionTestState({ kind: 'ok', dbTitle: res.dbTitle });
      else setNotionTestState({ kind: 'err', error: res.error });
    } catch (e) {
      setNotionTestState({ kind: 'err', error: e instanceof Error ? e.message : String(e) });
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

  // 주어진 키들만 default 값으로 되돌리는 patch 생성 → 기존 update() 배선(디바운스 저장·즉시
  // 반영)을 그대로 탄다. 키별 타입 좁히기 대신 Record 캐스트로 단순화.
  const resetKeys = (keys: readonly (keyof Settings)[], message: string): void => {
    if (!confirm(message)) return;
    const patch: Partial<Settings> = {};
    for (const k of keys) (patch as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
    update(patch);
  };
  const onResetTextStyle = (): void =>
    resetKeys(TEXT_STYLE_KEYS, '원문·번역 자막 스타일(크기·색·굵기)을 기본값으로 되돌릴까요?');
  const onResetLayout = (): void =>
    resetKeys(
      LAYOUT_KEYS,
      '쇼츠 자막 크기·배경 진하기·줄 간격·자막 위치를 기본값으로 되돌릴까요?',
    );

  const dangerButtonStyle: React.CSSProperties = {
    padding: '4px 10px',
    borderColor: '#6b2a2a',
    color: '#ffb3b3',
  };

  // 테스트 버튼 — 바로 옆 '보기/숨김'(중립 회색)과 헷갈리지 않게 파란 accent 테두리·글자 +
  // 🧪 기호로 "동작 확인" 액션임을 구분. 세 곳(Gemini·Mindlogic·Notion) 공용.
  const testButtonStyle: React.CSSProperties = {
    padding: '4px 10px',
    fontSize: 12,
    borderColor: '#2a4a6b',
    color: '#8fc7ff',
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

  // Gemini·Mindlogic 키 설정 섹션은 제공자별로 표시 — 번역방식 라디오나 해설 백엔드 라디오
  // 둘 중 어느 곳에서든 그 제공자를 고르면 해당 설정만 펼쳐진다("고른 것만 나온다"). 해설은
  // 상시 on이고 키가 필요하므로 해설 백엔드도 반영해야 키 입력 경로가 안 끊긴다.
  const showGemini =
    settings.backend === 'gemini' || settings.explainBackend === 'gemini';
  const showMindlogic =
    settings.backend === 'mindlogic' || settings.explainBackend === 'mindlogic';

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
      <h1 style={{ fontSize: 22, margin: '0 0 24px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span>YouTube Dual Subtitle</span>
        <span style={{ color: '#999', fontSize: 12, fontWeight: 400 }}>
          v{chrome.runtime.getManifest().version}
        </span>
        {saveState === 'pending' && (
          <span style={{ fontSize: 11, color: '#888', fontWeight: 400 }}>저장 중…</span>
        )}
        {saveState === 'saved' && (
          <span style={{ fontSize: 11, color: '#3ea6ff', fontWeight: 400 }}>● 저장됨</span>
        )}
      </h1>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 360px',
          gap: 32,
          alignItems: 'start',
        }}
      >
        <div>

      <Section title="이중 자막 설정">
        <Row label="자막 켜기" hint="단축키 'C'">
          <input
            type="checkbox"
            checked={settings.subtitlesEnabled}
            onChange={(e) => update({ subtitlesEnabled: e.target.checked })}
          />
        </Row>
        <Row label="원문 → 번역문">
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
        <Row label="노래방 모드">
          <input
            type="checkbox"
            checked={settings.wordRevealEnabled}
            onChange={(e) => update({ wordRevealEnabled: e.target.checked })}
          />
        </Row>
      </Section>

      <Section title="이중 자막이 아닐때">
        <Row label="표시 자막 수">
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

      <Section
        title="자막 스타일"
        action={
          <ResetIcon
            onClick={onResetTextStyle}
            title="원문·번역 텍스트 스타일(크기·색·굵기)을 기본값으로"
          />
        }
      >
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
      </Section>

      <Section
        title="자막 배치 · 배경"
        action={
          <ResetIcon
            onClick={onResetLayout}
            title="쇼츠 크기·배경·줄 간격·자막 위치를 기본값으로"
          />
        }
      >
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
                위치 초기화는 섹션 제목 옆 ↻(자막 배치·배경 그룹)에 통합. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <label style={{ minWidth: 140, fontSize: 13 }}>
                <Bullet />자막 위치
              </label>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  fontSize: 11,
                  color: '#999',
                }}
              >
                <div>• 자막 드래그 = 이동</div>
                <div>• 마우스 휠 = 크기 조절</div>
              </div>
            </div>
      </Section>

      <Section title="번역 방식">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
              onChange={() => update({ backend: 'gemini' as BackendId, explainBackend: 'gemini' })}
              style={{ marginTop: 2 }}
            />
            <span>
              <div>
                Gemini (내 API 키){' '}
                <span style={{ fontSize: 11, color: '#9eff9e', marginLeft: 2 }}>AI 번역</span>
              </div>
              <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{ color: '#3ea6ff' }}
                >
                  Google AI Studio
                </a>
                에서 무료 발급 가능
              </div>
            </span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
            <input
              type="radio"
              checked={settings.backend === 'mindlogic'}
              onChange={() => update({ backend: 'mindlogic' as BackendId, explainBackend: 'mindlogic' })}
              style={{ marginTop: 2 }}
            />
            <span>
              <div>
                Mindlogic Gateway (학교/조직 키){' '}
                <span style={{ fontSize: 11, color: '#9eff9e', marginLeft: 2 }}>AI 번역</span>
              </div>
              <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
                학교/조직 계정으로 발급된 키 하나로 Claude · GPT · Gemini 등 여러 모델 사용 가능
              </div>
            </span>
          </label>
        </div>
      </Section>

      {showGemini && (
        <Section title="Gemini 설정">
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
              {showKey ? '🙈 숨김' : '👁 보기'}
            </button>
            <button
              onClick={() => void onTestGemini()}
              disabled={!apiKey.trim() || testState.kind === 'pending'}
              style={testButtonStyle}
              type="button"
            >
              {testState.kind === 'pending' ? '테스트 중…' : '🧪 테스트'}
            </button>
            {testState.kind === 'ok' && (
              <span style={{ fontSize: 12, color: '#9eff9e' }}>
                ✓ 동작함 (예: "Hello, world." → "{testState.translation}")
              </span>
            )}
            {testState.kind === 'err' && (
              <span style={{ fontSize: 12, color: '#ff7777' }}>✗ {testState.error}</span>
            )}
            {!apiKey.trim() && (
              <span style={{ fontSize: 11, color: '#ff7777' }}>
                키 없으면 Google 무료로 자동 fallback
              </span>
            )}
          </Row>
          <p style={{ fontSize: 11, color: '#888', margin: '2px 0 4px 152px' }}>
            가입만 하면 무료로 발급되고 신용카드도 필요 없어요. 키는 이 PC에만 저장돼요(다른 기기로 동기화 안 됨).
          </p>
          <Row label="번역 모델">
            {renderGeminiSelect(settings.geminiModel, (v) => update({ geminiModel: v }), false)}
            {modelRefreshControls('gemini')}
          </Row>
          {transModelHint}
          {renderExplainBlock('gemini')}
        </Section>
      )}

      {showMindlogic && (
        <Section title="Mindlogic Gateway 설정">
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
              {showMindlogicKey ? '🙈 숨김' : '👁 보기'}
            </button>
            <button
              onClick={() => void onTestMindlogic()}
              disabled={!mindlogicApiKey.trim() || mindlogicTestState.kind === 'pending'}
              style={testButtonStyle}
              type="button"
            >
              {mindlogicTestState.kind === 'pending' ? '테스트 중…' : '🧪 테스트'}
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
            {!mindlogicApiKey.trim() && (
              <span style={{ fontSize: 11, color: '#ff7777' }}>
                키 없으면 Google 무료로 자동 fallback
              </span>
            )}
          </Row>
          <p style={{ fontSize: 11, color: '#888', margin: '2px 0 4px 152px' }}>
            학교/조직에서 발급받은 키를 붙여넣으세요. 키는 이 PC에만 저장돼요(다른 기기로 동기화 안 됨).
          </p>
          <Row label="번역 모델">
            {renderMindlogicSelect(settings.mindlogicModel, (v) => update({ mindlogicModel: v }), false)}
            {modelRefreshControls('mindlogic')}
          </Row>
          {transModelHint}
          {renderExplainBlock('mindlogic')}
        </Section>
      )}

      <Section title="Notion 저장 (해설 패널)">
        <p style={{ fontSize: 12, color: '#999', margin: '-4px 0 4px' }}>
          <b style={{ color: '#3ea6ff' }}>📝 Notion</b> 버튼으로 DB에 바로 저장하려면 아래를 설정하세요.
        </p>
        <ol style={{ fontSize: 11, color: '#999', margin: '2px 0 6px', paddingLeft: 18, lineHeight: 1.7 }}>
          <li>
            <a
              href="https://www.notion.so/my-integrations"
              target="_blank"
              rel="noreferrer"
              style={{ color: '#3ea6ff' }}
            >
              notion.so/my-integrations
            </a>
            에서 integration 만들고 <b>Internal Integration Secret</b> 복사
          </li>
          <li>저장할 데이터베이스 페이지 → 우측 ⋯ → <b>연결(Connections)</b>에 그 integration 추가</li>
          <li>그 데이터베이스의 URL을 아래 "DB ID/URL"에 붙여넣기</li>
        </ol>
        <Row label="Integration 토큰">
          <input
            type={showNotionToken ? 'text' : 'password'}
            value={notionToken}
            onChange={(e) => onNotionTokenChange(e.target.value)}
            placeholder="ntn_... 또는 secret_..."
            style={{ width: 280, fontFamily: 'monospace', fontSize: 12 }}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            onClick={() => setShowNotionToken((v) => !v)}
            style={{ padding: '4px 10px', fontSize: 12 }}
            type="button"
          >
            {showNotionToken ? '🙈 숨김' : '👁 보기'}
          </button>
        </Row>
        <p style={{ fontSize: 11, color: '#888', margin: '2px 0 4px 152px' }}>
          위 1번에서 복사한 Internal Integration Secret을 붙여넣으세요. 토큰은 이 PC에만 저장돼요.
        </p>
        <Row label="DB ID/URL">
          <input
            type="text"
            value={settings.notionDatabaseId}
            onChange={(e) => update({ notionDatabaseId: e.target.value })}
            placeholder="https://notion.so/...?v=... 또는 32자리 ID"
            style={{ width: 280, fontFamily: 'monospace', fontSize: 12 }}
            autoComplete="off"
            spellCheck={false}
          />
        </Row>
        <p style={{ fontSize: 11, color: '#888', margin: '2px 0 4px 152px' }}>
          저장할 데이터베이스 페이지의 주소(URL)를 통째로 붙여넣어도 자동으로 ID를 인식해요.
        </p>
        <Row label="연결 확인">
          <button
            onClick={() => void onTestNotion()}
            disabled={
              !notionToken.trim() ||
              !settings.notionDatabaseId.trim() ||
              notionTestState.kind === 'pending'
            }
            style={testButtonStyle}
            type="button"
          >
            {notionTestState.kind === 'pending' ? '확인 중…' : '🧪 테스트'}
          </button>
          {notionTestState.kind === 'ok' && (
            <span style={{ fontSize: 12, color: '#9eff9e' }}>
              ✓ 연결됨 (DB: "{notionTestState.dbTitle}")
            </span>
          )}
          {notionTestState.kind === 'err' && (
            <span style={{ fontSize: 12, color: '#ff7777' }}>✗ {notionTestState.error}</span>
          )}
        </Row>
      </Section>

      <Section title="관리">
        <Row label="저장된 번역">
          <button onClick={onClearCache} style={{ padding: '4px 10px' }}>
            캐시 비우기
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
          <div style={{ fontSize: 18, color: '#ffa200', fontWeight: 700, marginBottom: 10 }}>
            미리보기
          </div>
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
