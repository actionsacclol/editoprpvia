/**
 * Making pictures from words: what is asked of a picture service and how its
 * answer is read. Pure, so every provider's request and answer is tested
 * without a key or a network (test/pictures.test.mjs).
 *
 * Two doors: a service the user has their own key for (the key lives in the
 * main process only, electron/system/secrets.ts), or the model that runs on
 * this computer (src/editor/pictureWorker.ts). Both are handed the same
 * prompt, built here.
 */

/** A service reached with the user's own key. */
export type PictureProviderId = 'openai' | 'google' | 'xai' | 'custom';
/** Where a picture is made: a service, or this computer. */
export type PictureSource = PictureProviderId | 'local';

export type PictureAspect = '16:9' | '9:16' | '1:1';
export type PictureQuality = 'low' | 'medium' | 'high';

export interface PictureProvider {
  id: PictureProviderId;
  name: string;
  /** Where requests go. Empty for `custom`: the user types it. */
  endpoint: string;
  /** Used until the user types another. Empty: the user must name one. */
  model: string;
  /** Other models worth offering. */
  models: string[];
  /** Where a key is made. */
  keyPage: string;
  /** One line about cost, for the settings page. Prices move: it points at the price page. */
  cost: string;
}

export const PICTURE_PROVIDERS: readonly PictureProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/images/generations',
    model: 'gpt-image-2',
    models: ['gpt-image-2', 'gpt-image-1-mini', 'gpt-image-1.5'],
    keyPage: 'https://platform.openai.com/api-keys',
    cost: 'Charged by OpenAI per picture; draft quality costs the least. See openai.com/api/pricing.',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/interactions',
    model: 'gemini-3.1-flash-image',
    models: ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image'],
    keyPage: 'https://aistudio.google.com/apikey',
    cost: 'Charged by Google per picture. See ai.google.dev/pricing.',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    endpoint: 'https://api.x.ai/v1/images/generations',
    model: 'grok-imagine-image',
    models: ['grok-imagine-image', 'grok-imagine-image-2.0'],
    keyPage: 'https://console.x.ai',
    cost: 'Charged by xAI per picture. See docs.x.ai for prices.',
  },
  {
    id: 'custom',
    name: 'Another service',
    endpoint: '',
    model: '',
    models: [],
    keyPage: '',
    cost: 'Any service that speaks the OpenAI images format (OpenRouter, Together, a LocalAI server on this computer…): type its address and the model name.',
  },
];

export const pictureProvider = (id: string): PictureProvider | undefined => PICTURE_PROVIDERS.find((p) => p.id === id);
export const isPictureSource = (v: unknown): v is PictureSource => v === 'local' || PICTURE_PROVIDERS.some((p) => p.id === v);
export const isPictureAspect = (v: unknown): v is PictureAspect => v === '16:9' || v === '9:16' || v === '1:1';
export const isPictureQuality = (v: unknown): v is PictureQuality => v === 'low' || v === 'medium' || v === 'high';

/** The aspect nearest a canvas. */
export function aspectFor(width: number, height: number): PictureAspect {
  const r = width / Math.max(1, height);
  return r > 1.2 ? '16:9' : r < 0.84 ? '9:16' : '1:1';
}

// ── Looks: what the words are wrapped in ────────────────────────────

export interface PictureLook {
  id: string;
  name: string;
  /** Put before the subject, so a model that reads only the start still gets it. */
  lead: string;
  /** Put after the subject. */
  tail: string;
}

export const PICTURE_LOOKS: readonly PictureLook[] = [
  { id: 'comic', name: 'Comic book', lead: 'Comic book art,', tail: 'bold black ink outlines, flat colours, halftone shading, full bleed' },
  { id: 'stickman', name: 'Stick figures', lead: 'Simple stick figure drawing,', tail: 'black marker lines on white paper, round heads, minimal detail, one accent colour' },
  { id: 'cartoon', name: 'Cartoon', lead: 'Cartoon illustration,', tail: 'clean outlines, bright flat colours, expressive faces' },
  { id: 'storybook', name: 'Storybook', lead: 'Storybook illustration,', tail: 'soft watercolour and pencil, warm light, gentle textures' },
  { id: 'anime', name: 'Anime', lead: 'Anime illustration,', tail: 'cel shading, clean line art, detailed background, soft light' },
  { id: 'render', name: '3D render', lead: '3D render,', tail: 'soft studio light, smooth clay-like materials, shallow depth of field' },
  { id: 'cinematic', name: 'Cinematic', lead: 'Cinematic film still,', tail: 'natural light, shallow depth of field, rich colour, wide shot' },
  { id: 'photo', name: 'Photo', lead: 'Photograph,', tail: 'natural light, sharp focus, realistic detail' },
  { id: 'flat', name: 'Flat graphic', lead: 'Flat vector illustration,', tail: 'simple geometric shapes, limited palette, no gradients' },
  { id: 'noir', name: 'Noir', lead: 'Black and white noir illustration,', tail: 'hard shadows, high contrast ink, film grain' },
  { id: 'pixel', name: 'Pixel art', lead: 'Pixel art scene,', tail: '16-bit game style, limited palette, crisp pixels' },
  { id: 'plain', name: 'As written', lead: '', tail: '' },
];

export const DEFAULT_LOOK = 'comic';
export const pictureLook = (id: string | undefined): PictureLook => PICTURE_LOOKS.find((l) => l.id === id) ?? PICTURE_LOOKS[0];

const MAX_SUBJECT = 600;
const MAX_KEEP = 300;
const tidy = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The words a model is given: the look, what the picture shows, what stays
 * the same from picture to picture (`keep`: "a tall man in a red scarf, a
 * grey cat"), and the request to leave letters out, since captions are the
 * editor's job and models spell badly.
 */
export function picturePrompt(subject: string, look?: string, keep?: string): string {
  const l = pictureLook(look);
  const s = tidy(subject, MAX_SUBJECT).replace(/[.\s]+$/, '');
  if (!s) throw new Error('Say what the picture should show.');
  const k = tidy(keep ?? '', MAX_KEEP).replace(/[.\s]+$/, '');
  const parts = [l.lead ? `${l.lead} ${s}` : s];
  if (k) parts.push(k);
  if (l.tail) parts.push(l.tail);
  if (l.id !== 'plain') parts.push('no text, no captions, no watermark');
  return `${parts.join('. ')}.`;
}

/** A file name from what a picture shows. */
export function pictureSlug(subject: string): string {
  const s = subject
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'picture';
}

// ── Asking a service ────────────────────────────────────────────────

export interface PictureAsk {
  /** The whole prompt, as picturePrompt wrote it. */
  prompt: string;
  aspect: PictureAspect;
  quality: PictureQuality;
  model: string;
  /** For `custom`: the address requests go to. */
  endpoint?: string;
}

export interface PictureRequest {
  url: string;
  /** Everything but the key. */
  headers: Record<string, string>;
  /** The header the key goes in, and what is written before it. */
  key: { header: string; prefix: string };
  body: Record<string, unknown>;
}

const OPENAI_SIZE: Record<PictureAspect, string> = { '16:9': '1536x1024', '9:16': '1024x1536', '1:1': '1024x1024' };
const PIXELS: Record<PictureAspect, [number, number]> = { '16:9': [1344, 768], '9:16': [768, 1344], '1:1': [1024, 1024] };

/**
 * Where a custom service is: https anywhere, or plain http on this computer
 * only (a model server the user runs). Throws with a sentence otherwise.
 */
export function customEndpoint(raw: string | undefined): URL {
  let u: URL;
  try {
    u = new URL((raw ?? '').trim());
  } catch {
    throw new Error('Type the full address of the service, like https://example.com/v1/images/generations.');
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.username || u.password) throw new Error('The address must not carry a name or password.');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('The address must start with https:// (http:// only for a server on this computer).');
  return u;
}

export function pictureRequest(id: PictureProviderId, ask: PictureAsk): PictureRequest {
  const p = pictureProvider(id);
  if (!p) throw new Error(`"${id}" is not a picture service.`);
  const model = ask.model.trim() || p.model;
  if (!model) throw new Error(`Name the model to use at ${p.name} (Settings, Pictures from words).`);
  const bearer = { header: 'Authorization', prefix: 'Bearer ' };
  const json = { 'Content-Type': 'application/json' };
  if (id === 'openai') {
    // GPT image models always answer with the picture itself (base64); `response_format` is refused.
    return { url: p.endpoint, headers: json, key: bearer, body: { model, prompt: ask.prompt, n: 1, size: OPENAI_SIZE[ask.aspect], quality: ask.quality, output_format: 'jpeg' } };
  }
  if (id === 'xai') {
    return { url: p.endpoint, headers: json, key: bearer, body: { model, prompt: ask.prompt, n: 1, aspect_ratio: ask.aspect, response_format: 'b64_json' } };
  }
  if (id === 'google') {
    return {
      url: p.endpoint,
      headers: { ...json, 'Api-Revision': '2026-05-20' },
      key: { header: 'x-goog-api-key', prefix: '' },
      body: { model, input: [{ type: 'text', text: ask.prompt }], response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: ask.aspect, image_size: ask.quality === 'high' ? '2K' : '1K' } },
    };
  }
  const url = customEndpoint(ask.endpoint);
  const [width, height] = PIXELS[ask.aspect];
  // Together's flavour of the format takes a width and a height where the others take a size.
  const sized = /(^|\.)together\.(ai|xyz)$/.test(url.hostname) ? { width, height } : { size: `${width}x${height}` };
  return { url: url.toString(), headers: json, key: bearer, body: { model, prompt: ask.prompt, n: 1, ...sized } };
}

// ── Reading the answer ──────────────────────────────────────────────

export interface PictureAnswer {
  /** The picture itself, base64. */
  b64?: string;
  /** Or where it can be fetched. */
  url?: string;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The first picture in a service's answer, whichever of the known shapes it has. Null when there is none. */
export function pictureAnswer(body: unknown): PictureAnswer | null {
  const top = obj(body);
  if (!top) return null;
  // OpenAI's shape (also xAI, OpenRouter, Together, LocalAI): data[0].b64_json or data[0].url.
  for (const d of list(top.data)) {
    const o = obj(d);
    if (!o) continue;
    const b64 = text(o.b64_json) || text(o.base64);
    if (b64) return { b64 };
    if (text(o.url)) return { url: text(o.url) };
  }
  // Google's interactions: steps[] of model output, each with content[] of images.
  const blocks = [...list(top.steps), ...list(top.outputs)].flatMap((s) => {
    const o = obj(s);
    return o ? [o, ...list(o.content)] : [];
  });
  for (const b of blocks) {
    const o = obj(b);
    if (o && o.type === 'image' && text(o.data)) return { b64: text(o.data) };
  }
  // Google's older shape: candidates[].content.parts[].inlineData.data.
  for (const c of list(top.candidates)) {
    for (const part of list(obj(obj(c)?.content)?.parts)) {
      const inline = obj(obj(part)?.inlineData) ?? obj(obj(part)?.inline_data);
      if (inline && text(inline.data)) return { b64: text(inline.data) };
    }
  }
  return null;
}

/** Removes a key from text that is about to be shown, logged or handed to an agent. */
export function withoutKey(message: string, key: string | null | undefined): string {
  return key && key.length >= 6 ? message.split(key).join('[key]') : message;
}

/**
 * Why a service said no, as a sentence someone can act on. What the service
 * wrote is quoted (cut short), never interpreted.
 */
export function pictureFailure(service: string, status: number, body: unknown): string {
  const e = obj(body)?.error;
  const said = tidy(text(obj(e)?.message) || text(e) || text(obj(body)?.message) || text(obj(body)?.detail), 240);
  const quote = said ? ` It said: "${said}"` : '';
  if (status === 401 || status === 403) return `${service} did not accept the key. Check it in Settings, Pictures from words.${quote}`;
  if (status === 402) return `${service} says the account has no credit left.${quote}`;
  if (status === 404) return `${service} does not know that model or address. Check the model name in Settings, Pictures from words.${quote}`;
  if (status === 429) return `${service} is asking for a pause (too many requests, or the account's limit is reached).${quote}`;
  if (status === 400 || status === 422) return `${service} refused the request.${quote || ' The prompt may be against its rules, or the model may not take this picture shape.'}`;
  if (status >= 500) return `${service} is having trouble right now (${status}). Try again shortly.`;
  return `${service} answered ${status}.${quote}`;
}

// ── What the page is told about the setup ───────────────────────────

/** Settings kept in the app's state file. No key is ever in here. */
export interface PictureSettings {
  /** Where pictures are made when nobody says. Null: not chosen yet. */
  source: PictureSource | null;
  quality: PictureQuality;
  /** The model per service, when the user typed another than the default. */
  models: Partial<Record<PictureProviderId, string>>;
  /** The address of the `custom` service. */
  endpoint: string;
  /** The most pictures made with a key in one day, by anyone (the dialogs and connected agents). */
  dailyLimit: number;
}

export const DEFAULT_PICTURE_SETTINGS: PictureSettings = { source: null, quality: 'low', models: {}, endpoint: '', dailyLimit: 100 };
export const MAX_DAILY_LIMIT = 2000;

export function readPictureSettings(raw: unknown, base: PictureSettings = DEFAULT_PICTURE_SETTINGS): PictureSettings {
  const o = obj(raw);
  if (!o) return { ...base, models: { ...base.models } };
  const models: PictureSettings['models'] = { ...base.models };
  const given = obj(o.models);
  if (given) for (const p of PICTURE_PROVIDERS) if (typeof given[p.id] === 'string') models[p.id] = tidy(given[p.id] as string, 120);
  const limit = Number(o.dailyLimit);
  return {
    source: o.source === null ? null : isPictureSource(o.source) ? o.source : base.source,
    quality: isPictureQuality(o.quality) ? o.quality : base.quality,
    models,
    endpoint: typeof o.endpoint === 'string' ? o.endpoint.trim().slice(0, 500) : base.endpoint,
    dailyLimit: Number.isFinite(limit) && limit >= 1 ? Math.min(MAX_DAILY_LIMIT, Math.round(limit)) : base.dailyLimit,
  };
}

export interface PictureProviderState {
  id: PictureProviderId;
  /** A key is kept for it. */
  hasKey: boolean;
  /** The end of that key ("…a1b2"), to tell two apart. */
  hint: string | null;
  /** The model in use. */
  model: string;
}

export interface PictureSetup {
  settings: PictureSettings;
  providers: PictureProviderState[];
  /** Pictures made with a key today, against settings.dailyLimit. */
  madeToday: number;
}

/** Can this source make a picture right now, and if not, why. `localReady`: the on-device model is installed. */
export function sourceProblem(setup: PictureSetup, source: PictureSource, localReady: boolean): string | null {
  if (source === 'local') return localReady ? null : 'The picture model for this computer is not downloaded yet (Settings, Pictures from words).';
  const p = pictureProvider(source);
  const st = setup.providers.find((x) => x.id === source);
  if (!p || !st) return `"${source}" is not a picture service.`;
  if (source === 'custom' && !setup.settings.endpoint) return 'Type the address of the service first (Settings, Pictures from words).';
  if (!st.hasKey && !(source === 'custom' && /^http:/.test(setup.settings.endpoint))) return `No key is kept for ${p.name} yet (Settings, Pictures from words).`;
  if (!st.model) return `Name the model to use at ${p.name} (Settings, Pictures from words).`;
  return null;
}

/** The source to use when none is named: the chosen one, else the first that is ready. */
export function pickSource(setup: PictureSetup, localReady: boolean, wanted?: PictureSource | null): PictureSource | null {
  if (wanted) return wanted;
  const chosen = setup.settings.source;
  if (chosen && !sourceProblem(setup, chosen, localReady)) return chosen;
  if (localReady) return 'local';
  return setup.providers.find((p) => !sourceProblem(setup, p.id, localReady))?.id ?? chosen;
}

export const sourceName = (s: PictureSource): string => (s === 'local' ? 'This computer' : (pictureProvider(s)?.name ?? s));

// ── The models that run on this computer ────────────────────────────

export type LocalPictureModelId = 'lcm' | 'sdxs';

export interface LocalPictureModel {
  id: LocalPictureModelId;
  name: string;
  /** Size of the download, in bytes (the files pinned in electron/system/pictures.ts). */
  bytes: number;
  /** Passes over the picture: more is slower and better. */
  steps: number;
  about: string;
  licence: string;
}

export const LOCAL_PICTURE_MODELS: readonly LocalPictureModel[] = [
  {
    id: 'lcm',
    name: 'DreamShaper 8 LCM',
    bytes: 246275486 + 1719739393 + 2467568 + 1059962 + 524619,
    steps: 4,
    about: 'The better one: four passes per picture, about two seconds each on a recent graphics card.',
    licence: 'CreativeML Open RAIL-M',
  },
  {
    id: 'sdxs',
    name: 'SDXS (small)',
    bytes: 246275486 + 631766742 + 2467568 + 1059962 + 524619,
    steps: 1,
    about: 'The small one: one pass per picture, a fraction of a second each, rougher drawings.',
    licence: 'CreativeML Open RAIL++-M',
  },
];

export const localPictureModel = (id: unknown): LocalPictureModel | undefined => LOCAL_PICTURE_MODELS.find((m) => m.id === id);

/** One model's install, as the page is told. */
export interface LocalPictureStatus {
  id: LocalPictureModelId;
  installed: boolean;
  downloadBytes: number;
  totalBytes: number;
  installing: boolean;
  progress: { stage: 'downloading' | 'verifying'; done: number; total: number } | null;
}

/** krypteditor:// addresses of an installed model's files, for the worker. */
export interface LocalPictureFiles {
  id: LocalPictureModelId;
  text: string;
  unet: string;
  vae: string;
  vocab: string;
  merges: string;
}

/** The best installed model: the better one when it is there. */
export const readyLocalModel = (list: readonly LocalPictureStatus[]): LocalPictureModelId | null => LOCAL_PICTURE_MODELS.find((m) => list.some((s) => s.id === m.id && s.installed))?.id ?? null;

/** What main is asked for one picture from a service. */
export interface PictureOrder {
  source: PictureProviderId;
  /** The whole prompt (picturePrompt). */
  prompt: string;
  /** What the picture shows, for the file name. */
  subject: string;
  aspect: PictureAspect;
  quality?: PictureQuality;
}

export interface MadePicture {
  path: string;
  source: PictureSource;
  model: string;
}

// ── A picture per beat of a narration ───────────────────────────────

export interface PictureBeat {
  /** The words spoken as the picture comes up (the start of the beat). */
  when: string;
  /** What the picture shows: the beat's own words. */
  subject: string;
}

export const MAX_PICTURES_PER_BUILD = 80;

/**
 * Narration cut into beats, one picture each: sentences, with short ones
 * joined to the next until a beat has at least `minWords` words (about four
 * seconds of speech at 12), so no picture flashes by.
 */
export function pictureBeats(text: string, minWords = 12): PictureBeat[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…]["'”’)]?)\s+(?=["'“‘(]?[\p{Lu}\p{N}])/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const beats: PictureBeat[] = [];
  let cur: string[] = [];
  const words = (s: string): number => s.split(' ').filter(Boolean).length;
  const flush = (): void => {
    if (cur.length === 0) return;
    const all = cur.join(' ');
    beats.push({ when: all.split(' ').slice(0, 6).join(' '), subject: all.slice(0, MAX_SUBJECT) });
    cur = [];
  };
  for (const s of sentences) {
    cur.push(s);
    if (words(cur.join(' ')) >= minWords) flush();
  }
  // A short tail joins the beat before it rather than standing alone.
  if (cur.length && beats.length && words(cur.join(' ')) < minWords / 2) {
    const last = beats[beats.length - 1];
    last.subject = `${last.subject} ${cur.join(' ')}`.slice(0, MAX_SUBJECT);
    cur = [];
  }
  flush();
  return beats;
}

/**
 * Beats for several parts of a script, at most `max` pictures in all: the
 * beats are made longer until they fit.
 */
export function pictureBeatsWithin(texts: string[], max = MAX_PICTURES_PER_BUILD, minWords = 12): PictureBeat[][] {
  let size = Math.max(4, minWords);
  for (;;) {
    const out = texts.map((t) => pictureBeats(t, size));
    if (out.reduce((n, b) => n + b.length, 0) <= max || size > 400) return out;
    size = Math.ceil(size * 1.3);
  }
}
