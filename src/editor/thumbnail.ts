// Thumbnails: a few big words over a drawn scene, a frame of the video or a picture, at 1280×720.
// The layout (which words go on which line, how large) is pure and tested; the drawing is a 2D canvas.
import type { ArtStyle } from './art/art';
import { figureIn } from './art/art';

export const THUMB = { width: 1280, height: 720 } as const;

export type ThumbLayout = 'left' | 'right' | 'center' | 'bottom';
export const THUMB_LAYOUTS: Array<{ id: ThumbLayout; name: string }> = [
  { id: 'left', name: 'Words on the left' },
  { id: 'right', name: 'Words on the right' },
  { id: 'bottom', name: 'Words along the bottom' },
  { id: 'center', name: 'Words in the middle' },
];
/** What sits behind the words: nothing (an outline carries them), or a block of the accent colour per line. */
export type ThumbPlate = 'none' | 'box';

export interface ThumbColors {
  text: string;
  accent: string;
  /** Around the letters, and behind them as a shadow. */
  outline: string;
  /** Top and bottom of the background where no picture covers it. */
  backdrop: [string, string];
}

export interface ThumbSpec {
  /** The words. *Stars* around the ones to colour; a line break is kept. */
  text: string;
  layout: ThumbLayout;
  plate: ThumbPlate;
  colors: ThumbColors;
  /** CSS font family. */
  font: string;
  upper: boolean;
  /** A small label in a corner ("NEW", "PART 2"). */
  badge?: string;
  /** How much the picture is darkened (or lightened, on a light look) behind the words, 0..1. */
  shade: number;
}

export interface ThumbWord {
  text: string;
  accent: boolean;
}

export const DEFAULT_THUMB_FONT = 'Impact, "Arial Black", "Segoe UI", sans-serif';
export const DEFAULT_THUMB_COLORS: ThumbColors = { text: '#FFFFFF', accent: '#FFD400', outline: '#000000', backdrop: ['#1B1F3B', '#0B0D1A'] };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** #rgb or #rrggbb as written, upper-cased; null for anything else. */
export function hexColor(v: unknown): string | null {
  const s = String(v ?? '').trim();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return `#${h.toUpperCase()}`;
}

/** 0 (black) to 1 (white), as the eye weighs it. */
export function luminance(color: string): number {
  const h = hexColor(color);
  if (!h) return 0;
  const lin = (i: number): number => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
}

/** Black or white, whichever reads on the colour. */
export const inkOn = (color: string): string => (luminance(color) > 0.36 ? '#111111' : '#FFFFFF');

/**
 * The words of a headline, line by line as typed. Words between *stars* take the accent colour; when
 * none are starred, the figure in it does ("40%", "$3 MILLION"), else the last word.
 */
export function thumbWords(text: string, upper = true): ThumbWord[][] {
  const rows = String(text ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 4);
  let starred = false;
  const lines = rows.map((row) => {
    const out: ThumbWord[] = [];
    let on = false;
    for (const part of row.split(/(\*)/)) {
      if (part === '*') {
        on = !on;
        starred = true;
        continue;
      }
      for (const w of part.split(/\s+/).filter(Boolean)) out.push({ text: (upper ? w.toUpperCase() : w).slice(0, 28), accent: on });
    }
    return out;
  });
  const kept = lines.filter((l) => l.length > 0);
  if (!starred && kept.length) {
    const flat = kept.flat();
    const fig = figureIn(flat.map((w) => w.text).join(' '))
      .split(' ')
      .filter(Boolean);
    const hit = fig.length ? flat.filter((w) => fig.includes(w.text.replace(/[.,!?]+$/, '').toUpperCase())) : [];
    if (hit.length) for (const w of hit) w.accent = true;
    else if (flat.length > 1) flat[flat.length - 1].accent = true;
  }
  return kept;
}

/** Where the words go: a box in fractions of the frame, and how they are aligned in it. */
export function thumbBox(layout: ThumbLayout): { x: number; y: number; w: number; h: number; align: 'left' | 'right' | 'center'; maxLines: number } {
  switch (layout) {
    case 'left':
      return { x: 0.045, y: 0.1, w: 0.47, h: 0.8, align: 'left', maxLines: 4 };
    case 'right':
      return { x: 0.485, y: 0.1, w: 0.47, h: 0.8, align: 'right', maxLines: 4 };
    case 'bottom':
      return { x: 0.04, y: 0.6, w: 0.92, h: 0.36, align: 'center', maxLines: 2 };
    default:
      return { x: 0.08, y: 0.16, w: 0.84, h: 0.68, align: 'center', maxLines: 3 };
  }
}

/**
 * A headline typed as one line, broken into `n` lines of about the same width: the break that leaves the
 * longest line shortest. Words are never split.
 */
export function balanceLines(words: ThumbWord[], n: number): ThumbWord[][] {
  const lines = clamp(Math.round(n), 1, Math.max(1, words.length));
  if (lines <= 1 || words.length <= 1) return [words];
  const len = (a: number, b: number): number => words.slice(a, b).reduce((s, w) => s + w.text.length, 0) + (b - a - 1);
  let best: number[] = [];
  let bestScore = Infinity;
  const walk = (from: number, left: number, cuts: number[], worst: number): void => {
    if (left === 1) {
      const score = Math.max(worst, len(from, words.length));
      if (score < bestScore) {
        bestScore = score;
        best = cuts;
      }
      return;
    }
    for (let at = from + 1; at <= words.length - (left - 1); at++) {
      const w = Math.max(worst, len(from, at));
      if (w >= bestScore) break;
      walk(at, left - 1, [...cuts, at], w);
    }
  };
  walk(0, lines, [], 0);
  const out: ThumbWord[][] = [];
  let a = 0;
  for (const cut of [...best, words.length]) {
    out.push(words.slice(a, cut));
    a = cut;
  }
  return out;
}

export interface ThumbFit {
  /** Font size in pixels of the 1280×720 frame. */
  size: number;
  lines: ThumbWord[][];
  lineHeight: number;
}

/**
 * The lines and the largest size at which they fit their box. `measure` gives a line's width at a font
 * size (a canvas does that; the tests pass a ruler of their own).
 */
export function fitThumb(text: string, layout: ThumbLayout, upper: boolean, measure: (line: string, size: number) => number, plate: ThumbPlate = 'none'): ThumbFit {
  const box = thumbBox(layout);
  const typed = thumbWords(text, upper);
  if (typed.length === 0) return { size: 0, lines: [], lineHeight: 0 };
  const W = box.w * THUMB.width;
  const H = box.h * THUMB.height;
  // A plate needs air around the letters; an outline needs a little.
  const lead = plate === 'box' ? 1.34 : 1.08;
  const pad = plate === 'box' ? 0.5 : 0.12;
  const sizeFor = (lines: ThumbWord[][]): number => {
    const widest = Math.max(...lines.map((l) => measure(l.map((w) => w.text).join(' '), 100)));
    return Math.min((W / (widest + pad * 100)) * 100, H / (lines.length * lead), 300);
  };
  // Typed on several lines: kept as typed. One line: every way of breaking it is tried, the largest letters win.
  let lines = typed;
  if (typed.length === 1) {
    const words = typed[0];
    let best = [words];
    let bestSize = sizeFor(best);
    for (let n = 2; n <= Math.min(box.maxLines, words.length); n++) {
      const tryLines = balanceLines(words, n);
      const s = sizeFor(tryLines);
      if (s > bestSize * 1.04) {
        best = tryLines;
        bestSize = s;
      }
    }
    lines = best;
  } else lines = typed.slice(0, box.maxLines + 1);
  const size = Math.max(24, Math.floor(sizeFor(lines)));
  return { size, lines, lineHeight: size * lead };
}

/** How many words a thumbnail carries before it stops reading at a glance. */
export const THUMB_WORDS = 6;

/** The colours a thumbnail takes from a drawing style: its paper, its ink and its highlight. */
export function thumbColorsFor(style: ArtStyle): ThumbColors {
  const paper = style.card.background;
  const light = luminance(paper) > 0.4;
  return { text: light ? '#161514' : '#FFFFFF', accent: light && luminance(style.highlight) > 0.7 ? style.card.accent : style.highlight, outline: light ? '#FFFFFF' : '#000000', backdrop: [paper, paper] };
}

/** Colours from a channel's thumbnails (or any list of colours): the most vivid one is the accent. */
export function thumbColorsFrom(palette: string[], base: ThumbColors = DEFAULT_THUMB_COLORS): ThumbColors {
  const cols = palette.map(hexColor).filter((c): c is string => !!c);
  if (cols.length === 0) return base;
  const vivid = (c: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const hi = Math.max(r, g, b);
    return hi === 0 ? 0 : ((hi - Math.min(r, g, b)) / hi) * (hi / 255);
  };
  const accent = [...cols].sort((a, b) => vivid(b) - vivid(a))[0];
  const dark = [...cols].sort((a, b) => luminance(a) - luminance(b))[0];
  const back = luminance(dark) < 0.12 && dark !== accent ? dark : '#0B0D1A';
  return { text: '#FFFFFF', accent, outline: '#000000', backdrop: [back, '#050608'] };
}

/** Up to three takes on one thumbnail, to choose between (or to test against each other). */
export function thumbVariants(spec: ThumbSpec, n = 3): ThumbSpec[] {
  const other: ThumbLayout = spec.layout === 'left' ? 'bottom' : spec.layout === 'bottom' ? 'left' : spec.layout === 'right' ? 'bottom' : 'bottom';
  const all: ThumbSpec[] = [spec, { ...spec, plate: spec.plate === 'box' ? 'none' : 'box' }, { ...spec, layout: other }];
  return all.slice(0, clamp(Math.round(n), 1, 3));
}

// ── Drawing ────────────────────────────────────────────────────────────────
export interface ThumbPicture {
  image: CanvasImageSource;
  width: number;
  height: number;
  /** Drawn for this thumbnail with room left for the words: it is not dimmed. */
  drawn?: boolean;
}

function rgba(color: string, alpha: number): string {
  const h = hexColor(color) ?? '#000000';
  return `rgba(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)}, ${clamp(alpha, 0, 1)})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

/** Draws the thumbnail into a 1280×720 context (any size works: it scales to the canvas). */
export function drawThumbnail(ctx: CanvasRenderingContext2D, spec: ThumbSpec, picture: ThumbPicture | null): void {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  ctx.save();
  ctx.setTransform(cw / THUMB.width, 0, 0, ch / THUMB.height, 0, 0);
  const W = THUMB.width;
  const H = THUMB.height;
  const c = spec.colors;

  const back = ctx.createLinearGradient(0, 0, 0, H);
  back.addColorStop(0, c.backdrop[0]);
  back.addColorStop(1, c.backdrop[1]);
  ctx.fillStyle = back;
  ctx.fillRect(0, 0, W, H);

  if (picture && picture.width > 0 && picture.height > 0) {
    // Cover the frame; the part cropped away is shared between both sides.
    const k = Math.max(W / picture.width, H / picture.height);
    const w = picture.width * k;
    const h = picture.height * k;
    ctx.imageSmoothingQuality = 'high';
    // Words along the bottom of a drawing made for this thumbnail: the drawing moves up out of their way, and its
    // last row of pixels fills what that uncovers (a drawn backdrop is flat there).
    const lift = picture.drawn && spec.layout === 'bottom' ? H * 0.14 : 0;
    ctx.drawImage(picture.image, (W - w) / 2, (H - h) / 2 - lift, w, h);
    if (lift > 0) ctx.drawImage(picture.image, 0, picture.height - 2, picture.width, 1, (W - w) / 2, (H + h) / 2 - lift - 1, w, lift + 2);
    // Behind the words the picture steps back, so they read at the size of a postage stamp.
    const shade = picture.drawn ? 0 : clamp(spec.shade, 0, 1);
    if (shade > 0 && spec.plate !== 'box') {
      const tone = c.outline;
      let g: CanvasGradient;
      if (spec.layout === 'left') g = ctx.createLinearGradient(0, 0, W * 0.72, 0);
      else if (spec.layout === 'right') g = ctx.createLinearGradient(W, 0, W * 0.28, 0);
      else if (spec.layout === 'bottom') g = ctx.createLinearGradient(0, H, 0, H * 0.3);
      else g = ctx.createLinearGradient(0, 0, 0, H);
      if (spec.layout === 'center') {
        g.addColorStop(0, rgba(tone, shade * 0.6));
        g.addColorStop(1, rgba(tone, shade * 0.6));
      } else {
        g.addColorStop(0, rgba(tone, shade));
        g.addColorStop(0.55, rgba(tone, shade * 0.55));
        g.addColorStop(1, rgba(tone, 0));
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }

  const font = (size: number): string => `900 ${size}px ${spec.font}`;
  const measure = (line: string, size: number): number => {
    ctx.font = font(size);
    return ctx.measureText(line).width;
  };
  const fit = fitThumb(spec.text, spec.layout, spec.upper, measure, spec.plate);
  if (fit.lines.length) {
    const box = thumbBox(spec.layout);
    const size = fit.size;
    ctx.font = font(size);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    const space = ctx.measureText(' ').width;
    const blockH = fit.lines.length * fit.lineHeight;
    const top = box.y * H + (spec.layout === 'bottom' ? box.h * H - blockH : (box.h * H - blockH) / 2);
    fit.lines.forEach((line, i) => {
      const widths = line.map((w) => ctx.measureText(w.text).width);
      const total = widths.reduce((a, b) => a + b, 0) + space * (line.length - 1);
      const padX = spec.plate === 'box' ? size * 0.22 : 0;
      const x0 = box.align === 'left' ? box.x * W + padX : box.align === 'right' ? (box.x + box.w) * W - total - padX : box.x * W + (box.w * W - total) / 2;
      const base = top + i * fit.lineHeight + fit.lineHeight / 2 + size * 0.36;
      if (spec.plate === 'box') {
        // A block per line, the accent line on the accent colour: the look of a headline cut from a paper.
        const strong = line.some((w) => w.accent);
        const fill = strong ? c.accent : c.outline;
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
        ctx.shadowBlur = size * 0.18;
        ctx.shadowOffsetY = size * 0.06;
        ctx.fillStyle = fill;
        roundRect(ctx, x0 - padX, base - size * 0.92, total + padX * 2, size * 1.18, size * 0.1);
        ctx.fill();
        ctx.restore();
        let x = x0;
        line.forEach((w, k) => {
          ctx.fillStyle = strong ? inkOn(c.accent) : w.accent ? c.accent : inkOn(fill);
          ctx.fillText(w.text, x, base);
          x += widths[k] + space;
        });
        return;
      }
      let x = x0;
      // The shadow first, then the outline, then the letters: three passes so no outline covers a neighbour's fill.
      const pass = (drawWord: (w: ThumbWord, at: number) => void): void => {
        x = x0;
        line.forEach((w, k) => {
          drawWord(w, x);
          x += widths[k] + space;
        });
      };
      ctx.strokeStyle = c.outline;
      ctx.fillStyle = c.outline;
      ctx.lineWidth = size * 0.2;
      pass((w, at) => {
        ctx.strokeText(w.text, at + size * 0.05, base + size * 0.07);
      });
      pass((w, at) => {
        ctx.strokeText(w.text, at, base);
      });
      pass((w, at) => {
        ctx.fillStyle = w.accent ? c.accent : c.text;
        ctx.fillText(w.text, at, base);
      });
    });
  }

  const badge = (spec.badge ?? '').trim().slice(0, 18);
  if (badge) {
    const size = 44;
    ctx.font = font(size);
    const label = spec.upper ? badge.toUpperCase() : badge;
    const w = ctx.measureText(label).width + size * 0.9;
    // The corner the words leave free.
    const right = spec.layout !== 'right';
    const x = right ? W - w - 36 : 36;
    const y = 34;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = c.accent;
    roundRect(ctx, x, y, w, size * 1.5, 12);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = inkOn(c.accent);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + size * 0.78);
  }
  ctx.restore();
}

/** The thumbnail as a canvas of 1280×720. */
export function renderThumbnail(spec: ThumbSpec, picture: ThumbPicture | null): HTMLCanvasElement {
  const el = document.createElement('canvas');
  el.width = THUMB.width;
  el.height = THUMB.height;
  drawThumbnail(el.getContext('2d', { alpha: false })!, spec, picture);
  return el;
}

/** JPEG bytes of a canvas (a thumbnail upload must stay under 2 MB: this is a tenth of that). */
export async function thumbnailBytes(canvas: HTMLCanvasElement, quality = 0.92): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', quality));
  if (!blob) throw new Error('The thumbnail could not be drawn.');
  return new Uint8Array(await blob.arrayBuffer());
}
