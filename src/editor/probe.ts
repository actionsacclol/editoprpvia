import { ALL_FORMATS, Input, UrlSource } from 'mediabunny';
import type { MediaFile } from '@shared/types';

/**
 * Read a media file's duration and pixel dimensions by loading just its
 * metadata through the krypteditor:// stream. Cached per media id. Dimensions
 * drive the project canvas (auto-set from the first clip) and crop/transform
 * math; audio has none (0×0). Images get a sensible default duration.
 *
 * Rejects when the file can't be used: the preview pipeline plays media
 * through an HTML element, so a file the element can't read must not land on
 * the timeline (it would be a clip that never renders). mediabunny is used as
 * a second probe purely to tell the user *why* it failed.
 */

export const IMAGE_DEFAULT_DURATION = 5;

export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  /** A video that carries sound (so the timeline can give the sound a clip of its own). Unset when that couldn't be told. */
  hasAudio?: boolean;
}

const cache = new Map<string, MediaInfo>();

/** A file that was probed and found to carry no audio (a silent screen recording, say). */
export const knownSilent = (mediaId: string): boolean => cache.get(mediaId)?.hasAudio === false;

/** Why a file can't be used as it is, and whether converting it could help (see ingest.ts). */
export class ProbeError extends Error {
  constructor(
    message: string,
    readonly convertible: boolean,
  ) {
    super(message);
    this.name = 'ProbeError';
  }
}

/** Distinguish "bad file" from "valid file the preview can't play" for the error message. */
async function diagnose(media: MediaFile): Promise<ProbeError> {
  const name = media.name;
  try {
    const input = new Input({ source: new UrlSource(media.mediaUrl), formats: ALL_FORMATS });
    const track = media.kind === 'audio' ? await input.getPrimaryAudioTrack() : await input.getPrimaryVideoTrack();
    if (!track) return new ProbeError(`"${name}" has no ${media.kind === 'audio' ? 'audio' : 'video'} track.`, false);
    if (await track.canDecode()) return new ProbeError(`"${name}" can't be played by the editor as it is.`, true);
    return new ProbeError(`"${name}" uses a codec this computer can't decode (ProRes, or HEVC without hardware support, for example).`, true);
  } catch {
    // Not a container the editor knows; FFmpeg knows many more.
    return new ProbeError(`"${name}" couldn't be read: the file may be damaged or in a format the editor doesn't know.`, true);
  }
}

interface ContainerFacts {
  /** Whether the file has an audio track. */
  hasAudio?: boolean;
  /** False when the export decoder (WebCodecs) can't read the picture, though the preview's player can. */
  decodable?: boolean;
}

/**
 * What the container says about a video that the <video> element doesn't:
 * whether there is sound (so the timeline can give it a clip of its own) and
 * whether the export's decoder can read the picture. The preview and the
 * export decode through different paths, and a file only one of them reads
 * would be a clip that plays and then exports black. Fields stay unset when
 * the container couldn't be read in time (the clip then behaves as a video
 * always did).
 */
async function containerFacts(media: MediaFile): Promise<ContainerFacts> {
  let input: Input | null = null;
  try {
    input = new Input({ source: new UrlSource(media.mediaUrl), formats: ALL_FORMATS });
    const from = input;
    const found = (async (): Promise<ContainerFacts> => {
      const [audio, video] = await Promise.all([from.getPrimaryAudioTrack(), from.getPrimaryVideoTrack()]);
      return { hasAudio: audio !== null, ...(video ? { decodable: await video.canDecode() } : {}) };
    })().catch((): ContainerFacts => ({}));
    const slow = new Promise<ContainerFacts>((resolve) => window.setTimeout(() => resolve({}), 6000));
    return await Promise.race([found, slow]);
  } catch {
    return {};
  } finally {
    try {
      input?.dispose();
    } catch {
      /* already closed */
    }
  }
}

export function probeMedia(media: MediaFile): Promise<MediaInfo> {
  const cached = cache.get(media.id);
  if (cached) return Promise.resolve(cached);
  if (media.needsConvert) return Promise.reject(new ProbeError(`"${media.name}" is still being converted.`, true));

  if (media.kind === 'image') {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const info = { duration: IMAGE_DEFAULT_DURATION, width: img.naturalWidth, height: img.naturalHeight };
        cache.set(media.id, info);
        resolve(info);
      };
      img.onerror = () => reject(new Error(`"${media.name}" couldn't be read as an image.`));
      img.src = media.mediaUrl;
    });
  }

  return new Promise((resolve, reject) => {
    const el = document.createElement(media.kind === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';

    // A video has to show its first frame, not just its header: a codec the
    // computer can't decode (10-bit 4:2:2 camera files, say) reads fine up to
    // the header and fails on the first picture.
    const ready = media.kind === 'video' ? 'loadeddata' : 'loadedmetadata';
    if (media.kind === 'video') {
      el.preload = 'auto';
      el.muted = true;
    }
    let settled = false;
    let sawHeader = false;
    const cleanup = (): void => {
      el.removeEventListener(ready, onMeta);
      el.removeEventListener('loadedmetadata', onHeader);
      el.removeEventListener('error', onErr);
      window.clearTimeout(timer);
      el.src = '';
    };
    const onHeader = (): void => {
      sawHeader = true;
    };
    const onMeta = (): void => {
      if (settled) return;
      const rawDur = el.duration;
      const w = (el as HTMLVideoElement).videoWidth ?? 0;
      const h = (el as HTMLVideoElement).videoHeight ?? 0;
      // A "successful" metadata load with no usable duration (or a video with
      // no pixels) is still an unusable clip — treat it as a failure.
      if (!Number.isFinite(rawDur) || rawDur <= 0 || (media.kind === 'video' && (w === 0 || h === 0))) {
        onErr();
        return;
      }
      settled = true;
      cleanup();
      const done = (facts: ContainerFacts): void => {
        if (facts.decodable === false) {
          reject(new ProbeError(`"${media.name}" plays here but its picture can't be decoded for export.`, true));
          return;
        }
        const info: MediaInfo = { duration: rawDur, width: w, height: h, ...(facts.hasAudio === undefined ? {} : { hasAudio: facts.hasAudio }) };
        cache.set(media.id, info);
        resolve(info);
      };
      if (media.kind !== 'video') return done({});
      void containerFacts(media).then(done);
    };
    const onErr = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void diagnose(media).then(reject);
    };

    // A slow disk or a very large file may not have a frame yet: with the header read and no error, take it.
    const timer = window.setTimeout(() => (sawHeader && !el.error ? onMeta() : onErr()), 8000);
    el.addEventListener(ready, onMeta);
    el.addEventListener('loadedmetadata', onHeader);
    el.addEventListener('error', onErr);
    el.src = media.mediaUrl;
  });
}
