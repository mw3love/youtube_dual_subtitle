import type { Cue, Word } from './types';

// JSON3 caption format reference: each event has tStartMs, dDurationMs, and a
// segs array of { utf8, tOffsetMs? } pieces. Some events are styling-only and have no segs.
// 자동자막(ASR)은 segs 각각에 tOffsetMs를 실어 보내 — 이게 단어/토큰 단위 타이밍.
// 수동/업로드 자막은 보통 하나의 seg에 전체 텍스트가 있고 tOffsetMs가 없다.

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
}

interface Json3Doc {
  events?: Json3Event[];
}

// tOffsetMs가 모두 0이면 의미 있는 단어 타이밍이 없는 것으로 보고 null을 반환 — caller가 보간으로 fallback.
function wordsFromSegs(
  segs: Json3Seg[],
  cueStartSec: number,
  cueEndSec: number,
): Word[] | null {
  const words: Word[] = [];
  let anyOffset = false;
  let curText = '';
  let curStartMs: number | null = null;

  const flush = (endMs: number): void => {
    if (curText.trim().length === 0) {
      curText = '';
      curStartMs = null;
      return;
    }
    const startSec = cueStartSec + (curStartMs ?? 0) / 1000;
    const endSec = cueStartSec + endMs / 1000;
    words.push({
      text: curText.trim(),
      start: startSec,
      end: Math.max(endSec, startSec),
    });
    curText = '';
    curStartMs = null;
  };

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const raw = seg?.utf8 ?? '';
    if (!raw) continue;
    const offset = typeof seg.tOffsetMs === 'number' ? seg.tOffsetMs : 0;
    if (typeof seg.tOffsetMs === 'number' && seg.tOffsetMs > 0) anyOffset = true;

    if (curText.length > 0 && curStartMs !== null) {
      flush(offset);
    }
    if (curStartMs === null) curStartMs = offset;
    curText += raw;
  }
  const cueDurMs = (cueEndSec - cueStartSec) * 1000;
  flush(cueDurMs);

  if (words.length === 0) return null;
  if (!anyOffset) return null;
  return words;
}

function interpolateWords(text: string, startSec: number, endSec: number): Word[] {
  const tokens = text.split(/\s+/).filter((s) => s.length > 0);
  if (tokens.length === 0) return [];
  const dur = Math.max(0, endSec - startSec);
  const step = dur / tokens.length;
  return tokens.map((tok, i) => ({
    text: tok,
    start: startSec + i * step,
    end: startSec + (i + 1) * step,
  }));
}

export function parseJson3(json: unknown): Cue[] {
  const doc = json as Json3Doc;
  const events = Array.isArray(doc?.events) ? doc.events : [];
  const cues: Cue[] = [];
  for (const ev of events) {
    if (typeof ev?.tStartMs !== 'number') continue;
    const segs = Array.isArray(ev.segs) ? ev.segs : [];
    const rawText = segs.map((s) => s?.utf8 ?? '').join('');
    const text = rawText.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const dur = typeof ev.dDurationMs === 'number' ? ev.dDurationMs : 0;
    const startSec = ev.tStartMs / 1000;
    const endSec = (ev.tStartMs + dur) / 1000;

    const wordsFromOffsets = wordsFromSegs(segs, startSec, endSec);
    const words = wordsFromOffsets ?? interpolateWords(text, startSec, endSec);

    cues.push({
      start: startSec,
      end: endSec,
      text,
      words: words.length > 0 ? words : undefined,
    });
  }
  return cues;
}
