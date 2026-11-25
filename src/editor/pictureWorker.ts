/// <reference lib="webworker" />
/**
 * A picture from words on this computer's graphics card: CLIP reads the
 * prompt, a distilled Stable Diffusion network turns noise into the picture in
 * one pass (SDXS) or four (DreamShaper 8 LCM), a decoder makes it pixels.
 * ONNX Runtime over WebGPU, the same runtime as the voices. Nothing leaves the
 * computer. The model stays loaded between pictures; the caller terminates the
 * worker to stop or to give the memory back.
 */
import * as ort from 'onnxruntime-web';
import ortWasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import ortMjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import type { LocalPictureFiles } from '@shared/imageGen';
import { clipTokenizer, CLIP_LENGTH, gaussian, LCM_TIMESTEPS, lcmStep, LOCAL_SIZE, noise, planesToRgba, sdxsInput, sdxsStep, SDXS_SIGMA, SDXS_TIMESTEP, type ClipTokenizer } from './pictureMath';

export type PictureWorkerIn = { type: 'load'; files: LocalPictureFiles } | { type: 'run'; id: number; prompt: string; seed: number };

export type PictureWorkerOut =
  | { type: 'status'; status: string }
  | { type: 'progress'; ratio: number }
  | { type: 'ready' }
  /** A square of LOCAL_SIZE pixels a side. `cut`: the prompt was longer than the model reads. */
  | { type: 'done'; id: number; size: number; rgba: Uint8ClampedArray; cut: boolean; ms: number }
  /** `lost`: the graphics card dropped the model (a driver reset, or it ran out of memory). */
  | { type: 'error'; id?: number; message: string; lost?: boolean }
  /** One line about how a picture went, for the log: the time of each part. */
  | { type: 'timing'; id: number; note: string };

const post = (m: PictureWorkerOut, transfer?: Transferable[]): void => self.postMessage(m, { transfer });

ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
ort.env.wasm.numThreads = 1;

interface Loaded {
  id: LocalPictureFiles['id'];
  tokens: ClipTokenizer;
  text: ort.InferenceSession;
  unet: ort.InferenceSession;
  vae: ort.InferenceSession;
  /** The network takes its step number as a whole number (some exports) or a float. */
  wholeStep: boolean | null;
}
let loaded: Loaded | null = null;

type Gpu = { requestAdapter(o?: { powerPreference?: string }): Promise<{ features: { has(f: string): boolean } } | null> };

async function needGpu(): Promise<void> {
  const gpu = (navigator as Navigator & { gpu?: Gpu }).gpu;
  const adapter = gpu ? await gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
  if (!adapter) throw new Error('Making pictures on this computer needs a graphics card with WebGPU, and none was found. A picture service with your own key works without one.');
  if (!adapter.features.has('shader-f16')) throw new Error('This graphics card (or its driver) lacks half-float support, which the picture model needs. Updating the graphics driver may add it; a picture service with your own key works without it.');
}

/** Reads a model file, reporting how far along the whole load is. */
async function bytesOf(url: string, what: string, base: number, share: number): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Couldn't read the picture model (${what}: HTTP ${res.status}). Download it again in Settings.`);
  const total = Number(res.headers.get('content-length') ?? 0);
  if (!total) return new Uint8Array(await res.arrayBuffer());
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let at = 0;
  let told = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > total) throw new Error(`The picture model file changed while it was read (${what}).`);
    out.set(value, at);
    at += value.length;
    const now = Date.now();
    if (now - told > 120) {
      told = now;
      post({ type: 'progress', ratio: base + (share * at) / total });
    }
  }
  if (at !== total) throw new Error(`The picture model file is cut short (${what}). Download it again in Settings.`);
  return out;
}

const OPTIONS: ort.InferenceSession.SessionOptions = { executionProviders: ['webgpu'], enableMemPattern: false, enableCpuMemArena: false };

async function open(url: string, what: string, base: number, share: number, inputs: string[]): Promise<ort.InferenceSession> {
  const s = await ort.InferenceSession.create(await bytesOf(url, what, base, share), OPTIONS);
  for (const want of inputs) if (!s.inputNames.includes(want)) throw new Error(`The picture model is not the one expected (${what} has no input '${want}').`);
  return s;
}

async function load(files: LocalPictureFiles): Promise<void> {
  if (loaded?.id === files.id) return post({ type: 'ready' });
  await needGpu();
  post({ type: 'status', status: 'Loading the picture model…' });
  const [vocab, merges] = await Promise.all([fetch(files.vocab).then((r) => r.json() as Promise<Record<string, number>>), fetch(files.merges).then((r) => r.text())]);
  const tokens = clipTokenizer(vocab, merges);
  // Shares of the load by file size: the big network is most of it.
  const text = await open(files.text, 'text reader', 0, 0.12, ['input_ids']);
  const vae = await open(files.vae, 'decoder', 0.12, 0.08, ['latent']);
  const unet = await open(files.unet, 'network', 0.2, 0.8, ['sample', 'timestep', 'encoder_hidden_states']);
  loaded = { id: files.id, tokens, text, unet, vae, wholeStep: null };
  // The runtime's device, once it has one: told at once when the card drops it, instead of waiting on a pass that will never come back.
  const device = (ort.env as unknown as { webgpu?: { device?: { lost?: Promise<{ reason?: string; message?: string }> } } }).webgpu?.device;
  void device?.lost?.then((info) => {
    if (info?.reason === 'destroyed') return;
    loaded = null;
    post({ type: 'error', lost: true, message: `The graphics card dropped the picture model (${(info?.message || 'device lost').slice(0, 160)}).` });
  });
  post({ type: 'progress', ratio: 1 });
  post({ type: 'ready' });
}

const first = (out: ort.InferenceSession.OnnxValueMapType, name: string): Float32Array => {
  const t = (out[name] ?? Object.values(out)[0]) as ort.Tensor | undefined;
  if (!t || !(t.data instanceof Float32Array)) throw new Error('The picture model answered in a form that could not be read.');
  return t.data;
};

/** One pass of the network: its guess of the noise in `sample` at step `t`. */
async function guess(m: Loaded, sample: Float32Array, t: number, words: ort.Tensor): Promise<Float32Array> {
  const side = LOCAL_SIZE / 8;
  const run = async (whole: boolean): Promise<Float32Array> => {
    const timestep = whole ? new ort.Tensor('int64', BigInt64Array.from([BigInt(t)]), [1]) : new ort.Tensor('float32', Float32Array.from([t]), [1]);
    return first(await m.unet.run({ sample: new ort.Tensor('float32', sample, [1, 4, side, side]), timestep, encoder_hidden_states: words }), 'out_sample');
  };
  if (m.wholeStep !== null) return run(m.wholeStep);
  try {
    const out = await run(false);
    m.wholeStep = false;
    return out;
  } catch (e) {
    if (!/type|int64|float/i.test((e as Error).message)) throw e;
    const out = await run(true);
    m.wholeStep = true;
    return out;
  }
}

async function draw(m: Loaded, words: ort.Tensor, seed: number, mark: (what: string) => void): Promise<Uint8ClampedArray> {
  const side = LOCAL_SIZE / 8;
  const n = 4 * side * side;
  const next = gaussian(seed);
  let x: Float32Array;
  if (m.id === 'sdxs') {
    x = noise(n, next, SDXS_SIGMA);
    post({ type: 'progress', ratio: 0.2 });
    x = sdxsStep(x, await guess(m, sdxsInput(x), SDXS_TIMESTEP, words));
    mark('step');
  } else {
    x = noise(n, next);
    for (let i = 0; i < LCM_TIMESTEPS.length; i++) {
      post({ type: 'progress', ratio: 0.1 + (0.75 * i) / LCM_TIMESTEPS.length });
      const eps = await guess(m, x, LCM_TIMESTEPS[i], words);
      x = lcmStep(x, eps, LCM_TIMESTEPS[i], LCM_TIMESTEPS[i + 1] ?? null, next);
      mark(`step${i + 1}`);
    }
  }
  post({ type: 'progress', ratio: 0.88 });
  const planes = first(await m.vae.run({ latent: new ort.Tensor('float32', x, [1, 4, side, side]) }), 'image');
  if (planes.length !== 3 * LOCAL_SIZE * LOCAL_SIZE) throw new Error('The picture model drew a picture of an unexpected size.');
  mark('decode');
  return planesToRgba(planes, LOCAL_SIZE, LOCAL_SIZE);
}

async function run(job: Extract<PictureWorkerIn, { type: 'run' }>): Promise<void> {
  const m = loaded;
  if (!m) throw new Error('The picture model is not loaded.');
  const t0 = performance.now();
  const marks: string[] = [];
  let last = t0;
  const mark = (what: string): void => {
    const now = performance.now();
    marks.push(`${what} ${Math.round(now - last)}`);
    last = now;
  };
  const ids = m.tokens(job.prompt);
  const cut = m.tokens.count(job.prompt) > CLIP_LENGTH - 2;
  const enc = await m.text.run({ input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map((v) => BigInt(v))), [1, CLIP_LENGTH]) });
  const hidden = first(enc, 'last_hidden_state');
  mark('words');
  const words = new ort.Tensor('float32', hidden, [1, CLIP_LENGTH, hidden.length / CLIP_LENGTH]);
  const rgba = await draw(m, words, job.seed, mark);
  post({ type: 'timing', id: job.id, note: `${m.id}: ${marks.join(', ')} ms` });
  post({ type: 'done', id: job.id, size: LOCAL_SIZE, rgba, cut, ms: Math.round(performance.now() - t0) }, [rgba.buffer]);
}

let chain: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<PictureWorkerIn>): void => {
  const msg = e.data;
  chain = chain.then(async () => {
    try {
      if (msg.type === 'load') await load(msg.files);
      else if (msg.type === 'run') await run(msg);
    } catch (err) {
      const raw = (err as Error)?.message ?? String(err);
      const memory = /out of memory|allocation|device.*lost|OOM|bad_alloc/i.test(raw);
      post({ type: 'error', id: msg.type === 'run' ? msg.id : undefined, message: memory ? `The graphics card ran out of memory making the picture. Close other heavy programs, or use the small model. (${raw.slice(0, 160)})` : raw.slice(0, 400) });
    }
  });
};
