// Notion 저장 백엔드 — 해설 패널을 사용자 본인 Notion 데이터베이스에 페이지로 만든다 (BYOK).
//
// 호출 경로는 gemini/mindlogic와 동일: background service worker가 host_permissions에 등록된
// api.notion.com으로 fetch(확장은 선언된 host에 한해 CORS 우회). 토큰은 secrets.ts(storage.local),
// DB ID는 settings(storage.sync). content가 NOTION_SAVE로 위임한다.
//
// 페이지 구성:
// - 제목 속성 = 선택 표현. DB마다 title 속성 "이름"이 달라(Name/이름/…) GET databases로 찾아 매핑.
// - URL/Date 타입 속성이 DB에 있으면 best-effort로 영상 링크/오늘 날짜를 채움(없으면 건너뜀 —
//   어떤 DB에도 안 깨지게). 그 외 속성은 건드리지 않음.
// - 본문 = (URL 속성 없을 때만 영상 링크) + 자막 문맥(quote) + 구분선 + 해설(markdown→블록).

import { getNotionToken } from '../shared/secrets';
import { markdownToBlocks, type NotionBlock, type RichText } from './notion-blocks';

const ENDPOINT = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface NotionSaveParams {
  term: string;
  markdown: string;
  context?: string;
  databaseId: string;
  videoTitle?: string;
  videoUrl?: string;
}

// 제목으로 적당한 한 문장 길이 상한. 넘으면(구두점 없는 ASR 런온 등 — 한 문장으로 안 쪼개짐) AI 예문으로.
const TITLE_MAX_LEN = 100;

// 페이지 제목 선택 — 단어보다 "예문"이 복습에 유용(ai-dictionary 차용). 우선순위:
// ① 자막 원문 문장(context) 중 **선택 단어가 든 한 문장**이 적당한 길이면 그것(실제 용례 우선).
// ② ①이 없거나(빈/단어와 동일) 한 문장이 상한 초과(ASR이 구두점을 안 줘 런온으로 안 쪼개짐)면
//    AI 해설의 첫 인라인 백틱 예문(깔끔한 한 문장). 코드펜스(```)는 [^`]에 안 걸림.
// ③ 그래도 없으면 단어.
function pickNotionTitle(term: string, context: string | undefined, markdown: string): string {
  const t = term.trim();
  const ctx = (context ?? '').trim();
  const example = markdown.match(/`([^`\n]+)`/)?.[1]?.trim();
  if (ctx && ctx.toLowerCase() !== t.toLowerCase() && ctx.length > t.length) {
    const sentence = pickContextSentence(ctx, t);
    if (sentence.length <= TITLE_MAX_LEN) return sentence;
    if (example) return example; // 한 문장이 너무 길면 AI 예문으로
    return sentence; // 예문도 없으면 어쩔 수 없이(caller가 truncate)
  }
  if (example) return example;
  return t || '(제목 없음)';
}

// 여러 문장일 수 있는 자막 문맥에서 선택 표현(term)이 든 한 문장만 고른다(없으면 첫 문장).
// 단어 해설 시 자막 2~3줄 전체가 제목이 되는 걸 막는다 — 제목엔 한 문장이 적합.
function pickContextSentence(context: string, term: string): string {
  const sentences = splitSentences(context);
  if (sentences.length <= 1) return context.trim();
  const t = term.trim().toLowerCase();
  const hit = t ? sentences.find((s) => s.toLowerCase().includes(t)) : undefined;
  return (hit ?? sentences[0]).trim();
}

// 종결부호(.?!…。！？) 뒤에서 문장 분할(부호 + 뒤따르는 닫는 따옴표/괄호는 앞 문장에 포함).
function splitSentences(text: string): string[] {
  const parts = text.trim().match(/[^.?!…。！？]+[.?!…。！？]*["'”’)\]】」』]*\s*/g);
  if (!parts) return [text.trim()].filter(Boolean);
  return parts.map((s) => s.trim()).filter(Boolean);
}

// 해설을 DB에 페이지로 저장. 생성된 페이지 URL + 실제 사용된 제목 반환(팝업/패널에 표시용).
export async function saveToNotion(params: NotionSaveParams): Promise<{ url?: string; title: string }> {
  const token = await getNotionToken();
  if (!token) throw new Error('Notion 토큰이 없음 (옵션 페이지에서 입력 필요)');
  const dbId = normalizeId(params.databaseId);
  if (!dbId) throw new Error('Notion 데이터베이스 ID 형식이 올바르지 않음');

  // 1) DB 스키마 조회 — title 속성 이름 + (있으면) url/date 속성 이름.
  const schema = await getDatabaseSchema(token, dbId);

  // 2) 속성 구성 — 제목은 "예문"(자막 문장) 우선, degenerate면 AI 첫 백틱 예문 → 단어.
  const title = pickNotionTitle(params.term, params.context, params.markdown);
  const properties: Record<string, unknown> = {
    [schema.titleProp]: { title: [{ text: { content: truncate(title, 2000) } }] },
  };
  if (schema.urlProp && params.videoUrl) {
    properties[schema.urlProp] = { url: params.videoUrl };
  }
  if (schema.dateProp) {
    properties[schema.dateProp] = { date: { start: new Date().toISOString() } };
  }

  // 3) 본문 블록
  const children: NotionBlock[] = [];
  // URL 속성이 있으면 영상 링크는 거기로 들어가므로 본문 맨 윗줄 링크는 생략(중복 제거).
  // URL 속성이 없는 DB에서만 링크를 잃지 않게 본문에 fallback으로 넣는다.
  if (params.videoUrl && !schema.urlProp) {
    const label = params.videoTitle?.trim() || '영상';
    children.push({
      type: 'paragraph',
      paragraph: {
        rich_text: [
          { type: 'text', text: { content: `🎬 ${truncate(label, 1900)}`, link: { url: params.videoUrl } } },
        ] as RichText[],
      },
    });
  }
  // 자막 문장을 제목으로 이미 썼으면 본문 인용은 중복이라 생략(degenerate fallback 시엔 유지).
  if (
    params.context &&
    params.context.trim() &&
    params.context.trim() !== params.term.trim() &&
    params.context.trim() !== title.trim()
  ) {
    children.push({
      type: 'quote',
      quote: { rich_text: [{ type: 'text', text: { content: truncate(params.context.trim(), 2000) } }] },
    });
  }
  if (children.length > 0) children.push({ type: 'divider', divider: {} });
  children.push(...markdownToBlocks(params.markdown));

  // 4) 페이지 생성
  const res = await fetch(`${ENDPOINT}/pages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties,
      // Notion children 한도 100 — markdownToBlocks가 이미 자르지만 meta 포함 안전하게 한 번 더.
      children: children.slice(0, 100),
    }),
  });
  if (!res.ok) throw await notionError(res);
  const data = (await res.json()) as { url?: string };
  return { url: data.url, title };
}

// 옵션 "테스트" 버튼용 — 토큰+DB 공유+ID를 한 번에 검증. DB 제목 반환.
export async function testNotion(token: string, databaseId: string): Promise<string> {
  const dbId = normalizeId(databaseId);
  if (!dbId) throw new Error('데이터베이스 ID 형식이 올바르지 않음 (32자리 ID 또는 DB URL)');
  const schema = await getDatabaseSchema(token, dbId);
  return schema.title || '(제목 없음)';
}

interface DbSchema {
  title: string;
  titleProp: string;
  urlProp?: string;
  dateProp?: string;
}

async function getDatabaseSchema(token: string, dbId: string): Promise<DbSchema> {
  const res = await fetch(`${ENDPOINT}/databases/${dbId}`, { headers: authHeaders(token) });
  if (!res.ok) throw await notionError(res);
  const data = (await res.json()) as {
    title?: Array<{ plain_text?: string }>;
    properties?: Record<string, { type?: string }>;
  };
  const props = data.properties ?? {};
  let titleProp = '';
  let urlProp: string | undefined;
  let dateProp: string | undefined;
  for (const [name, def] of Object.entries(props)) {
    if (def.type === 'title' && !titleProp) titleProp = name;
    else if (def.type === 'url' && !urlProp) urlProp = name;
    else if (def.type === 'date' && !dateProp) dateProp = name;
  }
  if (!titleProp) throw new Error('데이터베이스에 제목(title) 속성이 없음');
  const title = (data.title ?? []).map((t) => t.plain_text ?? '').join('');
  return { title, titleProp, urlProp, dateProp };
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

// Notion ID는 32자리 hex(대시 유무 무관). DB URL을 통째로 붙여넣어도 추출.
// 주의: DB URL은 `notion.so/{ws}/{title}-{DB_ID}?v={VIEW_ID}`라 32-hex가 둘 — 경로의 DB_ID가
// 먼저, 쿼리의 VIEW_ID가 뒤. 그래서 **첫 번째** 매치(DB_ID)를 쓴다(마지막은 view id라 오답).
function normalizeId(raw: string): string | null {
  const cleaned = raw.trim().replace(/-/g, '');
  const m = cleaned.match(/[0-9a-fA-F]{32}/g);
  if (!m) return null;
  const id = m[0];
  // 대시 형태(8-4-4-4-12)로 재조립 — Notion API는 둘 다 받지만 정규형으로.
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

async function notionError(res: Response): Promise<Error> {
  const body = await res.text().catch(() => '');
  let msg = '';
  try {
    msg = (JSON.parse(body) as { message?: string }).message ?? '';
  } catch {
    msg = body;
  }
  if (res.status === 401) return new Error('Notion 토큰 인증 실패 (HTTP 401) — 토큰 확인');
  if (res.status === 404) {
    return new Error('DB를 못 찾음 (HTTP 404) — ID가 맞는지, integration에 DB를 연결(share)했는지 확인');
  }
  if (res.status === 429) return new Error('Notion 요청 한도 초과 (HTTP 429) — 잠시 후 다시');
  return new Error(`Notion 오류 (HTTP ${res.status})${msg ? `: ${truncate(msg, 200)}` : ''}`);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
