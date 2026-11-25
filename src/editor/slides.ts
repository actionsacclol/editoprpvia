import { useMediaStore } from './mediaStore';

/**
 * Slide decks: a PDF becomes one image per page in the media library, with the
 * page's text kept beside it so the slides can be lined up against what the
 * speaker says (alignSlides), by the app or by an AI agent reading both.
 */

export interface Slide {
  page: number;
  mediaId: string;
  /** The slide's heading (its biggest line of text), or "Slide 3". */
  title: string;
  /** Everything written on the slide, line by line. */
  text: string;
  width: number;
  height: number;
}

export interface Deck {
  path: string;
  name: string;
  /** Pages in the PDF (slides may hold fewer when a page range was imported). */
  pages: number;
  slides: Slide[];
}

export interface PdfLineLike {
  text: string;
  size: number;
}

const MAX_PAGES = 300;
const MAX_TEXT = 1500;

// Decks imported this session, newest last. The text is what alignment needs;
// the images themselves are ordinary media and are saved with the project.
const decks: Deck[] = [];
const byMedia = new Map<string, Slide>();

export const lastDeck = (): Deck | undefined => decks[decks.length - 1];
export const slideFor = (mediaId: string): Slide | undefined => byMedia.get(mediaId);

/** The biggest line near the top of a slide is its title. */
export function slideTitle(lines: PdfLineLike[], page: number): string {
  const head = lines.slice(0, 6).filter((l) => /[\p{L}\p{N}]/u.test(l.text));
  if (head.length === 0) return `Slide ${page}`;
  const top = head.reduce((best, l) => (l.size > best.size * 1.05 ? l : best), head[0]);
  return top.text.length > 120 ? `${top.text.slice(0, 117)}…` : top.text;
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export interface ImportSlidesOptions {
  /** First and last page to import (1-based, inclusive). Default: all. */
  from?: number;
  to?: number;
  /** Image height in pixels (default 1620: sharp at 1080p with room to zoom in). */
  height?: number;
  onProgress?: (ratio: number, status: string) => void;
  signal?: AbortSignal;
}

/** Turn a PDF's pages into images in the media library. */
export async function importSlides(path: string, opts: ImportSlidesOptions = {}): Promise<Deck> {
  const file = await window.krypt.media.readSlides(path);
  if (!file.ok || !file.data) throw new Error(file.message ?? 'Could not read that PDF.');
  opts.onProgress?.(-1, 'Opening slides…');
  const { openPdf } = await import('./pdfLoader');
  const pdf = await openPdf(file.data.data);
  try {
    const from = Math.max(1, Math.floor(opts.from ?? 1));
    const to = Math.min(pdf.pages, Math.floor(opts.to ?? pdf.pages));
    if (from > to) throw new Error(`That PDF has ${pdf.pages} page${pdf.pages === 1 ? '' : 's'}; pages ${from}–${opts.to ?? pdf.pages} is empty.`);
    if (to - from + 1 > MAX_PAGES) throw new Error(`That is ${to - from + 1} pages; import at most ${MAX_PAGES} at a time (use a page range).`);
    const stem = file.data.name.replace(/\.pdf$/i, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'slides';
    const tag = fnv(path);
    const height = Math.max(360, Math.min(2160, Math.round(opts.height ?? 1620)));
    const digits = String(pdf.pages).length;
    const slides: Slide[] = [];
    for (let n = from; n <= to; n++) {
      if (opts.signal?.aborted) throw new Error('Cancelled.');
      opts.onProgress?.((n - from) / (to - from + 1), `Slide ${n} of ${to}`);
      const page = await pdf.render(n, height);
      const saved = await window.krypt.media.saveDerived(page.png, `${stem}-${tag}-p${String(n).padStart(digits, '0')}.png`);
      if (!saved.ok || !saved.data) throw new Error(saved.message ?? `Could not store slide ${n}.`);
      useMediaStore.getState().add([saved.data]);
      // A page imported before keeps the library entry (and id) it already has.
      const entry = useMediaStore.getState().media.find((m) => m.filePath === saved.data!.filePath) ?? saved.data;
      const slide: Slide = { page: n, mediaId: entry.id, title: slideTitle(page.lines, n), text: page.lines.map((l) => l.text).join('\n').slice(0, MAX_TEXT), width: page.width, height: page.height };
      slides.push(slide);
      byMedia.set(entry.id, slide);
    }
    const deck: Deck = { path, name: file.data.name, pages: pdf.pages, slides };
    decks.push(deck);
    return deck;
  } finally {
    await pdf.close().catch(() => {});
  }
}

// ── Lining slides up with the narration ────────────────────────────────────
const STOP = new Set(
  'the and but for with from that this these those are was were been being have has had will would can could should may might must not you your they their them our its his her she him who what which when where why how into out over under about also just very more most some any each every all both such only own same too than then there here does did doing let lets now one two get got make made use used using like well going really actually basically okay yeah'.split(
    ' ',
  ),
);

const stem = (w: string): string => (w.length > 4 ? w.replace(/ies$/, 'y').replace(/sses$/, 'ss').replace(/([^s])s$/, '$1') : w);

/** The words of a text that say what it is about (lower-cased, plurals folded, small words dropped). */
export function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stem).filter((w) => w.length >= 3 && !STOP.has(w));
}

export interface SpokenLine {
  start: number;
  end: number;
  text: string;
}

/** A slide placed by its neighbours rather than by its words is given at least this long when there is room. */
const MIN_SHOW = 4;

/**
 * When each slide should come up, from what is written on it and what is said.
 * Each slide is its title on the first line and the rest of its text after
 * (an empty string for a slide with no text: a diagram, a photo).
 *
 * The slides with wording stay in order and the split is the one where the
 * most slide wording falls under its own slide: rare words count for more,
 * and title words double, since the title is what a speaker says on arriving.
 * Where the words leave the moment open (a remark between two topics), the
 * slide changes at the pause. Slides nothing was said about share the time
 * around them. `matched` is how many slides shared wording with their stretch
 * of speech.
 */
export function alignSlides(slides: string[], lines: SpokenLine[]): { starts: number[]; matched: number } {
  const S = slides.length;
  const N = lines.length;
  if (S === 0) return { starts: [], matched: 0 };
  const t0 = lines[0]?.start ?? 0;
  const t1 = lines[N - 1]?.end ?? t0 + S * 5;
  const sets = slides.map((text) => {
    const [title, ...rest] = text.split('\n');
    const words = new Map<string, number>();
    for (const w of contentWords(rest.join(' '))) words.set(w, 1);
    for (const w of contentWords(title)) words.set(w, 2);
    return words;
  });
  const worded = sets.flatMap((words, i) => (words.size > 0 ? [i] : []));
  const K = worded.length;
  // Nothing to match on (a deck of pictures, or hardly any speech): share the time out.
  if (K === 0 || N < K) return { starts: slides.map((_, i) => t0 + ((t1 - t0) * i) / S), matched: 0 };

  const df = new Map<string, number>();
  for (const i of worded) for (const w of sets[i].keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const said = lines.map((l) => [...new Set(contentWords(l.text))]);
  const score = (k: number, j: number): number => {
    const words = sets[worded[k]];
    return said[j].reduce((sum, w) => sum + (words.get(w) ?? 0) * Math.log(1 + K / (df.get(w) ?? K)), 0);
  };

  // best[k][j]: the best total with line j under slide k (slides 0..k each used, in order).
  const best: Float64Array[] = Array.from({ length: K }, () => new Float64Array(N).fill(-Infinity));
  const advanced: Uint8Array[] = Array.from({ length: K }, () => new Uint8Array(N));
  for (let k = 0; k < K; k++) {
    for (let j = k; j < N - (K - 1 - k); j++) {
      const here = score(k, j);
      if (k === 0) {
        best[0][j] = (j > 0 ? best[0][j - 1] : 0) + here;
        continue;
      }
      const stay = j - 1 >= k ? best[k][j - 1] : -Infinity;
      const advance = best[k - 1][j - 1];
      if (advance >= stay) {
        best[k][j] = advance + here;
        advanced[k][j] = 1;
      } else best[k][j] = stay + here;
    }
  }
  const first = new Array<number>(K).fill(0);
  let j = N - 1;
  for (let k = K - 1; k > 0; k--) {
    while (!advanced[k][j]) j--;
    first[k] = j;
    j--;
  }
  // The first and last line under each slide that share its wording (-1: none do).
  const firstMatch = new Array<number>(K).fill(-1);
  const lastMatch = new Array<number>(K).fill(-1);
  for (let k = 0; k < K; k++) {
    const to = k + 1 < K ? first[k + 1] : N;
    for (let n = first[k]; n < to; n++) {
      if (score(k, n) <= 0) continue;
      if (firstMatch[k] < 0) firstMatch[k] = n;
      lastMatch[k] = n;
    }
  }

  // Between the last words of one slide and the first words of the next, the
  // words do not say where the change belongs: it goes to the clearest break
  // (a pause, the start of a sentence), else stays with the first matching line.
  const breakAt = (n: number): number => Math.min(2, Math.max(0, lines[n].start - lines[n - 1].end)) + (/[.!?…]["')\]]?\s*$/.test(lines[n - 1].text) ? 1 : 0);
  const times = new Array<number>(S).fill(NaN);
  const tail = new Array<number>(S).fill(NaN); // where a slide's own wording ends
  let floor = 1;
  for (let k = 0; k < K; k++) {
    if (firstMatch[k] < 0) continue;
    let at = firstMatch[k];
    if (at >= floor) {
      for (let n = at - 1; n >= floor; n--) if (breakAt(n) >= breakAt(at) + 0.5) at = n;
      times[worded[k]] = lines[at].start;
    } else if (worded[k] === 0) times[0] = t0;
    // (else: slides come before it yet it is talked about from the first line; it shares the opening with them below)
    if (Number.isFinite(times[worded[k]])) tail[worded[k]] = lines[lastMatch[k]].end;
    floor = lastMatch[k] + 1;
  }
  times[0] = t0;

  // The slides nothing was said about: after the wording of the slide before
  // when there is time there, else an even share of that slide's stretch.
  const snap = (target: number, after: number, before: number): number => {
    let pick = target;
    let off = 3;
    for (const l of lines) {
      if (l.start <= after + 1 || l.start >= before - 1) continue;
      if (Math.abs(l.start - target) < off) {
        off = Math.abs(l.start - target);
        pick = l.start;
      }
    }
    return pick;
  };
  for (let i = 1; i < S; i++) {
    if (Number.isFinite(times[i])) continue;
    let k = i;
    while (k + 1 < S && !Number.isFinite(times[k + 1])) k++;
    const u = k - i + 1;
    const from = times[i - 1];
    const to = k + 1 < S ? times[k + 1] : t1;
    const e = tail[i - 1];
    const inTail = Number.isFinite(e) && to - e >= u * MIN_SHOW;
    for (let m = 0; m < u; m++) {
      const target = inTail ? e + ((to - e) * m) / u : from + ((to - from) * (m + 1)) / (u + 1);
      times[i + m] = snap(target, times[i + m - 1], to);
    }
    i = k;
  }
  for (let i = 1; i < S; i++) if (!(times[i] > times[i - 1])) times[i] = times[i - 1] + 0.5;
  return { starts: times, matched: firstMatch.filter((n) => n >= 0).length };
}
