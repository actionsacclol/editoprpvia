import { ALL_FORMATS, CanvasSink, Input, UrlSource } from 'mediabunny';
import type { MediaFile } from '@shared/types';
import { getEnvelope } from './peaks';
import type { EditStyle } from './styles';

/**
 * Reference-video analysis: measure how a finished video is edited so an
 * agent can make the user's project feel the same. The numbers (shot length,
 * cut rate, fades, colour, how much of it has sound) come from sampling small
 * frames; the things only eyes can judge (caption and title typography,
 * framing, graphics) are left to the agent, which gets real frames back.
 */

/** Colour and tone of one small frame. */
export interface FrameStats {
  /** Normalised 4×4×4 RGB histogram (sums to 1). */
  hist: Float32Array;
  /** Mean luma, 0..1. */
  luma: number;
  /** Luma standard deviation, 0..1 (contrast). */
  spread: number;
  /** Mean HSV saturation, 0..1. */
  saturation: number;
  /** Red against blue, -1 (cool) .. 1 (warm). */
  warmth: number;
}

export function frameStats(rgba: Uint8ClampedArray | Uint8Array): FrameStats {
  const hist = new Float32Array(64);
  const n = Math.floor(rgba.length / 4);
  let sum = 0;
  let sumSq = 0;
  let sat = 0;
  let red = 0;
  let blue = 0;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    hist[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)]++;
    const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sum += y;
    sumSq += y * y;
    const mx = Math.max(r, g, b);
    sat += mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
    red += r;
    blue += b;
  }
  if (n === 0) return { hist, luma: 0, spread: 0, saturation: 0, warmth: 0 };
  for (let k = 0; k < 64; k++) hist[k] /= n;
  const luma = sum / n;
  return { hist, luma, spread: Math.sqrt(Math.max(0, sumSq / n - luma * luma)), saturation: sat / n, warmth: red + blue > 0 ? (red - blue) / (red + blue) : 0 };
}

/** How different two frames are, 0 (same) .. 1 (nothing in common). */
export function frameDistance(a: FrameStats, b: FrameStats): number {
  let d = 0;
  for (let k = 0; k < 64; k++) d += Math.abs(a.hist[k] - b.hist[k]);
  return d / 2;
}

const HARD_CUT = 0.42;
const SOFT_CUT = 0.2;
const MIN_SHOT = 0.25;

/**
 * Times where the picture cuts. A cut is a frame far from the one before it:
 * either very far, or clearly further than the motion around it (so a shaky
 * or fast-moving shot doesn't read as a string of cuts).
 */
export function detectCuts(stats: FrameStats[], times: number[]): number[] {
  const d = stats.map((s, i) => (i === 0 ? 0 : frameDistance(stats[i - 1], s)));
  const cuts: number[] = [];
  for (let i = 1; i < d.length; i++) {
    let around = 0;
    let count = 0;
    for (let j = Math.max(1, i - 3); j <= Math.min(d.length - 1, i + 3); j++) {
      if (j === i) continue;
      around += d[j];
      count++;
    }
    const local = count > 0 ? around / count : 0;
    const isCut = d[i] >= HARD_CUT || (d[i] >= SOFT_CUT && d[i] >= local * 4);
    if (isCut && (cuts.length === 0 || times[i] - cuts[cuts.length - 1] >= MIN_SHOT)) cuts.push(times[i]);
  }
  return cuts;
}

/** Runs of near-black frames: fades and dips to black. */
export function countBlackDips(stats: FrameStats[]): number {
  let dips = 0;
  let dark = false;
  for (let i = 0; i < stats.length; i++) {
    const isDark = stats[i].luma < 0.035;
    // The very first and last frames being black is a fade in / out, not a dip between scenes.
    if (isDark && !dark && i > 0) dips++;
    dark = isDark;
  }
  return dark && dips > 0 ? dips - 1 : dips;
}

export interface Tone {
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
}

export function averageTone(stats: FrameStats[]): Tone {
  // Black frames (fades, cards) would drag every average down.
  const lit = stats.filter((s) => s.luma >= 0.035);
  const src = lit.length > 0 ? lit : stats;
  const avg = (f: (s: FrameStats) => number): number => (src.length ? src.reduce((a, s) => a + f(s), 0) / src.length : 0);
  return { brightness: avg((s) => s.luma), contrast: avg((s) => s.spread), saturation: avg((s) => s.saturation), warmth: avg((s) => s.warmth) };
}

export interface ReferenceProfile {
  duration: number;
  /** Seconds actually analysed (long references are capped). */
  analysed: number;
  width: number;
  height: number;
  /** Closest canvas preset. */
  aspect: '16:9' | '9:16' | '1:1' | '4:5';
  shots: number;
  cutsPerMinute: number;
  averageShot: number;
  medianShot: number;
  shortestShot: number;
  longestShot: number;
  pace: 'very fast' | 'fast' | 'medium' | 'slow';
  blackDips: number;
  tone: Tone;
  /** Share of the audio that is not silence, 0..1 (null without an audio track). */
  soundCoverage: number | null;
  /** Timeline of the cuts, seconds. */
  cuts: number[];
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

export function nearestAspect(width: number, height: number): ReferenceProfile['aspect'] {
  const ratio = width > 0 && height > 0 ? width / height : 16 / 9;
  const options: Array<[ReferenceProfile['aspect'], number]> = [['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['4:5', 4 / 5]];
  return options.reduce((best, o) => (Math.abs(Math.log(o[1] / ratio)) < Math.abs(Math.log(best[1] / ratio)) ? o : best))[0];
}

export function buildProfile(input: { duration: number; width: number; height: number; stats: FrameStats[]; times: number[]; soundCoverage: number | null }): ReferenceProfile {
  const { stats, times } = input;
  const analysed = times.length > 0 ? Math.min(input.duration, times[times.length - 1] + (times.length > 1 ? times[1] - times[0] : 0)) : 0;
  const cuts = detectCuts(stats, times);
  const edges = [0, ...cuts, analysed];
  const lengths = edges.slice(1).map((e, i) => e - edges[i]).filter((l) => l > 0);
  const sorted = [...lengths].sort((a, b) => a - b);
  const averageShot = lengths.length ? analysed / lengths.length : analysed;
  const medianShot = sorted.length ? sorted[Math.floor(sorted.length / 2)] : analysed;
  return {
    duration: r2(input.duration),
    analysed: r2(analysed),
    width: input.width,
    height: input.height,
    aspect: nearestAspect(input.width, input.height),
    shots: lengths.length,
    cutsPerMinute: analysed > 0 ? r2((cuts.length / analysed) * 60) : 0,
    averageShot: r2(averageShot),
    medianShot: r2(medianShot),
    shortestShot: r2(sorted[0] ?? analysed),
    longestShot: r2(sorted[sorted.length - 1] ?? analysed),
    pace: medianShot < 1.6 ? 'very fast' : medianShot < 3.5 ? 'fast' : medianShot < 8 ? 'medium' : 'slow',
    blackDips: countBlackDips(stats),
    tone: averageTone(stats),
    soundCoverage: input.soundCoverage,
    cuts: cuts.map(r2),
  };
}

const clampTo = (v: number, lo: number, hi: number): number => Math.round(Math.min(hi, Math.max(lo, v)));

/**
 * update_clip values that move footage with tone `own` towards the reference's
 * tone. Ratios, held to a sane range: a grade should nudge, not wreck.
 */
export function gradeTowards(ref: Tone, own: Tone): NonNullable<EditStyle['grade']> {
  const ratio = (a: number, b: number): number => (b > 1e-3 ? a / b : 1);
  const g: NonNullable<EditStyle['grade']> = {
    brightness: clampTo(100 * ratio(ref.brightness, own.brightness), 75, 135),
    contrast: clampTo(100 * ratio(ref.contrast, own.contrast), 75, 145),
    saturation: clampTo(100 * ratio(ref.saturation, own.saturation), 50, 170),
  };
  // Within 4% is the same as far as an eye can tell: leave it alone.
  for (const k of ['brightness', 'contrast', 'saturation'] as const) if (Math.abs(g[k]! - 100) < 4) delete g[k];
  return g;
}

/** The parts of an edit style the measurements can fill in (the agent adds captions, titles and cards from the frames). */
export function suggestStyle(p: ReferenceProfile, own: Tone | null): Partial<EditStyle> {
  const fast = p.medianShot < 3.5;
  const out: Partial<EditStyle> = {
    pacing: { min_pause: p.medianShot < 1.6 ? 0.3 : fast ? 0.4 : p.medianShot < 8 ? 0.6 : 0.9, zoom: fast, shot_seconds: Math.max(0.8, Math.round(p.medianShot * 10) / 10) },
    transition: p.blackDips >= 2 ? { type: 'dip', duration: 0.6 } : { type: 'none' },
  };
  if (fast) out.motion = { motion: 'zoom-in', amount: 1, every: 'alternate' };
  else if (p.medianShot >= 5) out.motion = { motion: 'zoom-in', amount: 0.6, every: 'all' };
  if (own) {
    const grade = gradeTowards(p.tone, own);
    if (Object.keys(grade).length > 0) out.grade = grade;
  }
  return out;
}

/** Share of an audio envelope (dBFS) that is louder than near-silence. */
export function soundCoverage(envelope: Float32Array): number | null {
  if (envelope.length === 0) return null;
  let loud = 0;
  for (let i = 0; i < envelope.length; i++) if (envelope[i] > -45) loud++;
  return loud / envelope.length;
}

// ── Reading frames ─────────────────────────────────────────────────────────
const SAMPLE_FPS = 5;
const SAMPLE_WIDTH = 64;

interface Sampled {
  duration: number;
  width: number;
  height: number;
  stats: FrameStats[];
  times: number[];
}

function pixels(canvas: HTMLCanvasElement | OffscreenCanvas): Uint8ClampedArray | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  return ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height).data : null;
}

async function sampleStats(media: MediaFile, times: (duration: number) => number[], signal: AbortSignal | undefined, onProgress?: (r: number) => void): Promise<Sampled> {
  const input = new Input({ source: new UrlSource(media.mediaUrl), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`${media.name} has no video track.`);
    const duration = await track.computeDuration();
    const at = times(duration);
    const sink = new CanvasSink(track, { width: SAMPLE_WIDTH, poolSize: 2 });
    const stats: FrameStats[] = [];
    const kept: number[] = [];
    let i = 0;
    for await (const frame of sink.canvasesAtTimestamps(at)) {
      if (signal?.aborted) throw new Error('Cancelled.');
      const t = at[i++];
      const px = frame ? pixels(frame.canvas) : null;
      if (px) {
        stats.push(frameStats(px));
        kept.push(t);
      }
      onProgress?.(i / at.length);
    }
    return { duration, width: track.displayWidth, height: track.displayHeight, stats, times: kept };
  } finally {
    input.dispose();
  }
}

const evenly = (duration: number, count: number): number[] => Array.from({ length: count }, (_, k) => (duration * (k + 0.5)) / count);

/** The overall tone of a video from a couple of dozen frames spread across it. */
export async function measureTone(media: MediaFile, signal?: AbortSignal): Promise<Tone> {
  const s = await sampleStats(media, (d) => evenly(Math.max(0.1, d - 0.1), 24), signal);
  return averageTone(s.stats);
}

/** JPEG stills (base64) at the given source times, long edge about 640px. */
export async function stills(media: MediaFile, times: number[], signal?: AbortSignal): Promise<string[]> {
  if (times.length === 0) return [];
  const input = new Input({ source: new UrlSource(media.mediaUrl), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return [];
    const tall = track.displayHeight > track.displayWidth;
    const sink = new CanvasSink(track, tall ? { height: 640, poolSize: 1 } : { width: 640, poolSize: 1 });
    const out: string[] = [];
    for await (const frame of sink.canvasesAtTimestamps(times)) {
      if (signal?.aborted) throw new Error('Cancelled.');
      if (!frame) continue;
      const c = frame.canvas;
      let url: string;
      if ('toDataURL' in c) url = c.toDataURL('image/jpeg', 0.82);
      else {
        const copy = document.createElement('canvas');
        copy.width = c.width;
        copy.height = c.height;
        copy.getContext('2d')?.drawImage(c, 0, 0);
        url = copy.toDataURL('image/jpeg', 0.82);
      }
      out.push(url.slice(url.indexOf(',') + 1));
    }
    return out;
  } finally {
    input.dispose();
  }
}

/** Where to look: the middle of the longest shots first (titles and captions sit still there), in time order. */
export function frameTimes(cuts: number[], analysed: number, count: number): number[] {
  const edges = [0, ...cuts, analysed];
  const shots = edges.slice(1).map((e, i) => ({ mid: (edges[i] + e) / 2, len: e - edges[i] })).filter((s) => s.len > 0);
  if (shots.length <= count) {
    // Few shots: spread the remaining looks evenly so a long take is still covered.
    const extra = evenly(analysed, count - shots.length);
    return [...shots.map((s) => s.mid), ...extra].sort((a, b) => a - b).map(r2);
  }
  // Many shots: one from each of `count` equal stretches of the video, the longest shot in each.
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    const lo = (analysed * k) / count;
    const hi = (analysed * (k + 1)) / count;
    const inside = shots.filter((s) => s.mid >= lo && s.mid < hi);
    if (inside.length > 0) out.push(inside.reduce((a, b) => (b.len > a.len ? b : a)).mid);
  }
  return out.map(r2);
}

export interface ReferenceResult {
  profile: ReferenceProfile;
  /** Times of the returned frames, seconds into the reference. */
  frameTimes: number[];
  /** JPEG base64. */
  frames: string[];
}

/** Analyse a reference video: up to `maxSeconds` of it, returning `frameCount` stills to look at. */
export async function analyzeReference(
  media: MediaFile,
  opts: { maxSeconds?: number; frameCount?: number; signal?: AbortSignal; onProgress?: (ratio: number, status: string) => void } = {},
): Promise<ReferenceResult> {
  const maxSeconds = Math.max(10, opts.maxSeconds ?? 180);
  opts.onProgress?.(0, `Reading ${media.name}…`);
  const sampled = await sampleStats(
    media,
    (d) => {
      const span = Math.min(d, maxSeconds);
      return Array.from({ length: Math.max(2, Math.floor(span * SAMPLE_FPS)) }, (_, k) => k / SAMPLE_FPS);
    },
    opts.signal,
    (r) => opts.onProgress?.(r * 0.85, `Finding the cuts in ${media.name}…`),
  );
  if (sampled.stats.length < 2) throw new Error(`Could not read frames from ${media.name}.`);
  let coverage: number | null = null;
  try {
    coverage = soundCoverage(await getEnvelope(media));
  } catch {
    /* no audio track, or it would not decode: leave it unknown */
  }
  const profile = buildProfile({ ...sampled, soundCoverage: coverage });
  opts.onProgress?.(0.9, 'Grabbing frames…');
  const at = frameTimes(profile.cuts, profile.analysed, Math.max(1, Math.min(10, opts.frameCount ?? 6)));
  const frames = await stills(media, at, opts.signal);
  return { profile, frameTimes: at.slice(0, frames.length), frames };
}
