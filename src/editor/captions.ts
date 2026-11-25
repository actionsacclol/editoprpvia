import type { MediaFile } from '@shared/types';
import type { Clip, MediaClip } from './timelineStore';
import type { CaptionWord, SpeechDevice, WorkerSegment } from './captionWorker';
import { decodeMono } from './audioDecode';

/**
 * Auto-captions + subtitles. Transcription runs fully on-device via Whisper
 * (transformers.js) inside a Web Worker (see captionWorker.ts) so the UI stays
 * responsive and the job is cancellable. The project's audio is mixed down to
 * mono 16 kHz (what Whisper expects) and fed in; timestamped segments come
 * back — word-level when the model supports it — and become caption text
 * clips. SRT/VTT import/export is plain text.
 */

export type { CaptionWord } from './captionWorker';

export interface CaptionSegment {
  start: number;
  end: number;
  text: string;
  /** Per-word timings (karaoke-ready) when the model produced them. */
  words?: CaptionWord[];
}

export interface SpeechModel {
  label: string;
  value: string;
  /** Large model: practical only on a graphics card (WebGPU). */
  gpu?: boolean;
}

/**
 * Speech models. Fast is Whisper base (~300 MB, fine on any CPU). Accurate is
 * Whisper large-v3-turbo (~1.6 GB, fp16): far fewer missed and wrong words,
 * offered when the GPU can run it. GPUs without fp16 shaders (shader-f16)
 * get Whisper small instead (fp32, ~1 GB): the turbo
 * fp32 build is 3.2 GB, too big to load per worker. "#en" forces English on
 * the multilingual model instead of guessing the language per chunk.
 */
export const CAPTION_MODELS: SpeechModel[] = [
  { label: 'English (fast)', value: 'Xenova/whisper-base.en' },
  { label: 'Multilingual (fast)', value: 'Xenova/whisper-base' },
  { label: 'English (accurate)', value: 'onnx-community/whisper-large-v3-turbo_timestamped#en', gpu: true },
  { label: 'Multilingual (accurate)', value: 'onnx-community/whisper-large-v3-turbo_timestamped', gpu: true },
];

const ACCURATE_F32 = ['onnx-community/whisper-small.en_timestamped', 'onnx-community/whisper-small_timestamped'];

export const isGpuModel = (model: string): boolean => !!CAPTION_MODELS.find((m) => m.value === model)?.gpu;

/** The models to offer: the accurate ones only where a GPU can run them. */
export const offeredModels = (): SpeechModel[] => CAPTION_MODELS.filter((m) => !m.gpu || (gpuAvailable !== false && !gpuFailed));

/** Shown under a model picker. */
export const modelHint = (model: string): string =>
  isGpuModel(model)
    ? `Fewer missed words. Downloads ${/large/.test(model) ? '1.6 GB' : '1 GB'} once, runs on your graphics card.`
    : 'Quick, ~300 MB download. Pick accurate for difficult audio.';

/** What "accurate" means on this machine, for settings. */
export const accurateModelName = (): string => (/large/.test(CAPTION_MODELS[2].value) ? 'Whisper large-v3-turbo · 1.6 GB' : 'Whisper small · 1 GB');

// ── GPU + accuracy preference ──────────────────────────────────────────────
let gpuProbe: Promise<boolean> | null = null;
/** Known once probed: whether this machine has a usable WebGPU adapter. */
export let gpuAvailable: boolean | null = null;
/** Set when a GPU worker failed to start: the rest of the session stays on the CPU. */
let gpuFailed = false;

export function hasWebGpu(): Promise<boolean> {
  gpuProbe ??= (async () => {
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: object): Promise<{ features: Set<string> } | null> } }).gpu;
      const adapter = gpu && (await gpu.requestAdapter({ powerPreference: 'high-performance' }));
      if (!adapter) return false;
      if (!adapter.features.has('shader-f16')) ACCURATE_F32.forEach((value, i) => (CAPTION_MODELS[2 + i].value = value));
      return true;
    } catch {
      return false;
    }
  })().then((ok) => (gpuAvailable = ok));
  return gpuProbe;
}

export type SpeechAccuracy = 'fast' | 'accurate';
const ACCURACY_KEY = 'krypt.speech.accuracy';

export function speechAccuracy(): SpeechAccuracy {
  try {
    return localStorage.getItem(ACCURACY_KEY) === 'accurate' ? 'accurate' : 'fast';
  } catch {
    return 'fast';
  }
}

export function setSpeechAccuracy(a: SpeechAccuracy): void {
  try {
    localStorage.setItem(ACCURACY_KEY, a);
  } catch {
    /* private mode: the choice lasts this session only */
  }
}

/** The model for a language at the chosen accuracy (fast when there's no GPU for the accurate one). */
export function speechModelFor(lang: 'english' | 'multilingual' = 'english', accuracy: SpeechAccuracy = speechAccuracy()): string {
  const accurate = accuracy === 'accurate' && gpuAvailable !== false && !gpuFailed;
  return CAPTION_MODELS[(lang === 'multilingual' ? 1 : 0) + (accurate ? 2 : 0)].value;
}

export interface TranscribeOptions {
  model?: string;
  onStatus?: (status: string) => void;
  /** 0..1: model download while loading, then share of audio transcribed. */
  onProgress?: (ratio: number) => void;
  /** Abort the transcription (terminates the worker). */
  signal?: AbortSignal;
}

const isMediaClip = (c: Clip): c is MediaClip => c.type === 'media';

/** The clips captions listen to: audible video/audio clips. */
export function captionSources(clips: Clip[], media: MediaFile[]): MediaClip[] {
  const mediaById = new Map(media.map((m) => [m.id, m]));
  return clips.filter(
    (c): c is MediaClip =>
      isMediaClip(c) && !c.muted && c.freezeAt == null && c.volume > 0 && (mediaById.get(c.mediaId)?.kind === 'video' || mediaById.get(c.mediaId)?.kind === 'audio'),
  );
}

/** Mix the timeline's audio to a mono Float32Array at 16 kHz for Whisper. */
export async function extractAudioMono16k(clips: Clip[], media: MediaFile[], total: number): Promise<Float32Array | null> {
  const mediaById = new Map(media.map((m) => [m.id, m]));
  const contributors = captionSources(clips, media);
  if (contributors.length === 0 || total <= 0) return null;

  const sampleRate = 16000;
  const octx = new OfflineAudioContext(1, Math.ceil(total * sampleRate), sampleRate);
  // Each file is decoded once, mono at 16k, over just the source span its clips use.
  const spans = new Map<string, [number, number]>();
  for (const c of contributors) {
    const [a, b] = spans.get(c.mediaId) ?? [Infinity, -Infinity];
    spans.set(c.mediaId, [Math.min(a, c.inPoint), Math.max(b, c.inPoint + c.duration * c.speed)]);
  }
  const decoded = new Map<string, { buf: AudioBuffer; off: number } | null>();
  for (const [id, [a, b]] of spans) {
    const m = mediaById.get(id);
    const off = Math.max(0, a - 0.5);
    try {
      const pcm = m ? await decodeMono(m.mediaUrl, sampleRate, { start: off, end: b + 0.5 }) : null;
      if (!pcm) throw new Error('no audio');
      const buf = octx.createBuffer(1, pcm.length, sampleRate);
      buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
      decoded.set(id, { buf, off });
    } catch {
      decoded.set(id, null);
    }
  }

  for (const c of contributors) {
    const d = decoded.get(c.mediaId);
    if (!d) continue;
    const node = octx.createBufferSource();
    node.buffer = d.buf;
    node.playbackRate.value = c.speed;
    node.connect(octx.destination);
    node.start(c.start, Math.max(0, c.inPoint - d.off), c.duration * c.speed);
  }

  const rendered = await octx.startRendering();
  return rendered.getChannelData(0).slice();
}

// ── Parallel transcription ─────────────────────────────────────────────────
const SR = 16000;

/**
 * Split mono-16k audio into slices for the worker pool, each cut at the
 * quietest 100ms frame within ±`search` seconds of the even split, so no word
 * is cut in half. Returns sample boundaries [0, …, audio.length].
 */
export function planSlices(audio: Float32Array, target: number, search = 5, sampleRate = SR): number[] {
  const n = audio.length;
  const count = Math.max(1, Math.round(n / sampleRate / Math.max(1, target)));
  if (count <= 1) return [0, n];
  const hop = Math.round(sampleRate / 10);
  const frames = Math.floor(n / hop);
  const energy = (f: number): number => {
    let s = 0;
    for (let i = f * hop, e = Math.min(n, i + hop); i < e; i++) s += audio[i] * audio[i];
    return s;
  };
  const win = Math.round(search * 10);
  const minGap = Math.max(1, Math.round(frames / count / 3)); // never leave a sliver
  const pts = [0];
  let lastFrame = 0;
  for (let k = 1; k < count; k++) {
    const centre = Math.round((frames * k) / count);
    const lo = Math.max(lastFrame + minGap, centre - win);
    const hi = Math.min(frames - minGap, centre + win);
    if (hi <= lo) continue;
    let best = lo;
    let bestE = Infinity;
    for (let f = lo; f < hi; f++) {
      const e = energy(f);
      if (e < bestE) {
        bestE = e;
        best = f;
      }
    }
    pts.push(best * hop + (hop >> 1));
    lastFrame = best;
  }
  pts.push(n);
  return pts;
}

// ── Skipping silence ───────────────────────────────────────────────────────
/** Silences at least this long (seconds) are left out of transcription… */
export const SKIP_MIN = 2.5;
/** …minus this much at each end, so word tails and breaths stay in. */
export const SKIP_PAD = 0.5;

/**
 * Sample ranges worth transcribing: everything except silences of SKIP_MIN or
 * more. Silent means 35 dB under the recording's loud parts (and below -55
 * dBFS at most), so quiet speech, music beds and game sound all stay in.
 * Returns the whole audio when skipping would save under 10%, and nothing
 * when the audio is silent throughout.
 */
export function speechRanges(audio: Float32Array, sampleRate = SR): Array<[number, number]> {
  const n = audio.length;
  const hop = Math.round(sampleRate / 10);
  const frames = Math.floor(n / hop);
  if (frames < 2) return n > 0 ? [[0, n]] : [];
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let i = f * hop, e = i + hop; i < e; i++) acc += audio[i] * audio[i];
    const rms = Math.sqrt(acc / hop);
    db[f] = rms > 1e-5 ? 20 * Math.log10(rms) : -100;
  }
  const audible = Array.from(db).filter((d) => d > -90).sort((a, b) => a - b);
  if (audible.length === 0) return [];
  const ref = audible[Math.min(audible.length - 1, Math.floor(audible.length * 0.95))];
  const quiet = Math.min(-55, ref - 35);
  const minRun = Math.round(SKIP_MIN * 10);
  const pad = Math.round(SKIP_PAD * 10);
  const kept: Array<[number, number]> = [];
  const lastFrame = Math.ceil(n / hop); // counting the partial frame at the end
  let keepFrom = 0;
  let removed = 0;
  let f = 0;
  while (f < frames) {
    if (db[f] >= quiet) {
      f++;
      continue;
    }
    const runStart = f;
    while (f < frames && db[f] < quiet) f++;
    if (f - runStart < minRun) continue;
    const cutA = runStart === 0 ? 0 : runStart + pad;
    const cutB = f === frames ? lastFrame : f - pad;
    if (cutA * hop > keepFrom) kept.push([keepFrom, cutA * hop]);
    keepFrom = Math.min(n, cutB * hop);
    removed += cutB - cutA;
  }
  if (keepFrom < n) kept.push([keepFrom, n]);
  if (removed * hop < n * 0.1) return [[0, n]];
  return kept.filter(([a, b]) => b > a);
}

/** Where a stretch of compacted audio came from: compacted seconds [at, at + (to - from)) ↔ source [from, to). */
export interface TimePiece {
  from: number;
  to: number;
  at: number;
}

/** Concatenates the kept sample ranges into one buffer, with the map back to source time. */
export function compactRanges(audio: Float32Array, ranges: Array<[number, number]>, sampleRate = SR): { audio: Float32Array; pieces: TimePiece[] } {
  if (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === audio.length) return { audio, pieces: [{ from: 0, to: audio.length / sampleRate, at: 0 }] };
  const total = ranges.reduce((s, [a, b]) => s + (b - a), 0);
  const out = new Float32Array(total);
  const pieces: TimePiece[] = [];
  let w = 0;
  for (const [a, b] of ranges) {
    out.set(audio.subarray(a, b), w);
    pieces.push({ from: a / sampleRate, to: b / sampleRate, at: w / sampleRate });
    w += b - a;
  }
  return { audio: out, pieces };
}

/** Source time of a compacted time (clamped into the piece it falls in). */
export function sourceTime(pieces: TimePiece[], t: number): number {
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pieces[mid].at <= t) lo = mid;
    else hi = mid - 1;
  }
  const p = pieces[lo];
  return Math.min(p.to, p.from + Math.max(0, t - p.at));
}

/**
 * Maps segments from compacted time back to source time, and splits any
 * caption line whose words now sit more than a pause apart (a line can't
 * span a skipped silence).
 */
export function restoreTimes(segs: CaptionSegment[], pieces: TimePiece[]): CaptionSegment[] {
  if (pieces.length === 1 && pieces[0].from === 0 && pieces[0].at === 0) return segs;
  const out: CaptionSegment[] = [];
  for (const s of segs) {
    if (!s.words?.length) {
      const start = sourceTime(pieces, s.start);
      out.push({ ...s, start, end: Math.max(start + 0.3, sourceTime(pieces, s.end)) });
      continue;
    }
    let cur: CaptionWord[] = [];
    const flush = (): void => {
      if (cur.length === 0) return;
      out.push({ start: cur[0].start, end: Math.max(cur[cur.length - 1].end, cur[0].start + 0.3), text: cur.map((w) => w.text).join('').trim(), words: cur });
      cur = [];
    };
    for (const w of s.words) {
      const start = sourceTime(pieces, w.start);
      const word = { ...w, start, end: Math.max(start, sourceTime(pieces, w.end)) };
      const prev = cur[cur.length - 1];
      if (prev && word.start - prev.end > 0.8) flush();
      cur.push(word);
    }
    flush();
  }
  return out;
}

/** How many workers to run: half the logical cores (the sweet spot measured on 16 threads), fewer on low-memory machines. */
export function poolSize(cores: number, memoryGb: number): number {
  let k = Math.max(1, Math.min(8, Math.floor(cores / 2)));
  if (memoryGb < 8) k = Math.min(k, 4); // each worker holds ~300MB of fp32 weights
  if (memoryGb < 4) k = Math.min(k, 2);
  return k;
}

function fmtEta(s: number): string {
  if (s < 60) return 'under a minute left';
  const m = Math.round(s / 60);
  return `about ${m} min left`;
}

type WorkerOut = { type: string; status?: string; ratio?: number; id?: number; segments?: WorkerSegment[]; message?: string };

/**
 * Transcribe mono-16k audio into timestamped caption segments. Long audio is
 * cut at quiet points into slices and fanned out over a pool of workers; the
 * first worker downloads/loads the model before the rest start, so a cold
 * cache downloads it once. Progress (0..1) during transcription is the share
 * of audio done, with an ETA in the status text.
 */
export async function transcribe(audio: Float32Array, opts: TranscribeOptions = {}): Promise<CaptionSegment[]> {
  const model = opts.model ?? speechModelFor();
  const gpu = !gpuFailed && (await hasWebGpu());
  if (!gpu && isGpuModel(model)) throw new Error('The accurate speech model needs a graphics card (WebGPU). Pick a fast model instead.');
  // Long silences don't go to Whisper at all (it only invents words there).
  const kept = speechRanges(audio);
  if (kept.length === 0) return [];
  const { audio: compact, pieces } = compactRanges(audio, kept);
  const run = (device: SpeechDevice) => runPool(compact, model, device, opts).then((segs) => restoreTimes(segs, pieces));
  if (!gpu) return run('wasm');
  try {
    return await run('webgpu');
  } catch (err) {
    // The GPU couldn't start Whisper (driver, memory): the fast models work on the CPU.
    if (!(err as PoolError).beforeReady || isGpuModel(model) || opts.signal?.aborted) throw err;
    console.warn('[captions] WebGPU failed, transcribing on the CPU', err);
    gpuFailed = true;
    return run('wasm');
  }
}

type PoolError = Error & { beforeReady?: boolean };

function runPool(audio: Float32Array, model: string, device: SpeechDevice, opts: TranscribeOptions): Promise<CaptionSegment[]> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cpu = poolSize(nav.hardwareConcurrency || 4, nav.deviceMemory ?? 8);
  // GPU: two workers keep it fed (measured best; more queue on the same
  // device, and CPU workers alongside starve its dispatch thread).
  const maxWorkers = device === 'webgpu' ? 2 : cpu;
  // Whisper base: encoder on the GPU, its small decoder on the CPU (measured
  // faster). Bigger decoders (small, large) run faster on the GPU too.
  const split = device === 'webgpu' && /base/.test(model);
  const secs = audio.length / SR;
  // ~3 slices per worker balances the tail (measured: beats 2 per worker); never below one Whisper window.
  const target = Math.max(30, Math.min(120, secs / (maxWorkers * 3)));
  const bounds = planSlices(audio, target);
  const jobs = bounds.slice(0, -1).map((a, i) => ({ id: i, a, b: bounds[i + 1] }));
  const workerCount = Math.min(maxWorkers, jobs.length);

  return new Promise((resolve, reject) => {
    const workers: Worker[] = [];
    const results: WorkerSegment[][] = new Array(jobs.length);
    let next = 0;
    let doneSamples = 0;
    let doneJobs = 0;
    let started = 0;
    let alive = 0;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      for (const w of workers) w.terminate();
      fn();
    };
    const onAbort = (): void => finish(() => reject(new Error('Transcription cancelled.')));
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener('abort', onAbort);

    const report = (): void => {
      const ratio = doneSamples / Math.max(1, audio.length);
      const elapsed = (performance.now() - started) / 1000;
      const eta = ((audio.length - doneSamples) / Math.max(1, doneSamples)) * elapsed;
      const parts = jobs.length > 1 ? ` ${doneJobs}/${jobs.length} parts ·` : '';
      // Until every worker has finished a slice the rate is dominated by start-up; don't guess yet.
      const tail = doneJobs >= Math.min(workerCount, jobs.length) ? fmtEta(eta) : doneJobs > 0 ? 'estimating time…' : `${workerCount} worker${workerCount === 1 ? '' : 's'}`;
      opts.onStatus?.(`Transcribing…${parts} ${tail}`);
      opts.onProgress?.(ratio);
    };

    const feed = (w: Worker): void => {
      const job = jobs[next++];
      if (!job) return;
      const slice = audio.slice(job.a, job.b);
      w.postMessage({ type: 'run', id: job.id, audio: slice, offset: job.a / SR }, [slice.buffer]);
    };

    const spawn = (first: boolean): void => {
      const w = new Worker(new URL('./captionWorker.ts', import.meta.url), { type: 'module' });
      workers.push(w);
      alive++;
      let ready = false;
      const drop = (message: string): void => {
        alive--;
        w.terminate();
        // A helper that failed to load (e.g. out of memory) just shrinks the pool;
        // the job it held, if any, fails the whole run so nothing is silently lost.
        if (first || ready || alive === 0) {
          const err: PoolError = new Error(message);
          err.beforeReady = first && !ready;
          finish(() => reject(err));
        }
      };
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        const m = e.data;
        if (m.type === 'status' && m.status && first && !ready) opts.onStatus?.(m.status);
        else if (m.type === 'progress' && typeof m.ratio === 'number' && first && !ready) opts.onProgress?.(m.ratio);
        else if (m.type === 'ready') {
          ready = true;
          if (first) {
            started = performance.now();
            report();
            for (let i = 1; i < workerCount; i++) spawn(false); // model is cached now
          }
          feed(w);
        } else if (m.type === 'done' && typeof m.id === 'number') {
          results[m.id] = m.segments ?? [];
          doneJobs++;
          doneSamples += jobs[m.id].b - jobs[m.id].a;
          report();
          if (doneJobs === jobs.length) finish(() => resolve(results.flat().sort((x, y) => x.start - y.start)));
          else feed(w);
        } else if (m.type === 'error') {
          drop(m.message ?? 'Transcription failed. Check your internet connection (the model downloads on first use).');
        }
      };
      w.onerror = (e) => drop(e.message || 'The caption worker crashed.');
      w.postMessage({ type: 'init', model, device, split });
    };

    spawn(true);
  });
}

// ── SRT / VTT ──────────────────────────────────────────────────────────────
function parseTimecode(tc: string): number {
  // 00:00:01,250 or 00:00:01.250
  const m = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/.exec(tc);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000;
}

/** Parse an SRT or WebVTT string into caption segments. */
export function parseSubtitles(text: string): CaptionSegment[] {
  const segs: CaptionSegment[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() && l.trim().toUpperCase() !== 'WEBVTT' && !/^\d+$/.test(l.trim()));
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const [a, b] = timeLine.split('-->');
    const body = lines.filter((l) => l !== timeLine).join('\n').trim();
    if (!body) continue;
    segs.push({ start: parseTimecode(a), end: parseTimecode(b), text: body });
  }
  return segs;
}

function srtTime(s: number): string {
  const t = Math.max(0, s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(sec)},${p(ms, 3)}`;
}

/** Serialize caption segments to an SRT string. */
export function toSRT(segs: CaptionSegment[]): string {
  return segs
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`)
    .join('\n');
}
