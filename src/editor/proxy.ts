import { ALL_FORMATS, Conversion, Input, Mp4OutputFormat, Output, StreamTarget, UrlSource, type StreamTargetChunk } from 'mediabunny';
import type { MediaFile } from '@shared/types';
import { useMediaStore } from './mediaStore';

/**
 * Preview copies ("proxies") of large video.
 *
 * Footage above 1080p is heavy to scrub: every stop of the playhead has to
 * decode from the last keyframe, which in a 4K camera or phone file can be
 * seconds of big frames away. For such files the editor makes a small copy
 * (1280 on the long side, a keyframe every half second) in the media cache and
 * the preview plays that. Everything that produces output (export, frame
 * grabs for agents, captions, analysis) keeps reading the original, so the
 * copy never costs quality.
 *
 * The copy is made in the app (WebCodecs through mediabunny), keeps every
 * frame's timestamp, and is found again the next time the same file is used.
 */

const KEY = 'krypt.editor.proxies';
export const proxiesEnabled = (): boolean => {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
};
export function setProxiesEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* private mode */
  }
  if (!on) useMediaStore.getState().clearProxies();
}

/** Long side of a preview copy, in pixels. */
export const PROXY_LONG_SIDE = 1280;
const PROXY_BITRATE = 4_000_000;
const KEYFRAME_EVERY = 0.5;

/** Whether a picture of this size gets a preview copy: anything clearly above 1080p. */
export function wantsProxy(width: number, height: number): boolean {
  return width * height > 1920 * 1080 * 1.15;
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** The size of the preview copy of a picture. */
export function proxySize(width: number, height: number): { width: number; height: number } {
  const s = PROXY_LONG_SIDE / Math.max(width, height);
  return { width: even(width * s), height: even(height * s) };
}

/** The URL the preview should play for a file: its preview copy when there is one. */
export function previewUrl(media: MediaFile): string {
  return useMediaStore.getState().proxies[media.id] ?? media.mediaUrl;
}

interface Job {
  media: MediaFile;
  width: number;
  height: number;
}

const queued = new Map<string, Job>();
const failed = new Set<string>();
let running: { id: string; cancel: () => void } | null = null;

const inBin = (id: string): MediaFile | undefined => useMediaStore.getState().media.find((m) => m.id === id);

// A file that leaves the bin takes its unfinished preview copy with it.
let watching = false;
function watchBin(): void {
  if (watching) return;
  watching = true;
  useMediaStore.subscribe((s, prev) => {
    if (s.media === prev.media) return;
    const ids = new Set(s.media.map((m) => m.id));
    for (const id of [...queued.keys()]) if (!ids.has(id)) queued.delete(id);
    if (running && !ids.has(running.id)) running.cancel();
  });
}

async function build(job: Job): Promise<void> {
  const { media } = job;
  const store = useMediaStore.getState;
  const begun = await window.krypt.media.proxyBegin(media.filePath);
  if (!begun.ok || !begun.data) throw new Error(begun.message ?? 'Could not start the preview copy.');
  const token = begun.data.token;
  let committed = false;
  let conversion: Conversion | null = null;
  let cancelled = false;
  running = {
    id: media.id,
    cancel: () => {
      cancelled = true;
      void conversion?.cancel().catch(() => {});
    },
  };
  store().setBusy(media.id, { label: 'Making a preview copy', fraction: 0 });
  const input = new Input({ source: new UrlSource(media.mediaUrl), formats: ALL_FORMATS });
  try {
    const write = async (c: StreamTargetChunk): Promise<void> => {
      const r = await window.krypt.media.exportWrite(token, c.data, c.position);
      if (!r.ok) throw new Error(r.message ?? 'Could not write the preview copy.');
    };
    const output = new Output({
      format: new Mp4OutputFormat(),
      target: new StreamTarget(new WritableStream<StreamTargetChunk>({ write }), { chunked: true }),
    });
    const size = proxySize(job.width, job.height);
    conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: { width: size.width, height: size.height, fit: 'fill', codec: 'avc', bitrate: PROXY_BITRATE, keyFrameInterval: KEYFRAME_EVERY, forceTranscode: true },
      audio: { codec: 'aac', bitrate: 128_000 },
      // Keep the file's own clock: a frame at 12.4 s in the original is at 12.4 s in the copy.
      trim: { start: 0 },
      showWarnings: false,
    });
    if (!conversion.isValid) throw new Error('this video can not be decoded here');
    if (cancelled) throw new Error('cancelled');
    let last = 0;
    conversion.onProgress = (p) => {
      // A handful of store writes a second is enough for a progress bar.
      const now = performance.now();
      if (now - last < 250) return;
      last = now;
      if (store().busy[media.id]) store().setBusy(media.id, { label: 'Making a preview copy', fraction: Math.min(0.999, p) });
    };
    await conversion.execute();
    if (cancelled) throw new Error('cancelled');
    await window.krypt.media.exportEnd(token, true);
    committed = true;
    const made = await window.krypt.media.proxyFind(media.filePath);
    const now = inBin(media.id);
    if (made && now && now.filePath === media.filePath && proxiesEnabled()) store().setProxy(media.id, made.mediaUrl);
  } finally {
    if (!committed) await window.krypt.media.exportEnd(token, false).catch(() => {});
    try {
      input.dispose();
    } catch {
      /* already closed */
    }
    store().setBusy(media.id, null);
    running = null;
  }
}

async function pump(): Promise<void> {
  if (running) return;
  const next = queued.values().next().value as Job | undefined;
  if (!next) return;
  queued.delete(next.media.id);
  if (inBin(next.media.id) && proxiesEnabled()) {
    try {
      await build(next);
    } catch (e) {
      const message = (e as Error).message;
      if (message !== 'cancelled' && !/cancel/i.test(message)) {
        failed.add(next.media.id);
        console.warn(`[proxy] no preview copy for ${next.media.name}: ${message}`);
      }
    }
  }
  void pump();
}

/**
 * See to it that a video of this size has its preview copy: use the one made
 * earlier, or queue one (one file at a time, in the background).
 */
export function ensureProxy(media: MediaFile, width: number, height: number): void {
  if (media.kind !== 'video' || media.needsConvert || !proxiesEnabled() || !wantsProxy(width, height)) return;
  const s = useMediaStore.getState();
  if (s.proxies[media.id] || queued.has(media.id) || failed.has(media.id) || running?.id === media.id) return;
  watchBin();
  void window.krypt.media
    .proxyFind(media.filePath)
    .then((found) => {
      if (!inBin(media.id)) return;
      if (found) {
        useMediaStore.getState().setProxy(media.id, found.mediaUrl);
        return;
      }
      queued.set(media.id, { media, width, height });
      void pump();
    })
    .catch(() => {});
}
