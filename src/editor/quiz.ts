import { duckKeys, duckSpans, DUCK } from './ducking';
import type { Range } from './autoEdit';
import { buildCard, buildStinger, cardPalette, fitText, readableOn, rectClip, spacedCaps, textClip, type CardText } from './scenes';
import type { CardLook } from './styles';
import { MIN_CLIP, REF_HEIGHT, newMediaClip, uid, type Canvas, type Clip, type Keyframe, type MediaClip } from './timelineStore';
import type { LongformFormat, LongformPlan, LongformScript, Narration, PlannedSection, VisualInfo } from './longform';

/**
 * A quiz to play along with. Each question is read out and shown with its
 * answers; a bar runs down while a clock ticks; then the right answer lights
 * up, the others dim, and a line about it is said. A picture, when the
 * question has one, sits beside it.
 *
 * Pure, like longform.ts: the caller (agentTools.ts) has spoken the questions
 * and the lines, made the sounds and probed the pictures.
 */

export interface QuizInput {
  /** sections = the questions: heading = the question, options, answer (index), text = the line said once it is shown. */
  script: LongformScript;
  format: LongformFormat;
  canvas: Canvas;
  narration: { hook?: Narration; questions: Array<Narration | undefined>; reveals: Array<Narration | undefined>; outro?: Narration };
  media: Map<string, VisualInfo>;
  card: { look: CardLook; background?: string; accent?: string };
  cardText?: CardText;
  /** The countdown, seconds. */
  think: number;
  /** The clock (one file, as long as the countdown) and the chime on the answer. */
  sounds?: { ticks?: { mediaId: string; duration: number }; ding?: { mediaId: string; duration: number } };
  music?: { mediaId: string; duration: number; volume: number; duckDb: number };
  start: number;
  tracks: { video: string; narration: string; music: string; fx: string; text: string };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** The right answer: the same green in every style, dark type on it. */
export const QUIZ_RIGHT = '#16A34A';
const ON_RIGHT = '#ffffff'; // every text has a soft dark shadow, so white reads on the green and dark text looks smudged
export const QUIZ_MAX_OPTIONS = 4;
const LETTERS = ['A', 'B', 'C', 'D'];

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where everything sits (fractions of the frame): wide or tall, with a picture or without. */
export function quizLayout(canvas: Canvas, picture: boolean, options: number): { kicker: { x: number; y: number }; question: { x: number; y: number; width: number; size: number; lines: number }; boxes: Box[]; picture?: Box; foot: number; type: number; badge: number } {
  const portrait = canvas.height > canvas.width;
  const n = clamp(options, 2, QUIZ_MAX_OPTIONS);
  if (portrait) {
    const top = picture ? 0.535 : 0.44;
    const step = picture ? 0.088 : 0.098;
    return {
      kicker: { x: 0.5, y: picture ? 0.05 : 0.09 },
      question: { x: 0.5, y: picture ? 0.405 : 0.24, width: 0.86, size: picture ? 58 : 70, lines: picture ? 3 : 4 },
      boxes: Array.from({ length: n }, (_, i) => ({ x: 0.5, y: top + i * step, w: 0.86, h: step - 0.016 })),
      picture: picture ? { x: 0.5, y: 0.2, w: 0.84, h: 0.23 } : undefined,
      foot: picture ? 0.915 : 0.88,
      type: 38,
      badge: 0.11,
    };
  }
  if (picture) {
    const step = 0.112;
    const top = 0.5 - ((n - 1) * step) / 2 + 0.1;
    return {
      kicker: { x: 0.275, y: 0.085 },
      question: { x: 0.275, y: 0.24, width: 0.45, size: 54, lines: 4 },
      boxes: Array.from({ length: n }, (_, i) => ({ x: 0.275, y: top + i * step, w: 0.45, h: step - 0.02 })),
      picture: { x: 0.75, y: 0.47, w: 0.42, h: 0.66 },
      foot: 0.93,
      type: 36,
      badge: 0.055,
    };
  }
  // Two by two; three puts the third in the middle of the second row; two share one row.
  const rows = n > 2 ? [0.56, 0.72] : [0.62];
  const cell = (i: number): Box => ({ x: n === 3 && i === 2 ? 0.5 : 0.5 + (i % 2 === 0 ? -0.2 : 0.2), y: rows[Math.floor(i / 2)], w: 0.38, h: 0.13 });
  return {
    kicker: { x: 0.5, y: 0.1 },
    question: { x: 0.5, y: 0.29, width: 0.82, size: 74, lines: 3 },
    boxes: Array.from({ length: n }, (_, i) => cell(i)),
    foot: 0.9,
    type: 40,
    badge: 0.06,
  };
}

/** What the narrator says once the answer is shown: the answer, then the line about it. */
export function revealLine(answer: string, text: string | undefined): string {
  const a = answer.trim().replace(/[.!?]+$/, '');
  const rest = text?.trim() ?? '';
  // A line that already opens with the answer does not say it twice.
  return rest.toLowerCase().startsWith(a.toLowerCase()) ? rest : `${a}.${rest ? ` ${rest}` : ''}`;
}

/** Which option is meant: its number (1-based), its letter, or its text. -1 when none is. */
export function answerIndex(answer: unknown, options: string[]): number {
  if (typeof answer === 'number' && Number.isInteger(answer)) return answer >= 1 && answer <= options.length ? answer - 1 : -1;
  const a = String(answer ?? '').trim();
  if (!a) return -1;
  const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const exact = options.findIndex((o) => norm(o) === norm(a));
  if (exact >= 0) return exact;
  const letter = /^\(?([a-d])\)?[.):]?$/i.exec(a);
  if (letter) {
    const i = letter[1].toLowerCase().charCodeAt(0) - 97;
    return i < options.length ? i : -1;
  }
  if (/^\d$/.test(a)) return Number(a) >= 1 && Number(a) <= options.length ? Number(a) - 1 : -1;
  // "B) Rome", or part of an option's text that only one option has.
  const lettered = /^\(?([a-d])[.):]\s+(.+)$/i.exec(a);
  if (lettered) return answerIndex(lettered[2], options) >= 0 ? answerIndex(lettered[2], options) : answerIndex(lettered[1], options);
  const part = options.map((o, i) => (norm(o).includes(norm(a)) || norm(a).includes(norm(o)) ? i : -1)).filter((i) => i >= 0);
  return part.length === 1 ? part[0] : -1;
}

export function planQuiz(input: QuizInput): LongformPlan {
  const { script, format: f, canvas, tracks } = input;
  const clips: Clip[] = [];
  const notes: string[] = [];
  const voiced: Range[] = [];
  const sections: PlannedSection[] = [];
  const palette = cardPalette(input.card.look, { background: input.card.background, accent: input.card.accent, text: input.cardText });
  const cardBase = { look: input.card.look, canvas, trackId: tracks.text, background: input.card.background, accent: input.card.accent, text: input.cardText };
  const type = { fontFamily: palette.fontFamily, italic: input.cardText?.italic ?? false };
  const dark = readableOn('#ffffff', palette.background) === '#ffffff';
  const boxFill = dark ? '#ffffff' : '#000000';
  const lineH = (size: number, lines: number): number => (lines * size * 1.18) / REF_HEIGHT;
  const think = clamp(input.think, 2, 20);
  let t = input.start;

  const group = (made: Clip[], kind: string): Clip[] => {
    const id = uid(kind);
    for (const c of made) c.group = id;
    return made;
  };
  const speak = (narr: Narration, at: number): void => {
    clips.push(newMediaClip({ mediaId: narr.mediaId, trackId: tracks.narration, start: at, duration: narr.duration, inPoint: narr.inPoint ?? 0, sourceDuration: narr.sourceDuration ?? narr.duration }));
    for (const l of narr.lines) voiced.push([at + l.start, at + l.end]);
  };

  /** The background of a question: the whole frame, or a frame around the picture so it shows through. */
  const ground = (from: number, to: number, hole?: Box): Clip[] => {
    const base = { trackId: tracks.text, start: from, duration: to - from, fill: palette.background };
    if (!hole) return [rectClip({ ...base, w: 1.01, h: 1.01 })];
    const l = hole.x - hole.w / 2;
    const r = hole.x + hole.w / 2;
    const u = hole.y - hole.h / 2;
    const d = hole.y + hole.h / 2;
    // Four pieces, each a hair over the picture's edge so no line of the project's background shows between them.
    const lap = 0.002;
    return [
      rectClip({ ...base, x: (l + lap) / 2, y: 0.5, w: l + lap + 0.01, h: 1.01 }),
      rectClip({ ...base, x: (r - lap + 1) / 2, y: 0.5, w: 1 - r + lap + 0.01, h: 1.01 }),
      rectClip({ ...base, x: (l + r) / 2, y: (u + lap) / 2, w: r - l + 0.01, h: u + lap + 0.01 }),
      rectClip({ ...base, x: (l + r) / 2, y: (d - lap + 1) / 2, w: r - l + 0.01, h: 1 - d + lap + 0.01 }),
    ];
  };

  // ── Opening: the title, the rules said over it ──
  const hook = input.narration.hook;
  const introLength = Math.max(f.introSeconds, hook ? hook.duration + 0.9 : 0);
  clips.push(...buildCard({ ...cardBase, title: script.title, subtitle: script.subtitle, kicker: `${script.sections.length} questions`, start: t, duration: introLength }).clips);
  if (hook) speak(hook, t + 0.4);
  t += introLength;

  // ── The questions ──
  const count = script.sections.length;
  script.sections.forEach((s, i) => {
    const options = (s.options ?? []).slice(0, QUIZ_MAX_OPTIONS);
    const right = clamp(s.answer ?? 0, 0, Math.max(0, options.length - 1));
    const asked = input.narration.questions[i];
    const said = input.narration.reveals[i];
    const visual = (s.visuals ?? []).find((v) => input.media.has(v.mediaId));
    const info = visual ? input.media.get(visual.mediaId) : undefined;
    const lay = quizLayout(canvas, !!info, options.length);
    const start = t;
    // Read out, then the countdown, then the answer and the line about it.
    const countFrom = start + 0.3 + (asked ? asked.duration + 0.3 : 1.2);
    const showAt = countFrom + think;
    const end = showAt + Math.max(2.4, said ? 0.4 + said.duration + 0.7 : 0);
    if (i > 0 && f.stinger) clips.push(...buildStinger({ at: start, direction: 'right', colors: [palette.accent, palette.background], sweep: 0.24, canvas, trackId: tracks.text }).clips);

    // The picture, whole, in its place; the background is built around it.
    let hole: Box | undefined;
    if (visual && info && lay.picture) {
      const fit = Math.min(canvas.width / info.width, canvas.height / info.height);
      const w0 = (info.width * fit) / canvas.width;
      const h0 = (info.height * fit) / canvas.height;
      const scale = Math.min(lay.picture.w / w0, lay.picture.h / h0);
      hole = { x: lay.picture.x, y: lay.picture.y, w: w0 * scale, h: h0 * scale };
      const base = { mediaId: visual.mediaId, trackId: tracks.video, sourceWidth: info.width, sourceHeight: info.height, scaleX: scale, scaleY: scale, posX: hole.x - 0.5, posY: hole.y - 0.5, muted: true };
      if (info.kind === 'image') clips.push(newMediaClip({ ...base, start, duration: end - start, sourceDuration: end - start }));
      else {
        const inPoint = clamp(visual.inPoint ?? 0, 0, Math.max(0, info.duration - MIN_CLIP));
        const avail = Math.max(MIN_CLIP, info.duration - inPoint);
        for (let at = start; at < end - MIN_CLIP; at += avail) clips.push(newMediaClip({ ...base, start: at, duration: Math.min(avail, end - at), inPoint, sourceDuration: info.duration }));
      }
    }
    const made: Clip[] = ground(start, end, hole);
    made[0].chapter = `${i + 1}. ${s.heading}`;

    const whole = { trackId: tracks.text, start: start + 0.1, duration: end - start - 0.1 };
    made.push(textClip({ ...whole, ...type, text: spacedCaps(`Question ${i + 1} of ${count}`), fontSize: 28, bold: true, color: palette.accent, x: lay.kicker.x, y: lay.kicker.y, animIn: 'fade', animOut: 'fade', animOutDur: 0.15 }));
    const q = fitText(s.heading, lay.question.size, palette.fontFamily, true, canvas, { widthFrac: lay.question.width, maxLines: lay.question.lines });
    made.push(textClip({ ...whole, ...type, text: q.text, fontSize: q.fontSize, bold: true, color: palette.color, x: lay.question.x, y: lay.question.y, animIn: 'slide', animInDur: 0.3, animOut: 'fade', animOutDur: 0.15 }));

    // The answers: as asked until the countdown ends, then the right one lit and the others dimmed.
    options.forEach((option, j) => {
      const b = lay.boxes[j];
      const left = b.x - b.w / 2;
      const textLeft = left + lay.badge;
      const fit = fitText(option, lay.type, palette.fontFamily, true, canvas, { widthFrac: b.w - lay.badge - 0.02, maxLines: 2 });
      const comes = start + 0.35 + j * 0.22;
      const before = { trackId: tracks.text, start: comes, duration: Math.max(MIN_CLIP, showAt - comes) };
      const after = { trackId: tracks.text, start: showAt, duration: end - showAt };
      const label = { ...type, text: fit.text, fontSize: fit.fontSize, bold: true, anchor: 'left' as const, align: 'left' as const, x: textLeft, y: b.y };
      const letter = { ...type, fontSize: lay.type, bold: true, x: left + lay.badge / 2, y: b.y };
      made.push(rectClip({ ...before, fill: boxFill, opacity: 0.1, x: b.x, y: b.y, w: b.w, h: b.h, animIn: 'pop' }));
      made.push(textClip({ ...before, ...letter, text: LETTERS[j], color: palette.accent, animIn: 'fade' }));
      made.push(textClip({ ...before, ...label, color: palette.color, animIn: 'fade' }));
      if (j === right) {
        made.push(rectClip({ ...after, fill: QUIZ_RIGHT, x: b.x, y: b.y, w: b.w, h: b.h, animIn: 'pop', animOut: 'fade' }));
        made.push(textClip({ ...after, ...letter, text: '✓', color: ON_RIGHT, animIn: 'pop', animOut: 'fade', animOutDur: 0.15 }));
        made.push(textClip({ ...after, ...label, color: ON_RIGHT, animOut: 'fade', animOutDur: 0.15 }));
      } else {
        made.push(rectClip({ ...after, fill: boxFill, opacity: 0.04, x: b.x, y: b.y, w: b.w, h: b.h, animOut: 'fade' }));
        made.push(textClip({ ...after, ...letter, text: LETTERS[j], color: palette.color, opacity: 0.3, animOut: 'fade', animOutDur: 0.15 }));
        made.push(textClip({ ...after, ...label, color: palette.color, opacity: 0.3, animOut: 'fade', animOutDur: 0.15 }));
      }
    });

    // The countdown: a bar that runs down (a cover in the background's colour slides over it) and the seconds beside it.
    const barW = hole && canvas.width >= canvas.height ? 0.36 : 0.5;
    const barX = hole && canvas.width >= canvas.height ? lay.question.x : 0.5;
    const bar = { trackId: tracks.text, start: countFrom, duration: think, y: lay.foot, h: 12 / REF_HEIGHT };
    const slide: Keyframe[] = [
      { id: uid('k'), prop: 'x', t: 0, value: barX + barW },
      { id: uid('k'), prop: 'x', t: think, value: barX },
    ];
    made.push(rectClip({ ...bar, fill: palette.accent, x: barX, w: barW, fadeIn: 0.15 }));
    made.push(rectClip({ ...bar, fill: palette.background, x: barX + barW, w: barW + 0.004, h: 20 / REF_HEIGHT, keyframes: slide }));
    for (let n = Math.ceil(think); n >= 1; n--) {
      const at = showAt - n;
      if (at < countFrom - 1e-6) continue;
      made.push(textClip({ trackId: tracks.text, start: at, duration: 1, ...type, text: String(n), fontSize: 44, bold: true, color: palette.color, x: barX - barW / 2 - 0.035, y: lay.foot, animIn: 'pop', animInDur: 0.15 }));
    }
    // The line about the answer, where the countdown was.
    if (s.text?.trim()) {
      const line = fitText(s.text.trim(), 36, palette.fontFamily, false, canvas, { widthFrac: hole && canvas.width >= canvas.height ? 0.5 : 0.84, maxLines: 2 });
      const at = showAt + 0.35;
      if (end - at > 0.8) made.push(textClip({ trackId: tracks.text, start: at, duration: end - at, ...type, text: line.text, fontSize: line.fontSize, bold: false, color: palette.color, x: barX, y: Math.min(lay.foot, 1 - lineH(line.fontSize, line.lines) / 2 - 0.02), animIn: 'fade', animOut: 'fade', animOutDur: 0.15 }));
    }
    clips.push(...group(made, 'question'));

    if (asked) speak(asked, start + 0.3);
    if (said) speak(said, showAt + 0.4);
    const fx = (sound: { mediaId: string; duration: number } | undefined, at: number, volume: number): void => {
      if (sound) clips.push(newMediaClip({ mediaId: sound.mediaId, trackId: tracks.fx, start: at, duration: sound.duration, sourceDuration: sound.duration, volume }));
    };
    fx(input.sounds?.ticks, countFrom, 0.7);
    fx(input.sounds?.ding, showAt, 0.8);
    if (options.length < 2) notes.push(`"${s.heading}" has fewer than two answers`);
    t = end;
    sections.push({ heading: s.heading, start, speech: start + 0.3, end, scene: info ? 'pictures' : 'text', pictures: info ? 1 : 0 });
  });

  // ── Close ──
  const outro = input.narration.outro;
  const outroLength = Math.max(f.outroSeconds, outro ? outro.duration + 1 : 0);
  clips.push(...buildCard({ ...cardBase, title: script.outro?.title?.trim() || f.outroTitle, subtitle: script.outro?.subtitle, start: t, duration: outroLength }).clips);
  if (outro) speak(outro, t + 0.4);
  t += outroLength;
  const end = t;

  // ── Music ──
  if (input.music && input.music.duration > 1) {
    const m = input.music;
    const settings = { ...DUCK, amountDb: clamp(m.duckDb, -40, -1) };
    const spans = duckSpans(voiced, settings);
    const bed: MediaClip[] = [];
    for (let at = input.start; at < end - 0.2; at += m.duration) bed.push(newMediaClip({ mediaId: m.mediaId, trackId: tracks.music, start: at, duration: Math.min(m.duration, end - at), sourceDuration: m.duration, volume: clamp(m.volume, 0, 2) }));
    bed.forEach((c, i) => {
      c.fadeIn = i === 0 ? Math.min(1, c.duration / 4) : Math.min(0.4, c.duration / 4);
      c.fadeOut = i === bed.length - 1 ? Math.min(2.5, c.duration / 3) : Math.min(0.4, c.duration / 4);
      c.keyframes = duckKeys(c, spans, settings) ?? [];
    });
    if (bed.length > 1) notes.push(`the music is ${Math.round(m.duration)}s long, so it plays ${bed.length} times`);
    clips.push(...bed);
  }

  return { clips, start: input.start, end, sections, captions: 0, fitted: false, notes };
}

// ── The sounds ─────────────────────────────────────────────────────────────
export const QUIZ_SOUND_RATE = 44100;

/**
 * The clock under a countdown: a tick a second, a little higher and twice as
 * often in the last second. Made here (as demo.ts makes its click), so there
 * is nothing to license. Mono samples, -1..1.
 */
export function quizTicks(seconds: number, rate = QUIZ_SOUND_RATE): Float32Array {
  const out = new Float32Array(Math.max(1, Math.round(seconds * rate)));
  const tick = (at: number, hz: number, gain: number): void => {
    const from = Math.round(at * rate);
    for (let i = 0; from + i < out.length && i < rate * 0.09; i++) {
      const t = i / rate;
      out[from + i] += gain * Math.min(1, t / 0.0008) * (Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / 0.012) + 0.4 * Math.sin(2 * Math.PI * hz * 2.76 * t) * Math.exp(-t / 0.006));
    }
  };
  const whole = Math.floor(seconds + 1e-6);
  for (let n = 0; n < whole; n++) {
    const last = n === whole - 1;
    tick(seconds - whole + n, last ? 1250 : 1000, 0.6);
    if (last) tick(seconds - whole + n + 0.5, 1250, 0.6);
  }
  return out;
}

/** The chime on the right answer: three notes of a major chord, quickly, ringing out. */
export function quizDing(rate = QUIZ_SOUND_RATE): Float32Array {
  const out = new Float32Array(Math.round(1.3 * rate));
  [1046.5, 1318.5, 1568].forEach((hz, k) => {
    const from = Math.round(k * 0.07 * rate);
    for (let i = 0; from + i < out.length; i++) {
      const t = i / rate;
      out[from + i] += 0.3 * Math.min(1, t / 0.002) * (Math.sin(2 * Math.PI * hz * t) + 0.3 * Math.sin(2 * Math.PI * hz * 2 * t) * Math.exp(-t / 0.1)) * Math.exp(-t / 0.32);
    }
  });
  const fadeFrom = out.length - Math.round(0.05 * rate);
  for (let i = fadeFrom; i < out.length; i++) out[i] *= (out.length - i) / (out.length - fadeFrom);
  return out;
}
