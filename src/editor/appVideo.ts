// A video about an app from one recording of it: a guide, a product demo or a
// trailer. The recording (the user's own, an agent's record_window, a filmed
// web page) is cut into steps where it was clicked; each step gets a name and,
// when wanted, a line; and the video is the longform build fed with those
// stretches. Nothing here touches the timeline: findMoments reads a pointer
// track, appVideoArgs writes the arguments build_longform takes.

import { settles, type PointerTrack } from './demo';
import { snapToPause, type SpokenLine } from './longform';

/** One stretch of a recording worth a step: what was clicked, and the seconds around it. */
export interface Moment {
  /** Recording seconds. */
  from: number;
  to: number;
  /** The moment to look at: the first click (or where the pointer came to rest). */
  at: number;
  /** Where that was, 0..1 across and down the picture. */
  x: number;
  y: number;
  clicks: number;
  /** What was said during it, when the recording was listened to. */
  said?: string;
  /** Not found from clicks: an even share of the recording. */
  guessed?: boolean;
}

export const MOMENT = {
  /** Clicks this close together are one step, seconds. */
  JOIN: 4,
  /** A step starts this long before its first click, so the pointer is seen arriving. */
  LEAD: 1.2,
  /** …and ends this long after its last, so what the click did is seen. */
  TAIL: 2.2,
  /** No step is shorter than this. */
  MIN: 2.5,
  /** More clicks than this many steps: the closest are joined. */
  MAX: 12,
  /** A recording without clicks is split about this often. */
  EVEN: 10,
} as const;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const r2 = (v: number): number => Math.round(v * 100) / 100;
const inPicture = (x: number, y: number): boolean => x >= 0 && x <= 1 && y >= 0 && y <= 1;

/**
 * The steps in a recording. Clicks close in time are one step; a step runs
 * from a little before its first click to a little after its last. With what
 * was said (`lines`), the steps follow one another without a gap and each
 * starts at a pause, so no sentence is cut. A recording with no clicks (and no
 * resting pointer) is split evenly, and says so (`guessed`).
 */
export function findMoments(input: { duration: number; pointer?: PointerTrack | null; lines?: SpokenLine[]; max?: number }): Moment[] {
  const duration = input.duration;
  if (!(duration > 0)) return [];
  const max = clamp(Math.round(input.max ?? MOMENT.MAX), 1, 40);
  const lines = (input.lines ?? []).filter((l) => l.end > l.start);
  const track = input.pointer ?? null;
  const pressed = (track?.clicks ?? []).filter(([t, x, y]) => t >= 0 && t <= duration && inPicture(x, y)).map(([t, x, y]) => ({ t, x, y }));
  const events = pressed.length ? pressed : track ? settles(track).filter((e) => e.t <= duration).map((e) => ({ t: e.t, x: e.x, y: e.y })) : [];
  const saidIn = (from: number, to: number): string | undefined => {
    const text = lines
      .filter((l) => (l.start + l.end) / 2 >= from && (l.start + l.end) / 2 < to)
      .map((l) => l.text.trim())
      .join(' ')
      .trim();
    return text || undefined;
  };

  if (events.length === 0) {
    const n = clamp(Math.round(duration / MOMENT.EVEN), 1, max);
    const cuts = Array.from({ length: n + 1 }, (_, i) => (i === 0 ? 0 : i === n ? duration : lines.length ? snapToPause(lines, (duration * i) / n) : (duration * i) / n));
    const out: Moment[] = [];
    for (let i = 0; i < n; i++) {
      if (cuts[i + 1] - cuts[i] < 1) continue;
      out.push({ from: r2(cuts[i]), to: r2(cuts[i + 1]), at: r2(Math.min(cuts[i] + 1, (cuts[i] + cuts[i + 1]) / 2)), x: 0.5, y: 0.5, clicks: 0, said: saidIn(cuts[i], cuts[i + 1]), guessed: true });
    }
    return out;
  }

  events.sort((a, b) => a.t - b.t);
  let groups: Array<Array<{ t: number; x: number; y: number }>> = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && e.t - last[last.length - 1].t <= MOMENT.JOIN) last.push(e);
    else groups.push([e]);
  }
  // Too many for one video: the two that lie closest together become one, until it fits.
  while (groups.length > max) {
    let k = 1;
    for (let i = 2; i < groups.length; i++) if (groups[i][0].t - groups[i - 1][groups[i - 1].length - 1].t < groups[k][0].t - groups[k - 1][groups[k - 1].length - 1].t) k = i;
    groups = [...groups.slice(0, k - 1), [...groups[k - 1], ...groups[k]], ...groups.slice(k + 1)];
  }

  const spans = groups.map((g) => ({ g, from: Math.max(0, g[0].t - MOMENT.LEAD), to: Math.min(duration, g[g.length - 1].t + MOMENT.TAIL) }));
  // Short ones are given room, later first, then earlier.
  for (const s of spans) {
    if (s.to - s.from >= MOMENT.MIN) continue;
    s.to = Math.min(duration, s.from + MOMENT.MIN);
    s.from = Math.max(0, s.to - MOMENT.MIN);
  }
  // Two that run into each other part half-way between the last click of one and the first of the next.
  for (let i = 1; i < spans.length; i++) {
    const a = spans[i - 1];
    const b = spans[i];
    if (a.to <= b.from) continue;
    const mid = (a.g[a.g.length - 1].t + b.g[0].t) / 2;
    a.to = mid;
    b.from = mid;
  }
  if (lines.length) {
    // Narrated: every step starts at a pause and runs until the next one starts, so nothing said is lost.
    spans.forEach((s, i) => {
      const want = i === 0 ? s.from : (spans[i - 1].g[spans[i - 1].g.length - 1].t + MOMENT.TAIL + s.g[0].t - MOMENT.LEAD) / 2;
      const lo = i === 0 ? 0 : spans[i - 1].g[spans[i - 1].g.length - 1].t + 0.2;
      const snapped = snapToPause(lines, clamp(want, lo, s.g[0].t));
      s.from = snapped >= lo && snapped <= s.g[0].t ? snapped : clamp(want, lo, s.g[0].t);
    });
    spans.forEach((s, i) => {
      s.to = i + 1 < spans.length ? spans[i + 1].from : Math.min(duration, Math.max(s.to, lines[lines.length - 1].end + 0.3));
    });
  }
  return spans
    .filter((s) => s.to - s.from >= 0.5)
    .map((s) => ({ from: r2(s.from), to: r2(s.to), at: r2(s.g[0].t), x: r2(s.g[0].x), y: r2(s.g[0].y), clicks: pressed.length ? s.g.length : 0, said: saidIn(s.from, s.to) }));
}

export type AppVideoKind = 'guide' | 'demo' | 'trailer';
/** Who speaks: the built-in voice reading each step's line, the recording's own sound, or nobody. */
export type AppVoice = 'built-in' | 'recording' | 'none';

export interface AppKind {
  id: AppVideoKind;
  name: string;
  /** The longform format that builds it. */
  format: string;
  description: string;
  voices: AppVoice[];
  voice: AppVoice;
  /** What a step is called here. */
  step: string;
  closing: string;
}

export const APP_KINDS: AppKind[] = [
  {
    id: 'guide',
    name: 'Guide',
    format: 'tutorial',
    description: 'How to do something, step by step: a numbered card before each step, the recording zooming in on what is clicked, the steps listed again at the end.',
    voices: ['built-in', 'recording', 'none'],
    voice: 'built-in',
    step: 'Step',
    closing: 'That is all it takes.',
  },
  {
    id: 'demo',
    name: 'Product demo',
    format: 'product-walkthrough',
    description: 'What the app does, feature by feature: the recording in a window on a backdrop, each feature named as it is shown, zooms on the clicks, what it does listed at the end.',
    voices: ['none', 'built-in', 'recording'],
    voice: 'none',
    step: 'Feature',
    closing: '',
  },
  {
    id: 'trailer',
    name: 'Trailer',
    format: 'trailer',
    description: 'A launch video of 30 to 90 seconds, cut to a beat: the name landing on a hit, a headline per feature with a few seconds of its recording in a window, and an end card with where to get it.',
    voices: ['none', 'built-in'],
    voice: 'none',
    step: 'Feature',
    closing: '',
  },
];

export const findAppKind = (id: unknown): AppKind | undefined => APP_KINDS.find((k) => k.id === id || k.name.toLowerCase() === String(id ?? '').trim().toLowerCase());

export interface AppStep {
  /** Recording seconds. */
  from: number;
  to: number;
  /** The step card, or the feature's headline. */
  heading: string;
  /** What is said (or shown as captions when nobody speaks). */
  text?: string;
  points?: string[];
  /** Where the step's first click landed, 0..1 across and down the picture: what a trailer moves in on. */
  click?: { x: number; y: number };
}

export interface AppVideoInput {
  kind: AppVideoKind;
  /** The recording: a media id or a file path. */
  take: string;
  title: string;
  subtitle?: string;
  /** Said (or shown) before the first step; a trailer's opening lines, one per line. */
  opening?: string;
  steps: AppStep[];
  voice: AppVoice;
  /** The built-in voice to read with. */
  voiceName?: string;
  closing?: { text?: string; action?: string; where?: string; note?: string };
  logo?: string;
  music?: string;
  captions?: boolean;
  clear?: boolean;
}

/** How near the edge of the picture a click counts as getting somewhere (a sidebar, a menu) rather than as the thing shown. */
export const TRAILER_EDGE = { x: 0.18, y: 0.1 } as const;
const inBody = (c: { x: number; y: number }): boolean => c.x >= TRAILER_EDGE.x && c.x <= 1 - TRAILER_EDGE.x && c.y >= TRAILER_EDGE.y && c.y <= 1 - TRAILER_EDGE.y / 2;

/** How long a feature's recording is shown in a trailer, seconds. */
export const TRAILER_WINDOW = { min: 3, max: 6 } as const;

/** What stops a video being built from these steps, in words for the person; null when nothing does. */
export function appVideoProblem(input: AppVideoInput): string | null {
  const kind = findAppKind(input.kind);
  if (!kind) return 'Pick what to make: a guide, a product demo or a trailer.';
  if (!input.title.trim()) return input.kind === 'guide' ? 'Give the guide a title.' : 'Give it the name of the app.';
  if (input.steps.length === 0) return 'There are no steps left: keep at least one.';
  if (!kind.voices.includes(input.voice)) return `A ${kind.name.toLowerCase()} cannot use that voice.`;
  const unnamed = input.steps.findIndex((s) => !s.heading.trim());
  if (unnamed >= 0) return `${kind.step} ${unnamed + 1} needs a name.`;
  const short = input.steps.findIndex((s) => !(s.to - s.from >= 1));
  if (short >= 0) return `${kind.step} ${short + 1} is under a second long.`;
  const order = input.steps.findIndex((s, i) => i > 0 && s.from < input.steps[i - 1].to - 0.05);
  if (order >= 0 && input.voice === 'recording') return `${kind.step} ${order + 1} starts before the one above it ends: with the recording's own voice the steps have to follow one another.`;
  return null;
}

/**
 * The build_longform arguments for a video about an app. With the built-in
 * voice or no voice, each step shows exactly its stretch of the recording,
 * fitted to the time its line takes; with the recording's own voice the steps
 * are stretches of the recording itself, sound and picture together.
 */
export function appVideoArgs(input: AppVideoInput): Record<string, unknown> {
  const kind = findAppKind(input.kind) ?? APP_KINDS[0];
  const steps = input.steps.map((s) => ({ ...s, heading: s.heading.trim(), text: s.text?.trim() || undefined, points: (s.points ?? []).map((p) => p.trim()).filter(Boolean) }));
  const opening = input.opening?.trim() || undefined;
  const common = { format: kind.format, title: input.title.trim(), subtitle: input.subtitle?.trim() || undefined, voice: input.voiceName, music: input.music || undefined, clear: input.clear === true };
  if (kind.id === 'trailer') {
    return {
      ...common,
      hook: opening,
      sections: steps.map((s) => ({
        heading: s.heading,
        text: s.text,
        points: s.points.slice(0, 3),
        seconds: r2(clamp(s.to - s.from, TRAILER_WINDOW.min, TRAILER_WINDOW.max)),
        // A click in the body of the app is the thing being shown, so the window moves in on it; one at the edge
        // (a sidebar, a menu, a tab) only got there, and the window stays whole, at an angle.
        visuals: [{ media: input.take, in_point: r2(s.from), ...(s.click && inBody(s.click) ? { focus_x: r2(s.click.x), focus_y: r2(s.click.y) } : {}) }],
      })),
      outro: { title: input.closing?.action?.trim() || undefined, subtitle: input.closing?.where?.trim() || undefined, note: input.closing?.note?.trim() || undefined },
      voiceover: input.voice === 'built-in',
      captions: input.voice === 'built-in' && input.captions !== false,
      logo: input.logo || undefined,
    };
  }
  const outro = { title: input.closing?.action?.trim() || undefined, subtitle: input.closing?.where?.trim() || undefined, text: input.voice === 'recording' ? undefined : input.closing?.text?.trim() || undefined };
  if (input.voice === 'recording') {
    return {
      ...common,
      recording: input.take,
      sections: steps.map((s, i) => {
        const next = steps[i + 1];
        // A step that stops before the next one starts (or before the end) says where; otherwise it runs on to the next.
        const open = next ? Math.abs(next.from - s.to) <= 0.3 : false;
        return { heading: s.heading, from: r2(s.from), ...(open ? {} : { to: r2(s.to) }), points: s.points.slice(0, 6) };
      }),
      outro,
      captions: input.captions !== false,
    };
  }
  return {
    ...common,
    hook: opening,
    sections: steps.map((s) => ({
      heading: s.heading,
      // Something has to be said for each step: without a line of its own, its name.
      text: s.text ?? (input.voice === 'built-in' ? s.heading : undefined),
      points: s.points.slice(0, 6),
      visuals: [{ media: input.take, in_point: r2(s.from), out_point: r2(s.to), fit: 'fit' }],
    })),
    outro,
    ...(input.voice === 'none' ? { silent: true } : {}),
    captions: input.captions !== false,
  };
}

/** What to ask an agent for, with the recording in the library: it looks at the steps and writes the words. */
export function appVideoPrompt(kind: AppVideoKind, take: string): string {
  const k = findAppKind(kind) ?? APP_KINDS[0];
  const what = k.id === 'guide' ? 'a guide (build_longform format "tutorial")' : k.id === 'demo' ? 'a product demo (build_longform format "product-walkthrough")' : 'a trailer (build_longform format "trailer")';
  return `In Krypt Editor, make ${what} from my recording "${take}". Call find_steps on it first and look at the frames, then name each step for what is clicked in it and write one short sentence for it. Say only what the recording shows.`;
}
