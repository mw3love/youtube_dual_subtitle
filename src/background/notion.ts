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
//
// 재저장(형광펜을 더 칠하고 다시 저장) = "새 페이지 생성 + 옛 페이지 휴지통으로". Notion API엔
// 본문을 통째로 교체하는 엔드포인트가 없다 — append 전용이고 블록 삭제는 1개씩(벌크 없음). 옛
// 페이지의 블록을 하나씩 지우면 느린 데다(평균 3 req/s) 중간에 실패하면 페이지가 반쯤 망가진다.
// 반면 create→archive는 요청 2번이고, archive가 실패해도 결과는 "지금까지처럼 페이지 두 개"라
// 더 나빠지지 않는다. 대가는 페이지 id/URL이 매번 바뀌는 것(단어장 페이지엔 사실상 무해).

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
  // 같은 탭을 이미 저장한 적이 있으면 그 페이지 id — 새로 만든 뒤 이 페이지를 휴지통으로 보낸다.
  prevPageId?: string;
  // 그때 쓴 DB id. 지금 DB와 다르면(옵션에서 DB를 바꿈) 남의 DB 페이지라 건드리지 않는다.
  prevDatabaseId?: string;
  // 그때 쓴 제목. 재저장 시 그대로 재사용 — 형광펜이 pickNotionTitle의 "첫 백틱 예문" 경로를
  // 흔들어 제목이 튀는 걸 막는다(자막 문장 경로면 어차피 같은 값).
  prevTitle?: string;
}

export interface NotionSaveOutcome {
  url?: string;
  title: string;
  pageId?: string;
  // 재저장인데 옛 페이지를 못 치웠음(권한 부족·수동 삭제·DB 변경). UI가 "옛 페이지 남음"으로 알림.
  oldKept?: boolean;
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

// 해설을 DB에 페이지로 저장. 생성된 페이지 URL/id + 실제 사용된 제목 반환(팝업/패널에 표시용).
// prevPageId가 오면 재저장 — 새 페이지를 만든 뒤 옛 페이지를 휴지통으로 보낸다(위 주석 참조).
export async function saveToNotion(params: NotionSaveParams): Promise<NotionSaveOutcome> {
  const token = await getNotionToken();
  if (!token) throw new Error('Notion 토큰이 없음 (옵션 페이지에서 입력 필요)');
  const dbId = normalizeId(params.databaseId);
  if (!dbId) throw new Error('Notion 데이터베이스 ID 형식이 올바르지 않음');

  // 1) DB 스키마 조회 — title 속성 이름 + (있으면) url/date 속성 이름.
  const schema = await getDatabaseSchema(token, dbId);

  // 2) 속성 구성 — 제목은 재저장이면 옛 제목 그대로, 아니면 "예문"(자막 문장) 우선,
  //    degenerate면 AI 첫 백틱 예문 → 단어.
  const title =
    params.prevTitle?.trim() || pickNotionTitle(params.term, params.context, params.markdown);
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
  const data = (await res.json()) as { id?: string; url?: string };

  // 5) 재저장이면 옛 페이지를 휴지통으로. 새 페이지는 이미 만들어졌으므로 여기서 실패해도
  //    저장 자체는 성공 — oldKept로 알리기만 하고 throw하지 않는다(중복 두 개 = 옛 동작).
  let oldKept: boolean | undefined;
  const prevPageId = params.prevPageId ? normalizeId(params.prevPageId) : null;
  if (prevPageId && prevPageId !== normalizeId(data.id ?? '')) {
    if (normalizeId(params.prevDatabaseId ?? '') !== dbId) {
      oldKept = true; // DB가 바뀜 — 옛 페이지는 다른 DB 소속이라 안 건드림
    } else {
      try {
        await archivePage(token, prevPageId);
      } catch (e) {
        console.warn('[YDT] 옛 Notion 페이지 정리 실패:', e);
        oldKept = true;
      }
    }
  }

  return { url: data.url, title, pageId: data.id, oldKept };
}

// 페이지를 휴지통으로(soft delete). integration에 "update content" 권한이 필요 — 없으면 403이고
// 호출 측이 oldKept로 흡수한다. 404는 사용자가 노션에서 이미 지운 것이라 치울 게 없다 = 성공으로
// 본다(실패로 치면 "옛 페이지 남음" 거짓 경고가 뜬다. notionError의 404 문구도 DB 전용이라 부적합).
// 필드명은 Notion-Version 2022-06-28 기준 `archived` — 최신 버전의 `in_trash`와 같은 동작.
async function archivePage(token: string, pageId: string): Promise<void> {
  const res = await fetch(`${ENDPOINT}/pages/${pageId}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ archived: true }),
  });
  if (res.status === 404) return;
  if (!res.ok) throw await notionError(res);
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
