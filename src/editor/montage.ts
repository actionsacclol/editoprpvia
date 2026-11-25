import { MAX_KEY_SPEED, MIN_CLIP, MIN_KEY_SPEED, newMediaClip, soundOf, sourceTimeAt, uid, type Keyframe, type MediaClip, type TransitionType } from './timelineStore';

/**
 * Montages cut to music (the "gaming montage" style): the pure half.
 *
 *  - detectBeats: where the beats of a song are (spectral-flux onsets, tempo by
 *    autocorrelation, beats by dynamic programming), which beats likely start
 *    a bar, and where the song lifts ("drops").
 *  - findHighlights: the moments of a recording that stand out of its own
 *    background by ear (gunfire, a kill sound, a shout). It cannot see.
 *  - planMontage: one clip per moment, back to back, each placed and re-timed
 *    so its moment lands exactly on a beat, with a speed ramp into it, a
 *    punch-in and a short shake on the hit.
 *
 * The agent tools that decode audio and call these are in agentTools.ts.
 */

// ── Beats ──────────────────────────────────────────────────────────────────
/** Rate the song is decoded at for beat detection (enough for drums; cheap to transform). */
export const BEAT_RATE = 11025;
const FRAME = 1024;
/** Onset frames per second (about). */
const ONSET_HZ = 100;
const MIN_BPM = 70;
const MAX_BPM = 190;

export interface BeatGrid {
  /** 0 when no steady beat was found. */
  bpm: number;
  /** Seconds from the start of the audio. */
  beats: number[];
  /** Index into beats (0..3) of the beats that most likely start a bar, taking 4/4. */
  barPhase: number;
  /** Where the song lifts, strongest first: time and how much louder it gets (dB). */
  drops: Array<{ at: number; lift: number }>;
  /** 0..1: how regular the pulse is (below about 0.15 there is no real beat). */
  confidence: number;
}

/** In-place radix-2 FFT (re, im of the same power-of-two length). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

function movingMean(src: Float64Array, half: number): Float64Array {
  const out = new Float64Array(src.length);
  let sum = 0;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < src.length; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(src.length, i + half + 1);
    while (hi < b) sum += src[hi++];
    while (lo < a) sum -= src[lo++];
    out[i] = sum / (hi - lo);
  }
  return out;
}

/**
 * How strongly something new starts in each frame: the rise in (compressed)
 * spectrum from one frame to the next, with the slow trend taken out and the
 * whole thing scaled to unit spread. `low` is the same for the bass alone
 * (kick drums: used to tell which beats start a bar); `level` is loudness in dB.
 */
export function onsetStrength(x: Float32Array, rate: number): { all: Float64Array; low: Float64Array; level: Float64Array; hz: number } {
  const hop = Math.max(1, Math.round(rate / ONSET_HZ));
  const hz = rate / hop;
  const n = Math.max(0, Math.floor((x.length - FRAME) / hop) + 1);
  const all = new Float64Array(n);
  const low = new Float64Array(n);
  const level = new Float64Array(n);
  if (n === 0) return { all, low, level, hz };
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const bins = FRAME / 2;
  const lowBins = Math.max(2, Math.round((180 * FRAME) / rate));
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  for (let f = 0; f < n; f++) {
    const o = f * hop;
    let energy = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = x[o + i];
      re[i] = v * win[i];
      im[i] = 0;
      energy += v * v;
    }
    fft(re, im);
    let flux = 0;
    let fluxLow = 0;
    for (let k = 1; k < bins; k++) {
      const mag = Math.log1p(80 * Math.hypot(re[k], im[k]));
      cur[k] = mag;
      const d = mag - prev[k];
      if (d > 0) {
        flux += d;
        if (k <= lowBins) fluxLow += d;
      }
    }
    all[f] = f === 0 ? 0 : flux;
    low[f] = f === 0 ? 0 : fluxLow;
    level[f] = 10 * Math.log10(energy / FRAME + 1e-10);
    const t = prev;
    prev = cur;
    cur = t;
  }
  const tidy = (s: Float64Array): void => {
    const trend = movingMean(s, Math.round(hz * 0.4));
    let sq = 0;
    for (let i = 0; i < n; i++) {
      s[i] = Math.max(0, s[i] - trend[i]);
      sq += s[i] * s[i];
    }
    const sd = Math.sqrt(sq / n) || 1;
    for (let i = 0; i < n; i++) s[i] /= sd;
  };
  tidy(all);
  tidy(low);
  return { all, low, level, hz };
}

/** Beats of a song from its samples (mono). */
export function detectBeats(x: Float32Array, rate: number): BeatGrid {
  const none: BeatGrid = { bpm: 0, beats: [], barPhase: 0, drops: [], confidence: 0 };
  const { all, low, level, hz } = onsetStrength(x, rate);
  const n = all.length;
  if (n < hz * 4) return none;
  // What the beat is tracked on: every onset, with the bass counted extra. A
  // hi-hat fills far more of the spectrum than a kick drum does, and on its
  // own would pull the beats onto the off-beat.
  const o = new Float64Array(n);
  let sq = 0;
  for (let i = 0; i < n; i++) {
    o[i] = all[i] + 2 * low[i];
    sq += o[i] * o[i];
  }
  const sd = Math.sqrt(sq / n) || 1;
  for (let i = 0; i < n; i++) o[i] /= sd;

  // Tempo: the lag at which the onsets best repeat. A song's pulse also
  // repeats at twice and half that lag, so a mild preference for the middle
  // of the range (about 125 BPM) settles which one is called "the beat".
  const minLag = Math.floor((hz * 60) / MAX_BPM);
  const maxLag = Math.min(n - 2, Math.ceil((hz * 60) / MIN_BPM));
  // Around its mean: onsets are never negative, so without this any signal "repeats" at every lag.
  let mu = 0;
  for (let i = 0; i < n; i++) mu += o[i];
  mu /= n;
  const ac = (lag: number): number => {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += (o[i] - mu) * (o[i + lag] - mu);
    return s / (n - lag);
  };
  const zero = ac(0) || 1;
  const acs = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) acs[lag] = ac(lag);
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (hz * 60) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.7, 2));
    const s = acs[lag] * prior;
    if (s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }
  if (bestLag === 0) return none;
  // Between whole frames: the top of a parabola through the peak and its neighbours.
  const y0 = acs[bestLag - 1];
  const y1 = acs[bestLag];
  const y2 = acs[bestLag + 1];
  const denom = y0 - 2 * y1 + y2;
  const period = bestLag + (denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0);
  const confidence = Math.max(0, Math.min(1, y1 / zero));

  // Beats: the sequence of frames that best trades "an onset is here" against
  // "one period after the last beat" (Ellis 2007).
  const tight = 100;
  const score = new Float64Array(n);
  const from = new Int32Array(n).fill(-1);
  const near = Math.round(period / 2);
  const far = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0;
    let bestP = -1;
    for (let p = Math.max(0, t - far); p <= t - near; p++) {
      const l = Math.log((t - p) / period);
      const s = score[p] - tight * l * l;
      if (s > best) {
        best = s;
        bestP = p;
      }
    }
    score[t] = o[t] + best;
    from[t] = bestP;
  }
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > score[end]) end = t;
  const frames: number[] = [];
  for (let t = end; t >= 0; t = from[t]) {
    frames.push(t);
    if (from[t] < 0) break;
  }
  frames.reverse();
  // The tracker carries on through a silent intro or tail: drop beats with nothing under them there.
  const hit = (f: number): number => Math.max(o[f], f > 0 ? o[f - 1] : 0, f + 1 < n ? o[f + 1] : 0);
  const mean = frames.reduce((s, f) => s + hit(f), 0) / Math.max(1, frames.length);
  let a = 0;
  let b = frames.length;
  while (a < b && hit(frames[a]) < mean * 0.25) a++;
  while (b > a && hit(frames[b - 1]) < mean * 0.25) b--;
  const kept = frames.slice(a, b);
  if (kept.length < 4) return none;
  // A hit shows in the spectrum as soon as it enters the tail of a frame's
  // window, well before the window is centred on it: measured on drum loops,
  // it sits 7/8 of a window after the frame's first sample.
  const at = (f: number): number => (f * Math.round(rate / ONSET_HZ) + FRAME * 0.875) / rate;
  const beats = kept.map((f) => Math.round(at(f) * 1000) / 1000);

  // Bars: of the four ways to count in fours, the one whose "ones" carry the most bass.
  let barPhase = 0;
  let barBest = -Infinity;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0;
    let c = 0;
    for (let i = ph; i < kept.length; i += 4) {
      const f = kept[i];
      s += Math.max(low[f], f > 0 ? low[f - 1] : 0, f + 1 < n ? low[f + 1] : 0);
      c++;
    }
    const v = c ? s / c : -Infinity;
    if (v > barBest) {
      barBest = v;
      barPhase = ph;
    }
  }

  // Drops: bar starts where the next two bars are much louder than the two before.
  const avg = (f0: number, f1: number): number => {
    let s = 0;
    let c = 0;
    for (let f = Math.max(0, f0); f < Math.min(n, f1); f++) {
      s += Math.pow(10, level[f] / 10);
      c++;
    }
    return c ? 10 * Math.log10(s / c + 1e-10) : -100;
  };
  const span = Math.round(period * 8);
  const cands: Array<{ at: number; lift: number }> = [];
  for (let i = barPhase; i < kept.length; i += 4) {
    const f = kept[i];
    if (f < span / 2) continue;
    const lift = avg(f, f + span) - avg(f - span, f);
    if (lift >= 3) cands.push({ at: beats[i], lift: Math.round(lift * 10) / 10 });
  }
  cands.sort((p, q) => q.lift - p.lift);
  const drops: BeatGrid['drops'] = [];
  for (const c of cands) {
    if (drops.length >= 4) break;
    if (drops.every((d) => Math.abs(d.at - c.at) > 8)) drops.push(c);
  }

  return { bpm: Math.round(((hz * 60) / period) * 10) / 10, beats, barPhase, drops, confidence: Math.round(confidence * 100) / 100 };
}

// ── Highlights ─────────────────────────────────────────────────────────────
export interface Highlight {
  /** The hit itself: where the sound jumps (seconds in the file). */
  at: number;
  /** How far it stands out of the sound around it, dB. */
  score: number;
  /** The loud stretch around it. */
  from: number;
  to: number;
}

/**
 * The moments that stand out of a recording's own background, loudest first
 * taken, returned in time order. `env` is loudness in dBFS at `hz` frames a
 * second (peaks.ts getEnvelope). Heard, not seen: in gameplay these are
 * fights, kills, explosions and shouting, and also a loud menu sound.
 */
export function findHighlights(env: Float32Array, hz: number, opts: { count?: number; minGap?: number; minScore?: number } = {}): Highlight[] {
  const n = env.length;
  const count = Math.max(1, Math.floor(opts.count ?? 8));
  const gap = Math.max(0.5, opts.minGap ?? 4);
  const minScore = opts.minScore ?? 3;
  if (n < hz * 2) return [];
  let top = -Infinity;
  for (let i = 0; i < n; i++) if (env[i] > top) top = env[i];
  if (!(top > -70)) return [];
  // Power, floored 50 dB under the loudest moment so digital silence doesn't drag the background down.
  const floor = Math.pow(10, (top - 50) / 10);
  const pw = new Float64Array(n);
  for (let i = 0; i < n; i++) pw[i] = Math.max(floor, Math.pow(10, env[i] / 10));
  const db = (s: Float64Array): Float64Array => s.map((v) => 10 * Math.log10(v));
  const short = db(movingMean(pw, Math.max(1, Math.round(hz * 0.15))));
  const quick = db(movingMean(pw, Math.max(1, Math.round(hz * 0.03))));
  // Background: the usual level over the surrounding 20 seconds (mean of dB, so a few bursts don't lift it much).
  const back = movingMean(short, Math.round(hz * 10));
  const score = new Float64Array(n);
  for (let i = 0; i < n; i++) score[i] = short[i] - back[i];

  const order = Array.from({ length: n }, (_, i) => i)
    .filter((i) => score[i] >= minScore && score[i] >= (score[i - 1] ?? -Infinity) && score[i] >= (score[i + 1] ?? -Infinity))
    .sort((p, q) => score[q] - score[p]);
  const picked: number[] = [];
  for (const i of order) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.abs(p - i) >= gap * hz)) picked.push(i);
  }
  const step = Math.max(1, Math.round(hz * 0.05));
  return picked
    .sort((p, q) => p - q)
    .map((i) => {
      const half = score[i] / 2;
      let a = i;
      let b = i;
      while (a > 0 && score[a - 1] > half && i - a < hz * 6) a--;
      while (b < n - 1 && score[b + 1] > half && b - i < hz * 6) b++;
      // The hit: the sharpest rise in the second up to the peak.
      let hit = i;
      let rise = -Infinity;
      for (let k = Math.max(step, i - Math.round(hz)); k <= Math.min(n - 1 - step, i); k++) {
        const r = quick[k + step] - quick[k - step];
        if (r > rise) {
          rise = r;
          hit = k;
        }
      }
      const r2 = (v: number): number => Math.round(v * 100) / 100;
      return { at: r2(hit / hz), score: Math.round(score[i] * 10) / 10, from: r2(a / hz), to: r2((b + 1) / hz) };
    });
}

// ── The montage ────────────────────────────────────────────────────────────
export type Ramp = 'velocity' | 'slowmo' | 'none';
export const RAMPS: Ramp[] = ['velocity', 'slowmo', 'none'];

export interface MontageMoment {
  mediaId: string;
  /** The moment in the file (source seconds): what lands on the beat. */
  at: number;
  sourceDuration: number;
  width: number;
  height: number;
  /** The file has sound of its own (game audio). */
  hasAudio: boolean;
  /** Beats this clip lasts (default: the montage's beats per clip). */
  beats?: number;
  ramp?: Ramp;
}

export interface MontageOptions {
  /** Timeline second the montage starts at. */
  start: number;
  /** Where in the song it starts (song seconds). */
  musicStart: number;
  /** Beats per clip. */
  beatsPerClip: number;
  /** Beats the clip stays up after its moment before the cut. */
  after: number;
  ramp: Ramp;
  /** Punch-in and a short shake on the hit. */
  punch: boolean;
  /** Transition into every clip but the first ("none" = hard cuts). */
  transition: TransitionType;
  /** Game sound under the music, 0 = none. */
  gameVolume: number;
  videoTrack: string;
  soundTrack: string;
}

export interface MontageHit {
  clipId: string;
  mediaId: string;
  /** Timeline seconds. */
  from: number;
  to: number;
  /** When the moment lands (timeline seconds): a beat. */
  impact: number;
  /** Source seconds shown. */
  sourceFrom: number;
  sourceTo: number;
  /** Something had to give (start or end of the file too close). */
  note?: string;
}

export interface MontagePlan {
  clips: MediaClip[];
  hits: MontageHit[];
  /** Timeline second the montage ends at. */
  end: number;
  /** Moments left out because the song ran out of beats. */
  left: number;
}

const key = (prop: string, t: number, value: number, ease: Keyframe['ease'] = 'inout'): Keyframe => ({ id: uid('k'), prop, t, value, ease });

/** Speed keys for a clip whose moment comes `a` seconds in and that runs `b` seconds after it. `lead` / `tail` scale the fast parts. */
function rampKeys(ramp: Ramp, a: number, b: number, lead = 1, tail = 1): Keyframe[] {
  if (ramp === 'none') return [];
  const sp = (v: number): number => Math.min(MAX_KEY_SPEED, Math.max(MIN_KEY_SPEED, v));
  const fast = ramp === 'velocity' ? 2.2 : 1;
  const slow = ramp === 'velocity' ? 0.4 : 0.35;
  const out = ramp === 'velocity' ? 1.8 : 1;
  const brake = Math.max(0, a - Math.min(0.35, a * 0.45));
  const hold = a + Math.min(b * 0.5, 0.3);
  const keys = [key('speed', 0, sp(fast * lead)), key('speed', brake, sp(fast * lead)), key('speed', a, sp(slow * Math.min(1, tail * 2))), key('speed', hold, sp(slow * 1.2 * tail)), key('speed', a + b, sp(out * tail))];
  // Two keys at the same time (a moment right at the cut) would fight: keep the later one.
  return keys.filter((k, i) => i === keys.length - 1 || keys[i + 1].t - k.t > 1e-3);
}

/** Source seconds a clip with these speed keys plays through by clip-local time t. */
function played(keys: Keyframe[], duration: number, t: number): number {
  if (keys.length === 0) return t;
  const probe = newMediaClip({ id: 'montage-probe', mediaId: '', trackId: '', start: 0, duration, keyframes: keys });
  return sourceTimeAt(probe, t);
}

/**
 * Lay the moments out back to back on the song's beats. `beats` are song
 * seconds (detectBeats); `barPhase` says which of them start a bar, so the
 * moments land on the strong beats. The first clip starts at opts.start, every
 * later one on the beat `after` beats past the moment before it.
 */
export function planMontage(moments: MontageMoment[], grid: Pick<BeatGrid, 'beats' | 'barPhase'>, opts: MontageOptions): MontagePlan {
  const per = Math.max(2, Math.round(opts.beatsPerClip));
  const after = Math.max(1, Math.min(per - 1, Math.round(opts.after)));
  // Song time → timeline time.
  const used = grid.beats.map((b, i) => ({ t: opts.start + (b - opts.musicStart), i })).filter((b) => b.t > opts.start + 1e-3);
  const B = used.map((b) => b.t);
  const clips: MediaClip[] = [];
  const hits: MontageHit[] = [];
  if (B.length < 2 || moments.length === 0) return { clips, hits, end: opts.start, left: moments.length };
  const beatLen = (B[B.length - 1] - B[0]) / (B.length - 1);

  // The first moment: a strong beat (bar start when clips are whole bars or half bars) with room for a lead-up.
  const grain = per % 4 === 0 ? 4 : per % 2 === 0 ? 2 : 1;
  const strong = (k: number): boolean => (((used[k].i - grid.barPhase) % grain) + grain) % grain === 0;
  const minLead = Math.max(0.5, beatLen * Math.min(2, per - after) * 0.9);
  let impact = 0;
  while (impact < B.length && !(B[impact] - opts.start >= minLead && strong(impact))) impact++;

  let cut = opts.start;
  let left = 0;
  for (let m = 0; m < moments.length; m++) {
    const mo = moments[m];
    if (m > 0) impact += Math.max(2, Math.round(mo.beats ?? per));
    else if (mo.beats && mo.beats > per) impact += Math.round(mo.beats) - per;
    if (impact + after >= B.length) {
      left = moments.length - m;
      break;
    }
    const x = B[impact];
    const endT = B[impact + after];
    const a = x - cut;
    const b = endT - x;
    const ramp = mo.ramp ?? opts.ramp;
    let note: string | undefined;

    // The speed curve is fitted to the file first, then the in point is whatever
    // puts the moment on the beat through that curve.
    const total = a + b;
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    const fit = (ok: (scale: number) => boolean, lo: number): number => {
      let hi = 1;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        if (ok(mid)) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    const upTo = (k: Keyframe[]): number => played(k, total, a);
    const past = (k: Keyframe[]): number => played(k, total, total) - played(k, total, a);
    let lead = 1;
    let tail = 1;
    // Too close to the end of the file for a fast way out: slow the way out until it fits.
    // (First, because it also lowers the speed at the moment itself, which the lead-up runs into.)
    const roomAfter = mo.sourceDuration - 0.03 - mo.at;
    if (ramp !== 'none' && past(rampKeys(ramp, a, b, lead, tail)) > roomAfter) tail = fit((v) => past(rampKeys(ramp, a, b, lead, v)) <= roomAfter, 0.02);
    // Too close to the start of the file for a fast lead-up: slow the lead-up until it fits.
    if (ramp !== 'none' && upTo(rampKeys(ramp, a, b, lead, tail)) > mo.at) lead = fit((v) => upTo(rampKeys(ramp, a, b, v, tail)) <= mo.at, 0.02);
    const keys = rampKeys(ramp, a, b, lead, tail);
    let inPoint = mo.at - upTo(keys);
    if (inPoint < -1e-6) note = `the moment is only ${r2(mo.at)}s into the file, so it lands ${r2(-inPoint)}s early`;
    inPoint = Math.max(0, inPoint);
    let duration = total;
    const room = mo.sourceDuration - 0.03 - inPoint;
    if (played(keys, total, total) > room + 1e-6) {
      // Still past the end (the moment is in the file's last instants): the clip ends with the footage.
      let lo = MIN_CLIP;
      let hi = total;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (played(keys, total, mid) <= room) lo = mid;
        else hi = mid;
      }
      duration = lo;
      note = `${note ? `${note}; ` : ''}the file ends ${r2(total - duration)}s before the cut`;
    }

    const extra: Keyframe[] = [];
    if (opts.punch && a > 0.12) {
      const back = Math.min(a + b, a + Math.min(0.45, Math.max(0.2, b * 0.8)));
      for (const prop of ['scaleX', 'scaleY']) extra.push(key(prop, Math.max(0, a - 0.07), 1, 'linear'), key(prop, a, 1.14, 'out'), key(prop, back, 1, 'inout'));
      const shake: Array<[number, number, number]> = [[0, 0, 0], [0.05, 0.012, -0.008], [0.1, -0.01, 0.007], [0.15, 0.006, -0.004], [0.2, -0.003, 0.002], [0.26, 0, 0]];
      for (const [dt, dx, dy] of shake) {
        if (a + dt > a + b) break;
        extra.push(key('posX', a + dt, dx, 'linear'), key('posY', a + dt, dy, 'linear'));
      }
    }

    const hasSound = mo.hasAudio && opts.gameVolume > 0;
    const link = hasSound ? uid('l') : undefined;
    const picture = newMediaClip({
      mediaId: mo.mediaId,
      trackId: opts.videoTrack,
      start: cut,
      duration,
      inPoint,
      sourceDuration: mo.sourceDuration,
      sourceWidth: mo.width,
      sourceHeight: mo.height,
      keyframes: [...keys, ...extra],
      muted: true,
      transition: m > 0 ? opts.transition : 'none',
      transitionDur: Math.max(0.08, Math.min(0.18, a * 0.4)),
      ...(link ? { link } : {}),
    });
    clips.push(picture);
    if (link) clips.push({ ...soundOf(picture, opts.soundTrack, link), volume: opts.gameVolume, fadeIn: 0.015, fadeOut: 0.015 });
    hits.push({ clipId: picture.id, mediaId: mo.mediaId, from: cut, to: cut + duration, impact: x, sourceFrom: inPoint, sourceTo: inPoint + played(keys, total, duration), ...(note ? { note } : {}) });
    cut = endT;
  }
  return { clips, hits, end: cut, left };
}
