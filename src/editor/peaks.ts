import type { MediaFile } from '@shared/types';
import { analyzeAudio } from './audioDecode';

/**
 * Audio analysis for timeline clips. Streams a media file's audio once
 * (audioDecode.ts) into two cached arrays: normalized waveform peaks (0..1, one per
 * bucket, drawn on clip blocks) and a loudness envelope in dBFS (what the
 * auto-edit silence detector scans). Clips use the slice for their trimmed
 * source range.
 */

export const PEAKS_PER_SEC = 60;

interface Analysis {
  peaks: Float32Array;
  envelope: Float32Array;
}

const EMPTY: Analysis = { peaks: new Float32Array(0), envelope: new Float32Array(0) };
const cache = new Map<string, Analysis>();
const pending = new Map<string, Promise<Analysis>>();

function analyze(media: MediaFile): Promise<Analysis> {
  const cached = cache.get(media.id);
  if (cached) return Promise.resolve(cached);
  const inflight = pending.get(media.id);
  if (inflight) return inflight;

  const job = (async (): Promise<Analysis> => {
    try {
      const out: Analysis = (await analyzeAudio(media.mediaUrl, PEAKS_PER_SEC)) ?? EMPTY; // null: no audio track
      cache.set(media.id, out);
      return out;
    } catch {
      // Don't cache the failure — a transient decode error (device pressure,
      // file briefly locked) would otherwise poison the waveform forever.
      return EMPTY;
    } finally {
      pending.delete(media.id);
    }
  })();

  pending.set(media.id, job);
  return job;
}

export function getPeaks(media: MediaFile): Promise<Float32Array> {
  return analyze(media).then((a) => a.peaks);
}

/** Loudness in dBFS at ENVELOPE_HZ frames/s over the whole file (empty if it couldn't be decoded). */
export function getEnvelope(media: MediaFile): Promise<Float32Array> {
  return analyze(media).then((a) => a.envelope);
}
