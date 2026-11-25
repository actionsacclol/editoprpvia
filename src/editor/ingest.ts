import type { MediaFile } from '@shared/types';
import { useMediaStore } from './mediaStore';
import { ProbeError, probeMedia } from './probe';

/**
 * Taking a file into the media bin.
 *
 * A file the editor can read is ready at once. One it can't (ProRes, AVI, a
 * 10-bit camera file, HEVC on a machine with no decoder for it…) is converted
 * into an H.264 working copy when the computer has FFmpeg, and the bin entry
 * then points at that copy while remembering the file it came from. Without
 * FFmpeg the file is turned away with the reason and what to install.
 */

export type IngestResult =
  | { status: 'ready'; media: MediaFile; converted: boolean }
  | { status: 'failed'; name: string; message: string }
  /** Taken out of the bin while it was still being converted. */
  | { status: 'gone' };

const NEEDS_FFMPEG = 'Install FFmpeg and import it again: Krypt Editor then converts files like this by itself.';

let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  window.krypt.media.onConvertProgress(({ id, fraction }) => {
    const s = useMediaStore.getState();
    if (s.busy[id]) s.setBusy(id, { label: 'Converting', fraction });
  });
}

const inBin = (id: string): boolean => useMediaStore.getState().media.some((m) => m.id === id);

/** Make (or find again) the working copy of a file and point its bin entry at it. */
export async function convertInPlace(m: MediaFile): Promise<MediaFile> {
  listen();
  const source = m.sourcePath ?? m.filePath;
  useMediaStore.getState().setBusy(m.id, { label: 'Converting', fraction: 0 });
  try {
    const r = await window.krypt.media.convert(m.id, source, m.kind === 'audio' ? 'audio' : 'video');
    if (!r.ok || !r.data) throw new Error(r.message ?? 'The conversion failed.');
    const next: MediaFile = {
      id: m.id,
      name: m.name,
      kind: m.kind,
      filePath: r.data.filePath,
      mediaUrl: r.data.mediaUrl,
      sizeBytes: r.data.sizeBytes,
      sourcePath: source,
    };
    useMediaStore.getState().replace(next);
    return next;
  } finally {
    useMediaStore.getState().setBusy(m.id, null);
  }
}

/**
 * Check a file in the bin, converting it if it has to be. A file that can't
 * be used is taken back out of the bin, unless `keep` says it was there before
 * (clips may be using it).
 */
export async function ingest(m: MediaFile, keep = false): Promise<IngestResult> {
  const reject = (message: string): IngestResult => {
    if (!inBin(m.id)) return { status: 'gone' };
    if (!keep) useMediaStore.getState().remove(m.id);
    return { status: 'failed', name: m.name, message };
  };
  let why = `"${m.name}" is in a format the editor can't read directly.`;
  if (!m.needsConvert) {
    try {
      await probeMedia(m);
      return { status: 'ready', media: m, converted: false };
    } catch (e) {
      const err = e as Error;
      if (m.kind === 'image' || !(err instanceof ProbeError) || !err.convertible) return reject(err.message);
      why = err.message;
    }
  }
  if (!inBin(m.id)) return { status: 'gone' };
  if (!(await window.krypt.media.converter()).available) return reject(`${why} ${NEEDS_FFMPEG}`);
  try {
    const next = await convertInPlace(m);
    if (!inBin(m.id)) return { status: 'gone' };
    await probeMedia(next);
    return { status: 'ready', media: next, converted: true };
  } catch (e) {
    const message = (e as Error).message;
    if (message === 'cancelled') return { status: 'gone' };
    return reject(`"${m.name}" couldn't be converted: ${message}`);
  }
}
