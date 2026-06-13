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
import type { ExplainBackend, GeminiModel, MindlogicModel } from '../shared/settings';

const TAG = '[YDT/explain]';

const GEMINI_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MINDLOGIC_ENDPOINT = 'https://factchat-cloud.mindlogic.ai/v1/gateway/chat/completions';

// gemini.ts와 동일 — preview/latest alias 회피용 고정 버전.
const GEMINI_MODEL_ID: Record<GeminiModel, string> = {
  flash: 'gemini-2.5-flash',
  'flash-lite': 'gemini-2.5-flash-lite',
};

// 해설은 표/예문 등으로 번역보다 길어질 수 있어 토큰 여유를 크게.
const MAX_TOKENS = 2048;

export interface ExplainParams {
  text: string; // 사용자가 선택한 영어 표현
  context?: string; // 그 표현이 속한 자막 문장 (단어 뜻 disambiguation용)
  backend: ExplainBackend;
  model: GeminiModel | MindlogicModel;
  prompt: string; // system 프롬프트 (옵션 explainPrompt)
}

export async function explain(params: ExplainParams): Promise<string> {
  const userMsg = buildUserMessage(params.text, params.context);
  if (params.backend === 'mindlogic') {
    return explainMindlogic(params.prompt, userMsg, params.model as MindlogicModel);
  }
  return explainGemini(params.prompt, userMsg, params.model as GeminiModel);
}

function buildUserMessage(text: string, context?: string): string {
  const t = text.trim();
  const ctx = context?.trim();
  if (ctx && ctx !== t) {
    return `아래 자막 문장에서 "${t}" 부분을 설명해줘.\n자막 문장: ${ctx}`;
  }
  return `"${t}"를 설명해줘.`;
}

async function explainGemini(
  prompt: string,
  userMsg: string,
  model: GeminiModel,
): Promise<string> {
  const apiKey = await getGeminiApiKey();
  if (!apiKey) throw new Error('Gemini API 키가 없음 (옵션 페이지에서 입력 필요)');
  const modelId = GEMINI_MODEL_ID[model] ?? GEMINI_MODEL_ID.flash;
  const url = `${GEMINI_ENDPOINT_BASE}/${modelId}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: prompt }] },
    contents: [{ role: 'user', parts: [{ text: userMsg }] }],
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
    throw new Error(`Gemini 해설 응답 없음 (finishReason=${candidate?.finishReason ?? 'unknown'})`);
  }
  return text;
}

async function explainMindlogic(
  prompt: string,
  userMsg: string,
  model: MindlogicModel,
): Promise<string> {
  const apiKey = await getMindlogicApiKey();
  if (!apiKey) throw new Error('Mindlogic API 키가 없음 (옵션 페이지에서 입력 필요)');
  const body = {
    model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.3,
    max_tokens: MAX_TOKENS,
  };

  const res = await fetchWithRetry(MINDLOGIC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw httpError('Mindlogic', res.status, await res.text().catch(() => ''));
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const choice = data.choices?.[0];
  const text = choice?.message?.content ?? '';
  if (!text.trim()) {
    throw new Error(`Mindlogic 해설 응답 없음 (finish_reason=${choice?.finish_reason ?? 'unknown'})`);
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
  if (status === 401 || status === 403) return new Error(`${name} 키 인증 실패 (HTTP ${status})`);
  if (status === 429) return new Error(`${name} 한도 초과 (HTTP 429) — 잠시 후 다시`);
  const detail = body.length > 200 ? body.slice(0, 200) + '…' : body;
  return new Error(`${name} 오류 (HTTP ${status})${detail ? `: ${detail}` : ''}`);
}
