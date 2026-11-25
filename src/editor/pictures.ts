/**
 * Pictures from words, the editor's side: one call makes a list of pictures
 * wherever the user set it up (a service with their own key, through main; or
 * the model on this computer, in pictureWorker.ts) and puts each in the media
 * library. Used by the Make pictures tab, the longform builder and the agent
 * tool `generate_images`.
 */
import type { MediaFile } from '@shared/types';
import {
  aspectFor,
  LOCAL_PICTURE_MODELS,
  localPictureModel,
  pickSource,
  picturePrompt,
  readyLocalModel,
  sourceName,
  sourceProblem,
  type LocalPictureFiles,
  type LocalPictureModelId,
  type LocalPictureStatus,
  type MadePicture,
  type PictureAspect,
  type PictureQuality,
  type PictureSetup,
  type PictureSource,
} from '@shared/imageGen';
import { intoLibrary } from './images';
import { localCrop } from './pictureMath';
import type { PictureWorkerIn, PictureWorkerOut } from './pictureWorker';

export interface PictureState {
  setup: PictureSetup;
  local: LocalPictureStatus[];
  /** The installed model for this computer, the better one first. */
  localModel: LocalPictureModelId | null;
  /** Where pictures would be made right now. Null: nothing is set up. */
  source: PictureSource | null;
}

export async function pictureState(): Promise<PictureState> {
  const [setup, local] = await Promise.all([window.krypt.pictures.setup(), window.krypt.pictures.localStatus()]);
  const localModel = readyLocalModel(local);
  const source = pickSource(setup, localModel !== null);
  return { setup, local, localModel, source: source && !sourceProblem(setup, source, localModel !== null) ? source : null };
}

/** One sentence on how to set pictures up, for when nothing is. */
export const NO_PICTURE_SOURCE = 'Pictures from words are not set up yet. In Settings, under Pictures from words, either download the model for this computer (free, needs a graphics card) or add your own key for a picture service.';

// ── The model on this computer ──────────────────────────────────────

let worker: { w: Worker; id: LocalPictureModelId; ready: Promise<void> } | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let jobs = 0;
let queue: Promise<unknown> = Promise.resolve();
/** The loaded model holds a few gigabytes of graphics memory: given back after this long unused. */
const IDLE_MS = 90_000;

/**
 * A picture normally takes a second to ten. When the graphics card is busy
 * with a game or out of memory, a pass can take minutes or never come back:
 * past these limits the model is dropped and the caller told. The first
 * picture after loading also compiles the model's programs for the card.
 */
const LOAD_LIMIT_MS = 300_000;
const FIRST_LIMIT_MS = 180_000;
const NEXT_LIMIT_MS = 90_000;
/** A model that stalled is passed over for this long: the card is probably still busy. */
const AVOID_MS = 15 * 60_000;
const avoid = new Map<LocalPictureModelId, number>();

class Stalled extends Error {}
/** The card dropped the model. Whether it can be asked again is found out by cardAlive. */
class Lost extends Error {}

const RESTART = 'The graphics card reset while a picture was being made (it was too busy, or ran out of memory), and this run of Krypt Editor cannot use it for pictures any more. Save the project, close games and other heavy programs, and start Krypt Editor again. A picture service with your own key does not need the card.';

/** Can a device still be had from the graphics card? After a driver reset the answer stays no until the app is restarted. */
async function cardAlive(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: unknown): Promise<{ requestDevice(): Promise<{ destroy(): void }> } | null> } }).gpu;
    const adapter = gpu ? await gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
    if (!adapter) return false;
    (await adapter.requestDevice()).destroy();
    return true;
  } catch {
    return false;
  }
}

/** How the last pictures went, part by part in milliseconds. For diagnosing a slow card: readable from the developer console. */
export const pictureTimings: string[] = [];
if (typeof window !== 'undefined') (window as unknown as { __kryptPictureTimings?: string[] }).__kryptPictureTimings = pictureTimings;
const stalled = (seconds: number): Stalled =>
  new Stalled(`The graphics card did not finish in ${seconds} seconds: it is busy with another program, or short of memory (the better picture model wants about 5 GB of it free, the small one about 2). Close games and other heavy programs and try again, or use a picture service with your own key.`);

/** Unloads the model on this computer (frees its graphics memory). */
export function releasePictureModel(): void {
  if (idle) clearTimeout(idle);
  idle = null;
  worker?.w.terminate();
  worker = null;
}

function loadLocal(files: LocalPictureFiles, onStatus: (note: string, ratio: number | null) => void): Promise<void> {
  if (worker && worker.id !== files.id) releasePictureModel();
  if (worker) return worker.ready;
  const w = new Worker(new URL('./pictureWorker.ts', import.meta.url), { type: 'module' });
  const ready = new Promise<void>((resolve, reject) => {
    const watchdog = setTimeout(() => {
      w.removeEventListener('message', on);
      reject(stalled(LOAD_LIMIT_MS / 1000));
    }, LOAD_LIMIT_MS);
    const on = (e: MessageEvent<PictureWorkerOut>): void => {
      const m = e.data;
      if (m.type === 'status') onStatus(m.status, null);
      else if (m.type === 'progress') onStatus('Loading the picture model…', m.ratio);
      else if (m.type === 'ready') {
        clearTimeout(watchdog);
        w.removeEventListener('message', on);
        resolve();
      } else if (m.type === 'error') {
        clearTimeout(watchdog);
        w.removeEventListener('message', on);
        reject(new Error(m.message));
      }
    };
    w.addEventListener('message', on);
    w.addEventListener('error', (e) => reject(new Error(e.message || 'The picture model stopped unexpectedly.')));
    w.postMessage({ type: 'load', files } satisfies PictureWorkerIn);
  });
  worker = { w, id: files.id, ready };
  ready.catch(() => {
    if (worker?.w === w) releasePictureModel();
  });
  return ready;
}

let runId = 0;
interface Drawn {
  rgba: Uint8ClampedArray;
  size: number;
  cut: boolean;
  ms: number;
}

function drawLocal(prompt: string, seed: number, limitMs: number, signal?: AbortSignal): Promise<Drawn> {
  const cur = worker;
  if (!cur) return Promise.reject(new Error('The picture model is not loaded.'));
  const id = ++runId;
  return new Promise<Drawn>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(watchdog);
      cur.w.removeEventListener('message', on);
      signal?.removeEventListener('abort', stop);
    };
    // A pass that never comes back: the worker is dropped, which also gives the card its memory back.
    const watchdog = setTimeout(() => {
      done();
      releasePictureModel();
      reject(stalled(limitMs / 1000));
    }, limitMs);
    const on = (e: MessageEvent<PictureWorkerOut>): void => {
      const m = e.data;
      if (m.type === 'done' && m.id === id) {
        done();
        resolve({ rgba: m.rgba, size: m.size, cut: m.cut, ms: m.ms });
      } else if (m.type === 'timing' && m.id === id) {
        pictureTimings.push(m.note);
        if (pictureTimings.length > 40) pictureTimings.shift();
      } else if (m.type === 'error' && (m.id === id || m.id === undefined)) {
        done();
        if (m.lost) releasePictureModel();
        reject(m.lost ? new Lost(m.message) : new Error(m.message));
      }
    };
    // A pass on the graphics card cannot be interrupted: stopping means dropping the worker.
    const stop = (): void => {
      done();
      releasePictureModel();
      reject(new Error('Stopped.'));
    };
    if (signal?.aborted) return stop();
    signal?.addEventListener('abort', stop);
    cur.w.addEventListener('message', on);
    cur.w.postMessage({ type: 'run', id, prompt, seed } satisfies PictureWorkerIn);
  });
}

/** The drawn square, cut to the video's shape, as JPEG bytes. */
async function encode(d: Drawn, aspect: PictureAspect): Promise<Uint8Array> {
  const full = new OffscreenCanvas(d.size, d.size);
  full.getContext('2d')!.putImageData(new ImageData(d.rgba as Uint8ClampedArray<ArrayBuffer>, d.size, d.size), 0, 0);
  const k = localCrop(aspect, d.size);
  const out = new OffscreenCanvas(k.width, k.height);
  out.getContext('2d')!.drawImage(full, k.x, k.y, k.width, k.height, 0, 0, k.width, k.height);
  return new Uint8Array(await (await out.convertToBlob({ type: 'image/jpeg', quality: 0.95 })).arrayBuffer());
}

// ── Making a list of pictures ───────────────────────────────────────

export interface PictureOptions {
  /** Where to make them; the user's choice when left out. */
  source?: PictureSource;
  /** A look from PICTURE_LOOKS. */
  look?: string;
  /** What stays the same in every picture: the characters, the place. */
  keep?: string;
  aspect?: PictureAspect;
  quality?: PictureQuality;
  /** The same seed and words give the same picture (this computer only). */
  seed?: number;
  /** Unload the model on this computer as soon as the pictures are made (the caller has other heavy work coming). */
  release?: boolean;
  signal?: AbortSignal;
  onStep?: (done: number, total: number, note: string) => void;
  /** Each picture as it lands, so a dialog can show them one by one. */
  onPicture?: (index: number, media: MediaFile) => void;
}

export interface PicturesMade {
  /** One per subject, in order; null where it failed. */
  media: Array<MediaFile | null>;
  failed: string[];
  source: PictureSource;
  /** The model's name, as it is called where it runs. */
  model: string;
  /** Notes worth passing on: prompts too long for the model, a shape it could not draw. */
  notes: string[];
}

/** The canvas's aspect, for pictures that are going on the timeline. */
export const canvasAspect = (width: number, height: number): PictureAspect => aspectFor(width, height);

/**
 * Make one picture per subject. Throws (before anything is ordered) when
 * nothing is set up or the source cannot be used; a picture that fails later
 * is reported in `failed` and the rest go on, except when the very first one
 * is refused: then the reason is thrown, so a wrong key does not fail fifty times.
 */
export async function makePictures(subjects: string[], o: PictureOptions = {}): Promise<PicturesMade> {
  const list = subjects.map((s) => String(s ?? '').trim());
  if (list.length === 0 || list.some((s) => !s)) throw new Error('Say what each picture should show.');
  const st = await pictureState();
  const source = o.source ?? st.source;
  if (!source) throw new Error(NO_PICTURE_SOURCE);
  const problem = sourceProblem(st.setup, source, st.localModel !== null);
  if (problem) throw new Error(problem);
  const aspect = o.aspect ?? '16:9';
  const prompts = list.map((s) => picturePrompt(s, o.look, o.keep));
  const media: Array<MediaFile | null> = list.map(() => null);
  const failed: string[] = [];
  const notes: string[] = [];
  const total = list.length;
  let done = 0;
  const step = (note: string): void => o.onStep?.(done, total, note);
  const stopped = (): boolean => o.signal?.aborted === true;
  const land = async (i: number, made: MadePicture): Promise<void> => {
    const m = await intoLibrary(made.path);
    media[i] = m;
    o.onPicture?.(i, m);
  };

  if (source === 'local') {
    // The installed models, the better one first; one that stalled a moment ago is passed over while another is there.
    const installed = LOCAL_PICTURE_MODELS.map((m) => m.id).filter((m) => st.local.some((s) => s.id === m && s.installed));
    let id = installed.find((m) => (avoid.get(m) ?? 0) < Date.now()) ?? installed[installed.length - 1];
    const nameOf = (m: LocalPictureModelId): string => localPictureModel(m)?.name ?? m;
    const open = async (m: LocalPictureModelId): Promise<LocalPictureFiles> => {
      const opened = await window.krypt.pictures.localOpen(m);
      if (!opened.ok || !opened.data) throw new Error(opened.message ?? 'The picture model could not be opened.');
      return opened.data;
    };
    let files = await open(id);
    const seed = Number.isFinite(o.seed) ? Math.floor(o.seed!) : Math.floor(Math.random() * 2 ** 31);
    let cut = 0;
    // One at a time, and after anything already running: two pictures at once fight for the same graphics memory.
    const work = async (): Promise<void> => {
      jobs++;
      if (idle) clearTimeout(idle);
      idle = null;
      try {
        let fresh = !worker || worker.id !== id;
        for (let i = 0; i < total; i++) {
          if (stopped()) break;
          try {
            if (!worker || worker.id !== id) {
              fresh = true;
              await loadLocal(files, (note, ratio) => o.onStep?.(done, total, ratio === null ? note : `${note} ${Math.round(ratio * 100)}%`));
            }
            if (stopped()) break;
            step(`Drawing picture ${i + 1} of ${total}…`);
            const d = await drawLocal(prompts[i], seed + i * 7919, fresh ? FIRST_LIMIT_MS : NEXT_LIMIT_MS, o.signal);
            fresh = false;
            if (d.cut) cut++;
            const kept = await window.krypt.pictures.keep(await encode(d, aspect), list[i], prompts[i], id);
            if (!kept.ok || !kept.data) throw new Error(kept.message ?? 'could not be saved');
            await land(i, kept.data);
          } catch (e) {
            if (stopped()) break;
            if (e instanceof Stalled || e instanceof Lost) {
              releasePictureModel();
              avoid.set(id, Date.now() + AVOID_MS);
              // After a driver reset no model can be loaded, the small one included: say so once instead of failing every picture.
              if (!(await cardAlive())) {
                if (i === 0) throw new Error(RESTART);
                failed.push(`${i + 1}${total - i > 1 ? ` to ${total}` : ''}: ${RESTART}`);
                break;
              }
              const smaller = installed[installed.indexOf(id) + 1];
              if (smaller) {
                // The small model needs less than half the memory: the same picture is tried again with it.
                notes.push(`${nameOf(id)} did not finish a picture in time (the graphics card is busy or short of memory), so ${i === 0 ? 'the pictures' : `pictures ${i + 1} onwards`} were made with ${nameOf(smaller)}.`);
                id = smaller;
                files = await open(id);
                i--;
                continue;
              }
              if (i === 0) throw e;
              failed.push(`${i + 1}${total - i > 1 ? ` to ${total}` : ''}: ${(e as Error).message}`);
              break;
            }
            if (i === 0) throw e;
            failed.push(`${i + 1}: ${(e as Error).message}`);
          }
          done++;
        }
      } finally {
        jobs--;
        if (jobs === 0 && worker) {
          // Kept for the next request, unless the caller has heavy work of its own coming (a voice, a transcription).
          if (o.release) releasePictureModel();
          else idle = setTimeout(releasePictureModel, IDLE_MS);
        }
      }
    };
    const mine = queue.then(work, work);
    queue = mine.catch(() => {});
    await mine;
    if (cut) notes.push(`${cut === total ? 'Every description' : cut === 1 ? 'One description' : `${cut} descriptions`} ${cut === 1 || cut === total ? 'was' : 'were'} longer than this model reads (about 60 words with the look): the end was left out. Shorter descriptions, or a shorter "keep the same" line, draw truer.`);
    if (aspect !== '1:1') notes.push(`The model on this computer draws 512 × 512 squares and nothing else, so a ${aspect === '16:9' ? 'wide' : 'tall'} picture is cut from one (${aspect === '16:9' ? '512 × 288' : '288 × 512'}) and is soft when shown large. A picture service with a key draws in the video's shape, and sharper.`);
    step(stopped() ? 'Stopped.' : 'Done.');
    return { media, failed, source, model: nameOf(id), notes };
  }

  const stop = (): void => void window.krypt.pictures.cancel();
  o.signal?.addEventListener('abort', stop);
  let model = st.setup.providers.find((p) => p.id === source)?.model ?? '';
  try {
    const order = async (i: number): Promise<void> => {
      const r = await window.krypt.pictures.generate({ source, prompt: prompts[i], subject: list[i], aspect, quality: o.quality });
      if (!r.ok || !r.data) throw new Error(r.message ?? 'The picture could not be made.');
      model = r.data.model;
      await land(i, r.data);
    };
    step(`Asking ${sourceName(source)} for picture 1 of ${total}…`);
    // The first alone: a wrong key or model name is one refusal, not one per picture.
    await order(0);
    done = 1;
    let next = 1;
    const lane = async (): Promise<void> => {
      while (next < total && !stopped()) {
        const i = next++;
        step(`Asking ${sourceName(source)} for picture ${i + 1} of ${total}…`);
        try {
          await order(i);
        } catch (e) {
          if (!stopped()) failed.push(`${i + 1}: ${(e as Error).message}`);
        }
        done++;
      }
    };
    await Promise.all([lane(), lane()]);
  } finally {
    o.signal?.removeEventListener('abort', stop);
  }
  step(stopped() ? 'Stopped.' : 'Done.');
  return { media, failed, source, model, notes };
}
