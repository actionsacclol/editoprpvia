import { duckKeys, duckSpans, DUCK } from './ducking';
import type { Range } from './autoEdit';
import { cardPalette, fitText, readableOn, rectClip, textClip, type CardText } from './scenes';
import type { CardLook } from './styles';
import { balanceLines } from './thumbnail';
import { MIN_CLIP, REF_HEIGHT, captionClipsFor, newMediaClip, uid, type Canvas, type Clip, type MediaClip, type TextClip } from './timelineStore';
import { captionSegments, splitSentences, type LongformFormat, type LongformPlan, type LongformScript, type LongformVisual, type Narration, type PlannedSection, type SpokenWord, type VisualInfo } from './longform';

/**
 * A software trailer: the launch video for an app, a tool or a website. Unlike
 * the narrated formats nothing has to be spoken: short lines that come up word
 * by word over the app leaning back in space, the product's name landing on a
 * hit, each feature as a headline over its recording in a window (which comes
 * in at an angle, turns to face the viewer, and moves in on the part that
 * matters), and an end card with where to get it. Every cut is on
 * a beat of the music: the user's song (its beats found by montage.ts) or the
 * beat made here for exactly this video (trailerMusic).
 *
 * Pure, like longform.ts: media is probed and any voice-over spoken by the
 * caller (agentTools.ts).
 */

/** Where the beats are, seconds from the start of the video. Past the list (or with none) they carry on every `period`. */
export interface TrailerGrid {
  beats: number[];
  period: number;
}

/** Cut number `k` of the grid: the start of the video, then every beat. */
export function beatTime(g: TrailerGrid, k: number): number {
  if (k <= 0) return 0;
  const n = g.beats.length;
  if (n < 2) return k * g.period;
  return k < n ? g.beats[k] : g.beats[n - 1] + (k - (n - 1)) * g.period;
}

export interface TrailerInput {
  /** title = the product, subtitle = its tagline, hook = the opening lines, sections = the features, outro = { title: call to action, subtitle: where }. */
  script: LongformScript;
  format: LongformFormat;
  canvas: Canvas;
  /** A voice-over, where there is one: the line said over each feature, and over the end card. */
  narration: { sections: Array<Narration | undefined>; outro?: Narration };
  media: Map<string, VisualInfo>;
  /** The product's logo (media id), on the name card and the end card. */
  logo?: string;
  card: { look: CardLook; background?: string; accent?: string };
  cardText?: CardText;
  captions: { patch: Partial<TextClip>; upper: boolean } | null;
  grid: TrailerGrid;
  music?: { mediaId: string; duration: number; volume: number; duckDb: number };
  /**
   * The project's background will be this trailer's backdrop (it was black, or put there by a tool). Otherwise the
   * cards bring a background of their own, and a logo (which would sit under it) is left out.
   */
  backdropFree: boolean;
  start: number;
  tracks: { video: string; narration: string; music: string; text: string; captions: string };
}

/** What the music has to do, seconds from the start of the video. */
export interface TrailerScore {
  period: number;
  /** The name lands here: a hit, and the beat comes in. */
  reveal: number;
  /** The end card: a last hit, and the drums stop. */
  close: number;
  end: number;
  /** A recording slides in or out here. */
  cuts: number[];
}

export interface TrailerPlan extends LongformPlan {
  score: TrailerScore;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const wordCount = (s: string | undefined): number => (s?.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
/**
 * How a recording moves, seconds: `enter` to come in at an angle and turn to face the viewer, `zoom` to move in on
 * the part that matters, `by` how far in (1.6 = that part shown 1.6 times larger).
 */
export const TRAILER_MOVE = { enter: 0.9, zoom: 0.9, by: 1.6 } as const;
/** Where a window is at one moment: its size and place, how it leans, and how much of the picture is cut away (left, top, right, bottom). */
interface Pose {
  scale: number;
  posX: number;
  posY: number;
  tiltX: number;
  tiltY: number;
  rotation: number;
  crop: [number, number, number, number];
}
const easeOut = (r: number): number => 1 - Math.pow(1 - r, 4);
const easeInOut = (r: number): number => (r < 0.5 ? 4 * r * r * r : 1 - Math.pow(-2 * r + 2, 3) / 2);
/**
 * `clip` taken through `pose`, a function of the seconds since its scene began; the clip covers a..b of the scene.
 * The curves here are steeper than a keyframe's own easing, so a move is written as keyframes close together
 * (`moves`: when the pose changes fast); between moves it is a straight line. A property that never changes gets no keyframes.
 */
function posed(clip: MediaClip, pose: (tau: number) => Pose, a: number, b: number, moves: Array<[number, number]>): MediaClip {
  const times = new Set<number>([a, b]);
  for (const [m0, m1] of moves) for (let i = 0, n = Math.max(1, Math.ceil((m1 - m0) * 15)); i <= n; i++) times.add(clamp(m0 + ((m1 - m0) * i) / n, a, b));
  const at = [...times].sort((x, y) => x - y).filter((t, i, all) => i === 0 || t - all[i - 1] > 1e-4);
  const poses = at.map(pose);
  const props: Array<[string, (q: Pose) => number]> = [
    ['scaleX', (q) => q.scale],
    ['scaleY', (q) => q.scale],
    ['posX', (q) => q.posX],
    ['posY', (q) => q.posY],
    ['tiltX', (q) => q.tiltX],
    ['tiltY', (q) => q.tiltY],
    ['rotation', (q) => q.rotation],
    ['cropLeft', (q) => q.crop[0]],
    ['cropTop', (q) => q.crop[1]],
    ['cropRight', (q) => q.crop[2]],
    ['cropBottom', (q) => q.crop[3]],
  ];
  const round = (v: number): number => Math.round(v * 1e5) / 1e5;
  const next = clip as MediaClip & Record<string, unknown>;
  for (const [prop, get] of props) {
    const values = poses.map((q) => round(get(q)));
    next[prop] = values[0];
    if (values.some((v) => Math.abs(v - values[0]) > 1e-4)) clip.keyframes = [...(clip.keyframes ?? []), ...values.map((value, i) => ({ id: uid('k'), prop, t: round(at[i] - a), value }))];
  }
  return clip;
}
/**
 * The same words on the same number of lines, broken so the lines are about as long as each other: a large line
 * with one word left over under it reads as a mistake. Never wider than what was fitted (the widest line can only
 * get shorter).
 */
export function evenLines(text: string): string {
  const lines = text.split('\n').length;
  const words = text.split(/\s+/).filter(Boolean);
  if (lines < 2 || words.length < lines) return text;
  return balanceLines(words.map((w) => ({ text: w, accent: false })), lines)
    .map((l) => l.map((w) => w.text).join(' '))
    .join('\n');
}

/** The most opening lines shown, and the most callouts over one recording. */
export const TRAILER_MAX_LINES = 4;
export const TRAILER_MAX_CALLOUTS = 3;

export function planTrailer(input: TrailerInput): TrailerPlan {
  const { script, format: f, canvas, tracks, grid } = input;
  const p = grid.period;
  const clips: Clip[] = [];
  const notes: string[] = [];
  const voiced: Range[] = [];
  const captionSegs: Array<{ start: number; end: number; text: string; words: SpokenWord[] }> = [];
  const sections: PlannedSection[] = [];
  const cuts: number[] = [];
  const palette = cardPalette(input.card.look, { background: input.card.background, accent: input.card.accent, text: input.cardText });
  const portrait = canvas.height > canvas.width;
  // On the trailer's own backdrop the type is white; on a card's own background, the card's colour.
  const backdrop = f.backdrop ?? ['#0B1020', '#312E81'];
  const onBackdrop = input.backdropFree ? readableOn('#ffffff', backdrop[0]) : palette.color;
  const accent = input.backdropFree ? readableOn(input.card.accent ?? palette.accent, backdrop[0]) : palette.accent;
  const type = { fontFamily: palette.fontFamily, italic: input.cardText?.italic ?? false };
  const up = (s: string): string => (palette.upper ? s.toUpperCase() : s);
  const lineH = (size: number, lines: number): number => (lines * size * 1.18) / REF_HEIGHT;
  const refW = (px: number): number => Math.min(0.8, (px * (canvas.height / REF_HEIGHT)) / canvas.width);
  /** Cut number k on the timeline. */
  const T = (k: number): number => input.start + beatTime(grid, k);
  /** Whole beats for about `seconds`, never under `least` seconds. */
  const span = (seconds: number, least: number): number => Math.max(1, Math.ceil(least / p - 1e-6), Math.round(seconds / p));
  let k = 0;
  let entranceAt = 0;

  const group = (made: Clip[], kind: string): Clip[] => {
    const id = uid(kind);
    for (const c of made) c.group = id;
    return made;
  };

  /** The background of a card, where the project's own is not the trailer's. */
  const ground = (from: number, to: number, fill?: string): Clip[] => (fill || !input.backdropFree ? [rectClip({ trackId: tracks.text, start: from, duration: to - from, fill: fill ?? palette.background, w: 1.01, h: 1.01 })] : []);

  /** One line alone on the frame, large; a smaller one under it when there is one. */
  const slam = (text: string, from: number, to: number, o: { sub?: string; fill?: string; size?: number; chapter?: string } = {}): Clip[] => {
    const length = to - from;
    const color = o.fill ? readableOn(palette.color, o.fill) : onBackdrop;
    const main = fitText(up(text), o.size ?? 132, palette.fontFamily, true, canvas, { widthFrac: 0.82, maxLines: 3 });
    const sub = o.sub?.trim() ? fitText(o.sub.trim(), 46, palette.fontFamily, false, canvas, { widthFrac: 0.72, maxLines: 2 }) : null;
    const hMain = lineH(main.fontSize, main.lines);
    const hSub = sub ? lineH(sub.fontSize, sub.lines) : 0;
    const top = 0.5 - (hMain + (sub ? 0.035 + hSub : 0)) / 2;
    const made: Clip[] = ground(from, to, o.fill);
    // The words come up one after another; the line then drifts toward the viewer.
    made.push(textClip({ trackId: tracks.text, start: from, duration: length, ...type, text: evenLines(main.text), fontSize: main.fontSize, bold: true, color, y: top + hMain / 2, animIn: 'cascade', animInDur: clamp(0.25 + 0.07 * wordCount(text), 0.3, Math.max(0.3, length / 2)), animOut: 'fade', animOutDur: Math.min(0.14, length / 4), motion: 'zoom-in', motionAmount: 0.5 }));
    if (o.chapter) made[0].chapter = o.chapter;
    if (sub && length > 0.9) made.push(textClip({ trackId: tracks.text, start: from + Math.min(0.3, length / 3), duration: length - Math.min(0.3, length / 3), ...type, text: sub.text, fontSize: sub.fontSize, bold: false, color, y: top + hMain + 0.035 + hSub / 2, animIn: 'fade', animOut: 'fade', animOutDur: Math.min(0.12, length / 4) }));
    return group(made, 'slam');
  };

  /** A picture's share of the frame at scale 1 (fitted inside it). */
  const fitShare = (info: VisualInfo): { w: number; h: number } => {
    const fit = Math.min(canvas.width / info.width, canvas.height / info.height);
    return { w: (info.width * fit) / canvas.width, h: (info.height * fit) / canvas.height };
  };

  /** The logo, `high` of the frame tall at most, its middle at `y`. */
  const logoClip = (from: number, to: number, y: number, high: number): MediaClip[] => {
    const info = input.logo && input.backdropFree ? input.media.get(input.logo) : undefined;
    if (!info || !input.logo) return [];
    const share = fitShare(info);
    const scale = Math.min(high / share.h, (portrait ? 0.5 : 0.32) / share.w);
    return [newMediaClip({ mediaId: input.logo, trackId: tracks.video, start: from, duration: to - from, sourceDuration: info.kind === 'video' ? info.duration : to - from, sourceWidth: info.width, sourceHeight: info.height, scaleX: scale, scaleY: scale, posY: y - 0.5, muted: true, animIn: 'pop', animInDur: 0.3, fadeOut: Math.min(0.15, (to - from) / 4) })];
  };
  const hasLogo = !!(input.logo && input.backdropFree && input.media.has(input.logo));
  if (input.logo && !input.backdropFree) notes.push('the logo is left out: this project has a background of its own, and the cards cover it (set the background to black, or build with clear: true, for the logo)');

  /** The name card (and, with a call to action, the end card). */
  const nameCard = (from: number, to: number, close?: { action: string; where?: string; note?: string }): Clip[] => {
    const length = to - from;
    const made: Clip[] = ground(from, to);
    const title = fitText(up(script.title.trim()), close ? 124 : 156, palette.fontFamily, true, canvas, { widthFrac: 0.84, maxLines: 2 });
    const tag = script.subtitle?.trim() ? fitText(script.subtitle.trim(), close ? 44 : 50, palette.fontFamily, false, canvas, { widthFrac: 0.74, maxLines: 2 }) : null;
    const action = close ? fitText(close.action, 48, palette.fontFamily, true, canvas, { widthFrac: 0.6, maxLines: 1 }) : null;
    const where = close?.where?.trim() ? fitText(close.where.trim(), 42, palette.fontFamily, true, canvas, { widthFrac: 0.8, maxLines: 1 }) : null;
    const gap = 0.034;
    const hLogo = hasLogo ? (close ? 0.15 : 0.2) : 0;
    const hTitle = lineH(title.fontSize, title.lines);
    const hBar = 8 / REF_HEIGHT;
    const hTag = tag ? lineH(tag.fontSize, tag.lines) : 0;
    const hAction = action ? lineH(action.fontSize, 1) + 0.04 : 0;
    const hWhere = where ? lineH(where.fontSize, 1) : 0;
    const total = hLogo + (hLogo ? gap : 0) + hTitle + gap + hBar + (tag ? gap + hTag : 0) + (action ? gap * 1.6 + hAction : 0) + (where ? gap + hWhere : 0);
    let y = 0.5 - total / 2;
    const place = (h: number, before = 0): number => {
      y += before;
      const mid = y + h / 2;
      y += h;
      return mid;
    };
    const fade = { animOut: 'fade' as const, animOutDur: Math.min(0.2, length / 5) };
    if (hLogo) clips.push(...logoClip(from, to, place(hLogo), hLogo));
    made.push(textClip({ trackId: tracks.text, start: from, duration: length, ...type, text: evenLines(title.text), fontSize: title.fontSize, bold: true, color: onBackdrop, y: place(hTitle, hLogo ? gap : 0), animIn: 'stomp', animInDur: Math.min(0.3, length / 4), ...fade, motion: 'zoom-in', motionAmount: 0.4 }));
    const at = (delay: number): { start: number; duration: number } => ({ start: from + Math.min(delay, length / 2), duration: Math.max(MIN_CLIP, length - Math.min(delay, length / 2)) });
    made.push(rectClip({ trackId: tracks.text, ...at(0.18), fill: accent, x: 0.5, y: place(hBar, gap), w: refW(220), h: hBar, animIn: 'pop', animOut: 'fade' }));
    if (tag) made.push(textClip({ trackId: tracks.text, ...at(0.3), ...type, text: tag.text, fontSize: tag.fontSize, bold: false, color: onBackdrop, y: place(hTag, gap), animIn: 'fade', ...fade }));
    if (action) made.push(textClip({ trackId: tracks.text, ...at(0.55), ...type, text: action.text, fontSize: action.fontSize, bold: true, color: readableOn('#ffffff', accent), y: place(hAction, gap * 1.6), bgStyle: 'box', bgColor: accent, bgOpacity: 1, bgRadius: 16, bgPadding: 30, animIn: 'pop', ...fade }));
    if (where) made.push(textClip({ trackId: tracks.text, ...at(0.75), ...type, text: where.text, fontSize: where.fontSize, bold: true, color: onBackdrop, y: place(hWhere, gap), animIn: 'fade', ...fade }));
    // Small print (a disclaimer, the platforms) at the foot, out of the way of the rest.
    if (close?.note?.trim()) {
      const note = fitText(close.note.trim(), 28, palette.fontFamily, false, canvas, { widthFrac: 0.86, maxLines: 2 });
      made.push(textClip({ trackId: tracks.text, ...at(0.9), ...type, text: note.text, fontSize: note.fontSize, bold: false, color: onBackdrop, opacity: 0.7, y: 1 - 0.035 - lineH(note.fontSize, note.lines) / 2, animIn: 'fade', ...fade }));
    }
    return group(made, close ? 'endcard' : 'namecard');
  };

  const speak = (narr: Narration, at: number, caption: boolean): void => {
    clips.push(newMediaClip({ mediaId: narr.mediaId, trackId: tracks.narration, start: at, duration: narr.duration, inPoint: narr.inPoint ?? 0, sourceDuration: narr.sourceDuration ?? narr.duration }));
    for (const l of narr.lines) voiced.push([at + l.start, at + l.end]);
    if (!caption || !input.captions) return;
    const size = input.captions.patch.fontSize ?? 64;
    const max = clamp(Math.floor((canvas.width * 0.84) / (size * (canvas.height / REF_HEIGHT) * 0.56)), 14, 52);
    captionSegs.push(...captionSegments(narr.lines, max).map((s) => ({ ...s, start: at + s.start, end: at + s.end, words: s.words.map((w) => ({ ...w, start: at + w.start, end: at + w.end })) })));
  };

  // ── The opening lines ──
  const lines = splitSentences(script.hook ?? '');
  if (lines.length > TRAILER_MAX_LINES) notes.push(`the opening shows its first ${TRAILER_MAX_LINES} lines (${lines.length - TRAILER_MAX_LINES} left out): a trailer opens on a few words`);
  const opening = lines.slice(0, TRAILER_MAX_LINES);
  // What leans behind the lines: the pictures given for it, else the features' own recordings, one per line.
  const given = (script.hookVisuals ?? []).filter((v) => input.media.has(v.mediaId));
  const pool = given.length ? given : script.sections.flatMap((s) => s.visuals ?? []).filter((v) => input.media.has(v.mediaId));
  opening.forEach((line, i) => {
    const n = Math.min(span(0.9 + 0.3 * wordCount(line), 1.2), Math.max(2, Math.floor(3.6 / p)));
    const from = T(k);
    const to = T(k + n);
    // A full stop reads as a caption; the line is cleaner without it.
    const text = line.replace(/\.$/, '');
    if (pool.length) {
      const v = pool[i % pool.length];
      const info = input.media.get(v.mediaId)!;
      const share = fitShare(info);
      const wide = (portrait ? 1.5 : 1.18) / share.w;
      const side = i % 2 ? 1 : -1;
      const d = to - from;
      const hero = newMediaClip({ mediaId: v.mediaId, trackId: tracks.video, start: from, duration: d, inPoint: info.kind === 'video' ? clamp(v.inPoint ?? 0, 0, Math.max(0, info.duration - d)) : 0, sourceDuration: info.kind === 'video' ? info.duration : d, sourceWidth: info.width, sourceHeight: info.height, muted: true, opacity: 0.5, cornerRadius: 0.02, shadow: 0.6, animIn: 'fade', animInDur: Math.min(0.3, d / 3), fadeOut: Math.min(0.15, d / 4) });
      // Far over on its back and turned, drifting up: the app as a backdrop, not yet as the subject.
      clips.push(posed(hero, (tau) => {
        const r = clamp(tau / d, 0, 1);
        return { scale: wide * (1 + 0.05 * r), posX: side * (0.1 - 0.03 * r), posY: 0.1 - 0.1 * r, tiltX: 30 - 4 * r, tiltY: side * (-20 + 6 * r), rotation: side * (6 - 1.5 * r), crop: [0, 0, 0, 0] };
      }, 0, d, []));
      clips.push(...group([rectClip({ trackId: tracks.text, start: from, duration: d, fill: '#05060d', opacity: 0.38, w: 1.01, h: 1.01 }), ...slam(text, from, to, { size: 124 }).filter((c) => c.type === 'text').map((c) => ({ ...c, color: '#ffffff' }) as Clip)], 'slam'));
    } else clips.push(...slam(text, from, to, { size: 124 }));
    k += n;
  });

  // ── The name ──
  const reveal = T(k) - input.start;
  const nameBeats = span(f.introSeconds, 2);
  clips.push(...nameCard(T(k), T(k + nameBeats)));
  k += nameBeats;

  // ── The features ──
  const WIN = portrait ? { w: 0.9, h: 0.56, y: 0.57 } : { w: 0.84, h: 0.68, y: 0.575 };
  script.sections.forEach((s, i) => {
    const start = T(k);
    const narr = input.narration.sections[i];
    const visuals: LongformVisual[] = (s.visuals ?? []).filter((v) => input.media.has(v.mediaId));
    const callouts = (s.points ?? []).map((x) => x.trim()).filter(Boolean);
    const sub = s.text?.trim() && wordCount(s.text) <= 18 ? s.text.trim() : undefined;
    if (visuals.length === 0) {
      // No recording: the headline carries the beat by itself, its line (or its callouts) under it.
      const under = sub ?? (callouts.length ? callouts.slice(0, TRAILER_MAX_CALLOUTS).join('  ·  ') : undefined);
      const n = span(Math.max(1.3 + 0.28 * (wordCount(s.heading) + wordCount(under)), narr ? narr.duration + 0.5 : 0), 1.6);
      clips.push(...slam(s.heading, T(k), T(k + n), { sub: under, chapter: s.heading }));
      if (narr) speak(narr, T(k) + 0.15, true);
      k += n;
      sections.push({ heading: s.heading, start, speech: start, end: T(k), scene: 'text', pictures: 0 });
      return;
    }
    cuts.push(T(k) - input.start);

    // Its recording, in a window, the headline above it: the window comes in at an angle and turns to face the
    // viewer, then either moves in on what matters (a visual with a focus) or stays at a slight angle.
    const natural = visuals.reduce((n, v) => {
      const info = input.media.get(v.mediaId)!;
      return n + (info.kind === 'video' ? clamp(info.duration - (v.inPoint ?? 0), 1.5, 5.5) : 2.6);
    }, 0);
    const wanted = Math.max(clamp(s.seconds ?? Math.min(9, natural), 1.2, 30) + TRAILER_MOVE.enter, narr ? narr.duration + 0.6 : 0, callouts.length ? TRAILER_MOVE.enter + 0.9 + 0.8 * Math.min(callouts.length, TRAILER_MAX_CALLOUTS) : 0);
    const showBeats = span(wanted, 1.6);
    const from = T(k);
    const to = T(k + showBeats);
    const shown = visuals.slice(0, showBeats);
    if (shown.length < visuals.length) notes.push(`"${s.heading}": ${visuals.length - shown.length} of ${visuals.length} recordings left out (a beat each is the least; give it more seconds)`);
    let left = 0.5 - WIN.w / 2;
    let bottom = WIN.y + WIN.h / 2;
    shown.forEach((v, j) => {
      const info = input.media.get(v.mediaId)!;
      const a = T(k + Math.floor((showBeats * j) / shown.length));
      const b = T(k + Math.floor((showBeats * (j + 1)) / shown.length));
      const d = b - a;
      const share = fitShare(info);
      const scale = Math.min(WIN.w / share.w, WIN.h / share.h);
      if (j === 0) {
        left = 0.5 - (share.w * scale) / 2;
        bottom = WIN.y + (share.h * scale) / 2;
      }
      const side = entranceAt++ % 2 ? -1 : 1;
      const still = v.motion === 'none';
      const enter = Math.min(TRAILER_MOVE.enter, d / 2);
      // Moving in needs time to arrive and be looked at; without it the window just stays at its angle.
      const zoom = v.focus && !still && d >= enter + TRAILER_MOVE.zoom + 1.2 ? { x: clamp(v.focus.x, 0, 1), y: clamp(v.focus.y, 0, 1), by: clamp(v.focus.zoom ?? TRAILER_MOVE.by, 1.15, 3), at: clamp(enter + 0.38 * (d - enter), enter + 0.5, d - TRAILER_MOVE.zoom - 0.7) } : null;
      if (zoom) cuts.push(a + zoom.at + 0.3 - input.start);
      const pose = (tau: number): Pose => {
        if (still) return { scale, posX: 0, posY: WIN.y - 0.5, tiltX: 0, tiltY: 0, rotation: 0, crop: [0, 0, 0, 0] };
        const e = easeOut(clamp(tau / enter, 0, 1));
        const late = clamp((tau - enter) / Math.max(0.1, d - enter), 0, 1);
        const out: Pose = { scale: scale * (0.86 + 0.14 * e), posX: side * 0.07 * (1 - e), posY: WIN.y - 0.5 + 0.04 * (1 - e), tiltX: 10 * (1 - e), tiltY: side * 24 * (1 - e), rotation: -side * 2.5 * (1 - e), crop: [0, 0, 0, 0] };
        if (zoom) {
          const u = easeInOut(clamp((tau - zoom.at) / TRAILER_MOVE.zoom, 0, 1));
          const part = 1 / (1 + (zoom.by - 1) * u);
          const l = clamp(zoom.x - part / 2, 0, 1 - part);
          const t = clamp(zoom.y - part / 2, 0, 1 - part);
          out.crop = [l, t, 1 - part - l, 1 - part - t];
          out.scale *= 1 + 0.05 * u;
          out.tiltY -= side * 4 * u;
          out.tiltX += 2 * u;
        } else {
          out.tiltY += side * (9 - 4 * late) * e;
          out.tiltX += (4 - 1.5 * late) * e;
          out.scale *= 1 + 0.035 * late;
        }
        return out;
      };
      const moves: Array<[number, number]> = still ? [] : zoom ? [[0, enter], [zoom.at, zoom.at + TRAILER_MOVE.zoom]] : [[0, enter]];
      const base = { mediaId: v.mediaId, trackId: tracks.video, sourceWidth: info.width, sourceHeight: info.height, muted: true, cornerRadius: 0.025, shadow: 0.6, motion: 'none' as const };
      const fadeIn = { animIn: 'fade' as const, animInDur: Math.min(0.22, d / 3) };
      if (info.kind === 'image') {
        clips.push(posed(newMediaClip({ ...base, ...fadeIn, start: a, duration: d, sourceDuration: d }), pose, 0, d, moves));
        return;
      }
      // A recording shorter than its turn plays again.
      const inPoint = clamp(v.inPoint ?? 0, 0, Math.max(0, info.duration - MIN_CLIP));
      const avail = Math.max(MIN_CLIP, info.duration - inPoint);
      for (let at = a; at < b - MIN_CLIP; at += avail) {
        const len = Math.min(avail, b - at);
        clips.push(posed(newMediaClip({ ...base, ...(at === a ? fadeIn : {}), start: at, duration: len, inPoint, sourceDuration: info.duration }), pose, at - a, at - a + len, moves));
      }
    });
    const label: Clip[] = [];
    const boxed = input.backdropFree ? {} : { bgStyle: 'box' as const, bgColor: '#000000', bgOpacity: 0.55, bgRadius: 8, bgPadding: 12 };
    const head = fitText(up(s.heading), 58, palette.fontFamily, true, canvas, { widthFrac: 0.86, maxLines: portrait ? 2 : 1 });
    const hHead = lineH(head.fontSize, head.lines);
    const room = WIN.y - WIN.h / 2;
    const subFit = sub ? fitText(sub, 34, palette.fontFamily, false, canvas, { widthFrac: 0.8, maxLines: 1 }) : null;
    const hSub = subFit ? lineH(subFit.fontSize, 1) : 0;
    const topPad = Math.max(0.02, (room - hHead - (subFit ? hSub + 0.012 : 0)) / 2);
    label.push(textClip({ trackId: tracks.text, start: from, duration: to - from, ...type, text: head.text, fontSize: head.fontSize, bold: true, color: input.backdropFree ? onBackdrop : '#ffffff', y: topPad + hHead / 2, ...boxed, animIn: 'cascade', animInDur: clamp(0.3 + 0.06 * wordCount(s.heading), 0.35, 0.8), animOut: 'fade', animOutDur: 0.12 }));
    label[0].chapter = s.heading;
    if (subFit) label.push(textClip({ trackId: tracks.text, start: from + 0.2, duration: Math.max(MIN_CLIP, to - from - 0.2), ...type, text: subFit.text, fontSize: subFit.fontSize, bold: false, color: input.backdropFree ? onBackdrop : '#ffffff', opacity: 0.85, y: topPad + hHead + 0.012 + hSub / 2, ...boxed, animIn: 'fade', animOut: 'fade', animOutDur: 0.12 }));
    // Callouts pop up over the recording's lower left, one a beat or two apart.
    const tags = callouts.slice(0, TRAILER_MAX_CALLOUTS);
    if (callouts.length > tags.length) notes.push(`"${s.heading}": ${callouts.length - tags.length} of ${callouts.length} callouts left out (${TRAILER_MAX_CALLOUTS} fit over a recording)`);
    const lead = Math.max(1, Math.ceil(TRAILER_MOVE.enter / p - 1e-6));
    const step = Math.max(1, Math.floor((showBeats - lead) / Math.max(1, tags.length)));
    tags.forEach((tag, j) => {
      const at = T(Math.min(k + showBeats - 1, k + lead + j * step));
      if (to - at < 0.5) return;
      const fit = fitText(tag, 34, palette.fontFamily, true, canvas, { widthFrac: 0.5, maxLines: 1 });
      label.push(textClip({ trackId: tracks.text, start: at, duration: to - at, ...type, text: fit.text, fontSize: fit.fontSize, bold: true, color: readableOn('#ffffff', palette.accent), anchor: 'left', align: 'left', x: left + (portrait ? 0.04 : 0.025), y: bottom - 0.06 - (tags.length - 1 - j) * 0.078, bgStyle: 'box', bgColor: palette.accent, bgOpacity: 1, bgRadius: 10, bgPadding: 14, animIn: 'pop', animInDur: 0.2, animOut: 'fade', animOutDur: 0.12 }));
    });
    clips.push(...group(label, 'feature'));
    if (narr) speak(narr, from + 0.2, true);
    k += showBeats;
    cuts.push(T(k) - input.start);
    sections.push({ heading: s.heading, start, speech: from, end: T(k), scene: 'pictures', pictures: shown.length });
  });

  // ── The end card ──
  const close = T(k) - input.start;
  const outro = input.narration.outro;
  const endBeats = span(Math.max(f.outroSeconds, outro ? outro.duration + 1.4 : 0), 3);
  clips.push(...nameCard(T(k), T(k + endBeats), { action: script.outro?.title?.trim() || f.outroTitle, where: script.outro?.subtitle, note: script.outro?.note }));
  if (outro) speak(outro, T(k) + 0.5, false);
  k += endBeats;
  const end = T(k);

  // ── Captions (a voice-over's words) ──
  let captions = 0;
  if (input.captions && captionSegs.length) {
    const look = input.captions;
    const made = captionClipsFor(captionSegs, undefined, tracks.captions).map((c): TextClip => {
      const next: TextClip = { ...c, ...look.patch };
      if (look.upper) {
        next.text = next.text.toUpperCase();
        next.words = next.words?.map((w) => ({ ...w, text: w.text.toUpperCase() }));
      }
      return next;
    });
    captions = made.length;
    clips.push(...made);
  }

  // ── Music ──
  if (input.music && input.music.duration > 1) {
    const m = input.music;
    const settings = { ...DUCK, amountDb: clamp(m.duckDb, -40, -1) };
    const spans = duckSpans(voiced, settings);
    const bed: MediaClip[] = [];
    for (let at = input.start; at < end - 0.2; at += m.duration) bed.push(newMediaClip({ mediaId: m.mediaId, trackId: tracks.music, start: at, duration: Math.min(m.duration, end - at), sourceDuration: m.duration, volume: clamp(m.volume, 0, 2) }));
    bed.forEach((c, i) => {
      c.fadeIn = i === 0 ? 0 : Math.min(0.4, c.duration / 4);
      c.fadeOut = i === bed.length - 1 ? Math.min(1.6, c.duration / 3) : Math.min(0.4, c.duration / 4);
      c.keyframes = voiced.length ? (duckKeys(c, spans, settings) ?? []) : [];
    });
    if (bed.length > 1) notes.push(`the music is ${Math.round(m.duration)}s long, so it plays ${bed.length} times`);
    clips.push(...bed);
  }

  return {
    clips,
    start: input.start,
    end,
    sections,
    captions,
    fitted: false,
    backdrop: input.backdropFree ? backdrop : undefined,
    notes,
    score: { period: p, reveal, close, end: end - input.start, cuts },
  };
}

// ── The beat ───────────────────────────────────────────────────────────────
/** The built-in beat's tempo: 120 a minute, so a beat is half a second and a bar two. */
export const TRAILER_BPM = 120;
export const TRAILER_MUSIC_RATE = 44100;

/**
 * Music for one trailer, made to its cuts: soft chords and single notes with
 * an echo under the opening lines, rising into a hit as the name lands; then
 * a four-on-the-floor beat with an off-beat bass, held chords that breathe
 * with the kick, and a plucked line in eighths with an echo; a soft rush of
 * air where a recording comes in; and a last hit that rings out over the end
 * card. Made here rather than shipped as a file (as demo.ts makes its click),
 * so there is nothing to license and every trailer gets one that fits. Mono
 * samples, -1..1.
 *
 * Mixed to be heard on a phone: the bass and the kick have overtones well
 * above 100 Hz (a sine at 50 Hz is silence on a small speaker), and the
 * chords and the plucked line carry as much as the drums do.
 */
export function trailerMusic(score: TrailerScore, rate = TRAILER_MUSIC_RATE): Float32Array {
  const p = score.period;
  const total = score.end + 0.5;
  const n = Math.max(1, Math.ceil(total * rate));
  // Mixed in groups: what the kick pushes down (music), what it does not (drums, effects), and what is sent to
  // the echo and to the room.
  const drums = new Float32Array(n);
  const music = new Float32Array(n);
  const effects = new Float32Array(n);
  const echoed = new Float32Array(n);
  const room = new Float32Array(n);
  let seed = 0x9e3779b1;
  const noise = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x80000000 - 1;
  };
  const TAU = 2 * Math.PI;
  const top = rate * 0.45;
  const add = (bus: Float32Array, at: number, len: number, fn: (t: number) => number): void => {
    const start = Math.round(at * rate);
    const count = Math.round(len * rate);
    for (let i = Math.max(0, -start); i < count && start + i < n; i++) bus[start + i] += fn(i / rate);
  };
  // A minor, F, C, G: one bar each. The third is minor on the first chord only.
  const ROOT = [110, 87.31, 130.81, 98];
  const THIRD = [1.1892, 1.2599, 1.2599, 1.2599];
  const FIFTH = 1.4983;
  /** The notes of chord c from its root up: root, third, fifth, octave. */
  const chordTones = (c: number): number[] => [ROOT[c] * 2, ROOT[c] * 2 * THIRD[c], ROOT[c] * 2 * FIFTH, ROOT[c] * 4];

  /**
   * A note built from its overtones, each one quieter than the last and (with `dull`) dying sooner, the way a
   * plucked string loses its edge: `dull` is the seconds the second overtone takes to fall to a third.
   */
  const note = (bus: Float32Array, at: number, len: number, hz: number, gain: number, o: { overtones: number; slope?: number; dull?: number; attack?: number; decay?: number; release?: number; send?: number; echo?: number }): void => {
    const count = Math.max(1, Math.min(o.overtones, Math.floor(top / hz)));
    const slope = o.slope ?? 1;
    const attack = o.attack ?? 0.004;
    const release = o.release ?? 0.02;
    // Each overtone as a point going round a circle (its height is the sine), with its own level.
    const level = new Float64Array(count);
    const fall = new Float64Array(count);
    const re = new Float64Array(count);
    const im = new Float64Array(count);
    const cs = new Float64Array(count);
    const sn = new Float64Array(count);
    for (let h = 0; h < count; h++) {
      level[h] = 1 / Math.pow(h + 1, slope);
      fall[h] = o.dull && h ? Math.exp(-h / (o.dull * rate)) : 1;
      re[h] = Math.cos(h * 1.7);
      im[h] = Math.sin(h * 1.7);
      cs[h] = Math.cos((TAU * hz * (h + 1)) / rate);
      sn[h] = Math.sin((TAU * hz * (h + 1)) / rate);
    }
    const fade = o.decay ? Math.exp(-1 / (o.decay * rate)) : 1;
    let held = 1;
    const start = Math.round(at * rate);
    const samples = Math.round(len * rate);
    for (let i = Math.max(0, -start); i < samples && start + i < n; i++) {
      const t = i / rate;
      let s = 0;
      for (let h = 0; h < count; h++) {
        s += level[h] * im[h];
        const x = re[h] * cs[h] - im[h] * sn[h];
        im[h] = re[h] * sn[h] + im[h] * cs[h];
        re[h] = x;
        level[h] *= fall[h];
      }
      const v = gain * s * Math.min(1, t / attack) * held * Math.min(1, Math.max(0, len - t) / release);
      held *= fade;
      bus[start + i] += v;
      if (o.send) room[start + i] += o.send * v;
      if (o.echo) echoed[start + i] += o.echo * v;
    }
  };

  const kick = (at: number, gain: number): void => {
    let ph = 0;
    add(drums, at, 0.32, (t) => {
      // Falls from a knock to a thump; the knock is what a small speaker plays.
      ph += (TAU * (52 + 170 * Math.exp(-t / 0.035))) / rate;
      const body = Math.sin(ph) + 0.35 * Math.sin(2 * ph) * Math.exp(-t / 0.05);
      const click = t < 0.006 ? noise() * (1 - t / 0.006) * 0.5 : 0;
      return gain * (body * Math.exp(-t / 0.11) + click) * Math.min(1, t / 0.0015);
    });
  };
  const hat = (at: number, gain: number, len = 0.05): void => {
    let prev = 0;
    let prev2 = 0;
    add(drums, at, len, (t) => {
      // Noise with its lows taken off twice.
      const x = noise();
      const once = x - prev;
      prev = x;
      const twice = once - prev2;
      prev2 = once;
      return gain * 0.3 * twice * Math.exp(-t / (len * 0.3));
    });
  };
  const clap = (at: number, gain: number): void => {
    let low = 0;
    let lower = 0;
    const hit = (t: number): number => {
      // Noise kept to the middle (about 700 Hz to 3 kHz): three quick bursts, then the tail.
      const x = noise();
      low += (x - low) * 0.35;
      lower += (low - lower) * 0.08;
      const env = t < 0.03 ? Math.abs(Math.sin((t / 0.01) * Math.PI)) : Math.exp(-(t - 0.03) / 0.07);
      return gain * (low - lower) * env * 1.4;
    };
    add(drums, at, 0.3, hit);
    add(room, at, 0.3, (t) => 0.5 * hit(t));
  };
  const boom = (at: number, gain: number): void => {
    let ph = 0;
    let low = 0;
    add(effects, at, 2.2, (t) => {
      ph += (TAU * (44 + 110 * Math.exp(-t / 0.09))) / rate;
      low += (noise() - low) * 0.2;
      return gain * ((0.7 * Math.sin(ph) + 0.45 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.15 * Math.sin(5 * ph)) * Math.exp(-t / 0.45) + 0.6 * low * Math.exp(-t / 0.3)) * Math.min(1, t / 0.002);
    });
    // A cymbal's wash over it: bright noise that takes a second and a half to go.
    let prev = 0;
    add(effects, at, 2.2, (t) => {
      const x = noise();
      const high = x - prev;
      prev = x;
      return gain * 0.2 * high * Math.exp(-t / 0.5) * Math.min(1, t / 0.004);
    });
  };
  const whoosh = (at: number, gain: number): void => {
    const len = 0.45;
    let low = 0;
    let lower = 0;
    add(effects, at - 0.32, len, (t) => {
      // Air, not hiss: the middle of the noise, brighter as it passes.
      low += (noise() - low) * (0.05 + 0.3 * (t / len));
      lower += (low - lower) * 0.03;
      const env = Math.sin(Math.PI * Math.min(1, t / len));
      return gain * (low - lower) * env * env;
    });
  };
  const riser = (at: number, len: number, gain: number): void => {
    let low = 0;
    let lower = 0;
    add(effects, at, len, (t) => {
      const u = t / len;
      low += (noise() - low) * (0.03 + 0.45 * u * u);
      lower += (low - lower) * 0.02;
      return gain * u * u * (low - lower);
    });
  };

  const revealBeat = Math.round(score.reveal / p);
  const closeBeat = Math.max(revealBeat, Math.round(score.close / p));
  const endBeat = Math.ceil(score.end / p);

  // Under the opening lines: a held chord, a low note under it, and one plucked note a beat, echoing.
  for (let b = 0; b < revealBeat; b += 4) {
    const chord = (b / 4) % 4;
    const len = Math.min(4, revealBeat - b) * p;
    for (const hz of chordTones(chord)) for (const off of [0.997, 1.003]) note(music, b * p, len, hz * off, 0.04, { overtones: 8, slope: 1.15, attack: 0.3, release: 0.3, send: 0.5 });
    note(music, b * p, len, ROOT[chord], 0.07, { overtones: 5, slope: 1.1, attack: 0.05, release: 0.2 });
  }
  for (let b = 0; b < revealBeat; b++) {
    const tones = chordTones(Math.floor(b / 4) % 4);
    note(music, b * p, 0.5, tones[[0, 2, 3, 2][b % 4]] * 2, 0.15, { overtones: 8, dull: 0.14, decay: 0.2, echo: 0.7, send: 0.4 });
  }
  if (revealBeat >= 2) riser(Math.max(0, score.reveal - Math.min(revealBeat, 6) * p), Math.min(revealBeat, 6) * p, 0.5);

  // The name lands; the beat runs until the end card.
  boom(score.reveal, 0.8);
  for (const hz of chordTones(0)) note(effects, score.reveal, 1.6, hz * 2, 0.07, { overtones: 10, dull: 0.3, decay: 0.5, send: 0.8 });
  const ARP = [
    [0, 2, 3, 2, 1, 2, 3, 2],
    [3, 2, 1, 2, 0, 2, 1, 2],
  ];
  const kicks: number[] = [];
  for (let b = revealBeat; b < closeBeat; b++) {
    const inBar = (b - revealBeat) % 4;
    const bar = Math.floor((b - revealBeat) / 4);
    const chord = bar % 4;
    const at = b * p;
    const tones = chordTones(chord);
    if (inBar === 0) {
      const len = Math.min(4, closeBeat - b) * p;
      for (const hz of tones) for (const off of [0.997, 1.003]) note(music, at, len, hz * off, 0.05, { overtones: 8, slope: 1.15, attack: 0.08, release: 0.25, send: 0.4 });
    }
    kick(at, 0.62);
    kicks.push(at);
    if (inBar === 1 || inBar === 3) clap(at, 0.8);
    hat(at + p / 2, 0.6);
    hat(at + p / 4, 0.2, 0.03);
    hat(at + (3 * p) / 4, 0.2, 0.03);
    // The bass answers the kick on the off-beat: the root, an octave above where it would only be felt.
    note(music, at + p / 2, p * 0.46, ROOT[chord], 0.16, { overtones: 10, slope: 0.9, dull: 0.25, attack: 0.005, release: 0.04 });
    note(music, at + p / 2, p * 0.46, ROOT[chord] / 2, 0.07, { overtones: 2, attack: 0.005, release: 0.04 });
    // Up the chord and back in eighths, the second of each pair softer.
    const line = ARP[Math.floor(bar / 4) % 2];
    for (let e = 0; e < 2; e++) note(music, at + (e * p) / 2, p * 0.5, tones[line[inBar * 2 + e]] * 2, e ? 0.11 : 0.16, { overtones: 8, dull: 0.12, decay: 0.16, echo: 0.6, send: 0.3 });
  }
  for (const c of score.cuts) if (c > score.reveal + 0.2 && c < score.close - 0.05) whoosh(c, 0.3);

  // The end card: a last hit, the first chord held, a few slow notes.
  if (score.close > score.reveal) boom(score.close, 0.8);
  const tail = Math.max(0.5, total - score.close);
  for (const hz of chordTones(0)) for (const off of [0.997, 1.003]) note(music, score.close, tail, hz * off, 0.05, { overtones: 8, slope: 1.15, attack: 0.25, release: Math.min(1.6, tail * 0.6), send: 0.5 });
  note(music, score.close, tail, ROOT[0], 0.07, { overtones: 5, slope: 1.1, attack: 0.05, release: Math.min(1.6, tail * 0.6) });
  for (let b = closeBeat; b < endBeat - 1; b += 2) note(music, b * p, 0.9, ROOT[0] * 4 * [1, FIFTH, 2, THIRD[0] * 2][((b - closeBeat) / 2) % 4], 0.16, { overtones: 8, dull: 0.16, decay: 0.3, echo: 0.7, send: 0.5 });

  // The echo: three quarters of a beat behind, each repeat duller and quieter.
  const gap = Math.max(1, Math.round(0.75 * p * rate));
  let damp = 0;
  for (let i = gap; i < n; i++) {
    damp += (echoed[i - gap] - damp) * 0.45;
    echoed[i] += damp * 0.42;
  }
  // The room: four echoes too close together to hear apart, fed back, then smeared twice.
  const wet = new Float32Array(n);
  for (const [seconds, back] of [[0.0297, 0.78], [0.0371, 0.8], [0.0411, 0.81], [0.0437, 0.82]] as const) {
    const d = Math.max(1, Math.round(seconds * rate));
    const line = new Float32Array(n);
    let soft = 0;
    for (let i = 0; i < n; i++) {
      const fed = i >= d ? line[i - d] : 0;
      soft += (fed - soft) * 0.5;
      line[i] = room[i] + echoed[i] * 0.3 + soft * back;
      wet[i] += fed * 0.25;
    }
  }
  for (const seconds of [0.0051, 0.0126]) {
    const d = Math.max(1, Math.round(seconds * rate));
    const kept = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const delayed = i >= d ? kept[i - d] : 0;
      const x = wet[i];
      kept[i] = x + delayed * 0.5;
      wet[i] = delayed - (x + delayed * 0.5) * 0.5;
    }
  }
  // The chords, the bass and the plucked line dip as each kick lands and come back before the next.
  const duck = new Float32Array(n).fill(1);
  for (const at of kicks) {
    const start = Math.round(at * rate);
    const count = Math.round(0.4 * rate);
    for (let i = 0; i < count && start + i < n; i++) duck[start + i] = Math.min(duck[start + i], 1 - 0.4 * Math.exp(-i / rate / 0.1));
  }

  // Kept under full scale, loud passages rounded off rather than clipped, and the end faded.
  const out = new Float32Array(n);
  const fadeFrom = Math.max(0, n - Math.round(0.4 * rate));
  for (let i = 0; i < n; i++) {
    const mixed = drums[i] + effects[i] + (music[i] + echoed[i] * 0.55 + wet[i] * 0.55) * duck[i];
    const v = Math.tanh(mixed * 1.25) * 0.82;
    out[i] = i >= fadeFrom ? (v * (n - i)) / (n - fadeFrom) : v;
  }
  return out;
}
