import { ALL_FORMATS, AudioBufferSink, Input, UrlSource } from 'mediabunny';
import { ENVELOPE_HZ, SILENCE_DB } from './autoEdit';

/**
 * Audio decoding for analysis, transcription and the export mix. Only the
 * audio track is read and decoded (WebCodecs, through mediabunny), a chunk at
 * a time, and only the part asked for: the old path fetched the whole file —
 * gigabytes of video for a long recording — into memory before
 * decodeAudioData could start. Rate conversion is a windowed-sinc filter, the
 * same kind decodeAudioData uses, so nothing is lost on the way. Files
 * mediabunny can't read fall back to decodeAudioData.
 */

// ── Resampling ─────────────────────────────────────────────────────────────
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * Streaming windowed-sinc resampler for one channel. Polyphase: the in/out
 * rate ratio reduces to L/M (44.1k → 16k is 441/160), so every output sample
 * uses one of M precomputed filters over 2R neighbouring inputs. Downsampling
 * low-passes at 92% of the new Nyquist, so nothing aliases.
 */
export class Resampler {
  private readonly L: number;
  private readonly M: number;
  private readonly R: number;
  private readonly taps: Float32Array[];
  private buf = new Float32Array(0);
  /** Absolute input index of buf[0]. */
  private base = 0;
  private len = 0;
  private received = 0;
  /** Next output index. */
  private k = 0;

  constructor(
    readonly inRate: number,
    readonly outRate: number,
  ) {
    let L = Math.round(inRate);
    let M = Math.round(outRate);
    const g = gcd(L, M);
    L /= g;
    M /= g;
    // Odd rates (e.g. 44056 Hz) would need thousands of phases: quantize to 1024.
    if (M > 1024) {
      L = (L * 1024) / M;
      M = 1024;
    }
    this.L = L;
    this.M = M;
    const ratio = inRate / outRate;
    const fc = ratio > 1 ? 0.92 / ratio : 0.97;
    this.R = Math.ceil(10 / fc);
    const R = this.R;
    this.taps = [];
    for (let p = 0; p < M; p++) {
      const frac = p / M; // output k = i + p/M input samples, where k·L = i·M + p
      const t = new Float32Array(2 * R);
      let sum = 0;
      for (let j = 0; j < 2 * R; j++) {
        const x = j - R + 1 - frac; // offset of input i-R+1+j from the centre
        const sx = fc * x;
        const sinc = Math.abs(sx) < 1e-9 ? 1 : Math.sin(Math.PI * sx) / (Math.PI * sx);
        const w = x / R; // Blackman window over [-R, R]
        const win = Math.abs(w) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * w) + 0.08 * Math.cos(2 * Math.PI * w);
        t[j] = sinc * win;
        sum += t[j];
      }
      for (let j = 0; j < 2 * R; j++) t[j] /= sum; // unity gain at DC for every phase
      this.taps.push(t);
    }
  }

  private append(x: Float32Array): void {
    if (this.len + x.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.len + x.length, this.buf.length * 2, 4096));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(x, this.len);
    this.len += x.length;
  }

  /** Outputs computable once inputs up to `limit` (exclusive, absolute) are known. */
  private drain(limit: number, emit: (v: number) => void): void {
    const { L, M, R, taps } = this;
    const buf = this.buf;
    for (;;) {
      const num = this.k * L;
      const i = Math.floor(num / M);
      if (i + R >= limit) break; // needs inputs up to i + R
      const h = taps[num % M | 0] ?? taps[0];
      const from = i - R + 1 - this.base;
      let acc = 0;
      if (from >= 0) {
        for (let j = 0; j < h.length; j++) acc += h[j] * buf[from + j];
      } else {
        for (let j = 0; j < h.length; j++) {
          const idx = from + j;
          if (idx >= 0) acc += h[j] * buf[idx];
        }
      }
      emit(acc);
      this.k++;
    }
    // Drop inputs no future output can reach.
    const keepFrom = Math.floor((this.k * L) / M) - R + 1 - this.base;
    if (keepFrom > 4096) {
      this.buf.copyWithin(0, keepFrom, this.len);
      this.len -= keepFrom;
      this.base += keepFrom;
    }
  }

  /** Feeds input samples; emits every output sample they complete. */
  push(x: Float32Array, emit: (v: number) => void): void {
    if (this.inRate === this.outRate) {
      for (let i = 0; i < x.length; i++) emit(x[i]);
      this.received += x.length;
      return;
    }
    this.append(x);
    this.received += x.length;
    this.drain(this.base + this.len, emit);
  }

  /** Emits the remaining outputs (the input ends here, silence after it). */
  flush(emit: (v: number) => void): void {
    if (this.inRate === this.outRate) return;
    const total = Math.ceil((this.received * this.outRate) / this.inRate - 1e-9);
    this.append(new Float32Array(this.R + 1));
    this.drain(this.base + this.len, (v) => {
      if (this.k < total) emit(v);
    });
  }
}

/** Resample a whole channel at once. */
export function resample(x: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return x.slice();
  const out = new Float32Array(Math.ceil((x.length * outRate) / inRate - 1e-9));
  let n = 0;
  const emit = (v: number): void => {
    if (n < out.length) out[n++] = v;
  };
  const r = new Resampler(inRate, outRate);
  r.push(x, emit);
  r.flush(emit);
  return out;
}

// ── Streaming decode ───────────────────────────────────────────────────────
export interface DecodeRange {
  /** Source seconds to decode from (default 0)… */
  start?: number;
  /** …and to (default: the end). */
  end?: number;
}

interface Opened {
  input: Input;
  sink: AudioBufferSink;
  channels: number;
  duration: number;
}

async function open(url: string): Promise<Opened | null> {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      input.dispose();
      return null;
    }
    if (!(await track.canDecode())) throw new Error(`can't decode ${track.codec ?? 'this audio'}`);
    return { input, sink: new AudioBufferSink(track), channels: track.numberOfChannels, duration: await track.computeDuration() };
  } catch (err) {
    input.dispose();
    throw err;
  }
}

/**
 * Decodes [start, end) of the file's audio at `rate`, writing into arrays from
 * `alloc(channels, length)` (one per channel, or one if `mono`): sample k is
 * source time start + k/rate, gaps in the stream stay silent. Returns false if
 * the file has no audio track.
 */
async function decodeInto(
  url: string,
  rate: number,
  range: DecodeRange,
  mono: boolean,
  alloc: (channels: number, length: number) => Float32Array[],
): Promise<boolean> {
  const src = await open(url);
  if (!src) return false;
  try {
    const start = Math.max(0, range.start ?? 0);
    const end = Math.min(src.duration, range.end ?? src.duration);
    const outCh = mono ? 1 : src.channels;
    const out = alloc(outCh, Math.max(1, Math.ceil((end - start) * rate)));
    if (end <= start) return true;
    // Built from the first decoded buffer: HE-AAC decodes at twice the rate the track declares.
    let rs: Resampler[] | null = null;
    const written = new Array<number>(outCh).fill(0);
    const emitters = out.map((arr, c) => (v: number) => {
      if (written[c] < arr.length) arr[written[c]++] = v;
    });
    let fed = 0; // input samples fed, from `start`
    for await (const { buffer, timestamp } of src.sink.buffers(start, end)) {
      const sr = buffer.sampleRate;
      const n = buffer.length;
      rs ??= Array.from({ length: outCh }, () => new Resampler(sr, rate));
      // Samples of this buffer already covered (the first one can begin before
      // `start`), or, if negative, a gap before it that stays silent.
      const covered = Math.round((start - timestamp) * sr) + fed;
      if (covered < -1) {
        const z = new Float32Array(-covered);
        rs.forEach((r, c) => r.push(z, emitters[c]));
        fed -= covered;
      }
      const skip = Math.max(0, covered);
      if (skip >= n) continue;
      const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).subarray(skip));
      if (mono) {
        const m = new Float32Array(n - skip);
        const inv = 1 / chans.length;
        for (const ch of chans) for (let i = 0; i < m.length; i++) m[i] += ch[i] * inv;
        rs[0].push(m, emitters[0]);
      } else {
        for (let c = 0; c < outCh; c++) rs[c].push(chans[Math.min(c, chans.length - 1)], emitters[c]);
      }
      fed += n - skip;
    }
    rs?.forEach((r, c) => r.flush(emitters[c]));
    return true;
  } finally {
    src.input.dispose();
  }
}

/** The old path, for files mediabunny can't demux or decode: the whole file through decodeAudioData. */
async function decodeLegacy(url: string, rate: number): Promise<AudioBuffer> {
  const ab = await (await fetch(url)).arrayBuffer();
  return new OfflineAudioContext(1, 1, rate).decodeAudioData(ab);
}

/** Mono audio of the file at `rate` (channels averaged). Null if it has no audio. */
export async function decodeMono(url: string, rate: number, range: DecodeRange = {}): Promise<Float32Array | null> {
  let out: Float32Array | null = null;
  try {
    const ok = await decodeInto(url, rate, range, true, (_c, n) => [(out = new Float32Array(n))]);
    return ok ? out : null;
  } catch (err) {
    console.warn('[audio] streaming decode failed, using decodeAudioData', err);
  }
  const buf = await decodeLegacy(url, rate);
  const a = Math.max(0, Math.round((range.start ?? 0) * rate));
  const b = Math.min(buf.length, range.end != null ? Math.round(range.end * rate) : buf.length);
  const m = new Float32Array(Math.max(1, b - a));
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < m.length && a + i < b; i++) m[i] += d[a + i] / buf.numberOfChannels;
  }
  return m;
}

/**
 * The file's audio over `range` as an AudioBuffer of `ctx` at `rate` (all
 * channels), written straight into the buffer's own storage. Null if the file
 * has no audio.
 */
export async function decodeAudioBuffer(url: string, ctx: BaseAudioContext, rate: number, range: DecodeRange = {}): Promise<AudioBuffer | null> {
  let buf: AudioBuffer | null = null;
  try {
    const ok = await decodeInto(url, rate, range, false, (c, n) => {
      buf = ctx.createBuffer(c, n, rate);
      return Array.from({ length: c }, (_, i) => buf!.getChannelData(i));
    });
    return ok ? buf : null;
  } catch (err) {
    console.warn('[audio] streaming decode failed, using decodeAudioData', err);
  }
  const whole = await decodeLegacy(url, rate);
  const a = Math.max(0, Math.round((range.start ?? 0) * rate));
  const b = Math.min(whole.length, range.end != null ? Math.round(range.end * rate) : whole.length);
  const out = ctx.createBuffer(whole.numberOfChannels, Math.max(1, b - a), rate);
  for (let c = 0; c < whole.numberOfChannels; c++) out.copyToChannel(whole.getChannelData(c).subarray(a, Math.max(a + 1, b)), c);
  return out;
}

// ── Waveform + loudness envelope ───────────────────────────────────────────
export interface AudioAnalysis {
  /** Normalized waveform peaks (0..1), `peaksPerSec` per second, from the first channel. */
  peaks: Float32Array;
  /** Loudness in dBFS at ENVELOPE_HZ frames/s (see envelopeDb). */
  envelope: Float32Array;
}

/**
 * Streams the source-rate audio into waveform peaks and the loudness envelope
 * (same definitions as before: peaks are bucket maxima of channel 0; envelope
 * frames are the RMS of the channel mix over a two-hop window centred on the
 * frame). Memory stays at a few hops, whatever the length.
 */
export class AnalysisAccumulator {
  private readonly bucket: number;
  private readonly hop: number;
  private peaks: number[] = [];
  private env: number[] = [];
  private pm = 0;
  private pc = 0;
  private pend = new Float32Array(0);
  private pendStart = 0;
  private pendLen = 0;
  private n = 0;

  constructor(
    readonly sampleRate: number,
    peaksPerSec: number,
  ) {
    this.bucket = Math.max(1, Math.round(sampleRate / peaksPerSec));
    this.hop = Math.max(1, Math.round(sampleRate / ENVELOPE_HZ));
  }

  private frame(final: boolean): boolean {
    const f = this.env.length;
    const s0 = Math.max(0, f * this.hop - (this.hop >> 1));
    let s1 = s0 + 2 * this.hop;
    if (s1 > this.n) {
      if (!final) return false;
      s1 = this.n;
    }
    let acc = 0;
    for (let i = s0; i < s1; i++) {
      const v = this.pend[i - this.pendStart];
      acc += v * v;
    }
    const rms = Math.sqrt(acc / Math.max(1, s1 - s0));
    this.env.push(rms > 1e-5 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB);
    return true;
  }

  push(channels: Float32Array[]): void {
    const len = channels[0]?.length ?? 0;
    const first = channels[0];
    for (let i = 0; i < len; i++) {
      const v = Math.abs(first[i]);
      if (v > this.pm) this.pm = v;
      if (++this.pc === this.bucket) {
        this.peaks.push(this.pm);
        this.pm = 0;
        this.pc = 0;
      }
    }
    if (this.pendLen + len > this.pend.length) {
      const next = new Float32Array(Math.max(this.pendLen + len, this.pend.length * 2, 4 * this.hop));
      next.set(this.pend.subarray(0, this.pendLen));
      this.pend = next;
    }
    const inv = 1 / channels.length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (const ch of channels) v += ch[i];
      this.pend[this.pendLen + i] = v * inv;
    }
    this.pendLen += len;
    this.n += len;
    while (this.frame(false));
    const nextS0 = Math.max(0, this.env.length * this.hop - (this.hop >> 1));
    const drop = nextS0 - this.pendStart;
    if (drop > 0) {
      this.pend.copyWithin(0, drop, this.pendLen);
      this.pendLen -= drop;
      this.pendStart += drop;
    }
  }

  finish(): AudioAnalysis {
    const frames = Math.ceil(this.n / this.hop);
    while (this.env.length < frames) this.frame(true);
    if (this.peaks.length === 0) this.peaks.push(this.pm);
    const peaks = Float32Array.from(this.peaks);
    let max = 0.0001;
    for (const p of peaks) if (p > max) max = p;
    for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
    return { peaks, envelope: Float32Array.from(this.env) };
  }
}

/** Waveform peaks and loudness envelope of the file's audio (null if it has none). */
export async function analyzeAudio(url: string, peaksPerSec: number): Promise<AudioAnalysis | null> {
  let src: Opened | null = null;
  try {
    src = await open(url);
  } catch (err) {
    console.warn('[audio] streaming decode failed, using decodeAudioData', err);
  }
  if (src) {
    try {
      let acc: AnalysisAccumulator | null = null;
      let fed = 0;
      for await (const { buffer, timestamp } of src.sink.buffers()) {
        acc ??= new AnalysisAccumulator(buffer.sampleRate, peaksPerSec);
        const gap = Math.round(timestamp * buffer.sampleRate) - fed;
        if (gap > 1) {
          acc.push([new Float32Array(gap)]);
          fed += gap;
        }
        const skip = Math.max(0, -gap);
        if (skip >= buffer.length) continue;
        acc.push(Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).subarray(skip)));
        fed += buffer.length - skip;
      }
      return acc?.finish() ?? null;
    } finally {
      src.input.dispose();
    }
  }
  const buf = await decodeLegacy(url, 48000);
  const acc = new AnalysisAccumulator(buf.sampleRate, peaksPerSec);
  acc.push(Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)));
  return acc.finish();
}
