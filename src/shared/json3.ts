import type { Cue } from './types';

// JSON3 caption format reference: each event has tStartMs, dDurationMs, and a
// segs array of { utf8 } pieces. Some events are styling-only and have no segs.

interface Json3Seg {
  utf8?: string;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
}

interface Json3Doc {
  events?: Json3Event[];
}

export function parseJson3(json: unknown): Cue[] {
  const doc = json as Json3Doc;
  const events = Array.isArray(doc?.events) ? doc.events : [];
  const cues: Cue[] = [];
  for (const ev of events) {
    if (typeof ev?.tStartMs !== 'number') continue;
    const segs = Array.isArray(ev.segs) ? ev.segs : [];
    const text = segs.map((s) => s?.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const dur = typeof ev.dDurationMs === 'number' ? ev.dDurationMs : 0;
    cues.push({
      start: ev.tStartMs / 1000,
      end: (ev.tStartMs + dur) / 1000,
      text,
    });
  }
  return cues;
}
