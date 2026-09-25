// 단어/표현 "해설" 백엔드 — 자막을 드래그 선택하면 AI "영어 선생님"이 markdown 해설을 돌려준다.
//
// 번역(translateBatch)과 다른 호출 모델: 짧은 cue × N의 배치/정렬이 아니라, 선택한 표현 하나에
// 대한 자유서술 1회 chat 호출. 그래서 router/길이검증/캐시를 거치지 않고 여기서 직접 호출한다.
// 백엔드는 자유 프롬프트 chat이 가능한 BYOK 둘(gemini/mindlogic)만 — google-free/chrome-builtin은
// 번역 전용이라 해설 불가. 키는 번역과 동일하게 secrets.ts(storage.local)에서 읽는다.
//
// system = 사용자 프롬프트(옵션의 explainPrompt, 기본값은 사용자의 Gem 프롬프트),
// user = 선택 표현 + 자막 문맥. 응답 markdown 문자열을 그대로 content로 돌려 패널이 렌더한다.

import { getGeminiApiKey, getMindlogicApiKey } from '../shared/secrets';
import { fillAnswerLang, getMindlogicBaseUrl, loadSettings, questionSystemPrompt } from '../shared/settings';
import type { ExplainBackend, GeminiModel, MindlogicModel } from '../shared/settings';
import type { ChatTurn } from '../shared/types';
import { resolveGeminiModelId } from './translators/gemini';
import { getUiLang, t as tr } from '../shared/i18n';

const TAG = '[YDT/explain]';

const GEMINI_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// 해설은 표·예문 여러 개로 번역보다 훨씬 길어질 수 있어 토큰 여유를 크게(잘림 방지).
const MAX_TOKENS = 4096;

export interface ExplainParams {
  text: string; // 사용자가 선택한 영어 표현
  context?: string; // 그 표현이 속한 자막 문장 (단어 뜻 disambiguation용)
  backend: ExplainBackend;
  model: GeminiModel | MindlogicModel;
  prompt: string; // system 프롬프트 (옵션 explainPrompt)
  question?: string; // 사용자 자유 질문 — 있으면 해설이 아니라 "질문" 경로(질문 전용 프롬프트)
  isAsk?: boolean; // Alt+Q "직접 질문"(자막 선택·문맥 없음) — 문맥이 얇아 질문 프롬프트론 답이 짧아지므로
  // 해설 프롬프트(params.prompt)로 풍부하게 답하게 한다. 후속(history 있음)·선택 ❓질문엔 안 붙는다.
  history?: ChatTurn[]; // 이전 대화(user/model 교대). 있으면 후속 질문 — 문맥으로 함께 전달.
}

// markdown뿐 아니라 이번에 실제로 보낸 user 메시지도 돌려준다 — content가 대화 기록(turns)에
// 정확히 그 문자열을 넣어 다음 후속 질문의 history로 재전송할 수 있게(재구성 drift 방지).
export interface ExplainOutput {
  markdown: string;
  userMessage: string;
}

export async function explain(params: ExplainParams): Promise<ExplainOutput> {
  const q = params.question?.trim();
  // 질문이 있으면(=후속 포함) 기본은 가벼운 질문 프롬프트. 단 Alt+Q "직접 질문"(isAsk)은 자막 문맥이
  // 없어 답이 얇아지므로 해설 프롬프트(params.prompt)로 풍부하게 — 프롬프트가 비면 질문 프롬프트로 폴백.
  const useExplainForAsk = params.isAsk === true && !!params.prompt?.trim();
  const rawPrompt = q ? (useExplainForAsk ? params.prompt : questionSystemPrompt(getUiLang())) : params.prompt;
  // 답변 언어 = 번역 언어(settings.ts:fillAnswerLang). storage에서 매 호출 fresh read — content와
  // ask-anywhere(유튜브 밖) 두 호출 경로를 한 곳에서 처리.
  const { targetLang } = await loadSettings();
  const systemPrompt = fillAnswerLang(rawPrompt, targetLang, getUiLang());
  const userMsg = buildUserMessage(params.text, params.context, q);
  const history = params.history ?? [];
  const markdown =
    params.backend === 'mindlogic'
      ? await explainMindlogic(systemPrompt, history, userMsg, params.model as MindlogicModel)
      : await explainGemini(systemPrompt, history, userMsg, params.model as GeminiModel);
  return { markdown, userMessage: userMsg };
}

function buildUserMessage(text: string, context?: string, question?: string): string {
  const t = text.trim();
  const ctx = context?.trim();
  const q = question?.trim();
  if (q) {
    const lines: string[] = [];
    // 자막 선택 없이 연 "직접 질문"(Alt+Q)이면 t가 비어 "고른 부분" 줄은 생략 → 순수 질문만.
    if (t) lines.push(tr('msg.selected', { text: t }));
    if (ctx && ctx !== t) lines.push(tr('msg.sentence', { context: ctx }));
    lines.push(tr('msg.question', { question: q }));
    return lines.join('\n');
  }
  if (ctx && ctx !== t) {
    return tr('msg.explainWithContext', { text: t, context: ctx });
  }
  return tr('msg.explainPlain', { text: t });
}

async function explainGemini(
  prompt: string,
  history: ChatTurn[],
  userMsg: string,
  model: GeminiModel,
): Promise<string> {
  const apiKey = await getGeminiApiKey();
  if (!apiKey) throw new Error(tr('err.gemini.noKey'));
  const url = `${GEMINI_ENDPOINT_BASE}/${resolveGeminiModelId(model)}:generateContent`;
  // history의 role('user'/'model')은 gemini 규약과 동일 → 그대로 매핑, 끝에 이번 user 메시지.
  const contents = [
    ...history.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: 'user', parts: [{ text: userMsg }] },
  ];
  const body = {
    systemInstruction: { parts: [{ text: prompt }] },
    contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: MAX_TOKENS },
  };

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw httpError('Gemini', res.status, await res.text().catch(() => ''));
  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
  };
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text.trim()) {
    throw new Error(
      tr('err.noExplainResponse', { name: 'Gemini', reason: candidate?.finishReason ?? 'unknown' }),
    );
  }
  return text;
}

async function explainMindlogic(
  prompt: string,
  history: ChatTurn[],
  userMsg: string,
  model: MindlogicModel,
): Promise<string> {
  const apiKey = await getMindlogicApiKey();
  if (!apiKey) throw new Error(tr('err.mindlogic.noKey'));
  const baseUrl = await getMindlogicBaseUrl();
  if (!baseUrl) throw new Error(tr('err.mindlogic.noBaseUrl'));
  // OpenAI 호환: system 다음에 history(model→assistant 매핑), 끝에 이번 user 메시지.
  const messages = [
    { role: 'system', content: prompt },
    ...history.map((t) => ({ role: t.role === 'model' ? 'assistant' : 'user', content: t.text })),
    { role: 'user', content: userMsg },
  ];
  const body = {
    model,
    messages,
    temperature: 0.3,
    max_tokens: MAX_TOKENS,
  };

  const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw httpError('Gateway', res.status, await res.text().catch(() => ''));
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const choice = data.choices?.[0];
  const text = choice?.message?.content ?? '';
  if (!text.trim()) {
    throw new Error(
      tr('err.noExplainResponse', { name: 'Gateway', reason: choice?.finish_reason ?? 'unknown' }),
    );
  }
  return text;
}

// 429/5xx만 1회 1500ms 백오프 재시도. 나머지는 그대로 반환해 호출 측이 status로 분기.
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let res = await fetch(url, init);
  if ((res.status === 429 || res.status >= 500) && res.status !== 501) {
    console.warn(TAG, `HTTP ${res.status}, retry in 1500ms`);
    await new Promise((r) => setTimeout(r, 1500));
    res = await fetch(url, init);
  }
  return res;
}

function httpError(name: string, status: number, body: string): Error {
  if (status === 401 || status === 403) return new Error(tr('err.auth', { name, status }));
  if (status === 429) return new Error(tr('err.rateLimit', { name }));
  const detail = body.length > 200 ? body.slice(0, 200) + '…' : body;
  return new Error(tr('err.generic', { name, status, detail: detail ? `: ${detail}` : '' }));
}
