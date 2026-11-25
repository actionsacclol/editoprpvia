/**
 * Edit by transcript: the timeline's speech as words (Whisper word timings
 * mapped through the cut pieces, autoEdit.remapSegments), and the cuts that
 * remove a selection of them. Deleting words cuts [first word, next kept
 * word) so the pause after them goes too; a long pause after is kept
 * (trimmed to a short tail) so the edit doesn't jam two sentences together.
 */
import { mergeRanges, type Range, type Segment } from './autoEdit';

export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
  /** Starts a new paragraph (a long pause, or a sentence end and a shorter one). */
  para: boolean;
}

/** A pause this long always starts a new paragraph… */
const PARA_GAP = 1.5;
/** …and one this long does after a sentence ends. */
const SENTENCE_GAP = 0.6;
/** A pause after deleted words up to this long is removed with them… */
const TAIL_GAP = 0.6;
/** …a longer one keeps this much after the deleted words' end. */
const TAIL_PAD = 0.12;

/** Timeline-time segments → words in order, with paragraph starts marked. */
export function transcriptWordsFrom(segments: Segment[]): TranscriptWord[] {
  const raw: Array<{ start: number; end: number; text: string }> = [];
  for (const s of segments) {
    if (s.words && s.words.length > 0) raw.push(...s.words);
    else raw.push({ start: s.start, end: s.end, text: s.text });
  }
  raw.sort((a, b) => a.start - b.start);
  const out: TranscriptWord[] = [];
  for (const w of raw) {
    const text = w.text.trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    const gap = prev ? w.start - prev.end : Infinity;
    const para = !prev || gap >= PARA_GAP || (gap >= SENTENCE_GAP && /[.!?…]$/.test(prev.text));
    out.push({ start: w.start, end: Math.max(w.end, w.start), text, para });
  }
  return out;
}

/** Timeline ranges that remove the words at `indices` (any order, duplicates fine). */
export function cutRangesForWords(words: TranscriptWord[], indices: Iterable<number>): Range[] {
  const sel = [...new Set(indices)].filter((i) => i >= 0 && i < words.length).sort((a, b) => a - b);
  const out: Range[] = [];
  let i = 0;
  while (i < sel.length) {
    let j = i;
    while (j + 1 < sel.length && sel[j + 1] === sel[j] + 1) j++;
    const first = words[sel[i]];
    const last = words[sel[j]];
    const next = words[sel[j] + 1];
    const prev = words[sel[i] - 1];
    const start = prev ? Math.max(first.start, prev.end) : first.start;
    const end = next && next.start - last.end <= TAIL_GAP ? next.start : last.end + TAIL_PAD;
    if (end > start + 0.01) out.push([start, next ? Math.min(end, next.start) : end]);
    i = j + 1;
  }
  return mergeRanges(out);
}

/** Index of the word playing at `t` (last word started by then, while it or its pause lasts), or -1. */
export function wordIndexAt(words: TranscriptWord[], t: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t + 1e-6) {
      hit = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (hit < 0) return -1;
  // Past the word by more than a beat (a long pause): nothing is playing.
  return t <= words[hit].end + 0.3 ? hit : -1;
}

/** Start indices of every occurrence of `query` (whole words, case and punctuation ignored). */
export function findPhrase(words: TranscriptWord[], query: string): number[] {
  const q = query.split(/\s+/).map(normWord).filter(Boolean);
  if (q.length === 0) return [];
  const norm = words.map((w) => normWord(w.text));
  const out: number[] = [];
  for (let i = 0; i + q.length <= norm.length; i++) {
    let ok = true;
    for (let k = 0; k < q.length && ok; k++) ok = norm[i + k] === q[k];
    if (ok) out.push(i);
  }
  return out;
}

/** Lower-case letters, digits and apostrophes only (any script). */
function normWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
}
