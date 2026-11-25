import type { MediaFile } from '@shared/types';
import { IS_MAC } from '../utils/format';
import { lutFromBase64, lutToBase64 } from './lut';
import { useLutStore } from './lutStore';
import { convertInPlace } from './ingest';
import { probeMedia } from './probe';
import { ensureProxy } from './proxy';
import { useMediaStore } from './mediaStore';
import { projectAi, useStyleStore, type ProjectAi } from './styles';
import { useTimelineStore, type Background, type Canvas, type Clip, type Track } from './timelineStore';

/**
 * Project serialization. A .krypt file is JSON of the timeline document plus
 * the media bin (file paths + stream URLs). Opening one restores the media
 * records as-is (the krypteditor:// URL is derived from the file path, so it
 * stays valid as long as the source file exists) and the timeline.
 */

export const PROJECT_SCHEMA = 1;

export interface ProjectFile {
  schemaVersion: number;
  canvas: Canvas;
  background?: Background;
  fps?: number;
  tracks: Track[];
  clips: Clip[];
  media: MediaFile[];
  /** Imported color LUTs, tables embedded (base64 Float32Array) — small. */
  luts?: Array<{ id: string; name: string; size: number; data: string }>;
  /** The edit style, standing notes and reference video chosen for AI agents (AI panel). */
  ai?: ProjectAi;
}

export function serializeProject(): string {
  const ts = useTimelineStore.getState();
  const ms = useMediaStore.getState();
  const doc: ProjectFile = {
    schemaVersion: PROJECT_SCHEMA,
    canvas: ts.canvas,
    background: ts.background,
    fps: ts.fps,
    tracks: ts.tracks,
    clips: ts.clips,
    media: ms.media,
    luts: useLutStore.getState().luts.map((l) => ({ id: l.id, name: l.name, size: l.size, data: lutToBase64(l.table) })),
    ai: projectAi(),
  };
  return JSON.stringify(doc);
}

export interface ApplyProjectResult {
  ok: boolean;
  /** Human-readable reason when ok is false. */
  error?: string;
  /** Names of media files referenced by the project that no longer exist. */
  missing: string[];
}

const CLIP_TYPES = new Set(['media', 'text', 'shape', 'draw']);
const TRACK_KINDS = new Set(['video', 'audio', 'text']);

function validClip(c: unknown): c is Clip {
  const x = c as Clip;
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.trackId === 'string' &&
    CLIP_TYPES.has(x.type) &&
    Number.isFinite(x.start) &&
    Number.isFinite(x.duration) &&
    x.duration > 0
  );
}

function validTrack(t: unknown): t is Track {
  const x = t as Track;
  return !!x && typeof x.id === 'string' && TRACK_KINDS.has(x.kind);
}

/** Replace the current session with a parsed project. Fails loudly instead of loading a damaged document partially. */
export async function applyProject(json: string): Promise<ApplyProjectResult> {
  const fail = (error: string): ApplyProjectResult => ({ ok: false, error, missing: [] });
  let doc: ProjectFile;
  try {
    doc = JSON.parse(json) as ProjectFile;
  } catch {
    return fail('That file is not a valid Krypt project.');
  }
  if (!doc || !Array.isArray(doc.clips) || !Array.isArray(doc.tracks)) {
    return fail('That file is not a valid Krypt project.');
  }
  if (typeof doc.schemaVersion === 'number' && doc.schemaVersion > PROJECT_SCHEMA) {
    return fail('This project was saved by a newer version of Krypt Editor — update the app to open it.');
  }
  if (!doc.clips.every(validClip) || !doc.tracks.every(validTrack)) {
    return fail('This project file is damaged and can’t be opened safely.');
  }

  const restoredMedia = (Array.isArray(doc.media) ? doc.media : []).filter(
    (m): m is MediaFile => !!m && typeof m.filePath === 'string' && typeof m.id === 'string',
  );
  // Re-resolve the project's files: this re-grants the krypteditor:// handler
  // access to the ones that still exist and tells us which ones are gone, so
  // the user hears "these files are missing" instead of seeing black clips.
  const r = await window.krypt.media.resolvePaths(restoredMedia.map((m) => m.filePath).filter(Boolean));
  // NFC-normalize (macOS returns NFD filenames) and fold case only on
  // Windows — macOS volumes can be case-sensitive.
  const foldPath = (p: string): string => {
    const n = p.normalize('NFC');
    return IS_MAC ? n : n.toLowerCase();
  };
  const found = new Set((r.ok ? r.data ?? [] : []).map((m) => foldPath(m.filePath)));
  // A converted working copy lives in the media cache; if that was emptied (or
  // the project was saved mid-conversion) the copy is made again from the
  // file it came from, as long as that one is still there.
  const stale = restoredMedia.filter((m) => m.kind !== 'image' && (m.needsConvert ? found.has(foldPath(m.filePath)) : !!m.sourcePath && !found.has(foldPath(m.filePath))));
  const sources = stale.length > 0 ? await window.krypt.media.resolvePaths(stale.map((m) => m.sourcePath ?? m.filePath)) : null;
  const haveSource = new Set((sources?.ok ? sources.data ?? [] : []).map((m) => foldPath(m.filePath)));
  const remake = stale.filter((m) => haveSource.has(foldPath(m.sourcePath ?? m.filePath)));
  const remaking = new Set(remake.map((m) => m.id));
  const missing = restoredMedia.filter((m) => !found.has(foldPath(m.filePath)) && !remaking.has(m.id)).map((m) => m.name);

  useLutStore.getState().replaceAll(
    (Array.isArray(doc.luts) ? doc.luts : [])
      .filter((l) => l && typeof l.id === 'string' && typeof l.data === 'string' && Number.isFinite(l.size))
      .map((l) => {
        try {
          return { id: l.id, name: String(l.name ?? 'LUT'), size: l.size, table: lutFromBase64(l.data) };
        } catch {
          return null;
        }
      })
      .filter((l): l is NonNullable<typeof l> => l !== null && l.table.length === l.size * l.size * l.size * 3),
  );

  useMediaStore.getState().replaceAll(restoredMedia.map((m) => (remaking.has(m.id) ? { ...m, needsConvert: true } : m)));
  for (const m of remake) {
    void convertInPlace(m).catch((e: Error) => {
      if (e.message !== 'cancelled') console.warn(`[project] could not convert ${m.name} again: ${e.message}`);
    });
  }
  useTimelineStore.getState().loadDoc({
    clips: doc.clips,
    tracks: doc.tracks,
    canvas: doc.canvas ?? { width: 1920, height: 1080 },
    background: doc.background,
    fps: doc.fps,
  });
  // Large videos on the timeline play from their preview copies (found again, or made in the background).
  const used = new Set(doc.clips.flatMap((c) => (c.type === 'media' ? [c.mediaId] : [])));
  for (const m of restoredMedia) {
    if (m.kind !== 'video' || !used.has(m.id) || remaking.has(m.id) || !found.has(foldPath(m.filePath))) continue;
    void probeMedia(m).then((info) => ensureProxy(m, info.width, info.height), () => {});
  }
  // A project made before styles existed leaves the current choices alone.
  useStyleStore.getState().loadProject(doc.ai);
  return { ok: true, missing };
}

/** True when the session has anything worth saving. */
export function hasContent(): boolean {
  return useMediaStore.getState().media.length > 0 || useTimelineStore.getState().clips.length > 0;
}
