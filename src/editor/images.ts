/**
 * Pictures from the web for a video: the editor's side of
 * electron/system/images.ts. Searching lists pictures, keeping one downloads
 * it into the Images folder and puts it in the media library with its credit
 * (MediaFile.credit), and the credits of what is on the timeline can be read
 * back as lines to paste under the video.
 */
import type { MediaFile } from '@shared/types';
import { creditsText, type FoundImage, type ImageQuery, type ImageSearchResult } from '@shared/imageSearch';
import { ingest } from './ingest';
import { useMediaStore } from './mediaStore';
import { useTimelineStore } from './timelineStore';

/** Look for pictures. Throws with a sentence the person (or agent) can act on. */
export async function findImages(q: ImageQuery): Promise<ImageSearchResult> {
  const r = await window.krypt.images.search(q);
  if (!r.ok || !r.data) throw new Error(r.message ?? 'The search did not work.');
  return r.data;
}

// A few previews at a time: a page of results is twenty small downloads.
const waiting: Array<() => void> = [];
let running = 0;
const turn = async <T>(work: () => Promise<T>): Promise<T> => {
  if (running >= 6) await new Promise<void>((go) => waiting.push(go));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
};
const previews = new Map<string, Promise<string>>();

/** A small copy of a found picture, as a data: address. */
export function thumbOf(id: string): Promise<string> {
  let p = previews.get(id);
  if (!p) {
    p = turn(async () => {
      const r = await window.krypt.images.thumb(id);
      if (!r.ok || !r.data) throw new Error(r.message ?? 'No preview.');
      return r.data;
    });
    previews.set(id, p);
    // A failed preview may work on the next look.
    p.catch(() => previews.delete(id));
  }
  return p;
}

export interface KeptImage {
  media: MediaFile;
  image: FoundImage;
  credit: string;
}

/** Download found pictures and put them in the media library. */
export async function keepImages(ids: string[]): Promise<{ kept: KeptImage[]; failed: string[] }> {
  const r = await window.krypt.images.save(ids);
  if (!r.ok || !r.data) throw new Error(r.message ?? 'The pictures could not be saved.');
  const kept: KeptImage[] = [];
  const failed = r.data.failed.map((f) => `${f.id}: ${f.message}`);
  for (const s of r.data.saved) {
    try {
      kept.push({ media: await intoLibrary(s.path), image: s.image, credit: s.credit });
    } catch (e) {
      failed.push(`${s.id}: ${(e as Error).message}`);
    }
  }
  return { kept, failed };
}

/** Put a picture file that is on disk into the media library (once), ready to use. Throws with the reason. */
export async function intoLibrary(filePath: string): Promise<MediaFile> {
  const library = (): MediaFile[] => useMediaStore.getState().media;
  const have = library().find((x) => x.filePath === filePath || x.sourcePath === filePath);
  if (have) return have;
  const files = await window.krypt.media.resolvePaths([filePath]);
  const file = files.ok ? files.data?.[0] : undefined;
  if (!file) throw new Error('saved, but could not be read back');
  const fresh = useMediaStore.getState().add([file]).length > 0;
  const entry = library().find((x) => x.filePath === file.filePath);
  const taken = entry ? await ingest(entry, !fresh) : undefined;
  if (!taken || taken.status !== 'ready') throw new Error(taken?.status === 'failed' ? taken.message : 'could not be imported');
  return taken.media;
}

const picture = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    // A library file comes over the app's own scheme: asked for by name, so the sheet can be read back off the canvas.
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('unreadable'));
    img.src = src;
  });

/**
 * The found pictures on one sheet, numbered in order, for an agent to look at:
 * one image instead of twenty. JPEG as base64, or null when no preview loaded.
 */
export function contactSheet(images: FoundImage[]): Promise<string | null> {
  return numberedSheet(images.map((i) => () => thumbOf(i.id).then(picture)));
}

/** Library pictures on one numbered sheet (the pictures an agent just had made, to look at). */
export function mediaSheet(list: MediaFile[]): Promise<string | null> {
  return numberedSheet(list.map((m) => () => picture(m.mediaUrl)));
}

async function numberedSheet(images: Array<() => Promise<HTMLImageElement>>): Promise<string | null> {
  if (images.length === 0) return null;
  const cols = images.length <= 4 ? images.length : images.length <= 9 ? 3 : 4;
  const rows = Math.ceil(images.length / cols);
  const W = 320;
  const H = 214;
  const gap = 8;
  const canvas = document.createElement('canvas');
  canvas.width = cols * W + (cols + 1) * gap;
  canvas.height = rows * H + (rows + 1) * gap;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#111318';
  g.fillRect(0, 0, canvas.width, canvas.height);
  const loaded = await Promise.all(images.map((load) => load().catch(() => null)));
  if (loaded.every((x) => !x)) return null;
  images.forEach((_, n) => {
    const x = gap + (n % cols) * (W + gap);
    const y = gap + Math.floor(n / cols) * (H + gap);
    g.fillStyle = '#1d2129';
    g.fillRect(x, y, W, H);
    const img = loaded[n];
    if (img) {
      // Shown whole: what is cropped away matters when choosing.
      const k = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      const w = img.naturalWidth * k;
      const h = img.naturalHeight * k;
      g.drawImage(img, x + (W - w) / 2, y + (H - h) / 2, w, h);
    }
    const label = String(n + 1);
    g.font = 'bold 20px sans-serif';
    const lw = g.measureText(label).width + 14;
    g.fillStyle = 'rgba(0,0,0,0.82)';
    g.fillRect(x, y, lw, 28);
    g.fillStyle = '#ffffff';
    g.textBaseline = 'middle';
    g.fillText(label, x + 7, y + 15);
  });
  return canvas.toDataURL('image/jpeg', 0.82).split(',')[1] ?? null;
}

/** The credits of the web pictures on the timeline, in the order they appear, none twice. */
export function creditsInUse(): string[] {
  const byId = new Map(useMediaStore.getState().media.map((m) => [m.id, m]));
  const out: string[] = [];
  for (const c of [...useTimelineStore.getState().clips].sort((a, b) => a.start - b.start)) {
    const credit = c.type === 'media' ? byId.get(c.mediaId)?.credit : undefined;
    if (credit && !out.includes(credit)) out.push(credit);
  }
  return out;
}

/** The same as a block to paste under the video ('' when there is nothing to credit). */
export const creditsBlock = (): string => creditsText(creditsInUse());
