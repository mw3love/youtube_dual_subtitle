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
import { BACKENDS, DISPLAY_MODES, GEMINI_MODELS, MINDLOGIC_MODELS, TARGET_LANGS } from '../shared/lang-options';
import {
  getGeminiApiKey,
  getLastBackend,
  getMindlogicApiKey,
  type LastBackendInfo,
} from '../shared/secrets';

// 현재 탭 상태 — 팝업이 열렸을 때 한 번 조회.
type TabStatus =
  | { kind: 'loading' }
  | { kind: 'not-youtube' }
  | { kind: 'unreachable' }
  | { kind: 'subtitles-off' }
  | { kind: 'no-cues' }
  | { kind: 'active'; cueCount: number };

function statusDot(color: string): React.CSSProperties {
  return {
    display: 'inline-block',
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: color,
    marginRight: 7,
    verticalAlign: 'middle',
  };
}

function StatusLine({ status }: { status: TabStatus }) {
  let color = '#888';
  let text = '';
  switch (status.kind) {
    case 'loading':
      color = '#666';
      text = '확인 중…';
      break;
    case 'not-youtube':
      color = '#888';
      text = 'YouTube 화면이 아님';
      break;
    case 'unreachable':
      color = '#aa6633';
      text = '페이지에 연결할 수 없음 · 새로고침 필요';
      break;
    case 'subtitles-off':
      color = '#888';
      text = '자막 꺼짐';
      break;
    case 'no-cues':
      color = '#aa6633';
      text = '이 영상에는 자막 없음';
      break;
    case 'active':
      color = '#3ea6ff';
      text = `자막 켜짐 · ${status.cueCount}줄`;
      break;
  }
  return (
    <div
      style={{
        fontSize: 11,
        padding: '6px 8px',
        background: '#222',
        borderRadius: 3,
        marginBottom: 10,
        color: '#bbb',
      }}
    >
      <span style={statusDot(color)} />
      {text}
    </div>
  );
}

// 백엔드 식별자 → 사용자에게 보여줄 짧은 이름.
const BACKEND_LABEL: Record<BackendId, string> = {
  'google-free': 'Google 무료',
  'chrome-builtin': 'Chrome 내장',
  gemini: 'Gemini',
  mindlogic: 'Mindlogic',
};

// gemini/mindlogic 모델 ID → 사람용 라벨(목록에 없으면 raw ID 그대로).
function modelLabel(backend: BackendId, model?: string): string | null {
  if (!model) return null;
  if (backend === 'gemini') return GEMINI_MODELS.find((m) => m.value === model)?.label ?? model;
  if (backend === 'mindlogic') return MINDLOGIC_MODELS.find((m) => m.value === model)?.label ?? model;
  return null;
}

function formatAgo(at: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}

// "최근 번역" 한 줄 — preferred ≠ used면 fallback 발생을 빨갛게 노출.
function LastBackendLine({ info, preferred }: { info: LastBackendInfo; preferred: BackendId }) {
  const fellBack = info.used !== info.preferred;
  // 사용자가 popup 열어둔 동안 시간 흐름 반영 (1분 단위).
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const stale = Date.now() - info.at > 30 * 60 * 1000; // 30분 이상이면 흐리게
  return (
    <p
      style={{
        margin: '6px 0 0',
        padding: '5px 8px',
        fontSize: 11,
        color: fellBack ? '#ffb37a' : stale ? '#888' : '#aac8ff',
        background: '#1f1f1f',
        border: '1px solid #2e2e2e',
        borderRadius: 3,
        opacity: stale ? 0.7 : 1,
      }}
      title={
        fellBack
          ? `${BACKEND_LABEL[info.preferred]} 호출 실패 → ${BACKEND_LABEL[info.used]}로 자동 fallback`
          : `${BACKEND_LABEL[info.used]}로 처리 완료`
      }
    >
      최근 번역: {BACKEND_LABEL[info.used]}
      {modelLabel(info.used, info.model) ? ` (${modelLabel(info.used, info.model)})` : ''} ·{' '}
      {formatAgo(info.at)}
      {fellBack && (
        <span style={{ marginLeft: 6, fontSize: 10 }}>
          ⚠ {BACKEND_LABEL[preferred]} 실패 → fallback
        </span>
      )}
    </p>
  );
}

function Popup() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<TabStatus>({ kind: 'loading' });
  // BYOK 백엔드의 키 설정 여부 — 키 없는데 해당 백엔드 선택했을 때만 안내 표시.
  const [geminiKeySet, setGeminiKeySet] = useState<boolean | null>(null);
  const [mindlogicKeySet, setMindlogicKeySet] = useState<boolean | null>(null);
  // 마지막 번역 호출 결과 — preferred ≠ used면 fallback 발생을 사용자에게 노출.
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

  // ➕ 새 질문 — 활성 YouTube 탭 콘텐츠에 OPEN_ASK 전달 → 자막 선택 없이 "직접 질문" 패널을 연다
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

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 0',
    fontSize: 13,
    gap: 10,
  };

  const selectStyle: React.CSSProperties = { fontSize: 12, padding: '2px 4px', maxWidth: 170 };

  const sizeBtnStyle: React.CSSProperties = {
    width: 26,
    height: 24,
    fontSize: 15,
    lineHeight: '1',
    padding: 0,
    cursor: 'pointer',
  };

  const SizeRow = ({
    label,
    value,
    bump,
  }: {
    label: string;
    value: number;
    bump: (d: number) => void;
  }): React.ReactElement => (
    <div style={rowStyle}>
      <span>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button style={sizeBtnStyle} disabled={!loaded} onClick={() => bump(-2)} title="작게">
          −
        </button>
        <span style={{ fontSize: 12, minWidth: 26, textAlign: 'center', color: '#ccc' }}>{value}</span>
        <button style={sizeBtnStyle} disabled={!loaded} onClick={() => bump(2)} title="크게">
          +
        </button>
      </span>
    </div>
  );

  return (
    <div
      style={{
        minWidth: 270,
        padding: 14,
        fontFamily: 'system-ui, sans-serif',
        opacity: loaded ? 1 : 0.5,
      }}
    >
      <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>YouTube Dual Subtitle</h3>

      <StatusLine status={status} />

      {pageReachable && (
        <button
          onClick={() => void openAskOnPage()}
          disabled={!loaded}
          style={{ width: '100%', marginBottom: 10, padding: '6px', fontSize: 12, cursor: 'pointer' }}
          title="자막 선택 없이 AI에게 바로 질문 (단축키 Alt+Q)"
        >
          ➕ 새 질문
        </button>
      )}

      <label style={rowStyle}>
        <span>
          자막 켜기
          <span style={{ fontSize: 10, color: '#888', marginLeft: 6 }}>
            단축키 {settings.subtitlesToggleKey.toUpperCase()}
          </span>
        </span>
        <input
          type="checkbox"
          checked={settings.subtitlesEnabled}
          onChange={(e) => update({ subtitlesEnabled: e.target.checked })}
          disabled={!loaded}
        />
      </label>

      <label style={rowStyle} title="노래방처럼 말하는 단어가 또렷해짐 (영어 자막)">
        <span>노래방 모드</span>
        <input
          type="checkbox"
          checked={settings.wordRevealEnabled}
          onChange={(e) => update({ wordRevealEnabled: e.target.checked })}
          disabled={!loaded}
        />
      </label>

      <label style={rowStyle}>
        <span>표시 모드</span>
        <select
          value={settings.displayMode}
          onChange={(e) => update({ displayMode: e.target.value as DisplayMode })}
          disabled={!loaded}
          style={selectStyle}
        >
          {DISPLAY_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <label style={rowStyle}>
        <span>바꿀 언어</span>
        <select
          value={settings.targetLang}
          onChange={(e) => update({ targetLang: e.target.value as TargetLang })}
          disabled={!loaded}
          style={selectStyle}
        >
          {TARGET_LANGS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </label>

      <label style={rowStyle}>
        <span>번역 방식</span>
        <select
          value={settings.backend}
          onChange={(e) => update({ backend: e.target.value as BackendId })}
          disabled={!loaded}
          style={selectStyle}
        >
          {BACKENDS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </label>

      {settings.backend === 'gemini' && geminiKeySet === false && (
        <p
          style={{
            margin: '4px 0 0',
            padding: '6px 8px',
            fontSize: 11,
            color: '#ffcfa6',
            background: '#3a2a1a',
            border: '1px solid #5a3a1a',
            borderRadius: 3,
          }}
        >
          Gemini API 키가 설정되지 않음 — 옵션에서 키 입력 필요 (안 하면 Google 무료로 fallback)
        </p>
      )}

      {settings.backend === 'mindlogic' && mindlogicKeySet === false && (
        <p
          style={{
            margin: '4px 0 0',
            padding: '6px 8px',
            fontSize: 11,
            color: '#ffcfa6',
            background: '#3a2a1a',
            border: '1px solid #5a3a1a',
            borderRadius: 3,
          }}
        >
          Mindlogic API 키가 설정되지 않음 — 옵션에서 키 입력 필요 (안 하면 Google 무료로 fallback)
        </p>
      )}

      {lastBackend && <LastBackendLine info={lastBackend} preferred={settings.backend} />}

      {/* 크기/위치 미세조정 — 한 번 맞춰두는 값이라 자주 바꾸는 언어·백엔드 아래(맨 하단)로.
          "자세히 설정하기" 바로 위 배치. */}
      <SizeRow label="원문 크기" value={settings.sourceStyle.fontSize} bump={bumpSource} />
      <SizeRow label="번역 크기" value={settings.targetStyle.fontSize} bump={bumpTarget} />

      <div style={rowStyle}>
        <span title="Shorts 하단 제목 등으로 자막이 흐려져 드래그/휠이 막힐 때 위치를 기본값으로 되돌림">
          자막 위치
        </span>
        <button
          style={{ fontSize: 12, padding: '3px 10px', cursor: 'pointer' }}
          disabled={!loaded}
          onClick={resetPosition}
          title="일반 영상/Shorts 위치를 모두 기본값으로 초기화"
        >
          위치 초기화
        </button>
      </div>

      <button
        onClick={openOptions}
        style={{
          width: '100%',
          marginTop: 10,
          padding: '6px',
          fontSize: 12,
        }}
      >
        자세히 설정하기
      </button>

      <p style={{ margin: '8px 0 0', fontSize: 11, color: '#999' }}>
        v{chrome.runtime.getManifest().version}
      </p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
