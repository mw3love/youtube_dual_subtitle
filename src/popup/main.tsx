import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type BackendId,
  type DisplayMode,
  type Settings,
  type TargetLang,
} from '../shared/settings';
import { TARGET_LANGS } from '../shared/lang-options';
import { setUiLang, t, type MsgKey } from '../shared/i18n';
import {
  getGeminiApiKey,
  getLastBackend,
  getMindlogicApiKey,
  type LastBackendInfo,
} from '../shared/secrets';

// 팝업(A75): 자주 바꾸는 것만 — 자막 켜기·표시 모드·내 언어·글자 크기·위치.
// 노래방 모드·번역 방식처럼 한 번 정하면 그만인 설정은 옵션 페이지(⚙)로 옮겼다.
// 스타일은 index.html의 클래스(.card/.tile/...)에 있다.

// 현재 탭 상태 — 팝업이 열렸을 때 한 번 조회.
type TabStatus =
  | { kind: 'loading' }
  | { kind: 'not-youtube' }
  | { kind: 'unreachable' }
  | { kind: 'subtitles-off' }
  | { kind: 'no-cues' }
  | { kind: 'active'; cueCount: number };

// 백엔드 식별자 → 사용자에게 보여줄 짧은 이름(표시 언어를 따라가므로 함수).
function backendLabel(id: BackendId): string {
  switch (id) {
    case 'google-free':
      return t('backend.googleFree.name');
    case 'chrome-builtin':
      return t('backend.chrome.name');
    case 'gemini':
      return t('backend.gemini.name');
    case 'mindlogic':
      return t('backend.mindlogic.name');
  }
}

// fallback 경고는 이 시간 안의 일만 — 오래된 실패를 지금 문제처럼 보이지 않게(옛 팝업의 stale 기준과 동일).
const FALLBACK_FRESH_MS = 30 * 60 * 1000;

// 표시 모드 타일 — 막대 두 개(원문·번역) 중 무엇을 그릴지로 모드를 그림으로 보여 준다.
const MODE_TILES: Array<{ value: DisplayMode; label: MsgKey; src: boolean; tgt: boolean }> = [
  { value: 'dual', label: 'pop.mode.dual', src: true, tgt: true },
  { value: 'translation-only', label: 'pop.mode.translationOnly', src: false, tgt: true },
  { value: 'source-only', label: 'pop.mode.sourceOnly', src: true, tgt: false },
];

// 아이콘 — 이모지 대신 선 SVG(폰트마다 모양이 달라지지 않게).
const IconAsk = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <line x1="12" y1="7" x2="12" y2="13" />
    <line x1="9" y1="10" x2="15" y2="10" />
  </svg>
);
const IconGear = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const IconReset = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

function Popup() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // 이 렌더에서 t()가 쓸 언어를 먼저 맞춘다(옵션 페이지와 같은 패턴 — shared/i18n.ts).
  setUiLang(settings.uiLang);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<TabStatus>({ kind: 'loading' });
  // BYOK 백엔드의 키 설정 여부 — 키 없는데 해당 백엔드 선택했을 때만 안내 표시.
  const [geminiKeySet, setGeminiKeySet] = useState<boolean | null>(null);
  const [mindlogicKeySet, setMindlogicKeySet] = useState<boolean | null>(null);
  // 마지막 번역 호출 결과 — preferred ≠ used(fallback)일 때만 경고로 노출.
  const [lastBackend, setLastBackendState] = useState<LastBackendInfo | null>(null);

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
    void getGeminiApiKey().then((k) => setGeminiKeySet(!!k));
    void getMindlogicApiKey().then((k) => setMindlogicKeySet(!!k));
    void getLastBackend().then((b) => setLastBackendState(b));

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

  // 새 질문 — 활성 YouTube 탭 콘텐츠에 OPEN_ASK 전달 → 자막 선택 없이 "직접 질문" 패널을 연다
  // (content/index.ts가 explainUI.openAsk() 호출). 패널 안 버튼과 동일 경로이자 단축키 Alt+Q의
  // cold-start 발견성 보완(단축키를 몰라도 됨). 콘텐츠 스크립트가 없거나 거부하면 무시.
  const openAskOnPage = async (): Promise<void> => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_ASK' });
    } catch {
      // 콘텐츠 스크립트 미도달 — 무시.
    }
    window.close();
  };

  // 콘텐츠 스크립트가 응답한 상태(=YouTube 탭 + 스크립트 도달)일 때만 "새 질문" 노출.
  const pageReachable =
    status.kind === 'active' || status.kind === 'no-cues' || status.kind === 'subtitles-off';

  // 폰트 크기 ± — 렌더러 휠 조절과 같은 범위(8~72), settings 스키마와도 동일.
  // update()가 storage.sync 저장 → content가 onChanged로 즉시 반영(setFontSizes).
  const FONT_MIN = 8;
  const FONT_MAX = 72;
  const clampFont = (v: number): number => Math.max(FONT_MIN, Math.min(FONT_MAX, v));
  const bumpSource = (d: number): void =>
    update({
      sourceStyle: { ...settings.sourceStyle, fontSize: clampFont(settings.sourceStyle.fontSize + d) },
    });
  const bumpTarget = (d: number): void =>
    update({
      targetStyle: { ...settings.targetStyle, fontSize: clampFont(settings.targetStyle.fontSize + d) },
    });

  // 자막 위치 초기화 — Shorts 하단 제목 오버레이 등으로 자막이 흐려져 드래그/휠이 막힐 때의 탈출구.
  // 일반/Shorts 두 모드 위치를 모두 기본값으로. update()→storage.sync→content onChanged→setPositions로 즉시 반영.
  const resetPosition = (): void =>
    update({ subtitlePosition: DEFAULT_SETTINGS.subtitlePosition });

  // 켜기 카드 아랫줄 — 페이지 상태 + 단축키. 상태는 팝업 열 때 한 번만 조회하므로, 여기서
  // 끄면 줄 수 대신 단축키만 보이게 settings 기준으로 가린다.
  const shortcut = t('pop.shortcut', { key: settings.subtitlesToggleKey.toUpperCase() });
  let statusText: string | null = null;
  let statusWarn = false;
  switch (status.kind) {
    case 'loading':
      statusText = t('status.checking');
      break;
    case 'not-youtube':
      statusText = t('status.notYoutube');
      break;
    case 'unreachable':
      statusText = t('status.unreachable');
      statusWarn = true;
      break;
    case 'no-cues':
      statusText = t('status.noCues');
      statusWarn = true;
      break;
    case 'active':
      statusText = t('pop.lines', { count: status.cueCount });
      break;
    case 'subtitles-off':
      break;
  }
  if (!settings.subtitlesEnabled && (status.kind === 'active' || status.kind === 'no-cues')) {
    statusText = null;
    statusWarn = false;
  }
  const heroSub = statusText ? `${statusText} · ${shortcut}` : shortcut;

  const fellBack =
    lastBackend !== null &&
    lastBackend.used !== lastBackend.preferred &&
    Date.now() - lastBackend.at < FALLBACK_FRESH_MS;

  const SizeStepper = ({
    label,
    value,
    bump,
  }: {
    label: string;
    value: number;
    bump: (d: number) => void;
  }): React.ReactElement => (
    <span className="size">
      <span className="size-label">{label}</span>
      <button
        className="step"
        disabled={!loaded}
        onClick={() => bump(-2)}
        title={t('pop.smaller')}
        aria-label={`${label} ${t('pop.smaller')}`}
      >
        −
      </button>
      <span className="step-value">{value}</span>
      <button
        className="step"
        disabled={!loaded}
        onClick={() => bump(2)}
        title={t('pop.larger')}
        aria-label={`${label} ${t('pop.larger')}`}
      >
        +
      </button>
    </span>
  );

  return (
    <div className="pop" style={{ opacity: loaded ? 1 : 0.5 }}>
      <div className="head">
        <span className="head-title">Dual Subtitle</span>
        {pageReachable && (
          <button
            className="icon-btn"
            onClick={() => void openAskOnPage()}
            disabled={!loaded}
            title={t('pop.newQuestion.title')}
            aria-label={t('pop.newQuestion')}
          >
            <IconAsk />
          </button>
        )}
        <button
          className="icon-btn"
          onClick={openOptions}
          title={`${t('pop.openOptions')} · v${chrome.runtime.getManifest().version}`}
          aria-label={t('pop.openOptions')}
        >
          <IconGear />
        </button>
      </div>

      <button
        className={`card hero${settings.subtitlesEnabled ? ' on' : ''}`}
        aria-pressed={settings.subtitlesEnabled}
        disabled={!loaded}
        onClick={() => update({ subtitlesEnabled: !settings.subtitlesEnabled })}
      >
        <span className="hero-text">
          <span className="hero-title">{settings.subtitlesEnabled ? t('pop.on') : t('pop.off')}</span>
          <span className={`hero-sub${statusWarn ? ' warn' : ''}`}>{heroSub}</span>
        </span>
        <span className="switch" aria-hidden="true" />
      </button>

      <div className="modes" role="group" aria-label={t('pop.displayMode')}>
        {MODE_TILES.map((m) => (
          <button
            key={m.value}
            className={`tile${settings.displayMode === m.value ? ' on' : ''}`}
            aria-pressed={settings.displayMode === m.value}
            disabled={!loaded}
            onClick={() => update({ displayMode: m.value })}
          >
            <span className="bars" aria-hidden="true">
              {m.src && <span className="bar src" />}
              {m.tgt && <span className="bar tgt" />}
            </span>
            {t(m.label)}
          </button>
        ))}
      </div>

      <div>
        <p className="cap">{t('pop.cap.lang')}</p>
        <label className="card row">
          <span>{t('pop.targetLang')}</span>
          <select
            className="lang-select"
            value={settings.targetLang}
            onChange={(e) => update({ targetLang: e.target.value as TargetLang })}
            disabled={!loaded}
          >
            {TARGET_LANGS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <p className="cap">{t('pop.cap.size')}</p>
        <div className="card row size-row">
          <SizeStepper label={t('pop.sourceSize')} value={settings.sourceStyle.fontSize} bump={bumpSource} />
          <span className="divider" />
          <SizeStepper label={t('pop.targetSize')} value={settings.targetStyle.fontSize} bump={bumpTarget} />
        </div>
      </div>

      <div>
        <p className="cap">{t('pop.cap.position')}</p>
        <div className="card row">
          <span title={t('pop.position.title')}>{t('pop.position')}</span>
          <button
            className="soft-btn"
            disabled={!loaded}
            onClick={resetPosition}
            title={t('pop.resetPosition.title')}
          >
            <IconReset />
            {t('pop.resetPosition')}
          </button>
        </div>
      </div>

      {settings.backend === 'gemini' && geminiKeySet === false && (
        <p className="warn-box">{t('pop.noGeminiKey')}</p>
      )}
      {settings.backend === 'mindlogic' && mindlogicKeySet === false && (
        <p className="warn-box">{t('pop.noMindlogicKey')}</p>
      )}
      {fellBack && lastBackend && (
        <p className="warn-box">
          {t('pop.fellBack', {
            preferred: backendLabel(lastBackend.preferred),
            used: backendLabel(lastBackend.used),
          })}
        </p>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
