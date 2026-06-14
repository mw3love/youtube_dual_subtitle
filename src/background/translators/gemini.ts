// Gemini API (BYOK) 번역 백엔드.
//
// 사용자가 본인 API 키를 옵션 페이지에서 입력 → storage.local(secrets.ts)에 분리 저장.
// 모델은 settings.geminiModel (storage.sync). gemini.ts가 호출 시점에 양쪽에서 fresh read.
//
// 요청 전략:
// - 입력 배열을 JSON.stringify → user 메시지 한 줄로 전송.
// - generationConfig.responseMimeType=application/json + responseSchema(ARRAY of STRING)로 JSON 강제.
//   minItems/maxItems로 항목 수까지 스키마 단에서 강제 (모델이 짧은 cue를 묶지 못하게).
// - 응답 배열 길이를 입력 길이와 비교해 alignment 보장. mismatch면 1회 재시도, 그래도 어긋나면 throw.
// - 429/5xx는 1회만 1500ms backoff 후 재시도. 401/403/400은 즉시 throw.
// - safety filter 등으로 빈 응답 가능 → finishReason 포함해 에러로.
//
// 청크 분할:
// - content/index.ts가 50개 단위로 보내는데, Gemini는 짧은 자막 cue를 여러 개 묶어 합치는
//   경향이 있어 50개 → 30~40개로 줄어드는 mismatch가 자주 발생.
// - 내부에서 GEMINI_CHUNK_SIZE(20)로 다시 쪼개 호출. 한 번 호출당 항목 수가 적을수록 모델이
//   "묶을지 말지" 갈등할 여지가 줄어듦.

import { getGeminiApiKey } from '../../shared/secrets';
import type { GeminiModel } from '../../shared/settings';

const TAG = '[YDT/gemini]';
const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// 정식 안정 모델 ID. preview/latest alias 대신 고정 버전 사용해 갑작스러운 동작 변화 회피.
const MODEL_ID: Record<GeminiModel, string> = {
  flash: 'gemini-2.5-flash',
  'flash-lite': 'gemini-2.5-flash-lite',
  '3.5-flash': 'gemini-3.5-flash',
};

// 청크당 최대 항목 수. 50 정도면 모델이 짧은 cue를 합쳐 응답이 줄어들고,
// 그러면 router fallback이 끼어 들어 사실상 google-free로 동작하게 됨.
const GEMINI_CHUNK_SIZE = 20;

// 429 (한도 초과) 맞으면 일정 시간 Gemini 호출 자체를 skip — 매 batch마다 1.5s 백오프 × 청크 ×
// 영상으로 누적되는 지연 방지. 그동안은 즉시 throw → router가 google-free로 fallback.
const RATE_LIMIT_COOLDOWN_MS = 60_000;
let rateLimitedUntil = 0;

interface GeminiOptions {
  apiKey?: string;
  model?: GeminiModel;
}

export async function translateBatch(
  texts: string[],
  src: string,
  tgt: string,
  opts?: GeminiOptions,
): Promise<string[]> {
  if (texts.length === 0) return [];
  // 호출 직전에 cooldown 확인 — 한도 도달 후엔 즉시 throw해 router가 다음 백엔드로.
  const now = Date.now();
  if (rateLimitedUntil > now) {
    const wait = Math.ceil((rateLimitedUntil - now) / 1000);
    throw new Error(`Gemini 한도 초과로 대기 중 (${wait}초 남음)`);
  }
  const apiKey = opts?.apiKey ?? (await getGeminiApiKey());
  if (!apiKey) {
    throw new Error('Gemini API 키가 설정되어 있지 않음 (옵션 페이지에서 입력 필요)');
  }
  const model = opts?.model ?? (await readModel());

  if (texts.length <= GEMINI_CHUNK_SIZE) {
    return callGeminiWithRetry(texts, src, tgt, apiKey, model);
  }
  // 큰 batch를 작은 청크로 쪼개 순차 호출. 각 청크는 자체적으로 길이 검증 + 1회 재시도.
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += GEMINI_CHUNK_SIZE) {
    const chunk = texts.slice(i, i + GEMINI_CHUNK_SIZE);
    const part = await callGeminiWithRetry(chunk, src, tgt, apiKey, model);
    out.push(...part);
  }
  return out;
}

// 옵션 페이지 "테스트" 버튼용 — storage 안 거치고 explicit 인자 사용해
// 디바운스 저장 race를 피하고, router fallback도 건너뜀.
// cooldown도 우회 — 사용자가 새 키로 검증 중일 수 있음. 성공 시 기존 cooldown 해제.
export async function testGeminiKey(apiKey: string, model: GeminiModel): Promise<string> {
  const out = await callGeminiWithRetry(['Hello, world.'], 'en', 'ko', apiKey, model);
  rateLimitedUntil = 0;
  return out[0] ?? '';
}

async function readModel(): Promise<GeminiModel> {
  const r = await chrome.storage.sync.get({ geminiModel: 'flash' });
  return r.geminiModel === 'flash-lite' ? 'flash-lite' : 'flash';
}

function systemInstruction(src: string, tgt: string, count: number): string {
  const srcDesc = src === 'auto' ? 'the auto-detected source language' : `'${src}'`;
  return [
    `You translate YouTube subtitle cues from ${srcDesc} to '${tgt}'.`,
    `INPUT: a JSON array of EXACTLY ${count} strings.`,
    `OUTPUT: a JSON array of EXACTLY ${count} strings — never more, never fewer.`,
    `- output[i] is the translation of input[i].`,
    `- DO NOT merge, split, drop, or reorder items.`,
    `- DO NOT skip empty, short, duplicate, or musical (♪) items — translate them as-is or echo unchanged.`,
    `- Preserve the speaker's casual or formal tone.`,
    `- Keep proper nouns, brand names, and technical terms in their original form.`,
    `- Output ONLY the JSON array. No prose, no markdown fences.`,
  ].join('\n');
}

async function callGeminiWithRetry(
  texts: string[],
  src: string,
  tgt: string,
  apiKey: string,
  model: GeminiModel,
): Promise<string[]> {
  try {
    return await callGemini(texts, src, tgt, apiKey, model);
  } catch (e) {
    // 길이 불일치만 1회 재시도. 인증·한도 오류는 재시도 무의미 → 즉시 throw.
    if (e instanceof Error && e.message.startsWith('Gemini 응답 길이 불일치')) {
      console.warn(TAG, `${e.message} — retry once`);
      return await callGemini(texts, src, tgt, apiKey, model);
    }
    throw e;
  }
}

async function callGemini(
  texts: string[],
  src: string,
  tgt: string,
  apiKey: string,
  model: GeminiModel,
): Promise<string[]> {
  const url = `${ENDPOINT_BASE}/${MODEL_ID[model]}:generateContent`;
  const n = texts.length;
  const body = {
    systemInstruction: { parts: [{ text: systemInstruction(src, tgt, n) }] },
    contents: [
      {
        role: 'user',
        parts: [{ text: JSON.stringify(texts) }],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      // minItems/maxItems는 protobuf 표현상 string. 모델이 항목 수 줄이는 걸 스키마 단에서 차단.
      responseSchema: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        minItems: String(n),
        maxItems: String(n),
      },
      temperature: 0.2,
      // 50개 자막이 한국어로 1000~2000 토큰 정도. 8192면 안전 마진.
      maxOutputTokens: 8192,
    },
  };

  let retried = false;
  while (true) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = (await res.json()) as unknown;
      return parseResponse(data, texts.length);
    }

    const status = res.status;
    const errText = await res.text().catch(() => '');

    // 일시 오류는 1회만 재시도
    if ((status === 429 || status >= 500) && !retried) {
      console.warn(TAG, `HTTP ${status}, retry in 1500ms`);
      await sleep(1500);
      retried = true;
      continue;
    }
    if (status === 401 || status === 403) {
      throw new Error(`Gemini API 키 인증 실패 (HTTP ${status})`);
    }
    if (status === 400) {
      throw new Error(`Gemini 요청 형식 오류 (HTTP 400): ${truncate(errText, 200)}`);
    }
    if (status === 429) {
      // 한도 도달 → cooldown 설정. 다음 호출들은 즉시 skip됨.
      rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      throw new Error(`Gemini 한도 초과 (HTTP 429) — ${RATE_LIMIT_COOLDOWN_MS / 1000}초 대기`);
    }
    throw new Error(`Gemini 서버 오류 (HTTP ${status}): ${truncate(errText, 200)}`);
  }
}

function parseResponse(data: unknown, expectedLen: number): string[] {
  const d = data as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
  };
  const candidate = d.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = candidate?.finishReason ?? 'unknown';
    throw new Error(`Gemini 응답에 번역 결과 없음 (finishReason=${reason})`);
  }
  let arr: unknown;
  try {
    arr = JSON.parse(text);
  } catch {
    throw new Error('Gemini 응답을 JSON 배열로 파싱 못함');
  }
  if (!Array.isArray(arr)) throw new Error('Gemini 응답이 배열이 아님');
  if (arr.length !== expectedLen) {
    throw new Error(`Gemini 응답 길이 불일치 (예상 ${expectedLen}, 받음 ${arr.length})`);
  }
  return arr.map((v) => String(v));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
