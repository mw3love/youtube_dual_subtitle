import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DEFAULT_SETTINGS,
  defaultExplainPrompt,
  loadSettings,
  saveSettings,
  browserDefaults,
  type BackendId,
  type CueStyle,
  type DisplayMode,
  type HistoryLayout,
  type Settings,
  type TargetLang,
} from '../shared/settings';
import { displayModes, GEMINI_MODELS, MINDLOGIC_MODELS, TARGET_LANGS } from '../shared/lang-options';
import { setUiLang, t, type MsgKey, type UiLang } from '../shared/i18n';
import { clearCache, getCacheStats } from '../shared/cache/idb-cache';
import {
  getGeminiApiKey,
  getMindlogicApiKey,
  getNotionToken,
  setGeminiApiKey,
  setMindlogicApiKey,
  setNotionToken,
} from '../shared/secrets';

const weights = (): Array<{ value: 400 | 500 | 700; label: string }> => [
  { value: 400, label: t('weight.400') },
  { value: 500, label: t('weight.500') },
  { value: 700, label: t('weight.700') },
];

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

// 섹션 = 작은 제목(+ 섹션 초기화 버튼) + 카드(A76). id는 왼쪽 목차의 이동 목표.
function Section({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="sec">
      <h2 className="sec-head">
        <span>{title}</span>
        {action}
      </h2>
      <div className="card">{children}</div>
    </section>
  );
}

// 섹션 제목 옆 초기화 버튼 — 해당 섹션의 값만 기본값으로 되돌린다. title 속성으로 무엇을
// 되돌리는지 툴팁 안내(전역 옵션 초기화는 맨 아래 별도 버튼).
function ResetIcon({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button onClick={onClick} title={title} type="button">
      {t('opt.reset')}
    </button>
  );
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="row">
      <label className="row-label">{label}</label>
      <div className="row-body">
        {children}
        {hint && <span className="hint">{hint}</span>}
      </div>
    </div>
  );
}

// 몇 개 중 하나를 고르는 값 — 드롭다운 대신 칩(누르면 바로 바뀜, 선택지가 다 보임).
function Chips<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="chips" role="group">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={`chip${o.value === value ? ' on' : ''}`}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="group-chip">{label}</div>
      {/* 크기·색·굵기는 위 그룹 라벨(1.원문/2.번역)의 하위 — 한 단계 들여쓰기. */}
      <div className="group-body">
        <Row label={t('style.size')}>
          <input
            type="number"
            min={8}
            max={72}
            value={style.fontSize}
            onChange={(e) => onChange({ ...style, fontSize: Number(e.target.value) || 22 })}
            style={{ width: 70 }}
          />
          <span className="hint">px</span>
        </Row>
        <Row label={t('style.color')}>
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
        <Row label={t('style.weight')}>
          <select
            value={style.fontWeight}
            onChange={(e) =>
              onChange({ ...style, fontWeight: Number(e.target.value) as CueStyle['fontWeight'] })
            }
          >
            {weights().map((w) => (
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
// lookup 실패 시 영어로 fallback.
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
    targetLang,
  } = settings;
  const cueBg = `rgba(0,0,0,${backgroundOpacity})`;
  const sourceFontSize = sourceStyle.fontSize;
  const targetFontSize = targetStyle.fontSize;

  // 모국어 영상(source-only) 케이스에서 source 줄은 사실 targetLang(=모국어) 텍스트가 들어감.
  // 그 외엔 원문 언어가 영상마다 자동 감지되는 값이라 미리보기는 영어로 고정.
  const sourceSample = displayMode === 'source-only' ? getSample(targetLang) : getSample('en');
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
        borderRadius: 10,
        border: '1px solid #2d2a25',
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
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div className="preview-label">{t('opt.preview.dual')}</div>
          <PreviewBox settings={settings} displayMode={settings.displayMode} />
        </div>
        <div>
          <div className="preview-label">{t('opt.preview.single')}</div>
          <PreviewBox settings={settings} displayMode="source-only" />
        </div>
      </div>
    </>
  );
}

function Options() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // 이 렌더에서 t()가 쓸 언어를 먼저 맞춘다(모듈 전역). settings가 바뀌면 리렌더되므로
  // 언어 전환이 그 즉시 화면 전체에 반영된다 — shared/i18n.ts 참조.
  setUiLang(settings.uiLang);
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

  // 듀얼자막 on/off 단축키 재지정 — "키 입력 대기" 중엔 다음 유효 키(a-z, 수정키 없음)를 캡처해
  // 저장. Escape로 취소. content/index.ts의 물리 키(ev.code) 판별과 짝이 맞아야 하므로 여기서도
  // 같은 알파벳 1글자 제약을 건다(SubtitlesToggleKeySchema). 숫자는 허용 안 함 — YouTube 네이티브
  // 0-9 seek 단축키와 겹치면 V가 겪은 충돌이 재발한다.
  const [recordingKey, setRecordingKey] = useState(false);
  useEffect(() => {
    if (!recordingKey) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        setRecordingKey(false);
        return;
      }
      if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      const key = ev.key.toLowerCase();
      if (!/^[a-z]$/.test(key)) return;
      ev.preventDefault();
      setSettings((prev) => ({ ...prev, subtitlesToggleKey: key }));
      void saveSettings({ subtitlesToggleKey: key });
      setRecordingKey(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingKey]);
  type TestState =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'ok'; translation: string }
    | { kind: 'err'; error: string };
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  const [mindlogicTestState, setMindlogicTestState] = useState<TestState>({ kind: 'idle' });

  // Mindlogic 게이트웨이 크레딧 사용량 (A66) — GET /v1/gateway/credits/. 이 게이트웨이 배포판에
  // 없을 수도 있어(구버전 등) 404는 "미지원"으로 구분해 표시. background/translators/mindlogic.ts의
  // 동명 인터페이스와 구조만 맞춘 로컬 정의(ModelInfo와 같은 기존 패턴 — background↔options 직접
  // import 없이 메시지 JSON 모양만 공유).
  interface MindlogicCredits {
    monthlyQuota: number;
    monthlyUsed: number;
    monthlyRemaining: number;
    renewalDate: string | null;
    purchasedQuota: number;
    purchasedUsed: number;
    purchasedRemaining: number;
    totalQuota: number;
    totalUsed: number;
    totalRemaining: number;
  }
  type CreditsState =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'ok'; credits: MindlogicCredits }
    | { kind: 'err'; error: string };
  const [creditsState, setCreditsState] = useState<CreditsState>({ kind: 'idle' });

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
  // 상태(pending/ok/err) 커밋은 호출 측(onTest*)이 다른 요청들과 한 번에 묶어서 한다 —
  // 여기서 바로 setFetch하면 테스트·크레딧 요청보다 먼저 끝났을 때 그 결과만 잠깐 떴다가
  // 나머지가 도착하는 순간 줄바꿈되는 레이아웃 점프가 생김. 모델 목록 자체(select 옵션)는
  // 그 점프와 무관한 별도 행이라 도착 즉시 반영해도 된다.
  const refreshModels = async (
    provider: 'mindlogic' | 'gemini',
  ): Promise<ModelsFetch> => {
    const isGemini = provider === 'gemini';
    const apiKeyVal = isGemini ? apiKey : mindlogicApiKey;
    const keyTimerRef = isGemini ? keySaveTimerRef : mindlogicKeySaveTimerRef;
    const setKey = isGemini ? setGeminiApiKey : setMindlogicApiKey;
    const setModels = isGemini ? setGeminiModels : setMindlogicModels;
    const msgType = isGemini ? 'GEMINI_LIST_MODELS' : 'MINDLOGIC_LIST_MODELS';
    const cacheKey = isGemini ? 'ydtGeminiModels' : 'ydtMindlogicModels';

    if (keyTimerRef.current !== null) {
      clearTimeout(keyTimerRef.current);
      keyTimerRef.current = null;
      await setKey(apiKeyVal.trim() || null);
    }
    try {
      const res = (await chrome.runtime.sendMessage({
        type: msgType,
        apiKey: apiKeyVal.trim(),
        ...(isGemini ? {} : { baseUrl: settings.mindlogicBaseUrl.trim() }),
      })) as { ok: true; models: ModelInfo[] } | { ok: false; error: string } | undefined;
      if (!res) return { kind: 'err', error: t('err.noBgResponse') };
      if (res.ok) {
        await chrome.storage.local.set({ [cacheKey]: res.models });
        setModels(res.models);
        return { kind: 'ok', count: res.models.length };
      }
      return { kind: 'err', error: res.error };
    } catch (e) {
      return { kind: 'err', error: e instanceof Error ? e.message : String(e) };
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
    curated: Array<{ value: string; transHint?: MsgKey; explainHint?: MsgKey }>,
  ): React.ReactNode => {
    const known = new Map(curated.map((m) => [m.value, m]));
    let base: ModelInfo[] =
      dynamic && dynamic.length
        ? dynamic
        : curated.map((m) => ({ id: m.value, ownedBy: t('opt.group.recommended') }));
    if (!base.some((x) => x.id === value)) base = [{ id: value, ownedBy: t('opt.group.current') }, ...base];
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
                  {hint ? ` — ${t(hint)}` : ''}
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

  // 번역 모델 설명 — 해설 모델 설명(renderExplainBlock 내 <p>)과 짝을 이루는 안내.
  // 자막 전체를 번역하는 용도라 "많은 문장 = 가성비" 관점을 강조. Gemini/Mindlogic 공용.
  const transModelHint = (
    <p className="sub-hint">
      {t('hint.transModel')}
    </p>
  );

  // 해설 모델 + 해설 프롬프트 블록 — 활성 provider(Gemini/Mindlogic) 섹션 하단에 붙여
  // "번역 모델 바로 아래 해설 모델"로 연계. 프롬프트(공용 explainPrompt)도 여기서 편집.
  // provider마다 렌더되지만 화면엔 활성 섹션 하나만 떠서 중복 노출 없음.
  const renderExplainBlock = (provider: 'gemini' | 'mindlogic'): React.ReactNode => (
    <>
      <Row label={t('row.explainModel')}>
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
      <p className="sub-hint">
        {t('hint.explainModelPre')}
        <b style={{ color: 'var(--accent-text)' }}>{t('panel.explain')}</b> ·{' '}
        <b style={{ color: 'var(--accent-text)' }}>{t('panel.question')}</b>
        {t('hint.explainModelPost')}
      </p>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <label className="row-label" style={{ marginTop: 6 }}>
          {t('row.explainPrompt')}
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
              padding: 10,
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => update({ explainPrompt: defaultExplainPrompt(settings.uiLang) })}
              disabled={settings.explainPrompt === defaultExplainPrompt(settings.uiLang)}
              type="button"
            >
              {t('btn.restoreDefault')}
            </button>
            <span className="hint">{t('opt.explainPrompt.langHint')}</span>
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

  // "테스트"가 키 유효성 확인과 모델 목록 새로고침을 함께 수행 — 둘 다 같은 키가 필요한
  // 검증이라 버튼을 분리해 둘 이유가 없었음(별도 "↻ 모델 새로고침" 버튼은 제거).
  // 두 결과는 항상 함께 커밋한다(Promise.all 이후 한 번에 setState) — 먼저 끝난 쪽만 즉시
  // 반영하면 짧은 텍스트가 버튼 옆에 붙었다가 나머지가 도착하는 순간 줄바꿈되는 점프가 생김.
  const onTestGemini = async (): Promise<void> => {
    // 디바운스로 보류 중인 키 저장이 있으면 먼저 flush — 테스트 결과의 일관성 확보.
    if (keySaveTimerRef.current !== null) {
      clearTimeout(keySaveTimerRef.current);
      keySaveTimerRef.current = null;
      await setGeminiApiKey(apiKey.trim() || null);
    }
    setTestState({ kind: 'pending' });
    setGeminiModelsFetch({ kind: 'pending' });
    const runTest = async (): Promise<TestState> => {
      try {
        const res = (await chrome.runtime.sendMessage({
          type: 'TEST_GEMINI',
          apiKey: apiKey.trim(),
          model: settings.geminiModel,
        })) as { ok: true; translation: string } | { ok: false; error: string } | undefined;
        if (!res) return { kind: 'err', error: t('err.noBgResponse') };
        if (res.ok) return { kind: 'ok', translation: res.translation };
        return { kind: 'err', error: res.error };
      } catch (e) {
        return { kind: 'err', error: e instanceof Error ? e.message : String(e) };
      }
    };
    const [test, models] = await Promise.all([runTest(), refreshModels('gemini')]);
    setTestState(test);
    setGeminiModelsFetch(models);
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
    setModelsFetch({ kind: 'pending' });
    setCreditsState({ kind: 'pending' });
    const runTest = async (): Promise<TestState> => {
      try {
        const res = (await chrome.runtime.sendMessage({
          type: 'TEST_MINDLOGIC',
          apiKey: mindlogicApiKey.trim(),
          model: settings.mindlogicModel,
          baseUrl: settings.mindlogicBaseUrl.trim(),
        })) as { ok: true; translation: string } | { ok: false; error: string } | undefined;
        if (!res) return { kind: 'err', error: t('err.noBgResponse') };
        if (res.ok) return { kind: 'ok', translation: res.translation };
        return { kind: 'err', error: res.error };
      } catch (e) {
        return { kind: 'err', error: e instanceof Error ? e.message : String(e) };
      }
    };
    const [test, models, credits] = await Promise.all([
      runTest(),
      refreshModels('mindlogic'),
      checkMindlogicCredits(),
    ]);
    setMindlogicTestState(test);
    setModelsFetch(models);
    setCreditsState(credits);
  };

  // refreshModels와 같은 이유로 상태 커밋은 호출 측(onTestMindlogic)에 맡기고 결과만 반환.
  const checkMindlogicCredits = async (): Promise<CreditsState> => {
    if (mindlogicKeySaveTimerRef.current !== null) {
      clearTimeout(mindlogicKeySaveTimerRef.current);
      mindlogicKeySaveTimerRef.current = null;
      await setMindlogicApiKey(mindlogicApiKey.trim() || null);
    }
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'MINDLOGIC_CREDITS',
        apiKey: mindlogicApiKey.trim(),
        baseUrl: settings.mindlogicBaseUrl.trim(),
      })) as { ok: true; credits: MindlogicCredits } | { ok: false; error: string } | undefined;
      if (!res) return { kind: 'err', error: t('err.noBgResponse') };
      if (res.ok) return { kind: 'ok', credits: res.credits };
      return { kind: 'err', error: res.error };
    } catch (e) {
      return { kind: 'err', error: e instanceof Error ? e.message : String(e) };
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
      if (!res) setNotionTestState({ kind: 'err', error: t('err.noBgResponse') });
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

  // 표시 언어 전환 — 손대지 않은 해설 프롬프트는 새 언어의 기본값으로 갈아끼운다.
  // 사용자가 편집한 프롬프트는 그대로 둔다(그쪽이 사용자 자산).
  const onUiLangChange = (uiLang: UiLang): void => {
    const patch: Partial<Settings> = { uiLang };
    if (settings.explainPrompt === defaultExplainPrompt(settings.uiLang)) {
      patch.explainPrompt = defaultExplainPrompt(uiLang);
    }
    update(patch);
  };

  const onClearCache = async (): Promise<void> => {
    if (!confirm(t('confirm.clearCache'))) return;
    const n = await clearCache();
    setCacheCount(0);
    alert(t('alert.cacheCleared', { count: n }));
  };

  const onResetSettings = async (): Promise<void> => {
    if (!confirm(t('confirm.resetAll'))) return;
    // 보류 중인 디바운스 저장이 있다면 리셋 직후 덮어쓰지 못하도록 취소.
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingPatchRef.current = {};
    // 언어 3종은 설치 때처럼 브라우저 언어 기준으로(settings.ts:browserDefaults).
    const fresh: Settings = { ...DEFAULT_SETTINGS, ...browserDefaults() };
    setSettings(fresh);
    await saveSettings(fresh);
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
    resetKeys(TEXT_STYLE_KEYS, t('confirm.resetTextStyle'));
  const onResetLayout = (): void =>
    resetKeys(LAYOUT_KEYS, t('confirm.resetLayout'));

  // 슬라이더 값(퍼센트/배수)을 폰트 크기 'px' 값과 시각적으로 구분.
  // accent 색 + monospace로 "조절된 값"임을 한눈에 인식.
  const sliderValueStyle: React.CSSProperties = {
    fontSize: 12,
    color: 'var(--accent-text)',
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

  // 목차 현재 위치 표시 — 화면 위쪽 1/3 띠에 걸린 섹션을 활성으로.
  const [activeSection, setActiveSection] = useState('sec-dual');
  useEffect(() => {
    if (!loaded) return;
    const els = [...document.querySelectorAll<HTMLElement>('section.sec')];
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) setActiveSection(hit.target.id);
      },
      { rootMargin: '0px 0px -66% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [loaded, showGemini, showMindlogic]);

  if (!loaded) return <div style={{ padding: 24 }}>{t('opt.loading')}</div>;

  // 왼쪽 목차 — 보이는 섹션만(Gemini/게이트웨이는 고른 제공자일 때만 렌더되므로 같이 숨김).
  const tocItems: Array<{ id: string; label: string }> = [
    { id: 'sec-dual', label: t('sec.dual') },
    { id: 'sec-single', label: t('sec.single') },
    { id: 'sec-style', label: t('sec.style') },
    { id: 'sec-layout', label: t('sec.layout') },
    { id: 'sec-backend', label: t('sec.backend') },
    ...(showGemini ? [{ id: 'sec-gemini', label: t('sec.gemini') }] : []),
    ...(showMindlogic ? [{ id: 'sec-mindlogic', label: t('sec.mindlogic') }] : []),
    { id: 'sec-notion', label: t('sec.notion') },
    { id: 'sec-manage', label: t('sec.manage') },
  ];

  return (
    <div className="layout">
      <aside className="side">
        <div className="brand">
          Dual Subtitle
          <small>v{chrome.runtime.getManifest().version}</small>
        </div>
        <nav className="toc">
          {tocItems.map((it) => (
            <a
              key={it.id}
              href={`#${it.id}`}
              className={activeSection === it.id ? 'on' : undefined}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(it.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              {it.label}
            </a>
          ))}
        </nav>
        {/* 미리보기는 목차 아래 고정 — 아래쪽 스타일 섹션을 고치는 동안에도 계속 보이게. */}
        <Preview settings={settings} />
      </aside>

      <main className="main">
        <div className="main-head">
          <h1>Dual Subtitle for YouTube</h1>
          {saveState === 'pending' && <span className="save-state">{t('opt.saving')}</span>}
          {saveState === 'saved' && <span className="save-state saved">{t('opt.saved')}</span>}
        </div>

      <Section id="sec-dual" title={t('sec.dual')}>
        <Row label={t('row.uiLang')} hint={t('hint.uiLang')}>
          <select
            value={settings.uiLang}
            onChange={(e) => onUiLangChange(e.target.value as UiLang)}
          >
            <option value="en">English</option>
            <option value="ko">한국어</option>
          </select>
        </Row>
        <Row label={t('row.subtitlesOn')}>
          <input
            type="checkbox"
            checked={settings.subtitlesEnabled}
            onChange={(e) => update({ subtitlesEnabled: e.target.checked })}
          />
        </Row>
        <Row
          label={t('row.toggleKey')}
          hint={recordingKey ? t('hint.recordingKey') : t('hint.toggleKey')}
        >
          <button
            onClick={() => setRecordingKey(true)}
            style={{
              minWidth: 64,
              fontWeight: 700,
              background: recordingKey ? 'var(--accent)' : undefined,
              color: recordingKey ? 'var(--bg)' : undefined,
            }}
          >
            {recordingKey ? t('btn.recordingKey') : settings.subtitlesToggleKey.toUpperCase()}
          </button>
        </Row>
        <Row label={t('row.targetLang')} hint={t('hint.targetLang')}>
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
        <Row label={t('row.displayMode')}>
          <Chips<DisplayMode>
            value={settings.displayMode}
            options={displayModes()}
            onChange={(v) => update({ displayMode: v })}
          />
        </Row>
        <Row label={t('row.wordReveal')}>
          <input
            type="checkbox"
            checked={settings.wordRevealEnabled}
            onChange={(e) => update({ wordRevealEnabled: e.target.checked })}
          />
        </Row>
      </Section>

      <Section id="sec-single" title={t('sec.single')}>
        <Row label={t('row.contextLines')}>
          <Chips<number>
            value={settings.singleContextLines}
            options={[
              { value: 1, label: t('lines.1') },
              { value: 2, label: t('lines.2') },
              { value: 3, label: t('lines.3') },
            ]}
            onChange={(v) => update({ singleContextLines: v })}
          />
        </Row>
        {settings.singleContextLines > 1 && (
          <>
            <Row label={t('row.historyLayout')}>
              <Chips<HistoryLayout>
                value={settings.historyLayout}
                options={[
                  { value: 'stacked', label: t('layout.stacked') },
                  { value: 'inline', label: t('layout.inline') },
                ]}
                onChange={(v) => update({ historyLayout: v })}
              />
            </Row>
            {settings.historyLayout === 'stacked' && (
              <Row label={t('row.dimHistory')}>
                <input
                  type="checkbox"
                  checked={settings.dimHistory}
                  onChange={(e) => update({ dimHistory: e.target.checked })}
                />
                <span className="hint">
                  {t('hint.dimHistory')}
                </span>
              </Row>
            )}
          </>
        )}
      </Section>

      <Section
        id="sec-style"
        title={t('sec.style')}
        action={<ResetIcon onClick={onResetTextStyle} title={t('reset.textStyle.title')} />
        }
      >
        <StyleEditor
          label={t('style.source')}
          style={settings.sourceStyle}
          onChange={(sourceStyle) => update({ sourceStyle })}
        />
        <StyleEditor
          label={t('style.target')}
          style={settings.targetStyle}
          onChange={(targetStyle) => update({ targetStyle })}
        />
      </Section>

      <Section
        id="sec-layout"
        title={t('sec.layout')}
        action={<ResetIcon onClick={onResetLayout} title={t('reset.layout.title')} />
        }
      >
            <Row label={t('row.shortsScale')} hint={t('hint.shortsScale')}>
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
            <Row label={t('row.bgOpacity')} hint={t('hint.bgOpacity')}>
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
            <Row label={t('row.lineHeight')}>
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
            <div className="row">
              <label className="row-label">{t('row.position')}</label>
              <div className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div>{t('hint.positionDrag')}</div>
                <div>{t('hint.positionWheel')}</div>
              </div>
            </div>
      </Section>

      <Section id="sec-backend" title={t('sec.backend')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label className="choice">
            <input
              type="radio"
              checked={settings.backend === 'google-free'}
              onChange={() => update({ backend: 'google-free' as BackendId })}
            />
            <span>
              <div>
                {t('backend.googleFree.title')}{' '}
                <span style={{ fontSize: 11, color: 'var(--accent-text)', marginLeft: 2 }}>
                  {t('backend.recommended')}
                </span>
              </div>
              <div className="hint" style={{ marginTop: 2 }}>
                {t('backend.googleFree.desc')}
              </div>
            </span>
          </label>
          <label className="choice">
            <input
              type="radio"
              checked={settings.backend === 'chrome-builtin'}
              onChange={() => update({ backend: 'chrome-builtin' as BackendId })}
            />
            <span>
              <div>{t('backend.chrome.title')}</div>
              <div className="hint" style={{ marginTop: 2 }}>
                {t('backend.chrome.desc')}
              </div>
            </span>
          </label>
          <label className="choice">
            <input
              type="radio"
              checked={settings.backend === 'gemini'}
              onChange={() => update({ backend: 'gemini' as BackendId, explainBackend: 'gemini' })}
            />
            <span>
              <div>
                {t('backend.gemini.title')}{' '}
                <span className="ok" style={{ fontSize: 11, marginLeft: 2 }}>
                  {t('backend.aiBadge')}
                </span>
              </div>
              <div className="hint" style={{ marginTop: 2 }}>
                {t('backend.gemini.descPre')}
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  
                >
                  Google AI Studio
                </a>
                {t('backend.gemini.descPost')}
              </div>
            </span>
          </label>
          <label className="choice">
            <input
              type="radio"
              checked={settings.backend === 'mindlogic'}
              onChange={() => update({ backend: 'mindlogic' as BackendId, explainBackend: 'mindlogic' })}
            />
            <span>
              <div>
                {t('backend.mindlogic.title')}{' '}
                <span className="ok" style={{ fontSize: 11, marginLeft: 2 }}>
                  {t('backend.aiBadge')}
                </span>
              </div>
              <div className="hint" style={{ marginTop: 2 }}>
                {t('backend.mindlogic.desc')}
              </div>
            </span>
          </label>
        </div>
      </Section>

      {showGemini && (
        <Section id="sec-gemini" title={t('sec.gemini')}>
          <Row label={t('row.apiKey')}>
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
              type="button"
            >
              {showKey ? t('btn.hide') : t('btn.show')}
            </button>
            <button
              onClick={() => void onTestGemini()}
              disabled={!apiKey.trim() || testState.kind === 'pending'}
              className="btn-test"
              type="button"
            >
              {testState.kind === 'pending' ? t('btn.testing') : t('btn.test')}
            </button>
            {testState.kind === 'ok' && (
              <span className="ok" style={{ fontSize: 12 }}>
                {t('test.ok', { translation: testState.translation })}
              </span>
            )}
            {testState.kind === 'err' && (
              <span className="err" style={{ fontSize: 12 }}>✗ {testState.error}</span>
            )}
            {geminiModelsFetch.kind === 'ok' && (
              <span className="ok" style={{ fontSize: 11 }}>
                {t('test.models.ok', { count: geminiModelsFetch.count })}
              </span>
            )}
            {geminiModelsFetch.kind === 'err' && (
              <span className="err" style={{ fontSize: 11 }}>
                {t('test.models.err', { error: geminiModelsFetch.error })}
              </span>
            )}
            {!apiKey.trim() && (
              <span className="err" style={{ fontSize: 11 }}>
                {t('warn.noGeminiKey')}
              </span>
            )}
          </Row>
          <p className="sub-hint">
            {t('hint.geminiKey')}
          </p>
          <Row label={t('row.transModel')}>
            {renderGeminiSelect(settings.geminiModel, (v) => update({ geminiModel: v }), false)}
          </Row>
          {transModelHint}
          {renderExplainBlock('gemini')}
        </Section>
      )}

      {showMindlogic && (
        <Section id="sec-mindlogic" title={t('sec.mindlogic')}>
          <Row label={t('row.baseUrl')}>
            <input
              type="text"
              value={settings.mindlogicBaseUrl}
              onChange={(e) => update({ mindlogicBaseUrl: e.target.value })}
              placeholder="https://factchat-xxx.../v1/gateway"
              style={{ width: 280, fontFamily: 'monospace', fontSize: 12 }}
              autoComplete="off"
              spellCheck={false}
            />
          </Row>
          <p className="sub-hint">
            {t('hint.baseUrl')}
          </p>
          <Row label={t('row.apiKey')}>
            <input
              type={showMindlogicKey ? 'text' : 'password'}
              value={mindlogicApiKey}
              onChange={(e) => onMindlogicKeyChange(e.target.value)}
              placeholder={t('ph.mindlogicKey')}
              style={{ width: 280, fontFamily: 'monospace', fontSize: 12 }}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              onClick={() => setShowMindlogicKey((v) => !v)}
              type="button"
            >
              {showMindlogicKey ? t('btn.hide') : t('btn.show')}
            </button>
            <button
              onClick={() => void onTestMindlogic()}
              disabled={
                !mindlogicApiKey.trim() ||
                !settings.mindlogicBaseUrl.trim() ||
                mindlogicTestState.kind === 'pending'
              }
              className="btn-test"
              type="button"
            >
              {mindlogicTestState.kind === 'pending' ? t('btn.testing') : t('btn.test')}
            </button>
            {mindlogicTestState.kind === 'ok' && (
              <span className="ok" style={{ fontSize: 12 }}>
                {t('test.ok', { translation: mindlogicTestState.translation })}
              </span>
            )}
            {mindlogicTestState.kind === 'err' && (
              <span className="err" style={{ fontSize: 12 }}>
                ✗ {mindlogicTestState.error}
              </span>
            )}
            {modelsFetch.kind === 'ok' && (
              <span className="ok" style={{ fontSize: 11 }}>
                {t('test.models.ok', { count: modelsFetch.count })}
              </span>
            )}
            {modelsFetch.kind === 'err' && (
              <span className="err" style={{ fontSize: 11 }}>
                {t('test.models.err', { error: modelsFetch.error })}
              </span>
            )}
            {creditsState.kind === 'ok' && (
              <span className="ok" style={{ fontSize: 11 }}>
                {t('credits.ok', {
                  remaining: creditsState.credits.monthlyRemaining.toLocaleString(),
                  quota: creditsState.credits.monthlyQuota.toLocaleString(),
                })}
                {creditsState.credits.renewalDate
                  ? t('credits.renewal', { date: creditsState.credits.renewalDate.slice(0, 10) })
                  : ''}
                {creditsState.credits.purchasedQuota > 0 &&
                  t('credits.purchased', {
                    remaining: creditsState.credits.purchasedRemaining.toLocaleString(),
                  })}
              </span>
            )}
            {creditsState.kind === 'err' && (
              <span className="err" style={{ fontSize: 11 }}>
                {t('credits.err', { error: creditsState.error })}
              </span>
            )}
            {(!mindlogicApiKey.trim() || !settings.mindlogicBaseUrl.trim()) && (
              <span className="err" style={{ fontSize: 11 }}>
                {t('warn.noMindlogicKey')}
              </span>
            )}
          </Row>
          <p className="sub-hint">
            {t('hint.mindlogicKey')}
          </p>
          <Row label={t('row.transModel')}>
            {renderMindlogicSelect(settings.mindlogicModel, (v) => update({ mindlogicModel: v }), false)}
          </Row>
          {transModelHint}
          {renderExplainBlock('mindlogic')}
        </Section>
      )}

      <Section id="sec-notion" title={t('sec.notion')}>
        <p className="hint" style={{ margin: 0, fontSize: 12 }}>
          {t('notion.introPre')}
          <b style={{ color: 'var(--accent-text)' }}>{t('panel.notion')}</b>
          {t('notion.introPost')}
        </p>
        <ol className="hint" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>
            {t('notion.step1Pre')}
            <a
              href="https://www.notion.so/my-integrations"
              target="_blank"
              rel="noreferrer"
              
            >
              notion.so/my-integrations
            </a>
            {t('notion.step1Post')}
            <b>{t('notion.step1Bold')}</b>
          </li>
          <li>
            {t('notion.step2Pre')}
            <b>{t('notion.step2Bold')}</b>
          </li>
          <li>{t('notion.step3')}</li>
        </ol>
        <Row label={t('row.notionToken')}>
          <input
            type={showNotionToken ? 'text' : 'password'}
            value={notionToken}
            onChange={(e) => onNotionTokenChange(e.target.value)}
            placeholder={t('opt.notionToken.placeholder')}
            style={{ width: 280, fontFamily: 'monospace', fontSize: 12 }}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            onClick={() => setShowNotionToken((v) => !v)}
            type="button"
          >
            {showNotionToken ? t('btn.hide') : t('btn.show')}
          </button>
        </Row>
        <p className="sub-hint">
          {t('hint.notionToken')}
        </p>
        <Row label={t('row.notionDb')}>
          <input
            type="text"
            value={settings.notionDatabaseId}
            onChange={(e) => update({ notionDatabaseId: e.target.value })}
            placeholder={t('ph.notionDb')}
            style={{ width: 280, fontFamily: 'monospace', fontSize: 12 }}
            autoComplete="off"
            spellCheck={false}
          />
        </Row>
        <p className="sub-hint">
          {t('hint.notionDb')}
        </p>
        <Row label={t('row.notionTest')}>
          <button
            onClick={() => void onTestNotion()}
            disabled={
              !notionToken.trim() ||
              !settings.notionDatabaseId.trim() ||
              notionTestState.kind === 'pending'
            }
            className="btn-test"
            type="button"
          >
            {notionTestState.kind === 'pending' ? t('btn.checking') : t('btn.test')}
          </button>
          {notionTestState.kind === 'ok' && (
            <span className="ok" style={{ fontSize: 12 }}>
              {t('test.notion.ok', { title: notionTestState.dbTitle })}
            </span>
          )}
          {notionTestState.kind === 'err' && (
            <span className="err" style={{ fontSize: 12 }}>✗ {notionTestState.error}</span>
          )}
        </Row>
      </Section>

      <Section id="sec-manage" title={t('sec.manage')}>
        <Row label={t('row.cache')}>
          <button onClick={onClearCache}>
            {t('btn.clearCache')}
          </button>
          <span className="hint">
            {t('cache.count', { count: cacheCount ?? '…' })}
          </span>
        </Row>
        <div className="divider" />
        <Row label={t('row.resetAll')} hint={t('hint.resetAll')}>
          <button onClick={onResetSettings} className="btn-danger">
            {t('btn.reset')}
          </button>
        </Row>
      </Section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
