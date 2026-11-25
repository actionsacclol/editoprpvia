/**
 * Per-clip sound shaping: a low cut, a three-band EQ, a compressor and pan.
 *
 * The chain is built from Web Audio nodes by one function, used both by the
 * preview's live graph (previewAudio.ts) and by the export's offline mix
 * (export.ts mixAudio), so what is heard while editing is what is written.
 *
 * Order: low cut → EQ → compressor → pan. The clip's volume and fades are
 * applied before the chain in both places, so the compressor reacts to the
 * level the user set.
 */

/** The sound settings a clip can carry (all optional; unset = untouched sound). */
export interface AudioFx {
  /** Stereo position, -1 (left) to 1 (right). */
  pan?: number;
  /** EQ gains in dB (-12 to 12): lows (shelf at 200 Hz), presence (bell at 3 kHz), highs (shelf at 8 kHz). */
  eqLow?: number;
  eqMid?: number;
  eqHigh?: number;
  /** Remove rumble below 80 Hz (desk bumps, traffic, mic handling). */
  lowCut?: boolean;
  /** Compressor amount, 0 (off) to 1: evens out loud and quiet parts. */
  comp?: number;
}

export const EQ_RANGE = 12;
export const EQ_LOW_HZ = 200;
export const EQ_MID_HZ = 3000;
export const EQ_HIGH_HZ = 8000;
export const LOW_CUT_HZ = 80;

/** One click for a spoken voice: rumble out, a little less mud, more presence and air, steadier level. */
export const VOICE_PRESET: Required<Omit<AudioFx, 'pan'>> = { lowCut: true, eqLow: -2, eqMid: 3, eqHigh: 2, comp: 0.5 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The settings with defaults filled in and values held to their ranges. */
export function resolveFx(fx: AudioFx): Required<AudioFx> {
  return {
    pan: clamp(num(fx.pan), -1, 1),
    eqLow: clamp(num(fx.eqLow), -EQ_RANGE, EQ_RANGE),
    eqMid: clamp(num(fx.eqMid), -EQ_RANGE, EQ_RANGE),
    eqHigh: clamp(num(fx.eqHigh), -EQ_RANGE, EQ_RANGE),
    lowCut: fx.lowCut === true,
    comp: clamp(num(fx.comp), 0, 1),
  };
}

/** Whether a clip's sound is shaped at all. */
export function hasAudioFx(fx: AudioFx): boolean {
  const r = resolveFx(fx);
  return r.lowCut || r.comp > 0 || Math.abs(r.pan) > 1e-3 || Math.abs(r.eqLow) > 0.05 || Math.abs(r.eqMid) > 0.05 || Math.abs(r.eqHigh) > 0.05;
}

/** Whether the clip's settings are exactly the voice preset (pan aside). */
export function isVoicePreset(fx: AudioFx): boolean {
  const r = resolveFx(fx);
  return r.lowCut === VOICE_PRESET.lowCut && r.eqLow === VOICE_PRESET.eqLow && r.eqMid === VOICE_PRESET.eqMid && r.eqHigh === VOICE_PRESET.eqHigh && r.comp === VOICE_PRESET.comp;
}

/** A short text that changes whenever the chain would have to be rebuilt. */
export function fxSignature(fx: AudioFx): string {
  if (!hasAudioFx(fx)) return '';
  const r = resolveFx(fx);
  return [r.lowCut ? 1 : 0, r.eqLow.toFixed(1), r.eqMid.toFixed(1), r.eqHigh.toFixed(1), r.comp.toFixed(2), r.pan.toFixed(2)].join('|');
}

/** The compressor settings for an amount between 0 and 1. */
export function compressorSettings(amount: number): { threshold: number; ratio: number; knee: number; attack: number; release: number } {
  const a = clamp(amount, 0, 1);
  return { threshold: -12 - 18 * a, ratio: 1.5 + 4.5 * a, knee: 12, attack: 0.005, release: 0.2 };
}

export interface FxChain {
  input: AudioNode;
  output: AudioNode;
  /** Every node made, for disconnecting. */
  nodes: AudioNode[];
}

/**
 * Build the chain in a context (live or offline). Null when there is nothing
 * to do, so untouched clips cost nothing.
 */
export function buildFxChain(ctx: BaseAudioContext, fx: AudioFx): FxChain | null {
  if (!hasAudioFx(fx)) return null;
  const r = resolveFx(fx);
  const nodes: AudioNode[] = [];
  const biquad = (type: BiquadFilterType, frequency: number, gain: number, q: number): void => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.gain.value = gain;
    f.Q.value = q;
    nodes.push(f);
  };
  if (r.lowCut) biquad('highpass', LOW_CUT_HZ, 0, 0.707);
  if (Math.abs(r.eqLow) > 0.05) biquad('lowshelf', EQ_LOW_HZ, r.eqLow, 0.707);
  if (Math.abs(r.eqMid) > 0.05) biquad('peaking', EQ_MID_HZ, r.eqMid, 0.9);
  if (Math.abs(r.eqHigh) > 0.05) biquad('highshelf', EQ_HIGH_HZ, r.eqHigh, 0.707);
  if (r.comp > 0) {
    const s = compressorSettings(r.comp);
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = s.threshold;
    c.ratio.value = s.ratio;
    c.knee.value = s.knee;
    c.attack.value = s.attack;
    c.release.value = s.release;
    nodes.push(c);
  }
  if (Math.abs(r.pan) > 1e-3) {
    const p = ctx.createStereoPanner();
    p.pan.value = r.pan;
    nodes.push(p);
  }
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return { input: nodes[0], output: nodes[nodes.length - 1], nodes };
}

/** Linear amplitude to decibels (silence is -Infinity). */
export const toDb = (amp: number): number => (amp > 0 ? 20 * Math.log10(amp) : -Infinity);

/** Where a level sits on a meter that runs from `floor` dB (empty) to 0 dB (full), as 0–1. */
export function meterFraction(db: number, floor = -60): number {
  if (!Number.isFinite(db)) return 0;
  return clamp((db - floor) / -floor, 0, 1);
}
