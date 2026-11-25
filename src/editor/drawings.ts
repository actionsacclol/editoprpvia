// Drawings an agent made (SVG): kept as pictures in the media library, and made to move when held on screen.
import type { MediaFile } from '@shared/types';
import { intoLibrary } from './images';
import { useMediaStore } from './mediaStore';
import type { Drawing } from './drawingRender';

export interface KeptDrawing {
  media: MediaFile;
  width: number;
  height: number;
  /** How many of its parts are tagged to move. */
  moving: number;
  /** What was changed or left out, for whoever drew it. */
  notes: string[];
}

/** The SVG of the drawings kept in this session, by media id (later sessions read it back from beside the file). */
const sources = new Map<string, string>();
/** Media looked up and found not to be drawings. */
const notDrawings = new Set<string>();

/** Reads, cleans and keeps one drawing: a PNG in the media library with its SVG beside it. Throws in words its author can act on. */
export async function keepDrawing(svg: string, name: string): Promise<KeptDrawing> {
  const { readDrawing, drawingStill } = await import('./drawingRender');
  const d = readDrawing(svg);
  // What is kept is the cleaned drawing, as it was drawn (the wrappers that move it are put back each time it is read).
  const clean = cleanText(readDrawing(svg));
  const still = await drawingStill(d);
  const kept = await window.krypt.pictures.keepDrawing(still.bytes, clean, name);
  if (!kept.ok || !kept.data) throw new Error(kept.message ?? 'it could not be saved');
  const media = await intoLibrary(kept.data.path);
  sources.set(media.id, clean);
  return { media, width: still.width, height: still.height, moving: d.moves.length, notes: d.notes };
}

/** A cleaned drawing as text, without what was added to move it. */
function cleanText(d: Drawing): string {
  for (const m of d.moves) {
    const inner = m.wrap.firstElementChild;
    if (inner) m.wrap.parentNode?.replaceChild(inner, m.wrap);
  }
  for (const g of Array.from(d.root.children)) {
    if (g.localName === 'g' && g.getAttribute('filter') === 'url(#krypt-boil)') {
      while (g.firstChild) d.root.insertBefore(g.firstChild, g);
      g.remove();
    }
  }
  d.noise?.closest('defs')?.remove();
  d.root.removeAttribute('width');
  d.root.removeAttribute('height');
  return new XMLSerializer().serializeToString(d.root);
}

/** The drawing a library picture was made from, freshly read (it is changed as it is animated), or null when it is not one. */
export async function drawingOf(media: MediaFile): Promise<Drawing | null> {
  if (media.kind !== 'image' || notDrawings.has(media.id)) return null;
  let text = sources.get(media.id);
  if (text === undefined) {
    for (const p of [media.sourcePath, media.filePath]) {
      if (!p || !/drawn-[\w.-]+\.png$/i.test(p)) continue;
      const r = await window.krypt.pictures.drawingSource(p);
      if (r.ok && r.data) {
        text = r.data;
        break;
      }
    }
    if (text === undefined) {
      notDrawings.add(media.id);
      return null;
    }
    sources.set(media.id, text);
  }
  try {
    return (await import('./drawingRender')).readDrawing(text);
  } catch {
    return null;
  }
}

/**
 * `seconds` of a drawing moving, as a video in the media library: its tagged parts move and its lines wobble.
 * Null when the picture is not a drawing.
 */
export async function movingDrawing(media: MediaFile, seconds: number, fps: number, signal: AbortSignal, fileName: string, onFrame: (done: number) => void = () => undefined): Promise<{ media: MediaFile; width: number; height: number; seconds: number } | null> {
  const d = await drawingOf(media);
  if (!d) return null;
  const { bakeDrawing } = await import('./drawingRender');
  const made = await bakeDrawing(d, seconds, fps, signal, onFrame);
  const r = await window.krypt.media.saveDerived(made.bytes, fileName);
  if (!r.ok || !r.data) throw new Error(r.message ?? 'The moving drawing could not be stored.');
  useMediaStore.getState().add([r.data]);
  return { media: r.data, width: made.width, height: made.height, seconds };
}
