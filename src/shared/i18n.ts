// UI 표시 언어 사전 (A70).
//
// 왜 chrome.i18n(_locales)이 아닌가 — chrome.i18n은 로케일을 "브라우저 UI 언어"로만 정하고
// 런타임에 바꾸는 API가 없다(공식 문서 실확인: getMessage/getAcceptLanguages/getUILanguage/
// detectLanguage 넷뿐). 이 확장의 요구는 "기본 영어 + 옵션에서 한국어로 전환"이라 사전을
// 직접 들고 있어야 한다. 스토어 목록(manifest name/description)만 브라우저 언어를 따르므로
// 그쪽은 별개 문제로 남긴다.
//
// 사용법 두 갈래:
//  - React 페이지(옵션/팝업): settings를 들고 있으므로 렌더 직전에 setUiLang(s.uiLang) 후 t().
//    (settings state가 바뀌면 리렌더되므로 언어 전환이 즉시 반영된다.)
//  - content/background/ask-anywhere: initUiLang()으로 한 번 읽고 storage.onChanged로 추적.
//    로드 전에는 영어(기본값)로 나간다 — 부팅 직후 잠깐이고 에러 문구에만 해당.

export type UiLang = 'en' | 'ko';

type Vars = Record<string, string | number>;

// 영어가 기준 사전 — 키 목록도 여기서 나온다(KO는 같은 키를 전부 가져야 타입이 통과).
const EN = {
  // ── 공통 에러 ──────────────────────────────────────────────
  'err.noBgResponse': 'No response from the extension — reload it in chrome://extensions',
  'err.settingsLoading': 'Settings are still loading. Please try again in a moment.',
  'err.settingsLoadingShort': 'Settings are still loading.',
  'err.emptyExplainPrompt':
    'The explanation prompt is empty (set it in Options, or press "Restore default").',
  'err.emptyNotionDb': 'Notion database ID is empty (set it in Options).',

  // ── 언어/모드/백엔드 라벨 ──────────────────────────────────
  'mode.dual': 'Original + translation',
  'mode.translationOnly': 'Translation only',
  'mode.sourceOnly': 'Original only',
  'backend.googleFree.short': 'Google (free)',
  'backend.chrome.short': 'Chrome built-in (offline)',
  'backend.gemini.short': 'Gemini (your key)',
  'backend.mindlogic.short': 'OpenAI-compatible gateway',
  'backend.googleFree.name': 'Google free',
  'backend.chrome.name': 'Chrome built-in',
  'backend.gemini.name': 'Gemini',
  'backend.mindlogic.name': 'Gateway',

  // ── 옵션 페이지 ────────────────────────────────────────────
  'opt.loading': 'Loading options…',
  'opt.saving': 'Saving…',
  'opt.saved': '● Saved',
  'opt.preview': 'Preview',
  'opt.preview.dual': 'Dual subtitles',
  'opt.preview.single': 'When not dual',
  'opt.reset': '↻ Reset',
  'opt.group.recommended': 'Recommended',
  'opt.group.current': 'Current',
  'weight.400': 'Normal',
  'weight.500': 'Semibold',
  'weight.700': 'Bold',
  'style.size': 'Size',
  'style.color': 'Color',
  'style.weight': 'Weight',
  'style.source': '1. Original line',
  'style.target': '2. Translated line',

  'sec.dual': 'Dual subtitles',
  'sec.single': 'When not dual',
  'sec.style': 'Subtitle style',
  'sec.layout': 'Placement · background',
  'sec.backend': 'Translation engine',
  'sec.gemini': 'Gemini settings',
  'sec.mindlogic': 'OpenAI-compatible gateway settings',
  'sec.notion': 'Notion export (explanation panel)',
  'sec.manage': 'Maintenance',

  'row.uiLang': 'Language',
  'hint.uiLang': 'Changes the extension UI. Default AI prompts follow this too.',
  'row.subtitlesOn': 'Show subtitles',
  'row.toggleKey': 'Toggle shortcut',
  'hint.toggleKey':
    'One letter, no modifiers · c/f/j/k/l/m/n/i/t/w and others collide with YouTube shortcuts',
  'hint.recordingKey': 'Press a key (Esc to cancel)',
  'btn.recordingKey': 'Waiting for key…',
  'row.targetLang': 'Translate into',
  'hint.targetLang': 'Source language is detected per video',
  'row.displayMode': 'Display mode',
  'row.wordReveal': 'Karaoke mode',
  'row.contextLines': 'Lines to show',
  'lines.1': 'Current line only',
  'lines.2': 'Two lines (current + previous)',
  'lines.3': 'Three lines (current + two previous)',
  'row.historyLayout': 'Stacking',
  'layout.stacked': 'One line each',
  'layout.inline': 'Flow as one paragraph',
  'row.dimHistory': 'Dim previous lines',
  'hint.dimHistory': 'Makes the line being spoken stand out',
  'reset.textStyle.title': 'Reset original/translated text style (size, color, weight)',
  'reset.layout.title': 'Reset Shorts size, background, line spacing and position',
  'confirm.resetTextStyle': 'Reset original/translated subtitle style (size, color, weight)?',
  'confirm.resetLayout': 'Reset Shorts subtitle size, background, line spacing and position?',
  'row.shortsScale': 'Shorts subtitle size',
  'hint.shortsScale': '100% matches regular videos',
  'row.bgOpacity': 'Subtitle background',
  'hint.bgOpacity': 'Higher is more opaque',
  'row.lineHeight': 'Gap between the two lines',
  'row.position': 'Subtitle position',
  'hint.positionDrag': '• Drag the subtitle to move it',
  'hint.positionWheel': '• Mouse wheel to resize',

  'backend.googleFree.title': 'Google free',
  'backend.recommended': 'recommended',
  'backend.googleFree.desc': 'Online translation. May pause briefly if used very heavily',
  'backend.chrome.title': 'Chrome built-in (offline)',
  'backend.chrome.desc': 'Runs offline. Long sentences can read a little awkwardly',
  'backend.gemini.title': 'Gemini (your API key)',
  'backend.aiBadge': 'AI translation',
  'backend.gemini.descPre': 'Free key from ',
  'backend.gemini.descPost': '',
  'backend.mindlogic.title': 'OpenAI-compatible gateway (organization key)',
  'backend.mindlogic.desc':
    'One key issued by your school or company gives access to Claude · GPT · Gemini and more through an OpenAI-compatible endpoint',

  'row.apiKey': 'API key',
  'btn.show': '👁 Show',
  'btn.hide': '🙈 Hide',
  'btn.test': '🧪 Test',
  'btn.testing': 'Testing…',
  'btn.checking': 'Checking…',
  'test.ok': '✓ Works (e.g. "Hello, world." → "{translation}")',
  'test.models.ok': '· {count} models listed',
  'test.models.err': '· model list failed: {error}',
  'credits.ok': '· {remaining} / {quota} credits left',
  'credits.renewal': ' (renews {date})',
  'credits.purchased': ' · purchased {remaining} left',
  'credits.err': '· credit check failed: {error}',
  'warn.noGeminiKey': 'Without a key it falls back to Google free',
  'warn.noMindlogicKey': 'Without a Base URL and key it falls back to Google free',
  'hint.geminiKey':
    'A free key needs nothing but a sign-up — no credit card. The key is stored on this computer only (never synced).',
  'hint.mindlogicKey':
    'Paste the key issued by your school or company. The key is stored on this computer only (never synced).',
  'row.baseUrl': 'Base URL',
  'hint.baseUrl':
    'Paste the gateway address your organization gave you. Each organization has its own domain — switch this too when you switch accounts.',
  'ph.mindlogicKey': 'sk-… or the key you were issued',
  'row.transModel': 'Translation model',
  'hint.transModel':
    'Used to translate the whole subtitle track. With that many sentences, a fast and cheap model fits best.',
  'row.explainModel': 'Explanation model',
  'hint.explainModelPre': 'Select subtitle text on the video and ',
  'hint.explainModelPost':
    ' buttons appear. It runs once in a while, so a slower but smarter model fits best.',
  'row.explainPrompt': 'Explanation prompt',
  'btn.restoreDefault': 'Restore default',

  'notion.introPre': 'Set this up to save explanations straight to your database with the ',
  'notion.introPost': ' button.',
  'notion.step1Pre': 'Create an integration at ',
  'notion.step1Post': ' and copy its ',
  'notion.step1Bold': 'Internal Integration Secret',
  'notion.step2Pre': 'Open the target database page → ⋯ menu → add that integration under ',
  'notion.step2Bold': 'Connections',
  'notion.step3': 'Paste that database URL into "DB ID/URL" below',
  'row.notionToken': 'Integration token',
  'hint.notionToken':
    'Paste the Internal Integration Secret from step 1. The token is stored on this computer only.',
  'row.notionDb': 'DB ID/URL',
  'ph.notionDb': 'https://notion.so/…?v=… or a 32-character ID',
  'hint.notionDb': 'Pasting the whole database URL works — the ID is picked out automatically.',
  'row.notionTest': 'Connection',
  'test.notion.ok': '✓ Connected (DB: "{title}")',

  'row.cache': 'Stored translations',
  'btn.clearCache': 'Clear cache',
  'cache.count': '{count} videos stored',
  'confirm.clearCache': 'Clear all stored translations? The same video will be translated again.',
  'alert.cacheCleared': 'Cleared translations for {count} videos.',
  'row.resetAll': 'Reset options',
  'hint.resetAll': 'Resets every option',
  'btn.reset': 'Reset',
  'confirm.resetAll': 'Reset every option to its default? Stored translations are kept.',

  // ── 팝업 ───────────────────────────────────────────────────
  'status.checking': 'Checking…',
  'status.notYoutube': 'Not a YouTube page',
  'status.unreachable': 'Cannot reach the page · reload it',
  'status.off': 'Subtitles off',
  'status.noCues': 'No subtitles on this video',
  'status.active': 'Subtitles on · {count} lines',
  'pop.newQuestion': '➕ New question',
  'pop.newQuestion.title': 'Ask the AI without selecting subtitles (shortcut Alt+Q)',
  'pop.subtitlesOn': 'Show subtitles',
  'pop.shortcut': 'shortcut {key}',
  'pop.wordReveal': 'Karaoke mode',
  'pop.wordReveal.title': 'Words brighten as they are spoken (original line)',
  'pop.displayMode': 'Display mode',
  'pop.targetLang': 'Translate into',
  'pop.backend': 'Engine',
  'pop.noGeminiKey':
    'No Gemini API key — set one in Options (otherwise it falls back to Google free)',
  'pop.noMindlogicKey':
    'No gateway API key — set one in Options (otherwise it falls back to Google free)',
  'pop.lastBackend': 'Last translation: {backend}',
  'pop.fellBack': '⚠ {backend} failed → fallback',
  'pop.fellBack.title': '{preferred} call failed → automatically fell back to {used}',
  'pop.used.title': 'Handled by {used}',
  'ago.sec': '{n}s ago',
  'ago.min': '{n}m ago',
  'ago.hour': '{n}h ago',
  'ago.day': '{n}d ago',
  'pop.sourceSize': 'Original size',
  'pop.targetSize': 'Translation size',
  'pop.smaller': 'Smaller',
  'pop.larger': 'Larger',
  'pop.position': 'Subtitle position',
  'pop.position.title':
    'Use this when the Shorts overlay covers the subtitle and dragging/wheel stops working',
  'pop.resetPosition': 'Reset position',
  'pop.resetPosition.title': 'Reset both regular and Shorts positions to default',
  'pop.openOptions': 'All settings',

  // ── 해설 패널 ──────────────────────────────────────────────
  'panel.highlight': '🖍️ Highlight',
  'panel.highlight.title':
    'Select text and press this to mark it. Press with nothing selected to keep the mode on. Shortcut Shift+`',
  'panel.explain': '💡 Explain',
  'panel.question': '❓ Ask',
  'panel.directAsk': 'Direct question',
  'panel.newQuestion': '➕ New question',
  'panel.newQuestion.title': 'Open a new question tab without selecting subtitles (Alt+Q)',
  'panel.copy': '📋 Copy',
  'panel.copied': '✓ Copied',
  'panel.copyFailed': '✗ Failed',
  'panel.notion': '📝 Notion',
  'panel.notion.saved': '✓ Saved',
  'panel.notion.savedOpen': '✓ Saved ↗',
  'panel.notion.update': '♻ Update',
  'panel.notion.saving': 'Saving…',
  'panel.notion.updating': 'Updating…',
  'panel.notion.failed': '✗ Save failed',
  'panel.notion.open.title': 'Open in Notion',
  'panel.notion.update.title': 'Replace the Notion page with the current content',
  'panel.notion.savedTab.title': 'Saved to Notion',
  'panel.minimize.title': 'Minimize (tabs kept)',
  'panel.close.title': 'Close panel (all tabs)',
  'panel.chat.followup': 'Ask a follow-up… (e.g. simpler, more examples)',
  'panel.chat.new': 'Type a question and press Enter…',
  'panel.send.title': 'Send (Enter)',
  'panel.loading.answer': 'Generating answer…',
  'panel.loading.explain': 'Generating explanation…',
  'panel.ask.hint': 'Type your question in the box at the bottom and press Enter.',
  'panel.fab.title': 'Open the explanation panel (drag to move)',
  'panel.notice.saved': '📝 Saved to Notion: 「{title}」{suffix}',
  'panel.notice.oldKept': ' · ⚠ old page kept',
  'panel.notice.open': 'Open ↗',
  'panel.err.explain': 'Could not load the explanation: {error}',
  'panel.err.answer': 'Could not load the answer: {error}',
  'panel.copy.quote': '> Subtitle: {context}',
  'panel.qPrefix': '**Question:**',

  // ── AI 프롬프트 (기본값) ───────────────────────────────────
  'prompt.explainDefault': `You are my language teacher. Do your best to help me improve. Skip greetings and filler — give information only.

Answer like this:
- Answer in English
- Put an example sentence that fits the question at the very top, as inline code
- Write the meaning right under the example
- Only example sentences go in inline code
- For an idiom, explain where it comes from
- Use a table whenever the content fits one
- When a word has several senses, give the one image that ties them together so it can be applied flexibly.`,
  'prompt.question': `You are my language-learning assistant. Use the expression the user selected in the subtitles and its context to answer their question.
- Answer in English, briefly and to the point.
- Put example sentences and words in inline code (\`backtick\`).
- Use a table when that is clearer.
- Skip greetings and filler.`,
  'msg.selected': 'Selected from the subtitles: "{text}"',
  'msg.sentence': 'Subtitle sentence: {context}',
  'msg.question': 'Question: {question}',
  'msg.explainWithContext':
    'Explain the part "{text}" in the subtitle sentence below.\nSubtitle sentence: {context}',
  'msg.explainPlain': 'Explain "{text}".',

  // ── 백엔드 에러 (번역/해설/Notion) ─────────────────────────
  'err.gemini.noKey': 'No Gemini API key (enter one in the options page)',
  'err.mindlogic.noKey': 'No gateway API key (enter one in the options page)',
  'err.mindlogic.noBaseUrl': 'No gateway Base URL (enter one in the options page)',
  'err.cooldown': '{name} rate limit — waiting ({sec}s left)',
  'err.auth': '{name} key authentication failed (HTTP {status})',
  'err.rateLimit': '{name} rate limit exceeded (HTTP 429) — try again shortly',
  'err.rateLimitCooldown': '{name} rate limit exceeded (HTTP 429) — waiting {sec}s',
  'err.badRequest': '{name} request format error (HTTP 400): {detail}',
  'err.server': '{name} server error (HTTP {status}): {detail}',
  'err.generic': '{name} error (HTTP {status}){detail}',
  'err.noExplainResponse': '{name} returned no explanation (finishReason={reason})',
  'err.noTranslation': '{name} returned no translation (finishReason={reason})',
  'err.notJsonArray': 'Could not parse the {name} response as a JSON array',
  'err.notArray': 'The {name} response is not an array',
  'err.lengthMismatch': '{name} response length mismatch (expected {expected}, got {got})',
  'err.modelListFailed': 'Model list failed (HTTP {status})',
  'err.modelListEmpty': 'No models available (response format changed?)',
  'err.keyAuth': 'Key authentication failed (HTTP {status})',
  'err.creditsUnsupported':
    'Credits endpoint not supported (HTTP 404) — this gateway build may not have it',
  'err.creditsFailed': 'Credit check failed (HTTP {status})',
  'model.group.other': 'other',
  'model.balanced': 'balanced',
  'model.quota': 'quota & speed',
  'model.newest': 'newest, high quality',
  'model.explainRec': 'best for explanations',
  'err.notion.noToken': 'No Notion token (enter one in the options page)',
  'err.notion.badDbId': 'Notion database ID is not in a valid format',
  'err.notion.badDbIdLong':
    'Database ID is not in a valid format (32-character ID or database URL)',
  'err.notion.noTitleProp': 'The database has no title property',
  'err.notion.auth': 'Notion token authentication failed (HTTP 401) — check the token',
  'err.notion.notFound':
    'Database not found (HTTP 404) — check the ID and that the database is shared with the integration',
  'err.notion.rateLimit': 'Notion rate limit exceeded (HTTP 429) — try again shortly',
  'err.notion.generic': 'Notion error (HTTP {status}){detail}',
  'notion.untitled': '(untitled)',
  'notion.video': 'Video',
} as const;

export type MsgKey = keyof typeof EN;

const KO: Record<MsgKey, string> = {
  'err.noBgResponse': '백그라운드 응답 없음 — 확장 재로드',
  'err.settingsLoading': '설정 로드 전입니다. 잠시 후 다시 시도하세요.',
  'err.settingsLoadingShort': '설정 로드 전입니다.',
  'err.emptyExplainPrompt': '해설 프롬프트가 비어 있어요 (옵션에서 입력하거나 "기본값으로").',
  'err.emptyNotionDb': 'Notion 데이터베이스 ID가 비어 있어요 (옵션에서 입력).',

  'mode.dual': '원문 + 번역 같이',
  'mode.translationOnly': '번역만',
  'mode.sourceOnly': '원문만',
  'backend.googleFree.short': 'Google 무료',
  'backend.chrome.short': 'Chrome 내장 (오프라인)',
  'backend.gemini.short': 'Gemini (내 키)',
  'backend.mindlogic.short': 'OpenAI 호환 게이트웨이',
  'backend.googleFree.name': 'Google 무료',
  'backend.chrome.name': 'Chrome 내장',
  'backend.gemini.name': 'Gemini',
  'backend.mindlogic.name': '게이트웨이',

  'opt.loading': '옵션 불러오는 중…',
  'opt.saving': '저장 중…',
  'opt.saved': '● 저장됨',
  'opt.preview': '미리보기',
  'opt.preview.dual': '이중 자막',
  'opt.preview.single': '이중 자막이 아닐때',
  'opt.reset': '↻ 초기화',
  'opt.group.recommended': '추천',
  'opt.group.current': '현재',
  'weight.400': '보통',
  'weight.500': '약간 굵게',
  'weight.700': '굵게',
  'style.size': '크기',
  'style.color': '색',
  'style.weight': '굵기',
  'style.source': '1. 원문 자막',
  'style.target': '2. 번역 자막',

  'sec.dual': '이중 자막 설정',
  'sec.single': '이중 자막이 아닐때',
  'sec.style': '자막 스타일',
  'sec.layout': '자막 배치 · 배경',
  'sec.backend': '번역 방식',
  'sec.gemini': 'Gemini 설정',
  'sec.mindlogic': 'OpenAI 호환 게이트웨이 설정',
  'sec.notion': 'Notion 저장 (해설 패널)',
  'sec.manage': '관리',

  'row.uiLang': '표시 언어',
  'hint.uiLang': '확장 화면 언어. AI 기본 프롬프트도 이 언어를 따라갑니다.',
  'row.subtitlesOn': '자막 켜기',
  'row.toggleKey': '켜기/끄기 단축키',
  'hint.toggleKey': '수정키 없는 알파벳 1개 · c/f/j/k/l/m/n/i/t/w 등은 YouTube 자체 단축키와 겹침',
  'hint.recordingKey': '키를 눌러 지정 (Esc로 취소)',
  'btn.recordingKey': '키 입력 대기…',
  'row.targetLang': '번역 언어',
  'hint.targetLang': '원문 언어는 영상마다 자동 감지',
  'row.displayMode': '표시 모드',
  'row.wordReveal': '노래방 모드',
  'row.contextLines': '표시 자막 수',
  'lines.1': '한 줄만',
  'lines.2': '두 줄 (지금 + 바로 앞)',
  'lines.3': '세 줄 (지금 + 앞 두 줄)',
  'row.historyLayout': '쌓는 방식',
  'layout.stacked': '줄로 쌓기',
  'layout.inline': '한 문단처럼 이어 보기',
  'row.dimHistory': '지난 줄 흐리게 표시',
  'hint.dimHistory': '지금 말하는 줄이 더 잘 보이게 설정',
  'reset.textStyle.title': '원문·번역 텍스트 스타일(크기·색·굵기)을 기본값으로',
  'reset.layout.title': '쇼츠 크기·배경·줄 간격·자막 위치를 기본값으로',
  'confirm.resetTextStyle': '원문·번역 자막 스타일(크기·색·굵기)을 기본값으로 되돌릴까요?',
  'confirm.resetLayout': '쇼츠 자막 크기·배경 진하기·줄 간격·자막 위치를 기본값으로 되돌릴까요?',
  'row.shortsScale': '쇼츠 자막 크기',
  'hint.shortsScale': '100%면 일반 영상이랑 같음',
  'row.bgOpacity': '자막 배경 진하기',
  'hint.bgOpacity': '올릴수록 진해짐',
  'row.lineHeight': '원문과 번역 사이',
  'row.position': '자막 위치',
  'hint.positionDrag': '• 자막 드래그 = 이동',
  'hint.positionWheel': '• 마우스 휠 = 크기 조절',

  'backend.googleFree.title': 'Google 무료',
  'backend.recommended': '추천',
  'backend.googleFree.desc': '온라인 번역. 너무 자주 쓰면 잠깐 끊길 수 있음',
  'backend.chrome.title': 'Chrome 내장 (오프라인)',
  'backend.chrome.desc': '오프라인 번역. 긴 문장은 살짝 어색할 수 있음',
  'backend.gemini.title': 'Gemini (내 API 키)',
  'backend.aiBadge': 'AI 번역',
  'backend.gemini.descPre': '',
  'backend.gemini.descPost': '에서 무료 발급 가능',
  'backend.mindlogic.title': 'OpenAI 호환 게이트웨이 (조직 키)',
  'backend.mindlogic.desc':
    '학교/조직에서 발급된 키 하나로 OpenAI 호환 엔드포인트를 통해 Claude · GPT · Gemini 등 여러 모델 사용 가능',

  'row.apiKey': 'API 키',
  'btn.show': '👁 보기',
  'btn.hide': '🙈 숨김',
  'btn.test': '🧪 테스트',
  'btn.testing': '테스트 중…',
  'btn.checking': '확인 중…',
  'test.ok': '✓ 동작함 (예: "Hello, world." → "{translation}")',
  'test.models.ok': '· 모델 목록 {count}개 확인',
  'test.models.err': '· 모델 목록 갱신 실패: {error}',
  'credits.ok': '· 잔여 {remaining} / {quota} 크레딧',
  'credits.renewal': ' (갱신 {date})',
  'credits.purchased': ' · 구매 잔여 {remaining} 크레딧',
  'credits.err': '· 크레딧 확인 실패: {error}',
  'warn.noGeminiKey': '키 없으면 Google 무료로 자동 fallback',
  'warn.noMindlogicKey': 'Base URL·키 없으면 Google 무료로 자동 fallback',
  'hint.geminiKey':
    '가입만 하면 무료로 발급되고 신용카드도 필요 없어요. 키는 이 PC에만 저장돼요(다른 기기로 동기화 안 됨).',
  'hint.mindlogicKey':
    '학교/조직에서 발급받은 키를 붙여넣으세요. 키는 이 PC에만 저장돼요(다른 기기로 동기화 안 됨).',
  'row.baseUrl': 'Base URL',
  'hint.baseUrl':
    '소속 조직(학교/회사)에서 안내받은 게이트웨이 주소를 붙여넣으세요. 조직마다 도메인이 달라요 — 다른 조직 계정으로 바꾸려면 이 값도 함께 바꾸면 됩니다.',
  'ph.mindlogicKey': 'sk-... 또는 발급받은 키',
  'row.transModel': '번역 모델',
  'hint.transModel':
    '영상 자막 전체를 번역할 때 쓰는 모델이에요. 문장이 많으니 빠르고 저렴한 모델이 잘 맞아요.',
  'row.explainModel': '해설 모델',
  'hint.explainModelPre': '영상에서 자막을 드래그하면 ',
  'hint.explainModelPost':
    ' 버튼이 떠요. 가끔 한 번씩만 부르니 조금 느려도 똑똑한 모델이 잘 맞아요.',
  'row.explainPrompt': '해설 프롬프트',
  'btn.restoreDefault': '기본값으로',

  'notion.introPre': '',
  'notion.introPost': ' 버튼으로 DB에 바로 저장하려면 아래를 설정하세요.',
  'notion.step1Pre': '',
  'notion.step1Post': '에서 integration 만들고 ',
  'notion.step1Bold': 'Internal Integration Secret',
  'notion.step2Pre': '저장할 데이터베이스 페이지 → 우측 ⋯ → ',
  'notion.step2Bold': '연결(Connections)',
  'notion.step3': '그 데이터베이스의 URL을 아래 "DB ID/URL"에 붙여넣기',
  'row.notionToken': 'Integration 토큰',
  'hint.notionToken':
    '위 1번에서 복사한 Internal Integration Secret을 붙여넣으세요. 토큰은 이 PC에만 저장돼요.',
  'row.notionDb': 'DB ID/URL',
  'ph.notionDb': 'https://notion.so/...?v=... 또는 32자리 ID',
  'hint.notionDb':
    '저장할 데이터베이스 페이지의 주소(URL)를 통째로 붙여넣어도 자동으로 ID를 인식해요.',
  'row.notionTest': '연결 확인',
  'test.notion.ok': '✓ 연결됨 (DB: "{title}")',

  'row.cache': '저장된 번역',
  'btn.clearCache': '캐시 비우기',
  'cache.count': '현재 {count}개 영상 저장',
  'confirm.clearCache': '저장된 번역을 모두 비울까요? 다음에 같은 영상을 봐도 다시 번역됨.',
  'alert.cacheCleared': '{count}개 영상의 번역을 비움.',
  'row.resetAll': '옵션 초기화',
  'hint.resetAll': '모든 옵션 초기화',
  'btn.reset': '초기화',
  'confirm.resetAll': '모든 옵션을 처음으로 되돌릴까요? 저장된 번역은 그대로 유지됨.',

  'status.checking': '확인 중…',
  'status.notYoutube': 'YouTube 화면이 아님',
  'status.unreachable': '페이지에 연결할 수 없음 · 새로고침 필요',
  'status.off': '자막 꺼짐',
  'status.noCues': '이 영상에는 자막 없음',
  'status.active': '자막 켜짐 · {count}줄',
  'pop.newQuestion': '➕ 새 질문',
  'pop.newQuestion.title': '자막 선택 없이 AI에게 바로 질문 (단축키 Alt+Q)',
  'pop.subtitlesOn': '자막 켜기',
  'pop.shortcut': '단축키 {key}',
  'pop.wordReveal': '노래방 모드',
  'pop.wordReveal.title': '노래방처럼 말하는 단어가 또렷해짐 (원문 자막)',
  'pop.displayMode': '표시 모드',
  'pop.targetLang': '바꿀 언어',
  'pop.backend': '번역 방식',
  'pop.noGeminiKey':
    'Gemini API 키가 설정되지 않음 — 옵션에서 키 입력 필요 (안 하면 Google 무료로 fallback)',
  'pop.noMindlogicKey':
    '게이트웨이 API 키가 설정되지 않음 — 옵션에서 키 입력 필요 (안 하면 Google 무료로 fallback)',
  'pop.lastBackend': '최근 번역: {backend}',
  'pop.fellBack': '⚠ {backend} 실패 → fallback',
  'pop.fellBack.title': '{preferred} 호출 실패 → {used}로 자동 fallback',
  'pop.used.title': '{used}로 처리 완료',
  'ago.sec': '{n}초 전',
  'ago.min': '{n}분 전',
  'ago.hour': '{n}시간 전',
  'ago.day': '{n}일 전',
  'pop.sourceSize': '원문 크기',
  'pop.targetSize': '번역 크기',
  'pop.smaller': '작게',
  'pop.larger': '크게',
  'pop.position': '자막 위치',
  'pop.position.title':
    'Shorts 하단 제목 등으로 자막이 흐려져 드래그/휠이 막힐 때 위치를 기본값으로 되돌림',
  'pop.resetPosition': '위치 초기화',
  'pop.resetPosition.title': '일반 영상/Shorts 위치를 모두 기본값으로 초기화',
  'pop.openOptions': '자세히 설정하기',

  'panel.highlight': '🖍️ 형광펜',
  'panel.highlight.title':
    '드래그 후 누르면 그 부분을 형광펜 표시. 선택 없이 누르면 모드 ON(이후 드래그마다 자동). 단축키 Shift+`',
  'panel.explain': '💡 해설',
  'panel.question': '❓ 질문',
  'panel.directAsk': '직접 질문',
  'panel.newQuestion': '➕ 새 질문',
  'panel.newQuestion.title': '자막 선택 없이 새 질문 탭 열기 (단축키 Alt+Q)',
  'panel.copy': '📋 복사',
  'panel.copied': '✓ 복사됨',
  'panel.copyFailed': '✗ 실패',
  'panel.notion': '📝 Notion',
  'panel.notion.saved': '✓ 저장됨',
  'panel.notion.savedOpen': '✓ 저장됨 ↗',
  'panel.notion.update': '♻ 업데이트',
  'panel.notion.saving': '저장 중…',
  'panel.notion.updating': '업데이트 중…',
  'panel.notion.failed': '✗ 저장 실패',
  'panel.notion.open.title': 'Notion에서 열기',
  'panel.notion.update.title': 'Notion 페이지를 지금 내용으로 갈아끼우기',
  'panel.notion.savedTab.title': 'Notion 저장됨',
  'panel.minimize.title': '최소화 (탭 유지)',
  'panel.close.title': '패널 닫기 (모든 탭)',
  'panel.chat.followup': '이어서 질문… (예: 더 쉽게, 예문 보여줘)',
  'panel.chat.new': '질문을 입력하고 Enter…',
  'panel.send.title': '보내기 (Enter)',
  'panel.loading.answer': '답변 생성 중…',
  'panel.loading.explain': '해설 생성 중…',
  'panel.ask.hint': '맨 아래 입력창에 질문을 입력하고 Enter.',
  'panel.fab.title': '해설 패널 펼치기 (드래그로 이동)',
  'panel.notice.saved': '📝 Notion 저장됨: 「{title}」{suffix}',
  'panel.notice.oldKept': ' · ⚠ 옛 페이지 남음',
  'panel.notice.open': '열기 ↗',
  'panel.err.explain': '해설을 불러오지 못했어요: {error}',
  'panel.err.answer': '답변을 불러오지 못했어요: {error}',
  'panel.copy.quote': '> 자막: {context}',
  'panel.qPrefix': '**질문:**',

  'prompt.explainDefault': `너는 나의 영어 선생님이야. 내가 영어를 잘 할 수 있도록 최선을 다해. 답변할 때 정보 전달 외 불필요한 인삿말은 하지 마.

답변은 다음과 같이 할것
- 답변은 한국말로
- 답변 최상단에는 질문에 적합한 영어예문을 인라인 코드로 작성
- 예문 아래에 한글 해석 작성
- 영어 예문들만 인라인 코드로 작성할것
- 관용어(idiom)의 경우 어원 설명
- 표로 만들 수 있는건 되도록 표로 제작
- 의미가 다양할 경우 관통하는 하나의 이미지 표현을 제시, 유연하게 해석할 수 있도록 한다.`,
  'prompt.question': `너는 나의 언어 학습 도우미야. 사용자가 자막에서 고른 표현과 그 문맥을 참고해 사용자의 질문에 답해.
- 답변은 한국어로, 핵심만 간결하게.
- 영어 예문이나 단어는 인라인 코드(\`backtick\`)로 표시.
- 표로 정리하는 게 더 명확하면 표로.
- 정보 전달 외 불필요한 인삿말은 하지 마.`,
  'msg.selected': '자막에서 고른 부분: "{text}"',
  'msg.sentence': '자막 문장: {context}',
  'msg.question': '질문: {question}',
  'msg.explainWithContext': '아래 자막 문장에서 "{text}" 부분을 설명해줘.\n자막 문장: {context}',
  'msg.explainPlain': '"{text}"를 설명해줘.',

  'err.gemini.noKey': 'Gemini API 키가 없음 (옵션 페이지에서 입력 필요)',
  'err.mindlogic.noKey': '게이트웨이 API 키가 없음 (옵션 페이지에서 입력 필요)',
  'err.mindlogic.noBaseUrl': '게이트웨이 Base URL이 없음 (옵션 페이지에서 입력 필요)',
  'err.cooldown': '{name} 한도 초과로 대기 중 ({sec}초 남음)',
  'err.auth': '{name} 키 인증 실패 (HTTP {status})',
  'err.rateLimit': '{name} 한도 초과 (HTTP 429) — 잠시 후 다시',
  'err.rateLimitCooldown': '{name} 한도 초과 (HTTP 429) — {sec}초 대기',
  'err.badRequest': '{name} 요청 형식 오류 (HTTP 400): {detail}',
  'err.server': '{name} 서버 오류 (HTTP {status}): {detail}',
  'err.generic': '{name} 오류 (HTTP {status}){detail}',
  'err.noExplainResponse': '{name} 해설 응답 없음 (finishReason={reason})',
  'err.noTranslation': '{name} 응답에 번역 결과 없음 (finishReason={reason})',
  'err.notJsonArray': '{name} 응답을 JSON 배열로 파싱 못함',
  'err.notArray': '{name} 응답이 배열이 아님',
  'err.lengthMismatch': '{name} 응답 길이 불일치 (예상 {expected}, 받음 {got})',
  'err.modelListFailed': '모델 목록 실패 (HTTP {status})',
  'err.modelListEmpty': '사용 가능한 모델이 없음 (응답 형식 변경?)',
  'err.keyAuth': '키 인증 실패 (HTTP {status})',
  'err.creditsUnsupported': '크레딧 조회 미지원 (HTTP 404) — 이 게이트웨이 버전엔 없을 수 있음',
  'err.creditsFailed': '크레딧 조회 실패 (HTTP {status})',
  'model.group.other': '기타',
  'model.balanced': '균형 (번역 추천)',
  'model.quota': '한도·속도',
  'model.newest': '최신·고품질',
  'model.explainRec': '해설 추천',
  'err.notion.noToken': 'Notion 토큰이 없음 (옵션 페이지에서 입력 필요)',
  'err.notion.badDbId': 'Notion 데이터베이스 ID 형식이 올바르지 않음',
  'err.notion.badDbIdLong': '데이터베이스 ID 형식이 올바르지 않음 (32자리 ID 또는 DB URL)',
  'err.notion.noTitleProp': '데이터베이스에 제목(title) 속성이 없음',
  'err.notion.auth': 'Notion 토큰 인증 실패 (HTTP 401) — 토큰 확인',
  'err.notion.notFound':
    'DB를 못 찾음 (HTTP 404) — ID가 맞는지, integration에 DB를 연결(share)했는지 확인',
  'err.notion.rateLimit': 'Notion 요청 한도 초과 (HTTP 429) — 잠시 후 다시',
  'err.notion.generic': 'Notion 오류 (HTTP {status}){detail}',
  'notion.untitled': '(제목 없음)',
  'notion.video': '영상',
};

const TABLE: Record<UiLang, Record<MsgKey, string>> = { en: EN, ko: KO };

// 현재 언어 — 모듈 전역. React 페이지는 렌더 직전 setUiLang으로 동기화하고,
// content/background는 initUiLang()이 storage를 따라 갱신한다.
let current: UiLang = 'en';

export function setUiLang(lang: UiLang): void {
  current = lang;
}

export function getUiLang(): UiLang {
  return current;
}

function fill(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** 현재 언어로 번역. 값이 비면 영어로 폴백. */
export function t(key: MsgKey, vars?: Vars): string {
  return fill(TABLE[current][key] || EN[key], vars);
}

/** 언어를 명시해 번역 — 저장된 기본 프롬프트 비교처럼 "다른 언어" 값이 필요할 때. */
export function tl(lang: UiLang, key: MsgKey, vars?: Vars): string {
  return fill(TABLE[lang][key] || EN[key], vars);
}

/** content/background/ask-anywhere용 — storage에서 읽고 이후 변경도 추적. */
export async function initUiLang(): Promise<void> {
  try {
    const r = await chrome.storage.sync.get({ uiLang: 'en' });
    if (r.uiLang === 'ko' || r.uiLang === 'en') current = r.uiLang;
  } catch {
    // storage 접근 실패 — 기본값(영어) 유지.
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.uiLang) return;
    const v = changes.uiLang.newValue;
    if (v === 'ko' || v === 'en') current = v;
  });
}
