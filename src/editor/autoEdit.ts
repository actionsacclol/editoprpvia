import type { MediaFile } from '@shared/types';
import { MIN_CLIP, clipHasKeys, hasSpeedKeys, sliceClip, sourceTimeAt, type Clip, type MediaClip, type Track } from './timelineStore';

/**
 * Auto edit — find the dead air and cut it (or just cut *at* it, for punch-in
 * zooms). Everything here is pure: decoded audio becomes a loudness envelope,
 * the envelope (or a Whisper transcript) becomes silence ranges in source
 * time, those map through each clip's trim and speed onto the timeline, and
 * the planner turns timeline + ranges into a new clip list the store commits
 * as one undo step. The dialog (AutoEditDialog.tsx) only wires sliders to
 * these functions and paints the pending ranges on the timeline until the user
 * applies.
 */

export type Range = [number, number];

// ── Loudness envelope ──────────────────────────────────────────────────────
/** Envelope frames per second (10ms hops). */
export const ENVELOPE_HZ = 100;
/** dBFS value standing in for digital silence. */
export const SILENCE_DB = -100;

/**
 * RMS loudness per frame in dBFS, mono-mixed across channels, measured over a
 * two-frame window centred on each frame. Computed once per media file next to
 * the waveform peaks (peaks.ts) and cached — an hour of audio is ~1.4MB.
 */
export function envelopeDb(channels: Float32Array[], sampleRate: number, hz = ENVELOPE_HZ): Float32Array {
  const n = channels[0]?.length ?? 0;
  if (n === 0) return new Float32Array(0);
  const hop = Math.max(1, Math.round(sampleRate / hz));
  const frames = Math.ceil(n / hop);
  const out = new Float32Array(frames);
  const inv = 1 / channels.length;
  for (let f = 0; f < frames; f++) {
    const s0 = Math.max(0, f * hop - (hop >> 1));
    const s1 = Math.min(n, s0 + 2 * hop);
    let acc = 0;
    for (let i = s0; i < s1; i++) {
      let v = 0;
      for (let c = 0; c < channels.length; c++) v += channels[c][i];
      v *= inv;
      acc += v * v;
    }
    const rms = Math.sqrt(acc / Math.max(1, s1 - s0));
    out[f] = rms > 1e-5 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB;
  }
  return out;
}

// ── Range arithmetic ───────────────────────────────────────────────────────
/** Sort and merge overlapping or touching ranges; drops empty ones. */
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter(([a, b]) => b > a).map((r): Range => [r[0], r[1]]).sort((x, y) => x[0] - y[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

/** base minus cuts. Either list may be unsorted or overlapping. */
export function subtractRanges(base: Range[], cuts: Range[]): Range[] {
  const c = mergeRanges(cuts);
  const out: Range[] = [];
  for (const [a0, b0] of mergeRanges(base)) {
    let a = a0;
    for (const [ca, cb] of c) {
      if (cb <= a) continue;
      if (ca >= b0) break;
      if (ca > a) out.push([a, ca]);
      a = Math.max(a, cb);
      if (a >= b0) break;
    }
    if (a < b0) out.push([a, b0]);
  }
  return out;
}

/** The overlap of two range lists. */
export function intersectRanges(a: Range[], b: Range[]): Range[] {
  const xs = mergeRanges(a);
  const ys = mergeRanges(b);
  const out: Range[] = [];
  let i = 0;
  let j = 0;
  while (i < xs.length && j < ys.length) {
    const lo = Math.max(xs[i][0], ys[j][0]);
    const hi = Math.min(xs[i][1], ys[j][1]);
    if (hi > lo) out.push([lo, hi]);
    if (xs[i][1] < ys[j][1]) i++;
    else j++;
  }
  return out;
}

export function rangesTotal(ranges: Range[]): number {
  return ranges.reduce((s, [a, b]) => s + Math.max(0, b - a), 0);
}

/** Merge runs separated by less than `gap` — the blip between them is noise, not content. */
function absorbBlips(runs: Range[], gap: number): Range[] {
  const out: Range[] = [];
  for (const r of mergeRanges(runs)) {
    const last = out[out.length - 1];
    if (last && r[0] - last[1] < gap) last[1] = r[1];
    else out.push([r[0], r[1]]);
  }
  return out;
}

// ── Silence detection ──────────────────────────────────────────────────────
export interface SilenceSettings {
  /**
   * Loudness mode: how far above the clip's own noise floor counts as sound (dB).
   * Speech mode: how much quieter than the speaker's voice a gap must be to count as a pause (dB).
   */
  sensitivityDb: number;
  /** Shortest pause worth cutting (timeline seconds). */
  minPause: number;
  /** Silence kept before a speech onset (s) — handles so cuts don't clip consonants. */
  padBefore: number;
  /** Silence kept after speech ends (s). Wider than padBefore: tails decay slowly. */
  padAfter: number;
  /** Sound blips shorter than this between two pauses are breaths/clicks, not words — absorbed into the cut. */
  minKeep: number;
}

/** Re-entering sound takes this much more than leaving it, so the gate doesn't flicker. */
const HYSTERESIS_DB = 3;
/** The noise floor is this percentile of frame loudness over the analysed window… */
const FLOOR_PERCENTILE = 0.1;
/** …and "loud" this one; together they bound the threshold so a quiet clip is never cut to nothing. */
const LOUD_PERCENTILE = 0.95;
/** Flatter audio than this has no speech to tell apart from the floor. */
const MIN_DYNAMIC_RANGE_DB = 6;
/** Cuts shorter than this aren't worth a seam. */
export const MIN_CUT = 0.1;

export interface LoudnessStats {
  floor: number;
  loud: number;
}

const frameIdx = (env: Float32Array, hz: number, from: number, to: number): [number, number] => {
  const i0 = Math.max(0, Math.min(env.length, Math.floor(from * hz)));
  const i1 = Math.max(i0, Math.min(env.length, Math.ceil(to * hz)));
  return [i0, i1];
};

/** Noise floor / loud level (dBFS) of env over source seconds [from, to). */
export function loudnessStats(env: Float32Array, hz: number, from: number, to: number): LoudnessStats {
  const [i0, i1] = frameIdx(env, hz, from, to);
  if (i1 === i0) return { floor: SILENCE_DB, loud: SILENCE_DB };
  const sorted = env.slice(i0, i1).sort();
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { floor: at(FLOOR_PERCENTILE), loud: at(LOUD_PERCENTILE) };
}

/** Raw quiet runs of env (frames i0..i1) under a hysteresis gate, in source seconds. */
function gateRuns(env: Float32Array, hz: number, i0: number, i1: number, enter: number, exit: number): Range[] {
  const runs: Range[] = [];
  let silent = false;
  let runStart = i0;
  for (let i = i0; i < i1; i++) {
    const v = env[i];
    if (silent) {
      if (v > exit) {
        runs.push([runStart / hz, i / hz]);
        silent = false;
      }
    } else if (v < enter) {
      silent = true;
      runStart = i;
    }
  }
  if (silent) runs.push([runStart / hz, i1 / hz]);
  return runs;
}

/**
 * Raw silent runs → the cuts: only pauses ≥ minPause survive, blips between
 * pauses are absorbed, and each cut is pulled in by the padding so speech
 * keeps its handles. A pause touching the start/end of the window only pads
 * on its speech side. Shared by the loudness and the transcript detectors.
 */
export function refineRuns(runs: Range[], from: number, to: number, s: SilenceSettings, eps = 1e-6): Range[] {
  const merged: Range[] = [];
  for (const r of runs) {
    if (r[1] - r[0] < s.minPause) continue;
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < s.minKeep) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  const out: Range[] = [];
  for (const [a, b] of merged) {
    const a2 = a <= from + eps ? Math.max(from, a) : a + s.padAfter;
    const b2 = b >= to - eps ? Math.min(to, b) : b - s.padBefore;
    if (b2 - a2 >= MIN_CUT) out.push([a2, b2]);
  }
  return out;
}

/**
 * Silent stretches of env within source seconds [from, to), as source-time
 * ranges: a hysteresis gate relative to the adaptive floor finds the raw runs,
 * refineRuns turns them into cuts.
 */
export function detectSilences(
  env: Float32Array,
  hz: number,
  from: number,
  to: number,
  s: SilenceSettings,
  stats: LoudnessStats = loudnessStats(env, hz, from, to),
): Range[] {
  const [i0, i1] = frameIdx(env, hz, from, to);
  if (i1 - i0 < 2 || stats.loud - stats.floor < MIN_DYNAMIC_RANGE_DB) return [];
  const enter = Math.min(stats.floor + s.sensitivityDb, stats.loud - 2); // below → silent
  const exit = enter + HYSTERESIS_DB; // above → sound again
  return refineRuns(gateRuns(env, hz, i0, i1, enter, exit), from, to, s, 0.5 / hz);
}

// ── Transcript-based detection (Whisper word timings) ──────────────────────
/** A timed word — or, from a chunk-level transcript, a whole phrase — in source seconds. */
export interface TimedWord {
  start: number;
  end: number;
  text: string;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  words?: TimedWord[];
}

/** Whisper's word timestamps drift by a couple of hundred ms; speech-derived cuts keep that much extra handle. */
export const WHISPER_SLOP = 0.2;

/** Flatten transcript segments to timed words (segments without word timings count as one word each). */
export function transcriptWords(segments: Segment[]): TimedWord[] {
  const out: TimedWord[] = [];
  for (const s of segments) {
    if (s.words && s.words.length > 0) out.push(...s.words);
    else out.push({ start: s.start, end: s.end, text: s.text });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The stretches of [from, to) not covered by any word (raw, unrefined). */
export function wordGaps(words: TimedWord[], from: number, to: number): Range[] {
  const inWin = words.filter((w) => w.end > from && w.start < to).sort((a, b) => a.start - b.start);
  const runs: Range[] = [];
  let cur = from;
  for (const w of inWin) {
    if (w.start > cur) runs.push([cur, w.start]);
    cur = Math.max(cur, w.end);
  }
  if (cur < to) runs.push([cur, to]);
  return runs;
}

/**
 * Dead air between transcribed words within [from, to): anything that isn't a
 * word. A window with no words at all is left alone rather than deleted
 * wholesale.
 */
export function silencesFromWords(words: TimedWord[], from: number, to: number, s: SilenceSettings): Range[] {
  if (!words.some((w) => w.end > from && w.start < to)) return [];
  return refineRuns(wordGaps(words, from, to), from, to, s);
}

/**
 * How loud the speaker is: the median envelope frame inside transcribed words
 * over [from, to). null when there are no words to measure.
 */
export function voiceLevelDb(env: Float32Array, hz: number, words: TimedWord[], from: number, to: number): number | null {
  const picked: number[] = [];
  for (const w of words) {
    const [i0, i1] = frameIdx(env, hz, Math.max(from, w.start), Math.min(to, w.end));
    for (let i = i0; i < i1; i++) picked.push(env[i]);
  }
  if (picked.length === 0) return null;
  const sorted = Float32Array.from(picked).sort();
  return sorted[sorted.length >> 1];
}

export const FILLER_WORDS = new Set(['um', 'uh', 'uhm', 'umm', 'ummm', 'uhh', 'uhhh', 'er', 'erm', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mmm', 'mhm']);

export function normalizeWord(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9']/g, '');
}

/**
 * Spans of filler words ("um", "uh", …), each widened into the surrounding gap
 * by up to `reach` so the cut lands in silence; neighbouring fillers merge.
 */
export function fillerRanges(words: TimedWord[], reach = 0.15, fillers: Set<string> = FILLER_WORDS): Range[] {
  const out: Range[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!fillers.has(normalizeWord(w.text))) continue;
    const prev = words[i - 1];
    const next = words[i + 1];
    const a = Math.max(prev ? prev.end : 0, w.start - reach, 0);
    const b = Math.min(next ? next.start : Number.POSITIVE_INFINITY, w.end + reach);
    if (b - a >= MIN_CUT) out.push([a, b]);
  }
  return mergeRanges(out);
}

export const RETAKE_MIN_WORDS = 5;
export const RETAKE_WINDOW = 15;

/**
 * False starts: a phrase of ≥ minWords words said again within `window`
 * seconds marks a retake, and everything from the first attempt's start up to
 * the last attempt's start goes. Five words keeps incidental repeats
 * ("and then I was…") out of it.
 */
export function retakeRanges(words: TimedWord[], minWords = RETAKE_MIN_WORDS, window = RETAKE_WINDOW): Range[] {
  const toks = words.map((w) => normalizeWord(w.text));
  const seen = new Map<string, number>(); // phrase → index where it last started
  const out: Range[] = [];
  let skipUntil = -1;
  for (let i = 0; i + minWords <= toks.length; i++) {
    if (toks[i] === '') continue;
    const key = toks.slice(i, i + minWords).join(' ');
    const j = seen.get(key);
    seen.set(key, i);
    if (j == null || i < skipUntil) continue;
    if (j + minWords > i) continue; // overlapping itself ("no no no no no no")
    if (words[i].start - words[j].start > window) continue;
    out.push([words[j].start, words[i].start]);
    skipUntil = i + minWords; // the retry itself is kept; don't match inside it
  }
  return mergeRanges(out);
}

// ── Clip ↔ timeline mapping ────────────────────────────────────────────────
/** Timeline time at which a media clip shows source time `src` (inverse of sourceTimeAt). */
export function timelineTimeAtSource(clip: MediaClip, src: number): number {
  if (!hasSpeedKeys(clip)) return clip.start + (src - clip.inPoint) / clip.speed;
  // Speed curves are integrated numerically, so invert by bisection on the monotonic map.
  let lo = clip.start;
  let hi = clip.start + clip.duration;
  if (src <= sourceTimeAt(clip, lo)) return lo;
  if (src >= sourceTimeAt(clip, hi)) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (sourceTimeAt(clip, mid) < src) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The source window a clip plays, [in, out) in media seconds. */
export function sourceWindow(clip: MediaClip): Range {
  return [clip.inPoint, sourceTimeAt(clip, clip.start + clip.duration)];
}

/** Source-time ranges → timeline ranges clamped to the clip (through its trim and speed). */
export function mapSourceRanges(clip: MediaClip, ranges: Range[]): Range[] {
  const end = clip.start + clip.duration;
  const out: Range[] = [];
  for (const [a, b] of ranges) {
    const ta = Math.max(clip.start, timelineTimeAtSource(clip, a));
    const tb = Math.min(end, timelineTimeAtSource(clip, b));
    if (tb - ta >= MIN_CUT) out.push([ta, tb]);
  }
  return out;
}

/** The settings' durations are timeline seconds; the detectors run in source seconds. */
export function scaleSettings(s: SilenceSettings, rate: number): SilenceSettings {
  return { ...s, minPause: s.minPause * rate, padBefore: s.padBefore * rate, padAfter: s.padAfter * rate, minKeep: s.minKeep * rate };
}

/** Silence in one clip's audio (loudness envelope), as timeline ranges clamped to the clip. */
export function clipSilences(clip: MediaClip, env: Float32Array, hz: number, s: SilenceSettings, stats?: LoudnessStats): Range[] {
  if (clip.freezeAt != null || env.length === 0 || clip.duration <= 0) return [];
  const [from, to] = sourceWindow(clip);
  if (to - from <= 0) return [];
  const rate = (to - from) / clip.duration;
  return mapSourceRanges(clip, detectSilences(env, hz, from, to, scaleSettings(s, rate), stats));
}

export interface SpeechCutFlags {
  fillers: boolean;
  retakes: boolean;
}

/** The loudness side of speech mode: the clip's envelope plus how loud the speaker is in it. */
export interface VoiceRef {
  env: Float32Array;
  hz: number;
  /** From voiceLevelDb; null when it couldn't be measured (then the transcript alone decides). */
  voiceDb: number | null;
}

/**
 * What a transcript says to cut in one clip, as timeline ranges: pauses
 * between words, filler words, retakes. A transcript is not a complete
 * account of speech — Whisper drops words, especially at its 30s chunk seams
 * — so with a VoiceRef a gap only counts as a pause where the sound is also
 * `sensitivityDb` quieter than the speaker's voice. Missed words stay loud,
 * so they stay in. Words are never absorbed as blips; only loud spikes inside
 * a gap are.
 */
export function clipSpeechCuts(clip: MediaClip, words: TimedWord[], s: SilenceSettings, flags: SpeechCutFlags, voice?: VoiceRef): { pauses: Range[]; fillers: Range[]; retakes: Range[] } {
  const none = { pauses: [], fillers: [], retakes: [] };
  if (clip.freezeAt != null || clip.duration <= 0) return none;
  const [from, to] = sourceWindow(clip);
  if (to - from <= 0) return none;
  const rate = (to - from) / clip.duration;
  const inWin = words.filter((w) => w.end > from && w.start < to).sort((a, b) => a.start - b.start);
  if (inWin.length === 0) return none;
  const scaled = scaleSettings({ ...s, padBefore: s.padBefore + WHISPER_SLOP, padAfter: s.padAfter + WHISPER_SLOP }, rate);

  let gaps = wordGaps(inWin, from, to);
  let eps = 1e-6;
  if (voice && voice.voiceDb != null && voice.env.length > 0) {
    const [i0, i1] = frameIdx(voice.env, voice.hz, from, to);
    const enter = voice.voiceDb - s.sensitivityDb;
    const quiet = absorbBlips(gateRuns(voice.env, voice.hz, i0, i1, enter, enter + HYSTERESIS_DB), scaled.minKeep);
    gaps = intersectRanges(gaps, quiet);
    eps = 0.5 / voice.hz;
  }
  return {
    pauses: mapSourceRanges(clip, refineRuns(gaps, from, to, { ...scaled, minKeep: 0 }, eps)),
    fillers: flags.fillers ? mapSourceRanges(clip, fillerRanges(inWin)) : [],
    retakes: flags.retakes ? mapSourceRanges(clip, retakeRanges(inWin)) : [],
  };
}

/**
 * Merge per-clip silences into the timeline's cut list. Where analysed clips
 * overlap in time (a voice track over music, a picture-in-picture) a moment is
 * only cut when *every* clip covering it is silent — one clip's silence must
 * never delete another's speech.
 */
export function combineSilences(items: Array<{ cover: Range; silences: Range[] }>): Range[] {
  const silent = mergeRanges(items.flatMap((i) => i.silences));
  const sound = mergeRanges(items.flatMap((i) => subtractRanges([i.cover], i.silences)));
  return subtractRanges(silent, sound).filter(([a, b]) => b - a >= MIN_CUT);
}

// ── Captions through the cut ───────────────────────────────────────────────
/**
 * Where a source moment of the pieces' media ends up on the new timeline, or
 * null if it was cut. A word or line *start* must fall inside a piece: one
 * sitting exactly on a piece's end is where a cut began, i.e. it was cut.
 */
export function locateSource(pieces: MediaClip[], src: number, asStart = false): { t: number; piece: number } | null {
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (p.freezeAt != null) continue;
    const [a, b] = sourceWindow(p);
    if (src >= a - 1e-6 && (asStart ? src < b - 1e-3 : src <= b + 1e-6)) return { t: timelineTimeAtSource(p, src), piece: i };
  }
  return null;
}

/**
 * Transcript segments (source time) → timeline time through the surviving
 * pieces of their media: words that fell into a cut vanish, and a line is
 * split wherever its words land on different pieces.
 */
export function remapSegments(segments: Segment[], pieces: MediaClip[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    if (seg.words && seg.words.length > 0) {
      let cur: TimedWord[] = [];
      let curPiece = -1;
      const flush = (): void => {
        if (cur.length === 0) return;
        out.push({ start: cur[0].start, end: Math.max(cur[cur.length - 1].end, cur[0].start + 0.3), text: cur.map((w) => w.text).join('').trim(), words: cur });
        cur = [];
      };
      for (const w of seg.words) {
        const loc = locateSource(pieces, w.start, true);
        if (!loc) {
          flush();
          continue;
        }
        if (loc.piece !== curPiece) {
          flush();
          curPiece = loc.piece;
        }
        const p = pieces[loc.piece];
        const endLoc = locateSource(pieces, w.end);
        const te = endLoc && endLoc.piece === loc.piece ? endLoc.t : Math.min(p.start + p.duration, loc.t + (w.end - w.start));
        cur.push({ start: loc.t, end: Math.max(te, loc.t + 0.05), text: w.text });
      }
      flush();
    } else {
      const a = locateSource(pieces, seg.start, true);
      const b = locateSource(pieces, seg.end);
      if (!a && !b) continue;
      const dur = seg.end - seg.start;
      const start = Math.max(0, a ? a.t : (b as { t: number }).t - dur);
      const end = b ? b.t : start + dur;
      out.push({ start, end: Math.max(end, start + 0.3), text: seg.text });
    }
  }
  return out;
}

// ── Planner ────────────────────────────────────────────────────────────────
export interface CutPlan {
  /** Remove the ranges and close the gaps (false = only split there, for zoom-only). */
  remove: boolean;
  /** Alternate a punch-in of this scale on every other piece of each cut video clip; null = off. */
  zoom: number | null;
  /** Micro-fade on audio-only clips at each new seam (s) — masks the click of a hard cut. */
  seamFade: number;
  /** When removing: close the gaps (default) or leave them. */
  ripple?: boolean;
}

export const SEAM_FADE = 0.015;
/** Slivers shorter than this left over beside a cut aren't worth a clip. */
const MIN_PIECE = 0.05;

/** Windows of `span` between the midpoints of the cuts it contains (zoom-only mode keeps all time). */
function splitWindows(span: Range, cuts: Range[]): Range[] {
  const [a, b] = span;
  const pts: number[] = [];
  for (const [ca, cb] of cuts) {
    const mid = (ca + cb) / 2;
    if (mid <= a || mid >= b) continue;
    const prev = pts.length > 0 ? pts[pts.length - 1] : a;
    if (mid - prev < MIN_CLIP || b - mid < MIN_CLIP) continue;
    pts.push(mid);
  }
  const out: Range[] = [];
  let cur = a;
  for (const p of pts) {
    out.push([cur, p]);
    cur = p;
  }
  out.push([cur, b]);
  return out;
}

/** How many pieces a clip ends up in under these cuts (for the dialog's summary). */
export function pieceCount(clip: Clip, cuts: Range[], remove: boolean): number {
  const span: Range = [clip.start, clip.start + clip.duration];
  return remove ? subtractRanges([span], cuts).filter(([a, b]) => b - a >= MIN_PIECE).length : splitWindows(span, cuts).length;
}

/**
 * The timeline with `ranges` cut out of it. Every clip on an unlocked track is
 * sliced around the ranges (keyframes, captions' word timings, fades and
 * transitions handled by sliceClip) and, when removing, everything after a cut
 * slides left by the removed time — a ripple across all tracks, so detached
 * audio, captions and overlays stay in sync. Locked tracks are left untouched.
 */
export function planCuts(clips: Clip[], tracks: Track[], media: Array<Pick<MediaFile, 'id' | 'kind'>>, ranges: Range[], plan: CutPlan): Clip[] {
  const cuts = mergeRanges(ranges);
  if (cuts.length === 0) return clips;
  const locked = new Set(tracks.filter((t) => t.locked).map((t) => t.id));
  const kind = new Map(media.map((m) => [m.id, m.kind]));
  const removedBefore = (t: number): number => {
    let s = 0;
    for (const [a, b] of cuts) {
      if (b <= t + 1e-6) s += b - a;
      else break;
    }
    return s;
  };

  const out: Clip[] = [];
  for (const clip of clips) {
    if (locked.has(clip.trackId)) {
      out.push(clip);
      continue;
    }
    const span: Range = [clip.start, clip.start + clip.duration];
    const windows = plan.remove ? subtractRanges([span], cuts).filter(([a, b]) => b - a >= MIN_PIECE) : splitWindows(span, cuts);
    if (windows.length === 0) continue; // the whole clip sat inside the dead air
    const pieces = windows.map(([a, b], i) => sliceClip(clip, a, b, { keepId: i === 0 }));

    const mediaKind = clip.type === 'media' ? kind.get(clip.mediaId) : undefined;
    const audioOnly = mediaKind === 'audio';
    const zoomable = plan.zoom != null && mediaKind === 'video' && pieces.length > 1 && !clipHasKeys(clip, 'scaleX') && !clipHasKeys(clip, 'scaleY');
    const nudge = !clipHasKeys(clip, 'posY');

    pieces.forEach((p, i) => {
      const piece: Clip = { ...p };
      const atHead = Math.abs(piece.start - span[0]) <= 1e-6;
      const atTail = Math.abs(piece.start + piece.duration - span[1]) <= 1e-6;
      if (plan.remove && audioOnly) {
        if (!atHead) piece.fadeIn = Math.max(piece.fadeIn, plan.seamFade);
        if (!atTail) piece.fadeOut = Math.max(piece.fadeOut, plan.seamFade);
      }
      if (zoomable && i % 2 === 1 && piece.type === 'media' && plan.zoom != null) {
        piece.scaleX *= plan.zoom;
        piece.scaleY *= plan.zoom;
        // Zooming about the centre pushes a face in the upper third up and out;
        // nudging the picture down by a sixth of the growth keeps it where it was.
        if (nudge) piece.posY += (plan.zoom - 1) / 6;
      }
      if (plan.remove && plan.ripple !== false) piece.start -= removedBefore(piece.start);
      out.push(piece);
    });
  }
  return out;
}

// ── One analysis for the dialog and the agent tools ────────────────────────
export interface CutAnalysis {
  cuts: Range[];
  pauses: number;
  fillers: number;
  retakes: number;
}

export interface AnalyzeInput {
  mode: AnalysisMode;
  /** The clips being listened to (media clips with audio). */
  clips: MediaClip[];
  settings: AutoEditSettings;
  envelope: (mediaId: string) => Float32Array | undefined;
  /** Speech mode: transcript words per media (source seconds). */
  words?: (mediaId: string) => TimedWord[] | undefined;
  /** Optional caches keyed per clip window, so slider drags don't re-sort envelopes. */
  statsCache?: Map<string, LoudnessStats>;
  voiceCache?: Map<string, number | null>;
}

/** Everything auto edit would cut for these clips and settings, as merged timeline ranges. */
export function analyzeCuts(input: AnalyzeInput): CutAnalysis {
  const { mode, clips, settings } = input;
  const items: Array<{ cover: Range; silences: Range[] }> = [];
  if (mode === 'loudness') {
    for (const c of clips) {
      const env = input.envelope(c.mediaId);
      if (!env || env.length === 0) continue;
      const [from, to] = sourceWindow(c);
      const key = `${c.mediaId}:${from.toFixed(3)}:${to.toFixed(3)}`;
      let stats = input.statsCache?.get(key);
      if (!stats) {
        stats = loudnessStats(env, ENVELOPE_HZ, from, to);
        input.statsCache?.set(key, stats);
      }
      items.push({ cover: [c.start, c.start + c.duration], silences: clipSilences(c, env, ENVELOPE_HZ, settings, stats) });
    }
    const cuts = combineSilences(items);
    return { cuts, pauses: cuts.length, fillers: 0, retakes: 0 };
  }
  const fill: Range[] = [];
  const ret: Range[] = [];
  // Fillers and retakes are removals by nature; in zoom-only mode only the pauses matter.
  const flags = { fillers: settings.removePauses && settings.fillers, retakes: settings.removePauses && settings.retakes };
  for (const c of clips) {
    const words = input.words?.(c.mediaId);
    if (!words) continue;
    const env = input.envelope(c.mediaId) ?? new Float32Array(0);
    const [from, to] = sourceWindow(c);
    const key = `${c.mediaId}:${from.toFixed(3)}:${to.toFixed(3)}`;
    let voiceDb = input.voiceCache?.get(key);
    if (voiceDb === undefined) {
      voiceDb = voiceLevelDb(env, ENVELOPE_HZ, words, from, to);
      input.voiceCache?.set(key, voiceDb);
    }
    const r = clipSpeechCuts(c, words, settings, flags, { env, hz: ENVELOPE_HZ, voiceDb });
    items.push({ cover: [c.start, c.start + c.duration], silences: r.pauses });
    fill.push(...r.fillers);
    ret.push(...r.retakes);
  }
  const pauses = combineSilences(items);
  const fillers = mergeRanges(fill);
  const retakes = mergeRanges(ret);
  return { cuts: mergeRanges([...pauses, ...fillers, ...retakes]), pauses: pauses.length, fillers: fillers.length, retakes: retakes.length };
}

// ── Presets ────────────────────────────────────────────────────────────────
export type AnalysisMode = 'loudness' | 'speech';

export interface AutoEditSettings extends SilenceSettings {
  /** Remove what was found (true) or only cut there for zooms (false). */
  removePauses: boolean;
  /** Alternate a punch-in zoom on each cut of a video clip. */
  zoom: boolean;
  zoomScale: number;
  /** Speech mode only: also cut filler words / retakes. */
  fillers: boolean;
  retakes: boolean;
}

export interface AutoEditPreset {
  id: string;
  label: string;
  hint: string;
  settings: AutoEditSettings;
  /** Picking the preset also switches the analysis mode (e.g. gameplay needs the transcript). */
  mode?: AnalysisMode;
}

export const AUTO_EDIT_PRESETS: AutoEditPreset[] = [
  {
    id: 'talking',
    label: 'Talking head',
    hint: 'Vlogs, reactions, yapping to camera: tight cuts, with alternating punch-ins to hide the jumps.',
    settings: { sensitivityDb: 12, minPause: 0.4, padBefore: 0.06, padAfter: 0.15, minKeep: 0.25, removePauses: true, zoom: true, zoomScale: 1.12, fillers: true, retakes: true },
  },
  {
    id: 'voiceover',
    label: 'Voice-over',
    hint: 'Tutorials and screen recordings: trims the pauses and leaves the picture alone.',
    settings: { sensitivityDb: 12, minPause: 0.7, padBefore: 0.1, padAfter: 0.22, minKeep: 0.3, removePauses: true, zoom: false, zoomScale: 1.1, fillers: true, retakes: true },
  },
  {
    id: 'podcast',
    label: 'Podcast',
    hint: 'Conversations: only the long gaps go, with roomy handles so it still breathes.',
    settings: { sensitivityDb: 10, minPause: 1.0, padBefore: 0.15, padAfter: 0.3, minKeep: 0.4, removePauses: true, zoom: false, zoomScale: 1.1, fillers: false, retakes: false },
  },
  {
    id: 'gameplay',
    label: 'Gameplay',
    hint: 'Commentary over game audio: listens for your voice with Whisper and cuts the long stretches where you say nothing.',
    settings: { sensitivityDb: 5, minPause: 2.0, padBefore: 0.3, padAfter: 0.5, minKeep: 0.5, removePauses: true, zoom: false, zoomScale: 1.1, fillers: false, retakes: false },
    mode: 'speech',
  },
  {
    id: 'zooms',
    label: 'Zooms only',
    hint: 'Keeps every frame — just cuts at the pauses and alternates a punch-in.',
    settings: { sensitivityDb: 12, minPause: 0.6, padBefore: 0.06, padAfter: 0.15, minKeep: 0.25, removePauses: false, zoom: true, zoomScale: 1.12, fillers: false, retakes: false },
  },
];
