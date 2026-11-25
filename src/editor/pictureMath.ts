/**
 * The parts of making a picture on this computer that are plain arithmetic:
 * CLIP's tokenizer (the words become 77 numbers), the noise, and the sampling
 * steps of the two models (pictureWorker.ts runs the networks between them).
 * Pure, so it is tested without a graphics card (test/pictures.test.mjs).
 */

// ── CLIP's byte-pair tokenizer ──────────────────────────────────────

export const CLIP_LENGTH = 77;
const START = '<|startoftext|>';
const END = '<|endoftext|>';
/** CLIP uses the first 48894 merges of its file (49152 - 256 - 2). */
const CLIP_MERGES = 48894;
const WORDS = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/gu;

export interface ClipTokenizer {
  /** Exactly 77 ids: start, the words (cut at 75 pieces), end, then padding with the end id. */
  (text: string): number[];
  /** How many word pieces the text has, before cutting: more than 75 means the tail is not read. */
  count: (text: string) => number;
}

/** `vocab`: piece to id (vocab.json). `merges`: the merge rules, one pair per line, best first (merges.txt). */
export function clipTokenizer(vocab: Record<string, number>, merges: string): ClipTokenizer {
  const rank = new Map<string, number>();
  let n = 0;
  for (const line of merges.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    if (n >= CLIP_MERGES) break;
    rank.set(l, n++);
  }
  const start = vocab[START];
  const end = vocab[END];
  if (typeof start !== 'number' || typeof end !== 'number') throw new Error("The picture model's word list is damaged.");
  const cache = new Map<string, string[]>();

  const bpe = (word: string): string[] => {
    const hit = cache.get(word);
    if (hit) return hit;
    let parts = Array.from(word);
    parts[parts.length - 1] += '</w>';
    while (parts.length > 1) {
      let best = -1;
      let bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = rank.get(`${parts[i]} ${parts[i + 1]}`);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          best = i;
        }
      }
      if (best < 0) break;
      const a = parts[best];
      const b = parts[best + 1];
      const next: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (i < parts.length - 1 && parts[i] === a && parts[i + 1] === b) {
          next.push(a + b);
          i++;
        } else next.push(parts[i]);
      }
      parts = next;
    }
    cache.set(word, parts);
    return parts;
  };

  const pieces = (text: string): number[] => {
    const ids: number[] = [];
    for (const m of text.replace(/\s+/g, ' ').trim().toLowerCase().matchAll(WORDS)) {
      if (m[0] === START || m[0] === END) continue;
      for (const p of bpe(m[0])) ids.push(vocab[p] ?? end);
    }
    return ids;
  };

  const tok = ((text: string): number[] => {
    const ids = [start, ...pieces(text).slice(0, CLIP_LENGTH - 2), end];
    while (ids.length < CLIP_LENGTH) ids.push(end);
    return ids;
  }) as ClipTokenizer;
  tok.count = (text) => pieces(text).length;
  return tok;
}

// ── Noise ───────────────────────────────────────────────────────────

/** Standard normal numbers from a seed: the same seed and words give the same picture. */
export function gaussian(seed: number): () => number {
  let a = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  const uniform = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u < 1e-12) u = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    const th = 2 * Math.PI * uniform();
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
}

export function noise(length: number, next: () => number, scale = 1): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = next() * scale;
  return out;
}

// ── Sampling ────────────────────────────────────────────────────────

let alphas: Float64Array | null = null;
/** Stable Diffusion's noise schedule: how much of the picture is left at each of the 1000 training steps. */
export function alphasCumprod(): Float64Array {
  if (alphas) return alphas;
  const out = new Float64Array(1000);
  const lo = Math.sqrt(0.00085);
  const hi = Math.sqrt(0.012);
  let prod = 1;
  for (let i = 0; i < 1000; i++) {
    const b = lo + ((hi - lo) * i) / 999;
    prod *= 1 - b * b;
    out[i] = prod;
  }
  return (alphas = out);
}

/** The four steps of the LCM model, from all noise down. */
export const LCM_TIMESTEPS: readonly number[] = [999, 759, 499, 259];

/**
 * One LCM step: from the noisy picture `x` and the network's guess of its
 * noise `eps` at step `t`, the cleaned picture; then (unless this is the last
 * step) noised again to the level of `tNext`.
 */
export function lcmStep(x: Float32Array, eps: Float32Array, t: number, tNext: number | null, next: () => number): Float32Array {
  const a = alphasCumprod();
  const at = a[t];
  const sa = Math.sqrt(at);
  const sn = Math.sqrt(1 - at);
  // Boundary condition of the consistency model (sigma_data 0.5, timestep scaling 10).
  const scaled = t * 10;
  const cSkip = 0.25 / (scaled * scaled + 0.25);
  const cOut = scaled / Math.sqrt(scaled * scaled + 0.25);
  const an = tNext === null ? 1 : a[tNext];
  const keep = Math.sqrt(an);
  const add = tNext === null ? 0 : Math.sqrt(1 - an);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const x0 = (x[i] - sn * eps[i]) / sa;
    const den = cOut * x0 + cSkip * x[i];
    out[i] = add === 0 ? den : keep * den + add * next();
  }
  return out;
}

/** The one-step model starts from noise this strong (Euler, trailing spacing: sigma at step 999). */
export const SDXS_SIGMA = 14.614646911621094;
export const SDXS_TIMESTEP = 999;

/** What the one-step network is fed: the noise, scaled down to what it was trained on. */
export function sdxsInput(x: Float32Array): Float32Array {
  const k = 1 / Math.sqrt(SDXS_SIGMA * SDXS_SIGMA + 1);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * k;
  return out;
}

/** The picture (in latent form) from the noise and the network's guess of it. */
export function sdxsStep(x: Float32Array, eps: Float32Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] - SDXS_SIGMA * eps[i];
  return out;
}

/** A decoded picture (three planes of numbers from -1 to 1) as RGBA bytes. */
export function planesToRgba(planes: Float32Array, width: number, height: number): Uint8ClampedArray {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = (planes[i] / 2 + 0.5) * 255;
    out[i * 4 + 1] = (planes[n + i] / 2 + 0.5) * 255;
    out[i * 4 + 2] = (planes[2 * n + i] / 2 + 0.5) * 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Both models draw a square of this many pixels a side, and nothing else: the files are built for it. */
export const LOCAL_SIZE = 512;

/**
 * The part of the drawn square kept for a video's shape. A wide cut is taken
 * from above the middle, not the middle: the models put faces in the upper
 * half, and a centred cut takes the tops of heads off.
 */
export function localCrop(aspect: '16:9' | '9:16' | '1:1', size = LOCAL_SIZE): { x: number; y: number; width: number; height: number } {
  const short = Math.round((size * 9) / 16 / 2) * 2;
  if (aspect === '16:9') return { x: 0, y: Math.round((size - short) * 0.3), width: size, height: short };
  if (aspect === '9:16') return { x: Math.round((size - short) / 2), y: 0, width: short, height: size };
  return { x: 0, y: 0, width: size, height: size };
}
