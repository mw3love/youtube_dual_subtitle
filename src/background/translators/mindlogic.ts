// Mindlogic API Gateway (BYOK) 번역 백엔드.
//
// 학교/조직 계정에서 발급된 키 하나로 OpenAI/Anthropic/Gemini 등 여러 upstream을 단일 endpoint로
// 사용하는 게이트웨이. 우리는 OpenAI Chat Completions 호환 path만 사용 (Anthropic native path도
// 별도로 있지만 모델 자유 선택을 위해 하나로 통일).
//
// 키는 settings(storage.sync) 아니라 storage.local에 별도 (Gemini와 같은 패턴). 매 batch마다
// fresh read해서 옵션 페이지의 디바운스 저장과 race 회피.
//
// 요청 전략:
// - system: JSON array N items in / N items out 규칙 명시.
// - user: JSON.stringify(texts).
// - response_format은 모델별로 지원 여부가 달라 사용하지 않고, system prompt + parser의
//   fence/preamble 제거 로직으로 JSON array 추출. ```json fence나 "Here is...:" preamble을
//   붙이는 모델도 다 받아낼 수 있게.
// - 응답 배열 길이 ≠ 입력 길이면 1회 재시도, 그래도 안 맞으면 throw → router fallback.
// - 429/5xx만 1회 1500ms backoff 후 재시도. 401/403/400은 즉시 throw (재시도 무의미).
// - 429 받으면 cooldown — Gemini 백엔드와 같은 패턴(매 청크마다 백오프 누적 방지).

import { getMindlogicApiKey } from '../../shared/secrets';
import type { MindlogicModel } from '../../shared/settings';

const TAG = '[YDT/mindlogic]';
const ENDPOINT = 'https://factchat-cloud.mindlogic.ai/v1/gateway/chat/completions';

// 한 호출당 항목 수가 적을수록 모델이 짧은 cue를 합쳐 응답이 줄어드는 mismatch가 덜 발생.
// Gemini와 같은 값으로 유지.
const MINDLOGIC_CHUNK_SIZE = 20;

const RATE_LIMIT_COOLDOWN_MS = 60_000;
let rateLimitedUntil = 0;

interface MindlogicOptions {
  apiKey?: string;
  model?: MindlogicModel;
}

export async function translateBatch(
  texts: string[],
  src: string,
  tgt: string,
  opts?: MindlogicOptions,
): Promise<string[]> {
  if (texts.length === 0) return [];
  const now = Date.now();
  if (rateLimitedUntil > now) {
    const wait = Math.ceil((rateLimitedUntil - now) / 1000);
    throw new Error(`Mindlogic 한도 초과로 대기 중 (${wait}초 남음)`);
  }
  const apiKey = opts?.apiKey ?? (await getMindlogicApiKey());
  if (!apiKey) {
    throw new Error('Mindlogic API 키가 설정되어 있지 않음 (옵션 페이지에서 입력 필요)');
  }
  const model = opts?.model ?? (await readModel());

  if (texts.length <= MINDLOGIC_CHUNK_SIZE) {
    return callWithRetry(texts, src, tgt, apiKey, model);
  }
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += MINDLOGIC_CHUNK_SIZE) {
    const chunk = texts.slice(i, i + MINDLOGIC_CHUNK_SIZE);
    const part = await callWithRetry(chunk, src, tgt, apiKey, model);
    out.push(...part);
  }
  return out;
}

// 옵션 페이지 "테스트" 버튼용 — router 우회 + cooldown 우회(사용자가 새 키 검증 중일 수 있음).
// 성공 시 cooldown 해제해 정상 호출 흐름 복귀.
export async function testMindlogicKey(
  apiKey: string,
  model: MindlogicModel,
): Promise<string> {
  const out = await callWithRetry(['Hello, world.'], 'en', 'ko', apiKey, model);
  rateLimitedUntil = 0;
  return out[0] ?? '';
}

async function readModel(): Promise<MindlogicModel> {
  const r = await chrome.storage.sync.get({ mindlogicModel: 'gemini-2.5-flash' });
  return validateModel(r.mindlogicModel);
}

function validateModel(v: unknown): MindlogicModel {
  if (
    v === 'gpt-5.4-nano' ||
    v === 'gpt-5.4-mini' ||
    v === 'claude-haiku-4-5-20251001' ||
    v === 'gemini-3.1-flash-lite'
  ) {
    return v;
  }
  return 'gemini-2.5-flash';
}

function systemPrompt(src: string, tgt: string, count: number): string {
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
    `- Output ONLY the JSON array. No prose, no markdown fences, no code blocks.`,
  ].join('\n');
}

async function callWithRetry(
  texts: string[],
  src: string,
  tgt: string,
  apiKey: string,
  model: MindlogicModel,
): Promise<string[]> {
  try {
    return await callMindlogic(texts, src, tgt, apiKey, model);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Mindlogic 응답 길이 불일치')) {
      console.warn(TAG, `${e.message} — retry once`);
      return await callMindlogic(texts, src, tgt, apiKey, model);
    }
    throw e;
  }
}

async function callMindlogic(
  texts: string[],
  src: string,
  tgt: string,
  apiKey: string,
  model: MindlogicModel,
): Promise<string[]> {
  const n = texts.length;
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt(src, tgt, n) },
      { role: 'user', content: JSON.stringify(texts) },
    ],
    temperature: 0.2,
    // 20개 자막이 한국어로 ~600 토큰. 4096이면 안전 마진.
    max_tokens: 4096,
  };

  let retried = false;
  while (true) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = (await res.json()) as unknown;
      return parseResponse(data, texts.length);
    }

    const status = res.status;
    const errText = await res.text().catch(() => '');

    if ((status === 429 || status >= 500) && !retried) {
      console.warn(TAG, `HTTP ${status}, retry in 1500ms`);
      await sleep(1500);
      retried = true;
      continue;
    }
    if (status === 401 || status === 403) {
      throw new Error(`Mindlogic API 키 인증 실패 (HTTP ${status})`);
    }
    if (status === 400) {
      throw new Error(`Mindlogic 요청 형식 오류 (HTTP 400): ${truncate(errText, 200)}`);
    }
    if (status === 429) {
      rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      throw new Error(
        `Mindlogic 한도 초과 (HTTP 429) — ${RATE_LIMIT_COOLDOWN_MS / 1000}초 대기`,
      );
    }
    throw new Error(`Mindlogic 서버 오류 (HTTP ${status}): ${truncate(errText, 200)}`);
  }
}

function parseResponse(data: unknown, expectedLen: number): string[] {
  const d = data as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const choice = d.choices?.[0];
  const text = choice?.message?.content;
  if (!text || typeof text !== 'string') {
    const reason = choice?.finish_reason ?? 'unknown';
    throw new Error(`Mindlogic 응답에 번역 결과 없음 (finish_reason=${reason})`);
  }
  // 모델이 ```json fence나 preamble("Here is the translation: [...]")을 붙이는 경우 대비.
  const cleaned = extractJsonArray(text);
  let arr: unknown;
  try {
    arr = JSON.parse(cleaned);
  } catch {
    throw new Error('Mindlogic 응답을 JSON 배열로 파싱 못함');
  }
  if (!Array.isArray(arr)) throw new Error('Mindlogic 응답이 배열이 아님');
  if (arr.length !== expectedLen) {
    throw new Error(`Mindlogic 응답 길이 불일치 (예상 ${expectedLen}, 받음 ${arr.length})`);
  }
  return arr.map((v) => String(v));
}

// 가장 바깥 [ ... ]만 잡음. 모델이 array 안에 또 array를 emit하는 경우는 거의 없고,
// 있더라도 JSON.parse가 그대로 받아 처리됨.
function extractJsonArray(text: string): string {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
