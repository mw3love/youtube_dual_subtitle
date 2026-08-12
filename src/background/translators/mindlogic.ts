// Mindlogic API Gateway (BYOK) 번역 백엔드.
//
// 학교/조직 계정에서 발급된 키 하나로 OpenAI/Anthropic/Gemini 등 여러 upstream을 단일 endpoint로
// 사용하는 게이트웨이. 우리는 OpenAI Chat Completions 호환 path만 사용 (Anthropic native path도
// 별도로 있지만 모델 자유 선택을 위해 하나로 통일).
//
// 키는 settings(storage.sync) 아니라 storage.local에 별도 (Gemini와 같은 패턴). 매 batch마다
// fresh read해서 옵션 페이지의 디바운스 저장과 race 회피.
//
// 요청 전략 (Immersive Translate의 자막 번역 레시피 차용):
// - 짧은 자막 cue는 모델이 "유창하게" 인접 조각을 합쳐 줄 수를 줄이는 경향(N in인데 N-2 out)
//   → 정렬 깨짐. 이를 줄이려고 세 가지를 함께 적용:
//   (1) 청크를 작게(5) — 합칠 거리가 적음, (2) temperature 0 — 합치는 재량 제거,
//   (3) "%%" 구분자 + few-shot 예시로 "같은 개수 유지"를 강하게 지시.
// - user: cue들을 "\n\n%%\n\n"으로 join. parser는 "%%"로 split해 개수 검증.
//   (JSON 배열은 합쳐도 valid JSON이라 모델이 부담 없이 합침 — 구분자 방식이 순응도가 높음)
// - 분리 개수 ≠ 입력 개수면 1회 재시도, 그래도 안 맞으면 throw → router가 그 배치만 google-free로 fallback.
// - 429/5xx만 1회 1500ms backoff 후 재시도. 401/403/400은 즉시 throw (재시도 무의미).
// - 429 받으면 cooldown — Gemini 백엔드와 같은 패턴(매 청크마다 백오프 누적 방지).

import { getMindlogicApiKey } from '../../shared/secrets';
import { getMindlogicBaseUrl } from '../../shared/settings';
import type { MindlogicModel } from '../../shared/settings';

const TAG = '[YDT/mindlogic]';

// 한 호출당 cue 수가 적을수록 합침 mismatch가 덜 발생. Immersive Translate의 "자막 요청당
// 최대 섹션 수 = 5"를 따름(일반 텍스트보다 자막을 더 잘게 쪼갬).
const MINDLOGIC_CHUNK_SIZE = 5;

// cue 경계 구분자 — Immersive와 동일하게 "%%". 자막 텍스트에 "%%"가 들어올 일은 사실상
// 없어 충돌 위험 낮음. 실제 전송은 앞뒤 빈 줄로 감싸 모델이 경계를 더 또렷이 보게 함.
const SEGMENT_TOKEN = '%%';
const SEGMENT_JOIN = `\n\n${SEGMENT_TOKEN}\n\n`;

const RATE_LIMIT_COOLDOWN_MS = 60_000;
let rateLimitedUntil = 0;

interface MindlogicOptions {
  apiKey?: string;
  model?: MindlogicModel;
  baseUrl?: string;
  // 영상 제목 — 모델에 주제 문맥으로 주입해 단어 뜻/말투를 교정(Immersive의 title_prompt 차용).
  // 예: 커리어 영상에서 "work gets seen"을 "작품 공개"가 아니라 "성과 인정"으로.
  videoTitle?: string;
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
  const baseUrl = opts?.baseUrl ?? (await getMindlogicBaseUrl());
  if (!baseUrl) {
    throw new Error('Mindlogic Base URL이 설정되어 있지 않음 (옵션 페이지에서 입력 필요)');
  }
  const chatUrl = `${baseUrl}/chat/completions`;
  const model = opts?.model ?? (await readModel());
  const title = opts?.videoTitle;

  if (texts.length <= MINDLOGIC_CHUNK_SIZE) {
    return callWithRetry(texts, src, tgt, apiKey, chatUrl, model, title);
  }
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += MINDLOGIC_CHUNK_SIZE) {
    const chunk = texts.slice(i, i + MINDLOGIC_CHUNK_SIZE);
    const part = await callWithRetry(chunk, src, tgt, apiKey, chatUrl, model, title);
    out.push(...part);
  }
  return out;
}

// 옵션 페이지 "테스트" 버튼용 — router 우회 + cooldown 우회(사용자가 새 키 검증 중일 수 있음).
// 성공 시 cooldown 해제해 정상 호출 흐름 복귀.
export async function testMindlogicKey(
  apiKey: string,
  model: MindlogicModel,
  baseUrl: string,
): Promise<string> {
  const out = await callWithRetry(['Hello, world.'], 'en', 'ko', apiKey, `${baseUrl}/chat/completions`, model);
  rateLimitedUntil = 0;
  return out[0] ?? '';
}

// 게이트웨이가 통과시키는 모델 목록 (OpenAI 호환 GET /models). 옵션 페이지가 "모델 새로고침"으로
// 호출 → storage.local에 캐시 → 드롭다운에 동적 표시. 하드코딩 큐레이션(MINDLOGIC_MODELS)은
// 추천 마커/새로고침 전 fallback으로 남는다.

export interface MindlogicModelInfo {
  id: string;
  ownedBy: string;
}

export async function listMindlogicModels(
  apiKey?: string,
  baseUrl?: string,
): Promise<MindlogicModelInfo[]> {
  const key = apiKey || (await getMindlogicApiKey());
  if (!key) throw new Error('Mindlogic API 키가 없음 (옵션 페이지에서 입력 필요)');
  const url = baseUrl || (await getMindlogicBaseUrl());
  if (!url) throw new Error('Mindlogic Base URL이 없음 (옵션 페이지에서 입력 필요)');
  const res = await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(`키 인증 실패 (HTTP ${res.status})`);
    throw new Error(`모델 목록 실패 (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { data?: Array<{ id?: string; owned_by?: string }> };
  const models = (data.data ?? [])
    .filter((m): m is { id: string; owned_by?: string } => typeof m.id === 'string' && !!m.id)
    .map((m) => ({ id: m.id, ownedBy: m.owned_by ?? 'other' }));
  if (models.length === 0) throw new Error('모델 목록이 비어 있음 (응답 형식 변경?)');
  return models;
}

// 게이트웨이 크레딧 조회 (GET /v1/gateway/credits/, A66) — 옵션 페이지에 월간/구매 크레딧 사용량
// 표시용. baseUrl은 이미 ".../v1/gateway"까지 포함(모델 목록·chat/completions와 동일 조립 방식).
export interface MindlogicCredits {
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

export async function getMindlogicCredits(
  apiKey?: string,
  baseUrl?: string,
): Promise<MindlogicCredits> {
  const key = apiKey || (await getMindlogicApiKey());
  if (!key) throw new Error('Mindlogic API 키가 없음 (옵션 페이지에서 입력 필요)');
  const url = baseUrl || (await getMindlogicBaseUrl());
  if (!url) throw new Error('Mindlogic Base URL이 없음 (옵션 페이지에서 입력 필요)');
  const res = await fetch(`${url}/credits/`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(`키 인증 실패 (HTTP ${res.status})`);
    if (res.status === 404) throw new Error('크레딧 조회 미지원 (HTTP 404) — 이 게이트웨이 버전엔 없을 수 있음');
    throw new Error(`크레딧 조회 실패 (HTTP ${res.status})`);
  }
  const data = (await res.json()) as {
    monthly_allocated?: {
      quota?: number;
      used?: number;
      remaining?: number;
      renewal_date?: string | null;
    };
    purchased?: { quota?: number; used?: number; remaining?: number };
    total?: { quota?: number; used?: number; remaining?: number };
  };
  return {
    monthlyQuota: data.monthly_allocated?.quota ?? 0,
    monthlyUsed: data.monthly_allocated?.used ?? 0,
    monthlyRemaining: data.monthly_allocated?.remaining ?? 0,
    renewalDate: data.monthly_allocated?.renewal_date ?? null,
    purchasedQuota: data.purchased?.quota ?? 0,
    purchasedUsed: data.purchased?.used ?? 0,
    purchasedRemaining: data.purchased?.remaining ?? 0,
    totalQuota: data.total?.quota ?? 0,
    totalUsed: data.total?.used ?? 0,
    totalRemaining: data.total?.remaining ?? 0,
  };
}

async function readModel(): Promise<MindlogicModel> {
  const r = await chrome.storage.sync.get({ mindlogicModel: 'gemini-2.5-flash' });
  return validateModel(r.mindlogicModel);
}

// 모델 ID는 자유 문자열(게이트웨이가 유효성 판정) — 비어있지 않은 문자열이면 그대로 사용.
function validateModel(v: unknown): MindlogicModel {
  return typeof v === 'string' && v.trim() ? v : 'gemini-2.5-flash';
}

function systemPrompt(src: string, tgt: string, count: number, title?: string): string {
  const srcDesc = src === 'auto' ? 'the auto-detected source language' : `'${src}'`;
  const single = count === 1;
  const sep = single ? '' : ` separated by lines containing only "${SEGMENT_TOKEN}"`;
  const lines = [
    `You are a professional subtitle translator. Translate the input from ${srcDesc} to '${tgt}' fluently and naturally.`,
  ];
  // A2: 영상 제목을 주제 문맥으로 — 단어 뜻/말투 교정. 제목 자체를 번역 대상으로 오인하지
  // 않도록 "background context only, do not translate it" 명시.
  const cleanTitle = title?.trim().slice(0, 200);
  if (cleanTitle) {
    lines.push(
      ``,
      `## Context`,
      `These subtitles are from a video titled: "${cleanTitle}".`,
      `Use this topic as background to choose correct word senses and tone. Do NOT translate or output this title.`,
    );
  }
  lines.push(
    ``,
    `## Rules`,
    `1. The input has EXACTLY ${count} segment(s)${sep}.`,
    `2. Output EXACTLY ${count} translated segment(s)${single ? '' : ` separated by the same "${SEGMENT_TOKEN}" lines`} — same number in, same number out. Never merge, split, drop, reorder, or add segments.`,
    `3. The i-th output segment is the translation of the i-th input segment, even when an input segment is a sentence fragment.`,
    // A: 합치지 말되(개수 보존) 문맥은 활용 — 정렬과 문맥을 동시에 얻으려는 핵심 규칙.
    `4. Read all segments together to pick the correct meaning and tone for ambiguous words, but still output exactly one translation per segment. A fragment may read awkwardly alone — translate it to fit the surrounding segments without merging them.`,
    `5. Keep empty, very short, duplicate, or musical (♪) segments — translate as-is or echo unchanged. Never omit one.`,
    `6. Keep proper nouns, brand names, and technical terms in their original form.`,
    `7. Output ONLY the translation${single ? '' : `s and the "${SEGMENT_TOKEN}" separators`}. No explanations, no preamble, no markdown fences.`,
  );
  if (!single) {
    lines.push(
      ``,
      `## Example (input 3 segments → output exactly 3, separators preserved)`,
      `Input:`,
      `A`,
      ``,
      SEGMENT_TOKEN,
      ``,
      `B`,
      ``,
      SEGMENT_TOKEN,
      ``,
      `C`,
      `Output:`,
      `Translation A`,
      ``,
      SEGMENT_TOKEN,
      ``,
      `Translation B`,
      ``,
      SEGMENT_TOKEN,
      ``,
      `Translation C`,
    );
  }
  return lines.join('\n');
}

async function callWithRetry(
  texts: string[],
  src: string,
  tgt: string,
  apiKey: string,
  chatUrl: string,
  model: MindlogicModel,
  title?: string,
): Promise<string[]> {
  try {
    return await callMindlogic(texts, src, tgt, apiKey, chatUrl, model, title);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Mindlogic 응답 길이 불일치')) {
      console.warn(TAG, `${e.message} — retry once`);
      return await callMindlogic(texts, src, tgt, apiKey, chatUrl, model, title);
    }
    throw e;
  }
}

async function callMindlogic(
  texts: string[],
  src: string,
  tgt: string,
  apiKey: string,
  chatUrl: string,
  model: MindlogicModel,
  title?: string,
): Promise<string[]> {
  const n = texts.length;
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt(src, tgt, n, title) },
      { role: 'user', content: texts.join(SEGMENT_JOIN) },
    ],
    // 0 = 가장 결정적. 모델이 "유창하게" cue를 합치는 재량을 제거(정렬 보존). Immersive도 0.
    temperature: 0,
    // 청크 5개라 응답이 짧음(한국어 ~수백 토큰). 4096이면 충분한 마진.
    max_tokens: 4096,
  };

  let retried = false;
  while (true) {
    const res = await fetch(chatUrl, {
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
  const parts = splitSegments(text);
  if (parts.length !== expectedLen) {
    throw new Error(`Mindlogic 응답 길이 불일치 (예상 ${expectedLen}, 받음 ${parts.length})`);
  }
  return parts;
}

// "%%" 구분자로 분리. 모델이 ```fence나 preamble을 붙이는 경우 대비해 코드펜스부터 벗김.
// 빈 cue를 echo한 빈 segment도 개수에 포함돼야 하므로 빈 문자열을 filter하지 않음.
function splitSegments(text: string): string[] {
  let s = text.trim();
  const fence = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) s = fence[1].trim();
  return s.split(/\s*%%\s*/).map((p) => p.trim());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
