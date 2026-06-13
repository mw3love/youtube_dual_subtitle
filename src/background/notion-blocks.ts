// markdown → Notion 블록 객체 변환 (service worker, DOM 없음).
//
// content/explain/markdown.ts와 같은 블록 인식 로직이지만, DOM element 대신 Notion API의
// 블록 JSON을 생성한다(SW에는 document가 없으므로 그 파일을 재사용 못 함 — 로직만 평행).
// 지원: heading_1~3, paragraph, bulleted/numbered_list_item, code, table(+table_row),
// 인라인 rich_text(bold / italic / code). 표/인라인은 해설(영어 선생님 답변)에 실제로 쓰이는 것.
//
// Notion 제약: rich_text 한 조각 content ≤ 2000자, children ≤ 100블록/요청. 해설은 짧아 보통
// 무관하지만 안전하게 평문은 2000자 청크로 쪼개고, 블록은 상위에서 100개로 자른다.

const MAX_TEXT = 2000;

export interface RichText {
  type: 'text';
  text: { content: string; link?: { url: string } | null };
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean };
}

// Notion 블록은 형태가 type별로 달라 느슨하게 표현(API가 형태 검증).
export type NotionBlock = Record<string, unknown>;

export function markdownToBlocks(md: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length === 0) return;
    blocks.push(paragraph(inlineToRichText(para.join(' '))));
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') {
      flushPara();
      i++;
      continue;
    }

    // 코드 펜스
    const fence = trimmed.match(/^```(\w*)\s*$/);
    if (fence) {
      flushPara();
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(codeBlock(code.join('\n')));
      continue;
    }

    // 헤딩 (1~3, 그 이상은 3으로)
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const level = Math.min(3, heading[1].length);
      blocks.push(headingBlock(level, inlineToRichText(heading[2].trim())));
      i++;
      continue;
    }

    // GFM 표
    if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushPara();
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push(tableBlock(header, rows));
      continue;
    }

    // 목록
    if (isListItem(trimmed)) {
      flushPara();
      while (i < lines.length && isListItem(lines[i].trim())) {
        const t = lines[i].trim();
        const ordered = /^\d+[.)]\s/.test(t);
        const content = t.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
        blocks.push(listItem(ordered, inlineToRichText(content)));
        i++;
      }
      continue;
    }

    para.push(trimmed);
    i++;
  }
  flushPara();
  // Notion children 한도(100). 넘으면 자른다(해설에선 사실상 도달 안 함).
  return blocks.slice(0, 100);
}

// ─── 블록 빌더 ───
function paragraph(rich: RichText[]): NotionBlock {
  return { type: 'paragraph', paragraph: { rich_text: rich } };
}

function headingBlock(level: number, rich: RichText[]): NotionBlock {
  const key = `heading_${level}`;
  return { type: key, [key]: { rich_text: rich } };
}

function listItem(ordered: boolean, rich: RichText[]): NotionBlock {
  const key = ordered ? 'numbered_list_item' : 'bulleted_list_item';
  return { type: key, [key]: { rich_text: rich } };
}

function codeBlock(code: string): NotionBlock {
  return {
    type: 'code',
    code: {
      rich_text: plainRichText(code),
      language: 'plain text',
    },
  };
}

function tableBlock(header: string[], rows: string[][]): NotionBlock {
  const width = header.length;
  const toRow = (cells: string[]): NotionBlock => ({
    type: 'table_row',
    table_row: {
      // 각 셀은 rich_text 배열. 열 수에 맞춰 패딩.
      cells: Array.from({ length: width }, (_, c) => inlineToRichText(cells[c] ?? '')),
    },
  });
  return {
    type: 'table',
    table: {
      table_width: width,
      has_column_header: true,
      has_row_header: false,
      children: [toRow(header), ...rows.map(toRow)],
    },
  };
}

// ─── 인라인 rich_text ───
const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;

function inlineToRichText(text: string): RichText[] {
  const out: RichText[] = [];
  for (const part of text.split(INLINE_RE)) {
    if (!part) continue;
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      pushChunks(out, part.slice(1, -1), { code: true });
    } else if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      pushChunks(out, part.slice(2, -2), { bold: true });
    } else if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      pushChunks(out, part.slice(1, -1), { italic: true });
    } else {
      pushChunks(out, part);
    }
  }
  // 빈 셀/빈 문단에도 Notion은 최소 빈 rich_text를 허용 → 빈 배열 그대로 둬도 됨.
  return out;
}

function plainRichText(text: string): RichText[] {
  const out: RichText[] = [];
  pushChunks(out, text);
  return out;
}

// content를 2000자 한도로 쪼개 rich_text 조각으로 추가.
function pushChunks(
  out: RichText[],
  content: string,
  annotations?: RichText['annotations'],
): void {
  if (content === '') return;
  for (let i = 0; i < content.length; i += MAX_TEXT) {
    const slice = content.slice(i, i + MAX_TEXT);
    out.push(
      annotations
        ? { type: 'text', text: { content: slice }, annotations }
        : { type: 'text', text: { content: slice } },
    );
  }
}

// ─── 표 파싱 헬퍼 (markdown.ts와 동일 규칙) ───
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.includes('|') && t.replace(/[^|]/g, '').length >= 1 && !/^\|?\s*$/.test(t);
}

function isTableDivider(line: string): boolean {
  const t = line.trim();
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(t) && t.includes('-');
}

function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

function isListItem(trimmed: string): boolean {
  return /^([-*+]\s+|\d+[.)]\s+)/.test(trimmed);
}
