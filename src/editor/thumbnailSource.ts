// What a thumbnail is drawn over (a scene in a drawing style, a frame of the video, a picture from the
// library), and keeping the result. The layout and the drawing itself are in thumbnail.ts.
import { cuePose, type ArtStyle } from './art/art';
import { renderStills } from './export';
import { useMediaStore } from './mediaStore';
import { THUMB, renderThumbnail, thumbnailBytes, type ThumbLayout, type ThumbPicture, type ThumbSpec } from './thumbnail';
import { timelineDuration, useTimelineStore } from './timelineStore';

export type ThumbFrom =
  | { kind: 'scene'; style: ArtStyle; pose?: string; props?: string; word?: string; camera?: 'wide' | 'close'; color?: string }
  | { kind: 'frame'; time: number }
  | { kind: 'image'; mediaId: string }
  | { kind: 'plain' };

/** The share of a drawn scene kept clear for the words. */
const SCENE_INSET = 0.42;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Without this the canvas could not be read back into a file.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That picture could not be opened.'));
    img.src = url;
  });
}

/** A drawn scene puts its figure on the right, so the words go left (or along the bottom). */
export const layoutFor = (from: ThumbFrom, layout: ThumbLayout): ThumbLayout => (from.kind === 'scene' && (layout === 'right' || layout === 'center') ? 'left' : layout);

/** The picture behind the words; null for a plain background. */
export async function thumbPicture(from: ThumbFrom, layout: ThumbLayout): Promise<ThumbPicture | null> {
  if (from.kind === 'plain') return null;
  if (from.kind === 'scene') {
    const { sceneFrame, releaseScenes } = await import('./art/bake');
    const engine = from.style.engine;
    const pose = cuePose(engine, from.pose) || cuePose(engine, 'shock') || 'talk';
    const beat = { start: 0, dur: 4, pose, word: (from.word ?? '').trim().slice(0, 24), props: engine === 'stick' ? (from.props ?? '').trim() : '', say: '', voStart: 9, voDur: 0.1, camera: from.camera ?? ('wide' as const), push: false };
    try {
      // Late enough in the beat that the figure has reached the pose and the props have landed.
      const el = await sceneFrame({ style: from.style, beats: [beat], duration: 4, index: 0, color: from.color, inset: layoutFor(from, layout) === 'left' ? SCENE_INSET : 0 }, THUMB, 2.2);
      return { image: el, width: el.width, height: el.height, drawn: true };
    } finally {
      await releaseScenes();
    }
  }
  if (from.kind === 'image') {
    const m = useMediaStore.getState().media.find((x) => x.id === from.mediaId);
    if (!m || m.kind !== 'image') throw new Error('That picture is not in the media library.');
    const img = await loadImage(m.mediaUrl);
    return { image: img, width: img.naturalWidth, height: img.naturalHeight };
  }
  const s = useTimelineStore.getState();
  if (timelineDuration(s.clips) <= 0) throw new Error('The timeline is empty: there is no frame to take.');
  // Without the captions: a thumbnail has words of its own.
  const clips = s.clips.filter((c) => !(c.type === 'text' && c.role === 'caption'));
  const [data] = await renderStills({ clips, tracks: s.tracks, canvas: s.canvas, background: s.background, media: useMediaStore.getState().media }, [from.time], THUMB.height);
  const img = await loadImage(`data:image/jpeg;base64,${data}`);
  return { image: img, width: img.naturalWidth, height: img.naturalHeight };
}

/** The finished thumbnail as a canvas. */
export async function makeThumbnail(spec: ThumbSpec, from: ThumbFrom, picture?: ThumbPicture | null): Promise<HTMLCanvasElement> {
  const pic = picture === undefined ? await thumbPicture(from, spec.layout) : picture;
  try {
    await document.fonts.ready;
  } catch {
    /* drawn in the fallback font */
  }
  return renderThumbnail({ ...spec, layout: layoutFor(from, spec.layout) }, pic);
}

/** Keeps a thumbnail in the Thumbnails folder; returns where. */
export async function saveThumbnail(canvas: HTMLCanvasElement, name: string): Promise<string> {
  const r = await window.krypt.thumbnails.save(await thumbnailBytes(canvas), name);
  if (!r.ok || !r.data) throw new Error(r.message ?? 'The thumbnail could not be saved.');
  return r.data;
}
