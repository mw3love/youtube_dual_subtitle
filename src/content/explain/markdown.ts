// 최소 markdown → DOM 렌더러 (해설 패널 전용).
//
// 왜 자체 구현인가: 해설 응답은 신뢰할 수 없는 LLM 출력이라 innerHTML로 넣으면 XSS 위험.
// 여기서는 모든 텍스트를 textContent로만 넣고 element를 직접 만들어 붙이므로 HTML 주입이
// 원천 불가능하다(sanitizer 의존성도 불필요). 대신 지원 문법은 해설에 실제로 쓰이는 것만:
// 헤딩(#~######), GFM 표, 순서/비순서 목록, 인라인(`code` / **bold** / *italic*), 문단.
//
// 한 줄 단위로 블록을 구분하고, 인라인은 정규식 토크나이저로 처리한다.

export function renderMarkdown(md: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  // 한 단락(연속된 비공백 줄)을 모으는 동안의 버퍼.
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length === 0) return;
    const p = document.createElement('p');
    appendInline(p, para.join(' '));
    frag.appendChild(p);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 빈 줄 → 단락 경계
    if (trimmed === '') {
      flushPara();
      i++;
      continue;
    }

    // 코드 펜스 ```lang ... ``` → <pre>
    const fence = trimmed.match(/^```(\w*)\s*$/);
    if (fence) {
      flushPara();
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      i++; // 닫는 펜스 소비
      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      codeEl.textContent = code.join('\n');
      pre.appendChild(codeEl);
      frag.appendChild(pre);
      continue;
    }

    // 헤딩 # ~ ######
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const level = Math.min(6, heading[1].length);
      const h = document.createElement(`h${Math.min(6, level + 2)}`); // h1→h3 … 패널 안에서 과대 방지
      appendInline(h, heading[2].trim());
      frag.appendChild(h);
      i++;
      continue;
    }

    // GFM 표 — 헤더 줄 + 구분 줄(|---|) 패턴
    if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushPara();
      const header = splitTableRow(line);
      i += 2; // 헤더 + 구분 줄 소비
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      frag.appendChild(buildTable(header, rows));
      continue;
    }

    // 목록 (- / * / 1.) — 연속 항목을 한 블록으로
    if (isListItem(trimmed)) {
      flushPara();
      const ordered = /^\d+[.)]\s/.test(trimmed);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length && isListItem(lines[i].trim())) {
        const li = document.createElement('li');
        appendInline(li, lines[i].trim().replace(/^(?:[-*+]|\d+[.)])\s+/, ''));
        list.appendChild(li);
        i++;
      }
      frag.appendChild(list);
      continue;
    }

    // 그 외 → 단락에 누적
    para.push(trimmed);
    i++;
  }
  flushPara();
  return frag;
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.includes('|') && t.replace(/[^|]/g, '').length >= 1 && !/^\|?\s*$/.test(t);
}

function isTableDivider(line: string): boolean {
  const t = line.trim();
  // | --- | :--: | 형태
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(t) && t.includes('-');
}

function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

function buildTable(header: string[], rows: string[][]): HTMLTableElement {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const cell of header) {
    const th = document.createElement('th');
    appendInline(th, cell);
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (let c = 0; c < header.length; c++) {
      const td = document.createElement('td');
      appendInline(td, row[c] ?? '');
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function isListItem(trimmed: string): boolean {
  return /^([-*+]\s+|\d+[.)]\s+)/.test(trimmed);
}

// renderMarkdown의 역방향 — 렌더된 패널 DOM을 다시 markdown으로 직렬화한다. 해설 패널에서
// 사용자가 백틱(코드)으로 표시한 부분이 DOM에 들어가므로(원본 markdown 매칭이 아니라 DOM이
// source of truth), 복사/Notion 내보낼 때 이걸로 백틱 포함 markdown을 만든다.
export function domToMarkdown(root: HTMLElement): string {
  return Array.from(root.children)
    .map((el) => serializeBlock(el as HTMLElement))
    .filter((b) => b !== '')
    .join('\n\n');
}

function serializeBlock(el: HTMLElement): string {
  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) {
    // 렌더 시 heading level+2로 태그를 만들었으므로 역산(h3→#, h4→##…).
    const n = Math.max(1, Number(tag[1]) - 2);
    return '#'.repeat(n) + ' ' + serializeInline(el).trim();
  }
  if (tag === 'UL' || tag === 'OL') {
    const ordered = tag === 'OL';
    return Array.from(el.children)
      .map((li, i) => (ordered ? `${i + 1}. ` : '- ') + serializeInline(li as HTMLElement).trim())
      .join('\n');
  }
  if (tag === 'PRE') {
    const code = el.querySelector('code');
    return '```\n' + (code?.textContent ?? el.textContent ?? '') + '\n```';
  }
  if (tag === 'TABLE') return serializeTable(el as HTMLTableElement);
  return serializeInline(el).trim();
}

function serializeInline(el: HTMLElement): string {
  let s = '';
  el.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      s += n.nodeValue ?? '';
      return;
    }
    const e = n as HTMLElement;
    if (e.tagName === 'STRONG') s += '**' + serializeInline(e) + '**';
    else if (e.tagName === 'EM') s += '*' + serializeInline(e) + '*';
    else if (e.tagName === 'CODE') s += '`' + (e.textContent ?? '') + '`';
    else s += serializeInline(e); // span 등은 내부만
  });
  return s;
}

function serializeTable(table: HTMLTableElement): string {
  const lines: string[] = [];
  const header = Array.from(table.querySelectorAll('thead th')).map((th) =>
    serializeInline(th as HTMLElement).trim(),
  );
  if (header.length) {
    lines.push('| ' + header.join(' | ') + ' |');
    lines.push('| ' + header.map(() => '---').join(' | ') + ' |');
  }
  table.querySelectorAll('tbody tr').forEach((tr) => {
    const cells = Array.from(tr.children).map((td) => serializeInline(td as HTMLElement).trim());
    lines.push('| ' + cells.join(' | ') + ' |');
  });
  return lines.join('\n');
}

// 인라인 토큰: `code`, **bold**, *italic*. 나머지는 평문(textContent).
// element + textContent로만 구성 — HTML 주입 불가.
const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;

function appendInline(parent: HTMLElement, text: string): void {
  const parts = text.split(INLINE_RE);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      const code = document.createElement('code');
      code.textContent = part.slice(1, -1);
      parent.appendChild(code);
    } else if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      parent.appendChild(strong);
    } else if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      const em = document.createElement('em');
      em.textContent = part.slice(1, -1);
      parent.appendChild(em);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  }
}
