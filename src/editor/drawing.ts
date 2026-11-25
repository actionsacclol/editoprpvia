// Drawings an agent makes itself, as SVG: the rules, and how a held one moves. No DOM here (drawingRender.ts has that).

/** The most SVG text one drawing may be, characters. A stick-figure panel is 1 to 6 thousand. */
export const DRAWING_MAX_CHARS = 300_000;
/** The most elements one drawing may have. */
export const DRAWING_MAX_ELEMENTS = 3000;
/** The most parts of one drawing that move. */
export const DRAWING_MAX_MOVES = 40;
/** The most drawings one call takes. */
export const MAX_DRAWINGS = 16;
/** The longest side a drawing is turned into pixels at. */
export const DRAWING_MAX_SIDE = 1920;
/** How many times a second the lines are redrawn (the wobble of hand-drawn animation). */
export const DRAWING_BOIL_FPS = 8;

export interface DrawingMoveKind {
  id: string;
  /** What it does, and what it is for. */
  about: string;
  /** Where it turns or grows from when the drawing does not say. */
  pivot: string;
}

/** What a tagged part of a drawing can do while the drawing is held on screen. All of it slight. */
export const DRAWING_MOVES: DrawingMoveKind[] = [
  { id: 'bob', about: 'rises and sinks gently: a figure standing or breathing', pivot: 'bottom' },
  { id: 'sway', about: 'leans a little from its base: a figure, a tree, a sign, a flame', pivot: 'bottom' },
  { id: 'wave', about: 'swings from its pivot: a waving arm, a tail, a flag, a pendulum', pivot: 'bottom' },
  { id: 'nod', about: 'tips and comes back: a head, a bird pecking', pivot: 'bottom' },
  { id: 'shake', about: 'trembles: fear, cold, anger, a ringing alarm', pivot: 'center' },
  { id: 'float', about: 'drifts slowly around its place: a cloud, a balloon, a ghost, a thought bubble', pivot: 'center' },
  { id: 'pulse', about: 'grows and shrinks: a heart, a glow, a warning light', pivot: 'center' },
  { id: 'blink', about: 'shuts for a moment every few seconds: eyes', pivot: 'center' },
  { id: 'talk', about: 'opens and closes: a mouth', pivot: 'center' },
  { id: 'spin', about: 'turns steadily: a wheel, a fan, sun rays, a loading ring', pivot: 'center' },
  { id: 'flicker', about: 'its brightness wavers: a flame, a screen, a bulb, a star', pivot: 'center' },
  { id: 'slide', about: 'travels slowly sideways and back: a car, a boat, a bank of cloud', pivot: 'center' },
];

export const isDrawingMove = (id: string): boolean => DRAWING_MOVES.some((m) => m.id === id);

const PIVOT_WORDS: Record<string, [number, number]> = {
  center: [50, 50],
  centre: [50, 50],
  middle: [50, 50],
  top: [50, 0],
  bottom: [50, 100],
  left: [0, 50],
  right: [100, 50],
  'top left': [0, 0],
  'top right': [100, 0],
  'bottom left': [0, 100],
  'bottom right': [100, 100],
};

/**
 * Where a part turns from, as percentages of its own box: a word ("bottom", "top left") or two percentages
 * ("30% 80%"). Null when it is neither.
 */
export function drawingPivot(raw: string | null | undefined, fallback = 'center'): [number, number] | null {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s,_-]+/g, ' ');
  if (!v) return PIVOT_WORDS[fallback] ?? [50, 50];
  const word = PIVOT_WORDS[v] ?? PIVOT_WORDS[v.split(' ').reverse().join(' ')];
  if (word) return word;
  const m = /^(-?\d+(?:\.\d+)?)%? (-?\d+(?:\.\d+)?)%?$/.exec(v);
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  return x >= -100 && x <= 200 && y >= -100 && y <= 200 ? [x, y] : null;
}

export interface MoveOptions {
  /** How big the move is: 1 is the usual, slight size. 0.2 to 3. */
  amount?: number;
  /** How fast: 1 is usual. 0.25 to 4; below zero runs it the other way. */
  speed?: number;
  /** Where in its cycle it starts, 0 to 1, so two parts do not move in step. */
  phase?: number;
  /** One 1920th of the drawing's longer side, in the drawing's own units: distances are in these. */
  unit?: number;
}

export interface MoveState {
  /** Shift, in the drawing's units. */
  x: number;
  y: number;
  /** Degrees. */
  rotate: number;
  sx: number;
  sy: number;
  opacity: number;
}

export const REST: MoveState = { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 };

const TAU = Math.PI * 2;
const wave = (cycles: number): number => Math.sin(TAU * cycles);
const clampTo = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** A steady number in 0..1 for a whole number and a salt: the same in every run. */
const hash = (n: number, salt: number): number => {
  const v = Math.sin(n * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

/** Where a moving part is at `t` seconds. A pure function of time: the same frame every time it is asked for. */
export function moveAt(kind: string, t: number, o: MoveOptions = {}): MoveState {
  const a = clampTo(o.amount ?? 1, 0.2, 3);
  const raw = o.speed ?? 1;
  const s = (raw < 0 ? -1 : 1) * clampTo(Math.abs(raw) || 1, 0.25, 4);
  const p = o.phase ?? 0;
  const u = o.unit ?? 1;
  const at = t * s;
  switch (kind) {
    case 'bob':
      return { ...REST, y: 5 * a * u * wave(0.5 * at + p) };
    case 'sway':
      return { ...REST, rotate: 2.2 * a * wave(0.28 * at + p) };
    case 'wave':
      return { ...REST, rotate: 13 * a * wave(1.05 * at + p) };
    case 'nod':
      return { ...REST, rotate: 5 * a * wave(0.85 * at + p) };
    case 'shake': {
      // A new place fourteen times a second: a tremble, not a swing.
      const n = Math.floor(Math.abs(at) * 14);
      return { ...REST, x: 4 * a * u * (hash(n, 1 + p) * 2 - 1), y: 2.5 * a * u * (hash(n, 2 + p) * 2 - 1) };
    }
    case 'float':
      return { ...REST, x: 9 * a * u * wave(0.13 * at + p), y: 6 * a * u * wave(0.19 * at + p + 0.25) };
    case 'pulse': {
      const k = 1 + 0.05 * a * wave(0.9 * at + p);
      return { ...REST, sx: k, sy: k };
    }
    case 'blink': {
      const period = 3.4;
      const into = (((Math.abs(at) + p * period) % period) + period) % period;
      return { ...REST, sy: into < 0.14 ? 0.1 : 1 };
    }
    case 'talk': {
      // Syllables, with a slower swell over them so it does not read as a metronome.
      const open = Math.abs(wave(1.55 * at + p)) * (0.65 + 0.35 * wave(0.37 * at + p * 2));
      return { ...REST, sy: clampTo(0.55 + 0.6 * a * open, 0.2, 2.2) };
    }
    case 'spin':
      return { ...REST, rotate: (((90 * at + 360 * p) % 360) + 360) % 360 };
    case 'flicker':
      return { ...REST, opacity: clampTo(1 - 0.4 * a * (0.5 + 0.5 * wave(7.3 * at + p)) * (0.5 + 0.5 * wave(2.9 * at + p * 3)), 0.15, 1) };
    case 'slide':
      return { ...REST, x: 40 * a * u * wave(0.07 * at + p) };
    default:
      return REST;
  }
}

/** Two moves on one part (a figure that bobs and sways): shifts and turns add, sizes and brightness multiply. */
export function combineMoves(list: MoveState[]): MoveState {
  return list.reduce((m, n) => ({ x: m.x + n.x, y: m.y + n.y, rotate: m.rotate + n.rotate, sx: m.sx * n.sx, sy: m.sy * n.sy, opacity: m.opacity * n.opacity }), REST);
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The CSS for a moving part's wrapper. Empty at rest. */
export function moveStyle(m: MoveState, pivot: [number, number]): string {
  const parts: string[] = [];
  if (m.x || m.y) parts.push(`translate(${r3(m.x)}px, ${r3(m.y)}px)`);
  if (m.rotate) parts.push(`rotate(${r3(m.rotate)}deg)`);
  if (m.sx !== 1 || m.sy !== 1) parts.push(`scale(${r3(m.sx)}, ${r3(m.sy)})`);
  const css: string[] = [];
  if (parts.length) css.push('transform-box: fill-box', `transform-origin: ${r3(pivot[0])}% ${r3(pivot[1])}%`, `transform: ${parts.join(' ')}`);
  if (m.opacity !== 1) css.push(`opacity: ${r3(m.opacity)}`);
  return css.join('; ');
}

/** Where each of several moving parts starts in its cycle, so no two move in step. */
export const movePhase = (index: number): number => {
  const v = index * 0.381966;
  return v - Math.floor(v);
};

/** Which of the wobbles the lines have at `t` (a whole number from 1). A still has the first. */
export function boilSeed(t: number | null): number {
  if (t === null || !(t > 0)) return 1;
  return 1 + (Math.floor(t * DRAWING_BOIL_FPS) % 5);
}

/**
 * What is wrong with a drawing's text before it is even parsed, in words its author can act on. Null when
 * nothing is.
 */
export function drawingProblem(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return 'a drawing is SVG text: <svg viewBox="0 0 1920 1080" …>…</svg>';
  if (text.length > DRAWING_MAX_CHARS) return `it is ${Math.round(text.length / 1000)} thousand characters; the most is ${DRAWING_MAX_CHARS / 1000} thousand. Draw with fewer, simpler shapes`;
  if (!/<svg[\s>]/i.test(text)) return 'it has no <svg> element';
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return 'it has a DOCTYPE or an ENTITY, which are not read. Start at <svg';
  return null;
}

/** Adds the namespaces a drawing forgot to declare, so it parses. */
export function withNamespaces(text: string): string {
  return text.replace(/<svg\b([^>]*)>/i, (whole, attrs: string) => {
    let extra = '';
    if (!/\sxmlns\s*=/.test(attrs)) extra += ' xmlns="http://www.w3.org/2000/svg"';
    if (/xlink:/.test(text) && !/\sxmlns:xlink\s*=/.test(attrs)) extra += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
    return extra ? `<svg${extra}${attrs}>` : whole;
  });
}

/** Elements a drawing may be made of. Anything else is taken out (and said so). */
export const DRAWING_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'style',
  'path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse', 'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker',
  'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feFlood', 'feComposite', 'feMerge', 'feMergeNode', 'feColorMatrix', 'feDropShadow', 'feTurbulence', 'feDisplacementMap', 'feMorphology', 'feComponentTransfer', 'feFuncR', 'feFuncG', 'feFuncB', 'feFuncA',
]);

/** Is this attribute safe to keep? Nothing that runs, and nothing that points outside the drawing. */
export function drawingAttributeOk(name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('on')) return false;
  if (n === 'href' || n === 'xlink:href') return /^\s*#/.test(value);
  // A url(...) may only name something inside the drawing.
  if (/url\s*\((?!\s*['"]?\s*#)/i.test(value)) return false;
  if (/javascript:|expression\s*\(|@import/i.test(value)) return false;
  return true;
}

/** A stylesheet with everything that reaches outside the drawing taken out. */
export function drawingStyleText(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\s*\((?!\s*['"]?\s*#)[^)]*\)/gi, 'none')
    .replace(/expression\s*\([^)]*\)/gi, 'none');
}

/** The size a drawing is turned into pixels at: its own shape, the longer side `max`, both sides even. */
export function drawingPixels(width: number, height: number, max = DRAWING_MAX_SIDE): { w: number; h: number } {
  const k = max / Math.max(width, height);
  const even = (n: number): number => Math.max(2, Math.round((n * k) / 2) * 2);
  return { w: even(width), h: even(height) };
}

/** A file-name slug for a drawing. */
export function drawingSlug(name: string): string {
  const s = String(name ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'drawing';
}
