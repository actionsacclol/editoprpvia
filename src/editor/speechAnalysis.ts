import type { MediaFile } from '@shared/types';
import { decodeMono } from './audioDecode';
import { remapSegments } from './autoEdit';
import { CAPTION_MODELS, speechModelFor, transcribe, type CaptionSegment } from './captions';
import type { MediaClip } from './timelineStore';

/**
 * Whisper transcripts per media file, for auto edit's speech mode. The file's
 * audio is decoded straight to mono 16 kHz (what the model expects) and sent
 * through the captions worker. A transcript of a long recording costs tens of
 * minutes, so results are kept in memory for the session *and* in IndexedDB
 * keyed by path + size + model: reopening the app, or a dev reload, never
 * repeats the pass for an unchanged file. Timestamps are source seconds — the
 * caller maps them through each clip.
 */

export interface SpeechProgress {
  status: string;
  /** 0..1 while the model downloads, then share of audio transcribed; 0 = indeterminate. */
  ratio: number;
}

const cache = new Map<string, CaptionSegment[]>();
const pending = new Map<string, Promise<CaptionSegment[]>>();

/** Stable across sessions (media.id is not): same file, same size, same model → same transcript. */
const keyOf = (media: MediaFile, model: string): string => `${media.filePath}|${media.sizeBytes}|${model}`;

export function cachedTranscript(media: MediaFile, model: string): CaptionSegment[] | undefined {
  return cache.get(keyOf(media, model));
}

// ── Persistent cache ───────────────────────────────────────────────────────
const DB_NAME = 'krypt-transcripts';
const STORE = 'transcripts';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function dbGet(key: string): Promise<CaptionSegment[] | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as CaptionSegment[]) : undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function dbPut(key: string, segs: CaptionSegment[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(segs, key);
  } catch {
    /* quota or private mode — the in-memory copy still serves this session */
  }
}

// ── Decode + transcribe ────────────────────────────────────────────────────
/** Decode a media file to mono 16 kHz PCM. */
export async function decodeMono16k(media: MediaFile): Promise<Float32Array> {
  const out = await decodeMono(media.mediaUrl, 16000);
  if (!out) throw new Error(`${media.name} has no audio.`);
  return out;
}

export function getTranscript(media: MediaFile, opts: { model: string; signal?: AbortSignal; onProgress?: (p: SpeechProgress) => void }): Promise<CaptionSegment[]> {
  const k = keyOf(media, opts.model);
  const hit = cache.get(k);
  if (hit) return Promise.resolve(hit);
  const inflight = pending.get(k);
  if (inflight) return inflight;

  const job = (async (): Promise<CaptionSegment[]> => {
    try {
      const stored = await dbGet(k);
      if (stored) {
        cache.set(k, stored);
        return stored;
      }
      opts.onProgress?.({ status: `Decoding ${media.name}…`, ratio: 0 });
      const audio = await decodeMono16k(media);
      if (opts.signal?.aborted) throw new Error('Transcription cancelled.');
      let status = 'Loading speech model…';
      let ratio = 0;
      const emit = (): void => opts.onProgress?.({ status: `${status} · ${media.name}`, ratio });
      const segs = await transcribe(audio, {
        model: opts.model,
        signal: opts.signal,
        onStatus: (st) => {
          status = st;
          emit();
        },
        onProgress: (r) => {
          ratio = r;
          emit();
        },
      });
      cache.set(k, segs);
      void dbPut(k, segs);
      return segs;
    } finally {
      pending.delete(k);
    }
  })();
  pending.set(k, job);
  return job;
}

/**
 * The speech model to use for `media`: one it already has a stored transcript
 * from (so opening the transcript after auto edit never repeats the pass),
 * else the default.
 */
export async function transcriptModelFor(media: MediaFile): Promise<string> {
  // Accurate first: if both exist, the better transcript wins.
  for (const { value } of [...CAPTION_MODELS].reverse()) {
    const k = keyOf(media, value);
    if (cache.has(k)) return value;
    const stored = await dbGet(k);
    if (stored) {
      cache.set(k, stored);
      return value;
    }
  }
  return speechModelFor();
}

/** Whether `media` already has a transcript from `model` (memory or IndexedDB), without running Whisper. */
export async function hasTranscript(media: MediaFile, model: string): Promise<boolean> {
  const k = keyOf(media, model);
  if (cache.has(k)) return true;
  const stored = await dbGet(k);
  if (stored) cache.set(k, stored);
  return !!stored;
}

/**
 * Captions for timeline clips from per-file transcripts mapped through the
 * clips, when that beats transcribing the timeline's mix: every file already
 * has a transcript from `model` (instant), or there's a single file the
 * timeline uses most of (its transcript then also serves auto edit and the
 * transcript panel, and a re-run after more edits is instant). Null:
 * transcribe the mix instead.
 */
export async function captionsFromTranscripts(
  sources: MediaClip[],
  media: MediaFile[],
  model: string,
  opts: { signal?: AbortSignal; onProgress?: (p: SpeechProgress) => void } = {},
): Promise<CaptionSegment[] | null> {
  const ids = [...new Set(sources.map((c) => c.mediaId))];
  const files = ids.map((id) => media.find((m) => m.id === id));
  if (files.length === 0 || files.some((m) => !m)) return null;
  const stored = await Promise.all(files.map((m) => hasTranscript(m!, model)));
  if (!stored.every(Boolean)) {
    if (files.length > 1) return null;
    const used = sources.reduce((s, c) => s + c.duration * c.speed, 0);
    if (used < 0.5 * (sources[0].sourceDuration || Infinity)) return null;
  }
  const out: CaptionSegment[] = [];
  for (const m of files) {
    const segs = await getTranscript(m!, { model, signal: opts.signal, onProgress: opts.onProgress });
    out.push(...remapSegments(segs, sources.filter((c) => c.mediaId === m!.id).sort((a, b) => a.start - b.start)));
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Keep a transcript that did not come from listening: narration spoken from a
 * script, where the words are known. Stored for every speech model, so
 * captions, the transcript panel and ducking all find it without a pass.
 */
export function storeTranscript(media: MediaFile, segs: CaptionSegment[]): void {
  for (const { value } of CAPTION_MODELS) {
    const k = keyOf(media, value);
    cache.set(k, segs);
    void dbPut(k, segs);
  }
}

/** An already-stored transcript of `media` from any model, without running Whisper; null if there is none. */
export async function storedTranscript(media: MediaFile): Promise<CaptionSegment[] | null> {
  const model = await transcriptModelFor(media);
  return cache.get(keyOf(media, model)) ?? null;
}
