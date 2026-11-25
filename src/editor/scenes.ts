import { FONTS, MIN_CLIP, REF_HEIGHT, sliceClip, sourceTimeAt, uid, type Canvas, type Clip, type Keyframe, type MediaClip, type MotionAnim, type ShapeClip, type TextAnim, type TextClip, type Track, type TransitionType } from './timelineStore';
import type { CardLook } from './styles';

/**
 * What goes between scenes: title cards (intro / chapter / outro screens),
 * stingers (colour panels that sweep across to cover a cut) and transitions
 * placed on every cut at once. All of it is built from ordinary clips — a
 * full-frame shape, text, keyframes — so it renders through the same preview
 * and export paths as everything else and stays editable by hand afterwards.
 */

// ── Text fitting ───────────────────────────────────────────────────────────
// The export draws text exactly as broken (no auto-wrap), so cards break their
// own lines and size the type to the frame. Widths are estimated from an
// average glyph width per typeface; the margin left absorbs the error.
const GLYPH: Array<[RegExp, number]> = [
  [/impact/i, 0.46],
  [/press start/i, 1.02],
  [/courier|mono/i, 0.6],
  [/verdana/i, 0.6],
  [/georgia|times/i, 0.52],
  [/comic/i, 0.56],
];

function glyphWidth(fontFamily: string, bold: boolean): number {
  const base = GLYPH.find(([re]) => re.test(fontFamily))?.[1] ?? 0.54;
  return bold ? base * 1.06 : base;
}

/** Roughly how many average glyphs a string takes (capitals and wide letters count for more). */
function glyphs(s: string): number {
  let n = 0;
  for (const ch of s) n += /[A-ZMW@#%&]/.test(ch) ? 1.18 : /[  .,:;!'|il]/.test(ch) ? 0.5 : 1;
  return n;
}

function wrap(text: string, maxGlyphs: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && glyphs(next) > maxGlyphs) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/**
 * Break `text` into at most `maxLines` lines that fit `widthFrac` of the frame,
 * shrinking the type from `size` (px at the 1080 reference height) until it does.
 */
export function fitText(text: string, size: number, fontFamily: string, bold: boolean, canvas: Canvas, opts: { widthFrac?: number; maxLines?: number; spread?: number } = {}): { text: string; fontSize: number; lines: number } {
  const widthFrac = opts.widthFrac ?? 0.84;
  const maxLines = opts.maxLines ?? 3;
  const perGlyph = glyphWidth(fontFamily, bold) * (opts.spread ?? 1);
  const avail = canvas.width * widthFrac;
  let fontSize = size;
  for (;;) {
    const px = fontSize * (canvas.height / REF_HEIGHT);
    const lines = wrap(text, avail / (px * perGlyph));
    const fits = lines.length <= maxLines && lines.every((l) => glyphs(l) * px * perGlyph <= avail * 1.02);
    if (fits || fontSize <= 26) return { text: lines.join('\n'), fontSize: Math.round(fontSize), lines: lines.length };
    fontSize *= 0.92;
  }
}

// ── Colour ─────────────────────────────────────────────────────────────────
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** `color` if it reads on `bg`, else black or white, whichever does. */
export function readableOn(color: string, bg: string): string {
  const a = luminance(color);
  const b = luminance(bg);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return ratio >= 3 ? color : b > 0.35 ? '#111111' : '#ffffff';
}

// ── Clip factories ─────────────────────────────────────────────────────────
export function textClip(over: Partial<TextClip> & Pick<TextClip, 'trackId' | 'start' | 'duration' | 'text'>): TextClip {
  return {
    type: 'text',
    id: uid('t'),
    fadeIn: 0,
    fadeOut: 0,
    fontSize: 80,
    fontFamily: FONTS[0].value,
    color: '#ffffff',
    bold: true,
    italic: false,
    outlineWidth: 0,
    outlineColor: '#000000',
    glow: 0,
    glowColor: '#a855f7',
    bgStyle: 'none',
    bgColor: '#000000',
    bgOpacity: 0.6,
    bgRadius: 10,
    bgPadding: 16,
    align: 'center',
    x: 0.5,
    y: 0.5,
    animIn: 'none',
    animOut: 'none',
    keyframes: [],
    ...over,
  };
}

export function rectClip(over: Partial<ShapeClip> & Pick<ShapeClip, 'trackId' | 'start' | 'duration' | 'fill'>): ShapeClip {
  return {
    type: 'shape',
    id: uid('s'),
    fadeIn: 0,
    fadeOut: 0,
    shape: 'rect',
    stroke: '',
    strokeWidth: 0,
    opacity: 1,
    x: 0.5,
    y: 0.5,
    w: 1,
    h: 1,
    rotation: 0,
    animIn: 'none',
    animOut: 'none',
    keyframes: [],
    ...over,
  };
}

const fontValue = (label: string): string => FONTS.find((f) => f.label === label)?.value ?? FONTS[0].value;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ── Title cards ────────────────────────────────────────────────────────────
interface LookDef {
  background: string;
  color: string;
  accent: string;
  font: string;
  titleSize: number;
  bold: boolean;
  upper?: boolean;
  /** Letter-spaced capitals (thin spaces between letters). */
  spaced?: boolean;
  glow?: number;
  animIn: TextAnim;
  animOut: TextAnim;
  motion?: MotionAnim;
  deco: 'bar' | 'lines' | 'none';
}

const LOOKS: Record<CardLook, LookDef> = {
  clean: { background: '#0f172a', color: '#ffffff', accent: '#3b82f6', font: 'Chakra Petch', titleSize: 118, bold: true, animIn: 'slide', animOut: 'fade', motion: 'zoom-in', deco: 'bar' },
  bold: { background: '#ffd53d', color: '#111111', accent: '#111111', font: 'Impact', titleSize: 150, bold: true, upper: true, animIn: 'stomp', animOut: 'zoom', deco: 'none' },
  cinematic: { background: '#000000', color: '#f5f1e8', accent: '#d4af37', font: 'Georgia', titleSize: 88, bold: false, upper: true, spaced: true, animIn: 'blur', animOut: 'fade', motion: 'zoom-in', deco: 'lines' },
  neon: { background: '#05060f', color: '#ffffff', accent: '#22d3ee', font: 'Chakra Petch', titleSize: 124, bold: true, upper: true, glow: 22, animIn: 'flicker', animOut: 'fade', deco: 'bar' },
  retro: { background: '#1a1033', color: '#fef08a', accent: '#ff2d95', font: 'Press Start 2P', titleSize: 62, bold: false, upper: true, animIn: 'typewriter', animOut: 'flicker', deco: 'bar' },
  minimal: { background: '#ffffff', color: '#111111', accent: '#111111', font: 'Arial', titleSize: 78, bold: false, animIn: 'fade', animOut: 'fade', deco: 'none' },
};

/** Text settings a card takes from the caller or the active style, over the look's own. */
export type CardText = Partial<Pick<TextClip, 'fontFamily' | 'color' | 'bold' | 'italic' | 'outlineWidth' | 'outlineColor' | 'glow' | 'glowColor' | 'animIn' | 'animOut'>>;

export interface CardSpec {
  title: string;
  subtitle?: string;
  /** Small line above the title ("CHAPTER 2", "UP NEXT"). */
  kicker?: string;
  start: number;
  duration: number;
  look: CardLook;
  canvas: Canvas;
  trackId: string;
  background?: string;
  /** Below 1 the footage shows through (cards laid over video). */
  backgroundOpacity?: number;
  accent?: string;
  text?: CardText;
  /** Fade the whole card in and out, seconds. */
  fade?: number;
  /** A chapter of the video starts at this card, with this title. */
  chapter?: string;
}

export interface BuiltCard {
  /** Background first: overlays that start together draw in list order. */
  clips: Clip[];
  background: string;
  title: string;
}

const spaceOut = (line: string): string => [...line].join(' ');
/** Letter-spaced capitals for small labels ("P A R T  2"): thin spaces between the letters. */
export const spacedCaps = (line: string): string => spaceOut(line.toUpperCase());
const blockH = (size: number, lines: number): number => (lines * size * 1.18) / REF_HEIGHT;

/** A card look's colours and typeface with the caller's overrides, for scenes built outside this file (longform.ts). */
export function cardPalette(lookName: CardLook, over: { background?: string; accent?: string; text?: CardText } = {}): { background: string; color: string; accent: string; fontFamily: string; bold: boolean; upper: boolean } {
  const look = LOOKS[lookName] ?? LOOKS.clean;
  const background = over.background ?? look.background;
  const t = over.text ?? {};
  return {
    background,
    color: (t.outlineWidth ?? 0) > 0 ? (t.color ?? look.color) : readableOn(t.color ?? look.color, background),
    accent: readableOn(over.accent ?? look.accent, background),
    fontFamily: t.fontFamily ?? fontValue(look.font),
    bold: t.bold ?? look.bold,
    upper: look.upper === true,
  };
}

export function buildCard(spec: CardSpec): BuiltCard {
  const look = LOOKS[spec.look] ?? LOOKS.clean;
  const { canvas, trackId, start } = spec;
  const duration = Math.max(1, spec.duration);
  const end = start + duration;
  const background = spec.background ?? look.background;
  const accent = readableOn(spec.accent ?? look.accent, background);
  const t = spec.text ?? {};
  const fontFamily = t.fontFamily ?? fontValue(look.font);
  const bold = t.bold ?? look.bold;
  const outlineWidth = t.outlineWidth ?? 0;
  // Outlined type reads on anything; bare type has to contrast with the card.
  const solid = (spec.backgroundOpacity ?? 1) >= 0.6;
  const color = outlineWidth > 0 || !solid ? (t.color ?? look.color) : readableOn(t.color ?? look.color, background);
  const base = { fontFamily, italic: t.italic ?? false, outlineWidth, outlineColor: t.outlineColor ?? '#000000' };
  const stagger = Math.min(0.12, duration / 12);

  const upper = (s: string): string => (look.upper ? s.toUpperCase() : s);
  const title = fitText(upper(spec.title.trim()), look.titleSize, fontFamily, bold, canvas, { spread: look.spaced ? 1.4 : 1 });
  const titleText = look.spaced ? title.text.split('\n').map(spaceOut).join('\n') : title.text;
  const kicker = spec.kicker?.trim() ? fitText(spec.kicker.trim().toUpperCase(), Math.max(30, title.fontSize * 0.3), fontFamily, true, canvas, { maxLines: 1, spread: 1.4 }) : null;
  const sub = spec.subtitle?.trim() ? fitText(spec.subtitle.trim(), Math.max(34, title.fontSize * 0.42), fontFamily, false, canvas, { maxLines: 3 }) : null;

  // Stack kicker / title / rule / subtitle and centre the stack on the frame.
  const gap = 0.032;
  const hasBar = look.deco === 'bar';
  const hK = kicker ? blockH(kicker.fontSize, 1) : 0;
  const hT = blockH(title.fontSize, title.lines);
  const hS = sub ? blockH(sub.fontSize, sub.lines) : 0;
  const hBar = hasBar ? 8 / REF_HEIGHT : 0;
  const total = hK + (kicker ? gap : 0) + hT + (hasBar ? gap + hBar : 0) + (sub ? gap + hS : 0);
  let y = 0.5 - total / 2;
  const place = (h: number): number => {
    const mid = y + h / 2;
    y += h;
    return mid;
  };
  const yK = kicker ? place(hK) : 0;
  if (kicker) y += gap;
  const yT = place(hT);
  if (hasBar) y += gap;
  const yBar = hasBar ? place(hBar) : 0;
  if (sub) y += gap;
  const yS = sub ? place(hS) : 0;

  const fade = Math.max(0, Math.min(spec.fade ?? 0, duration / 3));
  const bg = rectClip({ trackId, start, duration, fill: background, w: 1.01, h: 1.01, opacity: spec.backgroundOpacity ?? 1, fadeIn: fade, fadeOut: fade });
  if (spec.chapter?.trim()) bg.chapter = spec.chapter.trim();
  const clips: Clip[] = [bg];
  // Each element starts a beat after the one above it, so the card builds.
  const at = (i: number): { start: number; duration: number } => {
    const s = start + 0.04 + i * stagger;
    return { start: s, duration: Math.max(MIN_CLIP, end - s) };
  };
  const refW = (px: number): number => Math.min(0.8, (px * (canvas.height / REF_HEIGHT)) / canvas.width);

  if (look.deco === 'lines') {
    const half = hT / 2 + gap * 0.9;
    for (const dy of [-half, half]) clips.push(rectClip({ trackId, ...at(1), fill: accent, x: 0.5, y: yT + dy, w: refW(360), h: 2 / REF_HEIGHT, animIn: 'fade', animOut: 'fade' }));
  }
  if (kicker) {
    clips.push(textClip({ trackId, ...at(0), ...base, text: spaceOut(kicker.text), fontSize: kicker.fontSize, bold: true, color: accent, y: yK, animIn: 'fade', animOut: 'fade' }));
  }
  const titleClip = textClip({
    trackId,
    ...at(1),
    ...base,
    text: titleText,
    fontSize: title.fontSize,
    bold,
    color,
    y: yT,
    glow: t.glow ?? look.glow ?? 0,
    glowColor: t.glowColor ?? accent,
    animIn: t.animIn ?? look.animIn,
    animOut: t.animOut ?? look.animOut,
    motion: look.motion,
    motionAmount: look.motion ? 0.5 : undefined,
  });
  clips.push(titleClip);
  if (hasBar) clips.push(rectClip({ trackId, ...at(2), fill: accent, x: 0.5, y: yBar, w: refW(200), h: hBar, animIn: 'pop', animOut: 'fade' }));
  if (sub) {
    clips.push(textClip({ trackId, ...at(3), ...base, text: sub.text, fontSize: sub.fontSize, bold: false, color, y: yS, animIn: 'fade', animOut: 'fade' }));
  }
  return { clips: grouped(clips, 'card'), background: bg.id, title: titleClip.id };
}

/** Tag the clips of one built scene with a shared group id. */
function grouped(clips: Clip[], kind: string): Clip[] {
  const group = uid(kind);
  for (const c of clips) c.group = group;
  return clips;
}

/**
 * Open a gap of `duration` seconds at time `at`: clips after it slide right and
 * a clip playing through it is split there. Locked tracks and the tracks in
 * `keep` (a music bed that should play on underneath) are left alone.
 */
export function insertGap(clips: Clip[], tracks: Track[], at: number, duration: number, keep: Set<string> = new Set()): Clip[] {
  const still = new Set([...tracks.filter((t) => t.locked).map((t) => t.id), ...keep]);
  const out: Clip[] = [];
  for (const c of clips) {
    const end = c.start + c.duration;
    if (still.has(c.trackId) || end <= at + 1e-6) out.push(c);
    else if (c.start >= at - 1e-6 || at - c.start < MIN_CLIP || end - at < MIN_CLIP) out.push({ ...c, start: c.start + duration });
    else {
      const right = sliceClip(c, at, end);
      out.push(sliceClip(c, c.start, at, { keepId: true }), { ...right, start: right.start + duration });
    }
  }
  return out;
}

// ── Key points ─────────────────────────────────────────────────────────────
// The lecture staple: a heading and a short list whose lines arrive one at a
// time as they are spoken, full-screen or as a panel beside the speaker.
export type PointsLayout = 'full' | 'left' | 'right';

export interface KeyPointsSpec {
  heading?: string;
  /** One to six short lines. */
  points: string[];
  start: number;
  duration: number;
  /** When each point appears, seconds after `start` (default: spread evenly). */
  reveal?: number[];
  layout: PointsLayout;
  look: CardLook;
  canvas: Canvas;
  trackId: string;
  background?: string;
  backgroundOpacity?: number;
  accent?: string;
  text?: CardText;
  /** 1 2 3 instead of bullet marks. */
  numbered?: boolean;
  /** Dim each point when the next one arrives, so the eye stays on the current one. */
  focus?: boolean;
}

export interface BuiltKeyPoints {
  clips: Clip[];
  panel: string;
  heading?: string;
  points: string[];
  /** When each point appears, timeline seconds. */
  times: number[];
  /** How far to slide the footage aside so a side panel doesn't cover its middle (0 = no need). */
  shiftX: number;
}

/** A side panel's share of a landscape frame. */
const SIDE_W = 0.42;
const POINT_ANIM: Record<CardLook, TextAnim> = { clean: 'slide', bold: 'pop', cinematic: 'fade', neon: 'slide', retro: 'typewriter', minimal: 'fade' };
const DIMMED = 0.42;

interface PointsArea {
  panel: { x: number; y: number; w: number; h: number };
  /** The column the text sits in. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  heading: number;
  point: number;
  enter: TextAnim;
  shiftX: number;
}

function pointsArea(layout: PointsLayout, canvas: Canvas): PointsArea {
  if (layout === 'full') return { panel: { x: 0.5, y: 0.5, w: 1.01, h: 1.01 }, x0: 0.12, x1: 0.88, y0: 0.1, y1: 0.9, heading: 72, point: 52, enter: 'none', shiftX: 0 };
  // A portrait frame has no room beside the speaker: the panel takes the lower part instead.
  if (canvas.height > canvas.width) return { panel: { x: 0.5, y: 0.745, w: 1.01, h: 0.52 }, x0: 0.08, x1: 0.92, y0: 0.52, y1: 0.96, heading: 54, point: 42, enter: 'fly-bottom', shiftX: 0 };
  const left = layout === 'left';
  return {
    panel: { x: left ? SIDE_W / 2 - 0.005 : 1 - SIDE_W / 2 + 0.005, y: 0.5, w: SIDE_W + 0.01, h: 1.01 },
    x0: left ? 0.04 : 1 - SIDE_W + 0.04,
    x1: left ? SIDE_W - 0.035 : 1 - 0.035,
    y0: 0.1,
    y1: 0.9,
    heading: 48,
    point: 38,
    enter: left ? 'fly-left' : 'fly-right',
    // Centre the footage in what is left of the frame.
    shiftX: (left ? 1 : -1) * (SIDE_W / 2),
  };
}

export function buildKeyPoints(spec: KeyPointsSpec): BuiltKeyPoints {
  const look = LOOKS[spec.look] ?? LOOKS.clean;
  const { canvas, trackId, start } = spec;
  const points = spec.points.map((p) => p.trim()).filter(Boolean).slice(0, 6);
  const duration = Math.max(1.5, spec.duration);
  const end = start + duration;
  const area = pointsArea(spec.layout, canvas);
  const side = area.enter !== 'none';
  const opacity = spec.backgroundOpacity ?? 1;
  const background = spec.background ?? look.background;
  const accent = readableOn(spec.accent ?? look.accent, background);
  const t = spec.text ?? {};
  const fontFamily = t.fontFamily ?? fontValue(look.font);
  const outlineWidth = t.outlineWidth ?? 0;
  const color = outlineWidth > 0 || opacity < 0.6 ? (t.color ?? look.color) : readableOn(t.color ?? look.color, background);
  const base = { fontFamily, italic: t.italic ?? false, outlineWidth, outlineColor: t.outlineColor ?? '#000000', color, anchor: 'left' as const, align: 'left' as const };
  const bold = t.bold ?? look.bold;
  const px = (size: number): number => size * (canvas.height / REF_HEIGHT);
  const colW = area.x1 - area.x0;

  const headingText = spec.heading?.trim() ? (look.upper ? spec.heading.trim().toUpperCase() : spec.heading.trim()) : '';
  const head = headingText ? fitText(headingText, area.heading, fontFamily, bold, canvas, { widthFrac: colW, maxLines: 2 }) : null;
  const hHead = head ? blockH(head.fontSize, head.lines) : 0;
  const hBar = head ? 6 / REF_HEIGHT : 0;
  const headGap = head ? 0.03 : 0;
  const listGap = head ? 0.045 : 0;
  const availH = area.y1 - area.y0;

  // One size for every point: the largest at which each fits its column and the list fits the panel.
  let size = area.point;
  let fitted: Array<{ text: string; fontSize: number; lines: number }> = [];
  let indent = 0;
  let pointGap = 0;
  for (;;) {
    indent = px(size * 1.45) / canvas.width;
    pointGap = (size * 0.6) / REF_HEIGHT;
    fitted = points.map((p) => fitText(p, size, fontFamily, false, canvas, { widthFrac: colW - indent, maxLines: 3 }));
    const smallest = Math.min(size, ...fitted.map((f) => f.fontSize));
    if (smallest < size) {
      size = smallest;
      continue;
    }
    const total = hHead + headGap + hBar + listGap + fitted.reduce((h, f) => h + blockH(size, f.lines), 0) + pointGap * Math.max(0, fitted.length - 1);
    if (total <= availH || size <= 24) break;
    size = Math.floor(size * 0.92);
  }
  const listH = fitted.reduce((h, f) => h + blockH(size, f.lines), 0) + pointGap * Math.max(0, fitted.length - 1);
  let y = area.y0 + Math.max(0, (availH - (hHead + headGap + hBar + listGap + listH)) / 2);

  // A side panel slides in first; its text follows once it has arrived.
  const lead = side ? 0.35 : 0.06;
  const textEnd = end - (side ? 0.2 : 0);
  const span = (from: number): { start: number; duration: number } => ({ start: from, duration: Math.max(MIN_CLIP, textEnd - from) });
  const panel = rectClip({
    trackId,
    start,
    duration,
    fill: background,
    ...area.panel,
    opacity,
    ...(side ? { animIn: area.enter, animOut: area.enter, animInDur: 0.4, animOutDur: 0.4 } : { fadeIn: 0.25, fadeOut: 0.25 }),
  });
  const clips: Clip[] = [panel];

  let headingId: string | undefined;
  if (head) {
    const h = textClip({ trackId, ...span(start + lead), ...base, text: head.text, fontSize: head.fontSize, bold, x: area.x0, y: y + hHead / 2, glow: t.glow ?? look.glow ?? 0, glowColor: t.glowColor ?? accent, animIn: t.animIn ?? look.animIn, animOut: 'fade', animOutDur: 0.25 });
    headingId = h.id;
    y += hHead + headGap;
    const barW = Math.min(colW, px(120) / canvas.width);
    clips.push(h, rectClip({ trackId, ...span(start + lead + 0.1), fill: accent, x: area.x0 + barW / 2, y: y + hBar / 2, w: barW, h: hBar, animIn: 'fade', animOut: 'fade', animOutDur: 0.25 }));
    y += hBar + listGap;
  }

  // When each point arrives: the caller's times, else spread over the first part of the card.
  const first = lead + (head ? 0.55 : 0.15);
  const step = clamp((duration - first - 1.2) / Math.max(1, points.length), 0.35, 2.5);
  const latest = Math.max(first, duration - 0.5);
  const given = (spec.reveal ?? []).filter((r) => Number.isFinite(r));
  const offsets = points.map((_, i) => clamp(given.length === points.length ? given[i] : first + i * step, lead, latest));
  for (let i = 1; i < offsets.length; i++) offsets[i] = Math.max(offsets[i], offsets[i - 1]);

  const pointIds: string[] = [];
  const enter = POINT_ANIM[spec.look] ?? 'slide';
  points.forEach((_, i) => {
    const f = fitted[i];
    const h = blockH(size, f.lines);
    const firstLine = y + (size * 1.18) / REF_HEIGHT / 2;
    const at = span(start + offsets[i]);
    // Dim it as the next point lands, so the list reads as "this one now".
    const next = offsets[i + 1];
    const until = next !== undefined ? next - offsets[i] : -1;
    const dim: Keyframe[] =
      spec.focus !== false && until > 0.05 && until + 0.35 < at.duration
        ? [
            { id: uid('k'), prop: 'opacity', t: until, value: 1 },
            { id: uid('k'), prop: 'opacity', t: until + 0.35, value: DIMMED, ease: 'out' },
          ]
        : [];
    const keys = (): Keyframe[] => dim.map((k) => ({ ...k, id: uid('k') }));
    if (spec.numbered) {
      clips.push(textClip({ trackId, ...at, ...base, text: String(i + 1), fontSize: size, bold: true, color: accent, x: area.x0, y: firstLine, animIn: 'fade', animOut: 'fade', animOutDur: 0.25, keyframes: keys() }));
    } else {
      const d = size * 0.34;
      const w = px(d) / canvas.width;
      clips.push(rectClip({ trackId, ...at, shape: 'ellipse', fill: accent, x: area.x0 + w / 2, y: firstLine, w, h: d / REF_HEIGHT, animIn: 'pop', animOut: 'fade', animOutDur: 0.25, keyframes: keys() }));
    }
    const p = textClip({ trackId, ...at, ...base, text: f.text, fontSize: size, bold: false, x: area.x0 + indent, y: y + h / 2, animIn: enter, animOut: 'fade', animOutDur: 0.25, keyframes: keys() });
    pointIds.push(p.id);
    clips.push(p);
    y += h + pointGap;
  });

  return { clips: grouped(clips, 'points'), panel: panel.id, heading: headingId, points: pointIds, times: offsets.map((o) => start + o), shiftX: area.shiftX };
}

/**
 * Slide the footage on one track sideways while a side panel is up
 * (`start`..`end`), easing over and back, so the speaker sits in the part of
 * the frame the panel leaves free. Clips that already move sideways (a
 * reframe's face follow, a hand-set position) are left alone and counted.
 */
export function makeRoom(clips: Clip[], trackId: string, start: number, end: number, dx: number, ease = 0.45): { clips: Clip[]; moved: number; skipped: number } {
  let moved = 0;
  let skipped = 0;
  const out = clips.map((c) => {
    if (c.type !== 'media' || c.trackId !== trackId) return c;
    const cEnd = c.start + c.duration;
    const from = Math.max(start, c.start);
    const to = Math.min(end, cEnd);
    if (to - from < MIN_CLIP) return c;
    if (c.posX !== 0 || c.keyframes.some((k) => k.prop === 'posX')) {
      skipped++;
      return c;
    }
    const a = from - c.start;
    const b = to - c.start;
    const ramp = Math.min(ease, (b - a) / 3);
    const keys: Keyframe[] = [];
    // A piece that begins (or ends) inside the window is already (or still) aside: no ramp at that edge.
    if (c.start < start - 1e-3) keys.push({ id: uid('k'), prop: 'posX', t: a, value: 0 }, { id: uid('k'), prop: 'posX', t: a + ramp, value: dx, ease: 'inout' });
    else keys.push({ id: uid('k'), prop: 'posX', t: 0, value: dx });
    if (cEnd > end + 1e-3) keys.push({ id: uid('k'), prop: 'posX', t: b - ramp, value: dx }, { id: uid('k'), prop: 'posX', t: b, value: 0, ease: 'inout' });
    else keys.push({ id: uid('k'), prop: 'posX', t: c.duration, value: dx });
    moved++;
    return { ...c, keyframes: [...c.keyframes, ...keys] };
  });
  return { clips: out, moved, skipped };
}

// ── Chapters ───────────────────────────────────────────────────────────────
/** The track the video is cut on: the first video track with footage on it, else the first with pictures (a narrated deck), else the first with any media. */
export function mainTrack(clips: Clip[], tracks: Track[], kinds: Map<string, string>): Track | undefined {
  const has = (t: Track, ok: (kind: string | undefined) => boolean): boolean => clips.some((c) => c.type === 'media' && c.trackId === t.id && ok(kinds.get(c.mediaId)));
  return (
    tracks.find((t) => t.kind === 'video' && has(t, (k) => k === 'video')) ??
    tracks.find((t) => t.kind === 'video' && has(t, (k) => k !== 'audio')) ??
    tracks.find((t) => t.kind !== 'text' && has(t, () => true))
  );
}

const AT = 0.05;

/**
 * Mark chapter starts. A chapter lives on a clip that begins at its time: a
 * title card that starts there, else the footage, which is split there if it
 * is mid-clip (a split that plays straight on, so nothing changes on screen).
 * `replace` clears the chapters already set. `missed` lists times where nothing
 * was playing to carry a mark.
 */
export function markChapters(clips: Clip[], tracks: Track[], kinds: Map<string, string>, marks: Array<{ time: number; title: string }>, replace = false): { clips: Clip[]; splits: number; missed: number[] } {
  const locked = new Set(tracks.filter((t) => t.locked).map((t) => t.id));
  const main = mainTrack(clips, tracks, kinds);
  let out = replace ? clips.map((c) => (c.chapter ? { ...c, chapter: undefined } : c)) : clips;
  let splits = 0;
  const missed: number[] = [];
  const rank = (c: Clip): number => (c.type === 'shape' && c.group ? 0 : c.type === 'media' && c.trackId === main?.id ? 1 : c.type === 'media' ? 2 : 3);
  for (const mark of [...marks].sort((a, b) => a.time - b.time)) {
    const title = mark.title.trim();
    const time = Math.max(0, mark.time);
    if (!title) continue;
    const here = out.filter((c) => Math.abs(c.start - time) <= AT && !locked.has(c.trackId)).sort((a, b) => rank(a) - rank(b));
    let carrier = here[0]?.id;
    if (!carrier) {
      const spans = (c: Clip): boolean => c.type === 'media' && !locked.has(c.trackId) && time - c.start >= MIN_CLIP && c.start + c.duration - time >= MIN_CLIP;
      const host = out.find((c) => spans(c) && c.trackId === main?.id) ?? out.find(spans);
      if (!host) {
        missed.push(time);
        continue;
      }
      const right = sliceClip(host, time, host.start + host.duration);
      out = out.flatMap((c) => (c.id === host.id ? [sliceClip(host, host.start, time, { keepId: true }), right] : [c]));
      carrier = right.id;
      splits++;
    }
    // One chapter per moment: anything else that starts here gives its mark up.
    out = out.map((c) => (c.id === carrier ? { ...c, chapter: title } : c.chapter && Math.abs(c.start - time) <= AT ? { ...c, chapter: undefined } : c));
  }
  return { clips: out, splits, missed };
}

// ── Stingers ───────────────────────────────────────────────────────────────
export type StingerDirection = 'left' | 'right' | 'up' | 'down';

export interface StingerSpec {
  /** The cut to cover, timeline seconds: the frame is fully covered at this moment. */
  at: number;
  direction: StingerDirection;
  /** One colour per panel (1–3), back to front. */
  colors: string[];
  /** Seconds a panel takes to cross in (and again to leave). */
  sweep?: number;
  /** Seconds the frame stays covered. */
  hold?: number;
  label?: string;
  labelText?: CardText;
  canvas: Canvas;
  trackId: string;
}

const STINGER_STAGGER = 0.07;

/** Colour panels that sweep across the frame, cover the cut at `at`, and sweep off the far side. */
export function buildStinger(spec: StingerSpec): { clips: Clip[]; start: number; end: number } {
  const colors = spec.colors.slice(0, 3);
  const sweep = Math.max(0.12, Math.min(1.5, spec.sweep ?? 0.3));
  const label = spec.label?.trim() ?? '';
  const hold = Math.max(0, Math.min(5, spec.hold ?? (label ? 0.9 : 0)));
  // Covered from the moment the first panel is fully in until the last starts to leave.
  const start = Math.max(0, spec.at - sweep - hold / 2);
  const horizontal = spec.direction === 'left' || spec.direction === 'right';
  const forward = spec.direction === 'right' || spec.direction === 'down';
  const [from, to] = forward ? [-0.51, 1.51] : [1.51, -0.51];
  const prop = horizontal ? 'x' : 'y';
  const lead = (colors.length - 1) * STINGER_STAGGER;
  // Panels pile in one after another and peel off in reverse (the top one first),
  // so every colour shows on the way in and again on the way out.
  const clips: Clip[] = colors.map((fill, i) => {
    const leave = sweep + hold + lead + (colors.length - 1 - 2 * i) * STINGER_STAGGER;
    const keyframes: Keyframe[] = [
      { id: uid('k'), prop, t: 0, value: from },
      { id: uid('k'), prop, t: sweep, value: 0.5, ease: 'out' },
      { id: uid('k'), prop, t: leave, value: 0.5 },
      { id: uid('k'), prop, t: leave + sweep, value: to, ease: 'in' },
    ];
    return rectClip({ trackId: spec.trackId, start: start + i * STINGER_STAGGER, duration: leave + sweep, fill, w: 1.02, h: 1.02, keyframes });
  });
  if (label && hold - lead > 0.25) {
    const top = colors[colors.length - 1];
    const t = spec.labelText ?? {};
    const fontFamily = t.fontFamily ?? FONTS[0].value;
    const fit = fitText(label, 120, fontFamily, t.bold ?? true, spec.canvas, { maxLines: 2 });
    clips.push(
      textClip({
        trackId: spec.trackId,
        start: start + sweep + lead,
        duration: hold - lead,
        text: fit.text,
        fontSize: fit.fontSize,
        fontFamily,
        bold: t.bold ?? true,
        italic: t.italic ?? false,
        color: readableOn(t.color ?? '#ffffff', top),
        animIn: t.animIn ?? 'pop',
        animOut: 'fade',
        animInDur: 0.2,
        animOutDur: 0.15,
      }),
    );
  }
  return { clips: grouped(clips, 'stinger'), start, end: start + sweep * 2 + hold + lead * 2 };
}

// ── Transitions on every cut ───────────────────────────────────────────────
const TOUCH = 0.03;
/** Two pieces of one recording less than this far apart in the source are a jump cut. */
const JUMP_CUT_GAP = 2;
/** Closer than this in the source, the two pieces play as one unbroken shot. */
const SEAMLESS_GAP = 0.05;

/**
 * Put a transition on each cut where two picture clips touch on a video
 * track, cycling through `types`. A transition can't run longer than 45% of
 * the shorter clip. 'none' clears. `skipJumpCuts` leaves cuts inside one
 * continuous take alone (the pieces an auto edit leaves), where a dissolve
 * between two near-identical frames reads as a glitch.
 */
export function planTransitions(
  clips: Clip[],
  tracks: Track[],
  kinds: Map<string, string>,
  opts: { types: TransitionType[]; duration: number; trackIds?: Set<string>; skipJumpCuts?: boolean },
): { clips: Clip[]; cuts: number; changed: number; jumpCuts: number } {
  const types = opts.types.length > 0 ? opts.types : (['fade'] as TransitionType[]);
  const patch = new Map<string, { transition: TransitionType; transitionDur: number }>();
  let cuts = 0;
  let jumpCuts = 0;
  let n = 0;
  for (const tr of tracks) {
    if (tr.kind !== 'video' || tr.locked || (opts.trackIds && !opts.trackIds.has(tr.id))) continue;
    const row = clips
      .filter((c): c is MediaClip => c.type === 'media' && c.trackId === tr.id && (kinds.get(c.mediaId) === 'video' || kinds.get(c.mediaId) === 'image'))
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < row.length; i++) {
      const prev = row[i - 1];
      const c = row[i];
      if (Math.abs(prev.start + prev.duration - c.start) > TOUCH) continue;
      const sameTake = prev.mediaId === c.mediaId && prev.freezeAt == null && c.freezeAt == null;
      const sourceGap = sameTake ? Math.abs(sourceTimeAt(prev, prev.start + prev.duration) - c.inPoint) : Infinity;
      // A split that plays straight on (a chapter mark, a piece cut for an
      // effect) is not a cut: nothing changes on screen there.
      if (sourceGap < SEAMLESS_GAP) continue;
      cuts++;
      if (opts.skipJumpCuts && sourceGap < JUMP_CUT_GAP) {
        jumpCuts++;
        continue;
      }
      const transition = types[n++ % types.length];
      patch.set(c.id, { transition, transitionDur: Math.max(0.1, Math.min(opts.duration, 0.45 * Math.min(prev.duration, c.duration))) });
    }
  }
  return { clips: clips.map((c) => (patch.has(c.id) ? { ...c, ...patch.get(c.id)! } : c)), cuts, changed: patch.size, jumpCuts };
}
