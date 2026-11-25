/**
 * Pictures from words, the main process's side: asking a picture service with
 * the user's own key, keeping what comes back in the Images folder, and
 * installing the models that make pictures on this computer.
 *
 * The key is read here and nowhere else (secrets.ts): the page and connected
 * agents can order a picture, never see what it was ordered with. Requests go
 * only to the service the user chose, from a session without cookies; the
 * prompt is the only thing of theirs that leaves. A daily limit caps what an
 * agent (or a slip of the hand) can spend.
 */

import { app, session, type Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  customEndpoint,
  DEFAULT_PICTURE_SETTINGS,
  isPictureAspect,
  isPictureQuality,
  LOCAL_PICTURE_MODELS,
  localPictureModel,
  PICTURE_PROVIDERS,
  pictureAnswer,
  pictureFailure,
  pictureProvider,
  pictureRequest,
  pictureSlug,
  readPictureSettings,
  withoutKey,
  type LocalPictureFiles,
  type LocalPictureModelId,
  type LocalPictureStatus,
  type MadePicture,
  type PictureOrder,
  type PictureProviderId,
  type PictureSettings,
  type PictureSetup,
  type PictureSource,
} from '../../shared/imageGen';
import { allowPaths } from './allowlist';
import { imagesDir, outside, sniff } from './images';
import { logger } from './logger';
import { mediaUrl } from './mediaProtocol';
import { PinnedModel, type InstallProgress, type PinnedFile } from './modelFiles';
import { getSecret, secretHint, setSecret } from './secrets';
import * as store from './settings-store';

/** A picture can take a while at the highest quality. */
const TIMEOUT = 180_000;
const MAX_ANSWER = 64 * 1024 * 1024;
const MAX_PICTURE = 30 * 1024 * 1024;
const MAX_PROMPT = 1600;

const secretName = (id: PictureProviderId): string => `pictures.${id}`;

let ses: Session | null = null;
function net(): Session {
  if (!ses) {
    ses = session.fromPartition('krypt-pictures', { cache: false });
    ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (e) => e.preventDefault());
  }
  return ses;
}

// ── Settings and keys ───────────────────────────────────────────────

export function settings(): PictureSettings {
  return readPictureSettings(store.load().pictures, DEFAULT_PICTURE_SETTINGS);
}

/** Pictures made with a key today: { day, count } in userData. */
const tallyPath = (): string => path.join(app.getPath('userData'), 'pictures-made.json');
const today = (): string => new Date().toISOString().slice(0, 10);
function madeToday(): number {
  try {
    const t = JSON.parse(fs.readFileSync(tallyPath(), 'utf8')) as { day?: string; count?: number };
    return t.day === today() && Number.isFinite(t.count) ? Math.max(0, Number(t.count)) : 0;
  } catch {
    return 0;
  }
}
function countOne(): void {
  try {
    fs.writeFileSync(tallyPath(), JSON.stringify({ day: today(), count: madeToday() + 1 }));
  } catch {
    /* the limit is a courtesy, not a ledger */
  }
}

export function setup(): PictureSetup {
  const s = settings();
  return {
    settings: s,
    providers: PICTURE_PROVIDERS.map((p) => ({ id: p.id, hasKey: getSecret(secretName(p.id)) !== null, hint: secretHint(secretName(p.id)), model: (s.models[p.id] ?? '').trim() || p.model })),
    madeToday: madeToday(),
  };
}

export function configure(patch: unknown): PictureSetup {
  const next = readPictureSettings(patch, settings());
  if (next.endpoint) customEndpoint(next.endpoint);
  store.update({ pictures: next });
  return setup();
}

/** Keep (or, with an empty value, forget) the key for a service. */
export function setKey(id: string, key: string): PictureSetup {
  const p = pictureProvider(id);
  if (!p) throw new Error(`"${id}" is not a picture service.`);
  const v = String(key ?? '').trim();
  if (v && (v.length < 8 || v.length > 400 || /\s/.test(v))) throw new Error('That does not look like a key: it should be one long word without spaces.');
  setSecret(secretName(p.id), v);
  logger.info(`[pictures] key for ${p.id} ${v ? 'kept' : 'forgotten'}`);
  return setup();
}

// ── Keeping a picture ───────────────────────────────────────────────

const stamp = (): string => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Writes a made picture into the Images folder, with the words it was made from next to it. */
function write(bytes: Buffer, subject: string, prompt: string, source: PictureSource, model: string): MadePicture {
  if (bytes.length > MAX_PICTURE) throw new Error('The picture that came back is too large to keep.');
  const ext = sniff(bytes);
  if (!ext) throw new Error('What came back is not a JPEG, PNG or WebP picture.');
  const dir = imagesDir();
  fs.mkdirSync(dir, { recursive: true });
  const base = `made-${stamp()}-${pictureSlug(subject)}`;
  let name = base;
  for (let n = 2; fs.existsSync(path.join(dir, `${name}.${ext}`)); n++) name = `${base}-${n}`;
  const file = path.join(dir, `${name}.${ext}`);
  fs.writeFileSync(`${file}.part`, bytes);
  fs.renameSync(`${file}.part`, file);
  try {
    fs.writeFileSync(path.join(dir, `${name}.prompt.txt`), `${prompt}\n\nMade ${new Date().toISOString().slice(0, 10)} with ${model} (${source === 'local' ? 'on this computer' : source}).\n`);
  } catch {
    /* the picture matters, the note is a convenience */
  }
  return { path: file, source, model };
}

/** A picture the page made itself (the model on this computer). */
export function keep(data: Uint8Array, subject: string, prompt: string, model: string): MadePicture {
  const m = localPictureModel(model);
  if (!m) throw new Error('Unknown picture model.');
  return write(Buffer.from(data.buffer, data.byteOffset, data.byteLength), String(subject), String(prompt).slice(0, MAX_PROMPT), 'local', m.name);
}

// ── Drawings ────────────────────────────────────────────────────────

const MAX_DRAWING_TEXT = 400_000;

/**
 * A drawing an agent made (SVG the page already cleaned and turned into a PNG): the picture goes into the Images
 * folder with its SVG next to it, which is what lets it move later.
 */
export function keepDrawing(data: Uint8Array, svg: string, name: string): { path: string } {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length > MAX_PICTURE) throw new Error('The drawing is too large to keep.');
  if (sniff(bytes) !== 'png') throw new Error('A drawing is kept as a PNG.');
  const text = String(svg ?? '');
  if (!text || text.length > MAX_DRAWING_TEXT) throw new Error('The drawing has no source, or too much of it.');
  const dir = imagesDir();
  fs.mkdirSync(dir, { recursive: true });
  const base = `drawn-${stamp()}-${pictureSlug(String(name ?? ''))}`;
  let stem = base;
  for (let n = 2; fs.existsSync(path.join(dir, `${stem}.png`)); n++) stem = `${base}-${n}`;
  const file = path.join(dir, `${stem}.png`);
  fs.writeFileSync(`${file}.part`, bytes);
  fs.renameSync(`${file}.part`, file);
  fs.writeFileSync(path.join(dir, `${stem}.svg`), text, 'utf8');
  return { path: file };
}

/** The SVG a kept drawing was made from, or null when the file is not one (or its source is gone). */
export function drawingSource(filePath: string): string | null {
  const dir = path.resolve(imagesDir());
  const file = path.resolve(String(filePath ?? ''));
  const name = path.basename(file);
  if (path.dirname(file).toLowerCase() !== dir.toLowerCase() || !/^drawn-[\w.-]+\.png$/i.test(name)) return null;
  const source = path.join(dir, `${name.slice(0, -4)}.svg`);
  try {
    if (fs.statSync(source).size > MAX_DRAWING_TEXT * 4) return null;
    return fs.readFileSync(source, 'utf8');
  } catch {
    return null;
  }
}

// ── Asking a service ────────────────────────────────────────────────

const flights = new Set<AbortController>();
/** Orders with a key that are out right now: counted against the day's limit before they come back, so two at once cannot both take the last place. */
let ordered = 0;

/** Stops every order in flight (the dialog's Cancel, an agent's cancelled call). */
export function cancel(): void {
  for (const f of flights) f.abort();
}

export async function generate(order: PictureOrder): Promise<MadePicture> {
  const p = pictureProvider(String(order?.source));
  if (!p) throw new Error(`"${String(order?.source)}" is not a picture service.`);
  const prompt = String(order.prompt ?? '').trim();
  if (!prompt) throw new Error('Say what the picture should show.');
  if (prompt.length > MAX_PROMPT) throw new Error(`The description is too long (${prompt.length} characters; ${MAX_PROMPT} at most).`);
  const s = settings();
  const key = getSecret(secretName(p.id));
  const local = p.id === 'custom' && /^http:/.test(s.endpoint);
  if (!key && !local) throw new Error(`No key is kept for ${p.name} yet. Add one in Settings, Pictures from words.`);
  const made = madeToday() + ordered;
  if (key && made >= s.dailyLimit) throw new Error(`Today's limit of ${s.dailyLimit} pictures made with a key is reached (Settings, Pictures from words). Nothing was ordered.`);

  const req = pictureRequest(p.id, { prompt, aspect: isPictureAspect(order.aspect) ? order.aspect : '16:9', quality: isPictureQuality(order.quality) ? order.quality : s.quality, model: s.models[p.id] ?? '', endpoint: s.endpoint });
  const model = String(req.body.model);
  const clean = (m: string): string => withoutKey(m, key);
  const ctl = new AbortController();
  flights.add(ctl);
  if (key) ordered++;
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    let res: Response;
    try {
      res = await net().fetch(req.url, {
        method: 'POST',
        signal: ctl.signal,
        redirect: 'error',
        credentials: 'omit',
        headers: { ...req.headers, ...(key ? { [req.key.header]: req.key.prefix + key } : {}) },
        body: JSON.stringify(req.body),
      });
    } catch (e) {
      throw new Error(ctl.signal.aborted ? `${p.name} was stopped, or took too long to answer.` : clean(`${p.name} could not be reached (${(e as Error).message}). Check the internet connection${p.id === 'custom' ? ' and the address' : ''}.`));
    }
    if (Number(res.headers.get('content-length') ?? 0) > MAX_ANSWER) throw new Error(`${p.name} sent something too large to read.`);
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.length > MAX_ANSWER) throw new Error(`${p.name} sent something too large to read.`);
    let body: unknown = null;
    try {
      body = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      /* not JSON: told below */
    }
    if (!res.ok) throw new Error(clean(pictureFailure(p.name, res.status, body)));
    const answer = pictureAnswer(body);
    if (!answer) throw new Error(`${p.name} answered without a picture. The model may not make pictures, or it turned the description down.`);

    let bytes: Buffer;
    if (answer.b64) bytes = Buffer.from(answer.b64.replace(/^data:[^,]*,/, ''), 'base64');
    else {
      // A picture kept at an address: on the open internet, or on the very server that was asked.
      const at = new URL(answer.url ?? '', req.url);
      if (at.origin !== new URL(req.url).origin) {
        try {
          outside(at.toString());
        } catch {
          throw new Error(`${p.name} made the picture but keeps it at an address that is not read from here (only https addresses on the open internet, or the service's own).`);
        }
      }
      const got = await net().fetch(at.toString(), { signal: ctl.signal, redirect: 'follow', credentials: 'omit', headers: { Accept: 'image/jpeg, image/png, image/webp' } });
      if (!got.ok) throw new Error(`${p.name} made the picture, but it could not be fetched (${got.status}).`);
      if (Number(got.headers.get('content-length') ?? 0) > MAX_PICTURE) throw new Error('The picture that came back is too large to keep.');
      bytes = Buffer.from(await got.arrayBuffer());
    }
    const out = write(bytes, String(order.subject ?? '') || prompt, prompt, p.id, model);
    if (key) countOne();
    return out;
  } catch (e) {
    logger.warn(`[pictures] ${p.id}: ${clean((e as Error).message)}`);
    throw new Error(clean((e as Error).message));
  } finally {
    clearTimeout(timer);
    flights.delete(ctl);
    if (key) ordered--;
  }
}

// ── The models that run on this computer ────────────────────────────

const HF = 'https://huggingface.co';
const pinned = (repo: string, rev: string, files: Array<[name: string, file: string, bytes: number, sha256: string]>): PinnedFile[] => files.map(([name, file, bytes, sha256]) => ({ name, url: `${HF}/${repo}/resolve/${rev}/${file}`, bytes, sha256 }));

const SDXS_REPO = 'skillsafeai/sdxs-512-dreamshaper-onnx-webgpu';
const SDXS_REV = 'b23bf8f4f809a0beb6d095bf52b5854e0b66caef';
/** TAESD, the tiny decoder (2.5 MB): what turns either model's result into pixels. */
const DECODER: [string, string, number, string] = ['decoder.onnx', 'vae_decoder.onnx', 2467568, '75c5e431703b1d87bcc44f5610b49f6b73594b09857a2263958123afe0be7190'];

const VOCAB = 'e089ad92ba36837a0d31433e555c8f45fe601ab5c221d4f607ded32d9f7a4349';
const MERGES = '9fd691f7c8039210e0fced15865466c65820d09b63988b0174bfe25de299051a';

/**
 * DreamShaper 8 LCM (Lykon; CreativeML Open RAIL-M) and SDXS-512-DreamShaper
 * (IDKiro; Open RAIL++-M, TAESD decoder by madebyollin, MIT), as the fp16 ONNX
 * exports for onnxruntime-web, each pinned to one revision.
 *
 * Both are decoded by TAESD. DreamShaper's own decoder (198 MB, full
 * precision) is left out on purpose: measured on an RTX 3080 it took 3 to 8
 * seconds a picture where the four drawing passes took 1.3, swung graphics
 * memory between 4 and 6.4 GB, and under load got the device removed by
 * Windows, after which the app could not use the card until restarted. TAESD
 * does the same job in 40 ms with memory steady near 4.2 GB, a little softer
 * in fine detail.
 */
const MODELS: Record<LocalPictureModelId, PinnedModel> = {
  lcm: new PinnedModel(
    'pictures-lcm',
    'picture model',
    pinned('skillsafeai/dreamshaper-8-lcm-onnx-webgpu', 'a310400909a293a7a937a54854910ed06469192b', [
      ['vocab.json', 'tokenizer/vocab.json', 1059962, VOCAB],
      ['merges.txt', 'tokenizer/merges.txt', 524619, MERGES],
      ['text_encoder.onnx', 'text_encoder.onnx', 246275486, '43f7a91340052d59c370b842388a34d5c337fe7323b268ba8e7b55795a1ec6f5'],
      ['unet.onnx', 'unet.onnx', 1719739393, '1851819e721a81cc7498c932ca040fb1c2032c6a82e5f24c2c87d283ad3c0e41'],
    ]).concat(pinned(SDXS_REPO, SDXS_REV, [DECODER])),
  ),
  sdxs: new PinnedModel(
    'pictures-sdxs',
    'picture model',
    pinned(SDXS_REPO, SDXS_REV, [
      ['vocab.json', 'tokenizer/vocab.json', 1059962, VOCAB],
      ['merges.txt', 'tokenizer/merges.txt', 524619, MERGES],
      DECODER,
      ['text_encoder.onnx', 'text_encoder.onnx', 246275486, '73464847bad29badc218bf9f0d285f36b92ddccd6b874643d2a2d31766870e83'],
      ['unet.onnx', 'unet.onnx', 631766742, 'f81dc16670944fead5561851a06038a21c23779760065249274801f47896ece7'],
    ]),
  ),
};

const model = (id: unknown): PinnedModel => {
  const m = localPictureModel(id);
  if (!m) throw new Error('Unknown picture model.');
  return MODELS[m.id];
};

export function localStatus(): LocalPictureStatus[] {
  return LOCAL_PICTURE_MODELS.map((m) => ({ id: m.id, ...MODELS[m.id].status() }));
}

function localFiles(id: LocalPictureModelId): LocalPictureFiles {
  const m = MODELS[id];
  allowPaths(m.files.map((f) => m.file(f.name)));
  const at = (name: string): string => mediaUrl(m.file(name));
  return { id, text: at('text_encoder.onnx'), unet: at('unet.onnx'), vae: at('decoder.onnx'), vocab: at('vocab.json'), merges: at('merges.txt') };
}

/** Installs a model if needed and returns where the worker reads it from. */
export async function localEnsure(id: unknown, onProgress: (p: InstallProgress) => void): Promise<LocalPictureFiles> {
  const m = localPictureModel(id);
  await model(id).ensure(onProgress);
  return localFiles(m!.id);
}

/** Where an installed model is read from; throws when it is not installed (nothing is downloaded). */
export function localOpen(id: unknown): LocalPictureFiles {
  const m = localPictureModel(id);
  if (!model(id).status().installed) throw new Error('That picture model is not downloaded yet (Settings, Pictures from words).');
  return localFiles(m!.id);
}

export const localCancel = (id: unknown): void => model(id).cancel();
export const localRemove = (id: unknown): void => model(id).remove();

/** Told whenever an install starts or ends, or a model is removed. */
export function onLocalChange(fn: () => void): void {
  for (const m of Object.values(MODELS)) m.onChange(fn);
}
