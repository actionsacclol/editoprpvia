import type { MediaFile } from '@shared/types';
import { decodeMono } from './audioDecode';
import { fft } from './denoise';
import { freeTrack, hasSpeedKeys, linkedIds, useTimelineStore, type Clip, type MediaClip } from './timelineStore';

/**
 * Sync by sound: line one recording up with another by what they both heard.
 *
 * The case it is for: a camera records picture and scratch sound while a phone
 * or a separate recorder captures the good sound (or a second camera films the
 * same moment). Both heard the same room, so the place where their sound
 * matches best says how far apart they were started.
 *
 * Two microphones never record the same waveform, so the match is made on
 * rhythm instead: how the loudness rises and falls (see onsetEnvelope).
 * A coarse pass at 10 ms finds the offset anywhere in the recordings, a fine
 * pass at 1 ms pins it down, which is well inside a frame.
 */

/** Audio is analysed at this rate (speech and claps live far below 4 kHz). */
export const SYNC_RATE = 8000;
/** No more than this much of each clip is listened to. */
export const SYNC_MAX_SECONDS = 600;
const COARSE_HZ = 100;
const FINE_HZ = 1000;
/** A match has to stand this many standard deviations above the other candidates. */
export const SYNC_MIN_SCORE = 6;
/** …and beat the best candidate elsewhere by this factor (unrelated recordings throw up several similar peaks). */
export const SYNC_MIN_LEAD = 2;

/**
 * Loudness envelope: the log energy of each hop, smoothed over about 30 ms,
 * with the slow drift (anything longer than about 0.6 s) taken out, scaled to
 * zero mean and unit spread. What is left is the rhythm of the sound: syllables,
 * knocks, claps. Two microphones in a room agree on that even when they
 * disagree on tone and level.
 *
 * Quiet is floored 40 dB under the clip's own loud parts, so the jump from
 * digital silence into sound that every file starts with is no bigger than a
 * loud syllable, and values are held to ±3 so no single event decides a match.
 */
export function onsetEnvelope(x: Float32Array, rate: number, envRate: number): Float32Array {
  const hop = Math.max(1, Math.round(rate / envRate));
  const n = Math.floor(x.length / hop);
  const out = new Float32Array(n);
  if (n === 0) return out;
  const energy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    const o = i * hop;
    for (let j = 0; j < hop; j++) e += x[o + j] * x[o + j];
    energy[i] = e / hop;
  }
  // Centred moving average over `w` hops, by running sum.
  const smooth = (src: Float64Array, w: number): Float64Array => {
    const half = Math.max(0, Math.floor(w / 2));
    const dst = new Float64Array(src.length);
    let sum = 0;
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < src.length; i++) {
      const a = Math.max(0, i - half);
      const b = Math.min(src.length, i + half + 1);
      while (hi < b) sum += src[hi++];
      while (lo < a) sum -= src[lo++];
      dst[i] = sum / (hi - lo);
    }
    return dst;
  };
  const e = smooth(energy, Math.max(1, Math.round(0.03 * envRate)));
  const sorted = Float64Array.from(e).sort();
  const loud = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
  const floor = Math.max(1e-10, loud * 1e-4);
  const l = new Float64Array(n);
  for (let i = 0; i < n; i++) l[i] = Math.log(Math.max(e[i], floor));
  const trend = smooth(l, Math.max(3, Math.round(0.6 * envRate)));
  let mean = 0;
  for (let i = 0; i < n; i++) {
    l[i] -= trend[i];
    mean += l[i];
  }
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    l[i] -= mean;
    v += l[i] * l[i];
  }
  const sd = Math.sqrt(v / n) || 1;
  for (let i = 0; i < n; i++) out[i] = Math.max(-3, Math.min(3, l[i] / sd));
  return out;
}

/**
 * Cross-correlation of two series by FFT. The result `c` has `at(k)` =
 * Σ a[n]·b[n − k] for every lag k from −(b.length − 1) to a.length − 1.
 */
export function crossCorrelate(a: Float32Array, b: Float32Array): { at: (k: number) => number; minLag: number; maxLag: number } {
  let n = 1;
  while (n < a.length + b.length) n <<= 1;
  const ar = new Float32Array(n);
  const ai = new Float32Array(n);
  const br = new Float32Array(n);
  const bi = new Float32Array(n);
  ar.set(a);
  br.set(b);
  fft(ar, ai, false);
  fft(br, bi, false);
  for (let i = 0; i < n; i++) {
    // A · conj(B)
    const re = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = re;
    ai[i] = im;
  }
  fft(ar, ai, true);
  return { at: (k) => ar[k >= 0 ? k : n + k], minLag: -(b.length - 1), maxLag: a.length - 1 };
}

export interface SoundOffset {
  /** Seconds the second recording's sound comes after the first's: sound at time u in `b` is at u + offset in `a`. */
  offset: number;
  /** How clearly the best match stands out (standard deviations above the rest). */
  score: number;
  /** The best match against the best one anywhere else (more than half a second away): 1 = no better than the runner-up. */
  lead: number;
}

/** Whether a match is convincing: it stands well above the field and well clear of the runner-up. */
export const soundMatches = (m: SoundOffset): boolean => m.score >= SYNC_MIN_SCORE && m.lead >= SYNC_MIN_LEAD;

/**
 * Where `b` lines up with `a` (both mono at `rate`). Null when either is too
 * short to judge; a low `score` means no convincing match.
 */
export function findSoundOffset(a: Float32Array, b: Float32Array, rate: number): SoundOffset | null {
  const ea = onsetEnvelope(a, rate, COARSE_HZ);
  const eb = onsetEnvelope(b, rate, COARSE_HZ);
  // At least this much has to overlap for a lag to count: a short overlap can match by chance.
  const need = Math.round(Math.min(Math.max(2 * COARSE_HZ, Math.min(ea.length, eb.length) * 0.25), 20 * COARSE_HZ));
  if (ea.length < need || eb.length < need) return null;
  const c = crossCorrelate(ea, eb);
  let best = -Infinity;
  let bestK = 0;
  let sum = 0;
  let sq = 0;
  let count = 0;
  for (let k = c.minLag; k <= c.maxLag; k++) {
    const overlap = Math.min(ea.length, eb.length + k) - Math.max(0, k);
    if (overlap < need) continue;
    // Per overlapping hop, so a lag is not preferred just for overlapping more.
    const v = c.at(k) / Math.sqrt(overlap);
    sum += v;
    sq += v * v;
    count++;
    if (v > best) {
      best = v;
      bestK = k;
    }
  }
  if (count < 3) return null;
  const mean = sum / count;
  const sd = Math.sqrt(Math.max(1e-12, sq / count - mean * mean));
  const score = (best - mean) / sd;
  // The runner-up: the best lag that is not part of the same peak.
  let second = -Infinity;
  const apart = COARSE_HZ / 2;
  for (let k = c.minLag; k <= c.maxLag; k++) {
    if (Math.abs(k - bestK) <= apart) continue;
    const overlap = Math.min(ea.length, eb.length + k) - Math.max(0, k);
    if (overlap < need) continue;
    const v = c.at(k) / Math.sqrt(overlap);
    if (v > second) second = v;
  }
  const lead = second > mean ? (best - mean) / (second - mean) : Infinity;

  // Fine pass: 1 ms envelopes, lags within ±1.5 coarse hops of the coarse answer.
  const fa = onsetEnvelope(a, rate, FINE_HZ);
  const fb = onsetEnvelope(b, rate, FINE_HZ);
  const per = FINE_HZ / COARSE_HZ;
  const centre = bestK * per;
  const reach = Math.ceil(per * 1.5);
  const limit = 180 * FINE_HZ; // three minutes of overlap is plenty to pin a millisecond
  const vals: number[] = [];
  for (let k = centre - reach; k <= centre + reach; k++) {
    const from = Math.max(0, k);
    const to = Math.min(fa.length, fb.length + k, from + limit);
    let v = 0;
    for (let i = from; i < to; i++) v += fa[i] * fb[i - k];
    vals.push(to > from ? v / (to - from) : -Infinity);
  }
  let fi = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i] > vals[fi]) fi = i;
  let fine = centre - reach + fi;
  // Parabola through the peak and its neighbours for the part of a millisecond.
  if (fi > 0 && fi < vals.length - 1) {
    const [l, m, r] = [vals[fi - 1], vals[fi], vals[fi + 1]];
    const den = l - 2 * m + r;
    if (Number.isFinite(l) && Number.isFinite(r) && den < 0) fine += Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den));
  }
  return { offset: fine / FINE_HZ, score, lead };
}

export interface SyncResult {
  /** Seconds the moved clip was shifted on the timeline (positive = later). */
  moved: number;
  score: number;
  /** Ids of the clips that moved (the clip and what is linked to it). */
  ids: string[];
  /** Seconds cut off the moved clip's start because it would have begun before the timeline does. */
  trimmed: number;
}

const constantSpeed = (c: MediaClip): boolean => !hasSpeedKeys(c) && Math.abs(c.speed - 1) < 1e-3 && c.freezeAt == null;

/**
 * Move `clipId` (with what is linked to it) so its sound lines up with the
 * sound of `refId`. One undo step. Throws with a plain reason when it can't.
 */
export async function syncBySound(refId: string, clipId: string, media: MediaFile[]): Promise<SyncResult> {
  const st = useTimelineStore.getState;
  const find = (id: string): MediaClip => {
    const c = st().clips.find((x) => x.id === id);
    if (!c || c.type !== 'media') throw new Error('Sync by sound needs two video or audio clips.');
    return c;
  };
  const ref = find(refId);
  const clip = find(clipId);
  if (ref.id === clip.id) throw new Error('Pick two different clips to sync.');
  const fileOf = (c: MediaClip): MediaFile => {
    const m = media.find((x) => x.id === c.mediaId);
    if (!m || m.kind === 'image') throw new Error('Sync by sound needs two clips with sound.');
    return m;
  };
  const [refFile, clipFile] = [fileOf(ref), fileOf(clip)];
  if (!constantSpeed(ref) || !constantSpeed(clip)) throw new Error('Sync by sound works on clips at normal speed. Sync first, then change the speed.');
  const listen = (c: MediaClip, m: MediaFile): Promise<Float32Array | null> =>
    decodeMono(m.mediaUrl, SYNC_RATE, { start: c.inPoint, end: c.inPoint + Math.min(c.duration, SYNC_MAX_SECONDS) });
  const [a, b] = await Promise.all([listen(ref, refFile), listen(clip, clipFile)]);
  if (!a || !b) throw new Error(`"${(a ? clipFile : refFile).name}" has no sound to listen to.`);
  const found = findSoundOffset(a, b, SYNC_RATE);
  if (!found) throw new Error('The clips are too short to compare.');
  if (!soundMatches(found)) throw new Error("Couldn't find the same sound in both clips. They need to have recorded the same moment (a clap at the start helps).");

  // The clips may have been edited while listening.
  const refNow = find(refId);
  const clipNow = find(clipId);
  let start = refNow.start + found.offset;
  let trimmed = 0;
  if (start < 0) {
    trimmed = Math.min(-start, clipNow.duration - 0.05);
    start = 0;
  }
  const s = st();
  const group = linkedIds(s.clips, [clipNow.id], s.tracks).filter((id) => id !== refNow.id);
  const delta = start - clipNow.start;
  s.pushHistory();
  const next: Clip[] = s.clips.map((c) => {
    if (!group.includes(c.id)) return c;
    const start = Math.max(0, c.start + delta);
    // Started before the timeline does: lose that much of the head instead.
    if (trimmed > 0 && c.type === 'media') return { ...c, start, inPoint: c.inPoint + trimmed * c.speed, duration: Math.max(0.05, c.duration - trimmed) };
    return { ...c, start };
  });
  // Lining up usually lands the clip right under the one it was matched to.
  // Where its own track is already taken there, it goes to a free one.
  let tracks = s.tracks;
  const placed: Clip[] = next.filter((c) => !group.includes(c.id));
  for (const c of next) {
    if (!group.includes(c.id)) continue;
    const end = c.start + c.duration;
    const taken = placed.some((o) => o.trackId === c.trackId && o.start < end - 1e-6 && o.start + o.duration > c.start + 1e-6);
    const kind = tracks.find((t) => t.id === c.trackId)?.kind;
    if (taken && kind) {
      const lane = freeTrack(tracks, placed, kind, c.start, end);
      tracks = lane.tracks;
      placed.push({ ...c, trackId: lane.track.id });
    } else {
      placed.push(c);
    }
  }
  const byId = new Map(placed.map((c) => [c.id, c]));
  useTimelineStore.setState({ clips: next.map((c) => byId.get(c.id) ?? c), tracks });
  return { moved: delta - trimmed, score: found.score, ids: group, trimmed };
}
