/**
 * WSOLA (waveform-similarity overlap-add) time stretch: change an audio
 * signal's duration without changing its pitch. The preview plays speed-
 * changed clips through HTMLMediaElement with preservesPitch, but WebAudio's
 * playbackRate alone shifts pitch — so the export pre-stretches the PCM and
 * plays it at rate 1, keeping what you hear in the preview and in the file
 * the same.
 */

const FRAME = 2048; // ~43ms at 48kHz
const HOP_OUT = FRAME / 2; // 50% overlap — Hann windows sum to unity
const SEARCH = 448; // max deviation (samples) when hunting for a similar waveform
const SEARCH_STEP = 2;
const CORR = 192; // samples compared per candidate offset

let hannCache: Float32Array | null = null;
function hann(): Float32Array {
  if (!hannCache) {
    hannCache = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) hannCache[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / FRAME));
  }
  return hannCache;
}

/** Offset near `nominal` whose waveform best continues the audio at `natural`. */
function bestOffset(ref: Float32Array, natural: number, nominal: number, inLen: number): number {
  const nat = Math.max(0, Math.min(inLen - CORR, natural));
  let best = nominal;
  let bestScore = -Infinity;
  for (let delta = -SEARCH; delta <= SEARCH; delta += SEARCH_STEP) {
    const cand = nominal + delta;
    if (cand < 0 || cand > inLen - FRAME) continue;
    let score = 0;
    for (let i = 0; i < CORR; i++) score += ref[nat + i] * ref[cand + i];
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}

/**
 * Stretch multi-channel PCM by `rate` (>1 = shorter/faster). All channels use
 * the offsets chosen on channel 0 so the stereo image stays coherent.
 */
export function timeStretch(channels: Float32Array<ArrayBuffer>[], rate: number): Float32Array<ArrayBuffer>[] {
  if (channels.length === 0 || Math.abs(rate - 1) < 1e-3) return channels;
  const inLen = channels[0].length;
  if (inLen < FRAME * 2) return channels;
  const outLen = Math.max(1, Math.round(inLen / rate));
  const hopIn = HOP_OUT * rate;
  const ref = channels[0];
  const win = hann();
  const out = channels.map(() => new Float32Array(outLen + FRAME));

  let prevIn = 0;
  const nFrames = Math.ceil(outLen / HOP_OUT);
  for (let k = 0; k < nFrames; k++) {
    const outPos = k * HOP_OUT;
    let inPos = Math.round(k * hopIn);
    if (k > 0) inPos = bestOffset(ref, prevIn + HOP_OUT, inPos, inLen);
    inPos = Math.max(0, Math.min(inLen - FRAME, inPos));
    for (let ch = 0; ch < channels.length; ch++) {
      const src = channels[ch];
      const dst = out[ch];
      for (let i = 0; i < FRAME; i++) dst[outPos + i] += src[inPos + i] * win[i];
    }
    prevIn = inPos;
  }
  return out.map((o) => o.slice(0, outLen));
}
