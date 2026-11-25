// Canvas helpers the art renderers share (ported from Krypt Marketo's render engine).
// Stage units: the renderers draw on a 1080 × 1920 stage; each one maps the part of it it needs onto the frame.

export const W = 1080;
export const H = 1920;

export type Ctx = CanvasRenderingContext2D;

export const FONT = {
  sans: '"Chakra Petch", Inter, system-ui, sans-serif',
  /** Signs, bubbles and the big word: a heavy sans every system has. */
  meme: '"Arial Black", "Segoe UI Black", Arial, sans-serif',
  pixel: '"Press Start 2P", monospace',
};

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 0→1 over [start, start+dur]. */
export const prog = (t: number, start: number, dur: number): number => (dur <= 0 ? (t >= start ? 1 : 0) : clamp01((t - start) / dur));
export const easeOut = (x: number): number => 1 - Math.pow(1 - x, 3);
export const easeInOut = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const easeBack = (x: number): number => {
  const c1 = 1.5;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
export const lerp = (a: number, b: number, x: number): number => a + (b - a) * x;

export function font(ctx: Ctx, size: number, weight = 700, family = FONT.sans): void {
  ctx.font = `${weight} ${Math.round(size)}px ${family}`;
}

/** Word-wrap honouring explicit newlines. Very long words are broken by characters. */
export function wrap(ctx: Ctx, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= maxW) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      if (ctx.measureText(word).width <= maxW) {
        line = word;
        continue;
      }
      let chunk = '';
      for (const ch of word) {
        if (ctx.measureText(chunk + ch).width > maxW && chunk) {
          out.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}

/** Largest size (≤ max) at which `text` wraps into ≤ maxLines lines within maxW and fits maxH. */
export function fit(ctx: Ctx, text: string, opts: { maxW: number; maxH: number; max: number; min?: number; maxLines?: number; weight?: number; family?: string; lh?: number }): { size: number; lines: string[]; lh: number } {
  const lhK = opts.lh ?? 1.08;
  let size = opts.max;
  const min = opts.min ?? 28;
  for (;;) {
    font(ctx, size, opts.weight ?? 700, opts.family);
    const lines = wrap(ctx, text, opts.maxW);
    const tooMany = opts.maxLines !== undefined && lines.length > opts.maxLines;
    if ((!tooMany && lines.length * size * lhK <= opts.maxH) || size <= min) return { size, lines, lh: size * lhK };
    size = Math.max(min, Math.floor(size * 0.93));
  }
}

export function rrect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

export function withAlpha(ctx: Ctx, a: number, fn: () => void): void {
  if (a <= 0.001) return;
  ctx.save();
  ctx.globalAlpha *= a;
  fn();
  ctx.restore();
}

/** Scale around a point. */
export function scaled(ctx: Ctx, s: number, cx: number, cy: number, fn: () => void): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.translate(-cx, -cy);
  fn();
  ctx.restore();
}

/** A screen prop's "@x,y x2" zoom (only meaningful with a recording behind it). */
export function screenZoom(a: string): { x: number; y: number; z: number } {
  const at = /@\s*([\d.]+)\s*,\s*([\d.]+)/.exec(a);
  const z = /x\s*([\d.]+)/i.exec(a);
  return { x: at ? Math.min(1, Math.max(0, Number(at[1]))) : 0.5, y: at ? Math.min(1, Math.max(0, Number(at[2]))) : 0.5, z: z ? Math.min(4, Math.max(1, Number(z[1]))) : 1 };
}

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Mouth openness for the spoken line at `local` seconds into the beat: syllable flaps, closed between words. */
export function mouthAt(say: string, local: number, start: number, dur: number): number {
  if (!say || dur <= 0 || local < start || local > start + dur) return 0;
  const u = (local - start) / dur;
  const ch = say[Math.min(say.length - 1, Math.floor(u * say.length))] ?? ' ';
  if (/[\s,.;:!?—-]/.test(ch)) return 0.05;
  const k = local * 11 + hash(Math.floor(local * 4)) * 2;
  return 0.25 + 0.65 * Math.abs(Math.sin(k)) * (0.7 + 0.3 * hash(Math.floor(local * 9)));
}
