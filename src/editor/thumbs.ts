import type { MediaFile } from '@shared/types';
import { previewUrl } from './proxy';

/**
 * Lazily extract a small strip of frames from a video so the timeline can show
 * a CapCut-style filmstrip. Frames are grabbed once per media (by seeking a
 * hidden <video> and drawing each frame to a tiny canvas) and cached for the
 * session. We never read pixels back out, so a cross-origin/tainted frame is
 * still fine to draw onto the timeline.
 */

export interface Thumb {
  /** Source time of this frame, seconds. */
  t: number;
  canvas: HTMLCanvasElement;
}

const THUMB_H = 44; // px tall — a touch under the track height
const MAX_THUMBS = 16;
const MIN_THUMBS = 3;
const EXTRACT_TIMEOUT = 15000;

const cache = new Map<string, Promise<Thumb[]>>();

/** Cached filmstrip frames for a video (empty for non-video / on failure). */
export function getThumbs(media: MediaFile): Promise<Thumb[]> {
  // No working copy yet: nothing to draw, and nothing worth caching.
  if (media.kind !== 'video' || media.needsConvert) return Promise.resolve([]);
  // A large video's frames come from its small preview copy once that exists
  // (seeking around a 4K original is slow enough to run into the time limit).
  const url = previewUrl(media);
  const key = url === media.mediaUrl ? media.id : `${media.id}|proxy`;
  let p = cache.get(key);
  if (!p) {
    p = extract(url).catch(() => []);
    cache.set(key, p);
  }
  return p;
}

function extract(url: string): Promise<Thumb[]> {
  return new Promise<Thumb[]>((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = url;

    const thumbs: Thumb[] = [];
    let times: number[] = [];
    let i = 0;
    let tileW = Math.round(THUMB_H * (16 / 9));
    let done = false;

    const cleanup = (): void => {
      try {
        video.removeAttribute('src');
        video.load();
      } catch {
        /* ignore */
      }
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(thumbs);
    };
    const fail = (e: unknown): void => {
      if (done) return;
      done = true;
      cleanup();
      reject(e);
    };

    const seekNext = (): void => {
      if (i >= times.length) {
        finish();
        return;
      }
      try {
        video.currentTime = times[i];
      } catch {
        finish();
      }
    };

    video.onloadedmetadata = (): void => {
      const dur = video.duration;
      if (!isFinite(dur) || dur <= 0) {
        fail(new Error('thumb: no duration'));
        return;
      }
      const vw = video.videoWidth || 16;
      const vh = video.videoHeight || 9;
      tileW = Math.max(8, Math.round(THUMB_H * (vw / vh)));
      const count = Math.max(MIN_THUMBS, Math.min(MAX_THUMBS, Math.round(dur / 2)));
      times = Array.from({ length: count }, (_, k) => (dur * (k + 0.5)) / count);
      seekNext();
    };

    video.onseeked = (): void => {
      try {
        const cnv = document.createElement('canvas');
        cnv.width = tileW;
        cnv.height = THUMB_H;
        const ctx = cnv.getContext('2d');
        if (ctx && video.videoWidth > 0) {
          ctx.drawImage(video, 0, 0, tileW, THUMB_H);
          thumbs.push({ t: times[i], canvas: cnv });
        }
      } catch {
        /* frame not drawable this seek */
      }
      i++;
      seekNext();
    };

    video.onerror = (): void => fail(new Error('thumb: video error'));
    // Don't hang forever on a stubborn decode — return whatever we have.
    setTimeout(finish, EXTRACT_TIMEOUT);
  });
}
