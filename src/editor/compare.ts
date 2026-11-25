import { MIN_CLIP, REF_HEIGHT, newMediaClip, soundOf, uid, type Canvas, type Clip, type Easing, type Keyframe, type MediaClip, type ShapeClip, type TextClip, type Track, type TransitionType } from './timelineStore';
import { rectClip, textClip } from './scenes';

/**
 * Before / after: two pictures of the same thing (raw and graded, the footage
 * and the finished edit, day 1 and day 90) shown against each other.
 *
 * The moving comparisons are built from two ordinary clips. The "before" fills
 * the frame; the "after" lies in front of it, cropped to its side of a divider
 * and placed so that every pixel sits exactly where it would uncropped. Moving
 * the divider is then a keyframed crop and position on the front clip, plus a
 * line, a handle and labels that ride along. Nothing here is a special effect,
 * so preview and export agree and it all stays editable by hand.
 */

export type CompareMode = 'wipe' | 'slider' | 'split' | 'cut';
export const COMPARE_MODES: readonly CompareMode[] = ['wipe', 'slider', 'split', 'cut'];
/** horizontal: before on the left, after on the right. vertical: before on top. */
export type CompareAxis = 'horizontal' | 'vertical';
export type CompareSound = 'after' | 'before' | 'none';

export interface CompareSide {
  mediaId: string;
  /** An image: no length of its own, no sound. */
  still: boolean;
  /** Where in the file it starts, seconds. */
  at: number;
  sourceDuration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface CompareOptions {
  mode: CompareMode;
  axis: CompareAxis;
  /** split only. same: one frame cut in two (a still slider). centered: each side shows the middle of its own picture. */
  framing: 'same' | 'centered';
  start: number;
  /** Whole length asked for, seconds; shortened to what the files hold. */
  duration: number;
  /** wipe / cut: how long the before is shown alone. slider: the pause before it starts moving. */
  hold: number;
  /** wipe: how long the divider takes to cross. slider: one pass. */
  sweep: number;
  canvas: Canvas;
  labels: { before: string; after: string } | null;
  sound: CompareSound;
  /** Colour of the divider and its handle. */
  line: string;
  /** cut only: how the after comes in. */
  transition: TransitionType;
  /** Typeface and the like for the labels, over the built-in look. */
  label?: Partial<TextClip>;
  /** Video track for the before (and for both, in a cut). */
  backTrack: string;
  /** Video track in front of it, for the after. */
  frontTrack: string;
  /** Audio track; '' when there is none to put sound on. */
  soundTrack: string;
  textTrack: string;
}

export interface ComparePlan {
  clips: Clip[];
  /** Shared by everything built, so it can be found and removed together. */
  group: string;
  before: string;
  after: string;
  start: number;
  end: number;
  /** When the after starts to show and when it is fully (or most) shown, timeline seconds. */
  revealFrom: number;
  revealTo: number;
  /** Tracks that got a clip. */
  usedSound: boolean;
  notes: string[];
}

interface Crop {
  l: number;
  r: number;
  t: number;
  b: number;
}

/** The crop that leaves the middle of a w×h picture in the given shape (width / height). */
export function coverCrop(w: number, h: number, aspect: number): Crop {
  if (!(w > 0 && h > 0 && aspect > 0)) return { l: 0, r: 0, t: 0, b: 0 };
  const own = w / h;
  if (own > aspect) {
    const c = (1 - aspect / own) / 2;
    return { l: c, r: c, t: 0, b: 0 };
  }
  const c = (1 - own / aspect) / 2;
  return { l: 0, r: 0, t: c, b: c };
}

/**
 * Crop and position that show only the part of a frame-filling picture beyond
 * the divider at `p` (0..1 along the axis), with every pixel where it would be
 * uncropped. `cover` is the picture's crop to the frame's shape.
 */
export function beyondDivider(cover: Crop, p: number, axis: CompareAxis): { cropLeft: number; cropRight: number; cropTop: number; cropBottom: number; posX: number; posY: number } {
  if (axis === 'horizontal') return { cropLeft: cover.l + p * (1 - cover.l - cover.r), cropRight: cover.r, cropTop: cover.t, cropBottom: cover.b, posX: p / 2, posY: 0 };
  return { cropLeft: cover.l, cropRight: cover.r, cropTop: cover.t + p * (1 - cover.t - cover.b), cropBottom: cover.b, posX: 0, posY: p / 2 };
}

/** The furthest the divider goes while the front clip is on screen: a clip cannot be cropped to nothing. */
const P_MAX = 0.985;
/** The least of a file's width or height a crop may leave (the renderers stop at 1%). */
const MIN_KEPT = 0.012;
const SLIDER_LO = 0.2;
const SLIDER_HI = 0.8;

interface PathPoint {
  /** Seconds from the start of the comparison. */
  t: number;
  p: number;
  ease?: Easing;
}

const key = (prop: string, t: number, value: number, ease?: Easing): Keyframe => ({ id: uid('k'), prop, t, value, ...(ease ? { ease } : {}) });

/** One property following the divider, as keyframes local to a clip that starts `offset` seconds in. */
function follow(path: PathPoint[], offset: number, prop: string, value: (p: number) => number): Keyframe[] {
  return path.map((pt) => key(prop, Math.max(0, pt.t - offset), value(pt.p), pt.ease));
}

const room = (s: CompareSide): number => (s.still ? Infinity : Math.max(0, s.sourceDuration - s.at));

/** Thrown when the files cannot carry a comparison at all; the message is for the user. */
export class CompareError extends Error {}

export function planCompare(before: CompareSide, after: CompareSide, o: CompareOptions): ComparePlan {
  const { canvas, axis, mode, start } = o;
  const W = canvas.width;
  const H = canvas.height;
  const notes: string[] = [];
  const group = uid('g');
  const r2 = (v: number): number => Math.round(v * 100) / 100;

  // ── Timing, fitted to what the files hold ──
  const roomB = room(before);
  const roomA = room(after);
  if (roomB < 0.5) throw new CompareError('The before file has less than half a second left from there.');
  if (roomA < 0.5) throw new CompareError('The after file has less than half a second left from there.');
  let D = Math.max(1, o.duration);
  let hold = Math.max(0, o.hold);
  let sweep = Math.max(0.2, o.sweep);
  if (mode === 'wipe') {
    // Before runs through the hold and the sweep; after from the hold to the end, in step with it.
    if (D > roomA) D = roomA;
    if (hold + sweep > roomB) {
      hold = Math.max(0, roomB - sweep);
      if (hold < 0.2) {
        sweep = Math.max(0.3, roomB - 0.2);
        hold = Math.max(0, roomB - sweep);
      }
    }
    if (hold + sweep > D - 0.3) {
      hold = Math.max(0, D - 0.3 - sweep);
      if (hold === 0) sweep = Math.max(0.3, D - 0.3);
    }
  } else if (mode === 'cut') {
    hold = Math.min(o.hold > 0 ? o.hold : D / 2, roomB, D - 0.5);
    D = hold + Math.min(D - hold, roomA);
  } else {
    D = Math.min(D, roomA, roomB);
  }
  if (D < o.duration - 0.05) notes.push(`${r2(D)}s long, not ${r2(o.duration)}s: that is all the footage holds from there`);
  const end = start + D;

  // ── Where the divider is over time ──
  const frame = W / H;
  const coverB = coverCrop(before.width, before.height, frame);
  const coverA = coverCrop(after.width, after.height, frame);
  // A picture already cropped hard to fill the frame has less left to give the wipe.
  const kept = axis === 'horizontal' ? 1 - coverA.l - coverA.r : 1 - coverA.t - coverA.b;
  const pMax = Math.min(P_MAX, 1 - MIN_KEPT / Math.max(MIN_KEPT, kept));
  // Labels are sized to the frame's width as well as its height: type sized for
  // a wide frame would fill a third of a vertical one.
  const px = H / REF_HEIGHT; // one reference pixel, in canvas pixels
  const tight = Math.min(1, (W / H) * 1.1);
  const fontSize = Math.round(54 * tight);
  const padding = Math.round(18 * tight);
  /** About how much of the frame's width a label takes (on the generous side). */
  const labelWidth = (text: string): number => ((text.length * 0.62 * fontSize + 2 * padding) * px) / W;
  const labelGap = (30 * px * tight) / W;
  // A slider stops where the label riding on the narrow side still fits in the frame.
  let lo = SLIDER_LO;
  let hi = SLIDER_HI;
  if (mode === 'slider' && axis === 'horizontal' && o.labels) {
    lo = Math.min(0.4, Math.max(lo, labelWidth(o.labels.before) + labelGap + 0.02));
    hi = Math.max(0.6, Math.min(hi, 1 - labelWidth(o.labels.after) - labelGap - 0.02));
  }
  let path: PathPoint[];
  if (mode === 'wipe') {
    path = [
      { t: hold, p: pMax },
      { t: hold + sweep, p: 0, ease: 'inout' },
    ];
  } else if (mode === 'slider') {
    hold = Math.min(hold, D / 3);
    path = [{ t: 0, p: 0.5 }];
    if (hold > 0) path.push({ t: hold, p: 0.5 });
    let t = hold;
    let to = lo;
    while (t + sweep <= D + 1e-6) {
      t += sweep;
      path.push({ t, p: to, ease: 'inout' });
      to = to === lo ? hi : lo;
    }
    // It ends showing mostly the after.
    const last = path[path.length - 1];
    if (last.p !== lo) {
      if (D - last.t >= 0.5 || path.length <= 2) path.push({ t: D, p: lo, ease: 'inout' });
      else path.pop();
    }
  } else {
    path = [{ t: 0, p: 0.5 }];
  }
  const moving = path.some((pt) => pt.p !== path[0].p);

  // ── The two pictures ──
  const picture = (side: CompareSide, trackId: string, at: number, length: number, inPoint: number, over: Partial<MediaClip>): MediaClip =>
    newMediaClip({
      mediaId: side.mediaId,
      trackId,
      start: at,
      duration: Math.max(MIN_CLIP, length),
      inPoint: side.still ? 0 : inPoint,
      sourceDuration: side.still ? Math.max(MIN_CLIP, length) : side.sourceDuration,
      sourceWidth: side.width,
      sourceHeight: side.height,
      muted: true,
      group,
      ...over,
    });
  const crop = (c: Crop): Partial<MediaClip> => ({ cropLeft: c.l, cropRight: c.r, cropTop: c.t, cropBottom: c.b });

  let back: MediaClip;
  let front: MediaClip;
  const sounds: MediaClip[] = [];
  if (mode === 'cut') {
    back = picture(before, o.backTrack, start, hold, before.at, crop(coverB));
    front = picture(after, o.backTrack, start + hold, D - hold, after.at, { ...crop(coverA), transition: o.transition, transitionDur: Math.min(0.4, hold / 2, (D - hold) / 2) });
    if (o.sound !== 'none' && o.soundTrack) {
      // Each keeps its own sound, as two clips cut together would.
      for (const [clip, side] of [[back, before], [front, after]] as const) {
        if (side.still || !side.hasAudio) continue;
        clip.link = uid('l');
        sounds.push({ ...soundOf(clip, o.soundTrack, clip.link), group });
      }
    }
  } else {
    const afterFrom = mode === 'wipe' ? hold : 0;
    const beforeLength = mode === 'wipe' ? Math.min(D, hold + sweep + 0.05, roomB) : D;
    if (mode === 'split' && o.framing === 'centered') {
      // Each half shows the middle of its own picture.
      const p = path[0].p;
      const half = axis === 'horizontal' ? (W * p) / H : W / (H * p);
      const other = axis === 'horizontal' ? (W * (1 - p)) / H : W / (H * (1 - p));
      back = picture(before, o.backTrack, start, D, before.at, { ...crop(coverCrop(before.width, before.height, half)), ...(axis === 'horizontal' ? { posX: (p - 1) / 2 } : { posY: (p - 1) / 2 }) });
      front = picture(after, o.frontTrack, start, D, after.at, { ...crop(coverCrop(after.width, after.height, other)), ...(axis === 'horizontal' ? { posX: p / 2 } : { posY: p / 2 }) });
    } else {
      back = picture(before, o.backTrack, start, beforeLength, before.at, crop(coverB));
      const keyframes: Keyframe[] = [];
      if (moving) {
        const at = (p: number): ReturnType<typeof beyondDivider> => beyondDivider(coverA, p, axis);
        if (axis === 'horizontal') keyframes.push(...follow(path, afterFrom, 'cropLeft', (p) => at(p).cropLeft), ...follow(path, afterFrom, 'posX', (p) => at(p).posX));
        else keyframes.push(...follow(path, afterFrom, 'cropTop', (p) => at(p).cropTop), ...follow(path, afterFrom, 'posY', (p) => at(p).posY));
      }
      // In step with the before: the same moment of both, whenever the after comes in.
      front = picture(after, o.frontTrack, start + afterFrom, D - afterFrom, after.at + afterFrom, { ...beyondDivider(coverA, path[0].p, axis), keyframes });
    }
    const heard = o.sound === 'before' ? before : o.sound === 'after' ? after : null;
    if (heard && !heard.still && heard.hasAudio && o.soundTrack) {
      const length = Math.min(D, room(heard));
      sounds.push(
        newMediaClip({ mediaId: heard.mediaId, trackId: o.soundTrack, start, duration: Math.max(MIN_CLIP, length), inPoint: heard.at, sourceDuration: heard.sourceDuration, sourceWidth: heard.width, sourceHeight: heard.height, fadeOut: Math.min(0.3, length / 4), group }),
      );
    }
  }

  // ── Divider, handle and labels ──
  const overlays: Clip[] = [];
  const horizontal = axis === 'horizontal';
  const along = horizontal ? 'x' : 'y';
  const shape = (over: Partial<ShapeClip> & Pick<ShapeClip, 'start' | 'duration' | 'fill'>): ShapeClip => rectClip({ trackId: o.textTrack, group, ...over });
  /** A clip that lives from `from` to `to` (seconds into the comparison) and rides the divider, `shift` away from it. */
  const riding = (from: number, shift: number): { keyframes: Keyframe[] } & Record<'x' | 'y', number> => {
    const p0 = path.find((pt) => pt.t >= from - 1e-6)?.p ?? path[path.length - 1].p;
    const base = { x: horizontal ? p0 + shift : 0.5, y: horizontal ? 0.5 : p0 + shift };
    return { ...base, keyframes: moving ? follow(path, from, along, (p) => p + shift) : [] };
  };
  if (mode !== 'cut') {
    const from = mode === 'wipe' ? hold : 0;
    const to = mode === 'wipe' ? hold + sweep : D;
    const life = { start: start + from, duration: Math.max(MIN_CLIP, to - from) };
    const thick = 8 * px;
    const line = riding(from, 0);
    overlays.push(shape({ ...life, fill: o.line, ...line, w: horizontal ? thick / W : 1, h: horizontal ? 1 : thick / H }));
    if (moving) {
      // A round handle with an arrow either way, like a comparison slider being dragged.
      const d = 76 * px;
      const a = 18 * px;
      overlays.push(shape({ ...life, shape: 'ellipse', fill: o.line, stroke: '#00000055', strokeWidth: 3, ...riding(from, 0), w: d / W, h: d / H }));
      for (const dir of [-1, 1]) {
        const off = (dir * 17 * px) / (horizontal ? W : H);
        overlays.push(shape({ ...life, shape: 'triangle', fill: '#111111', ...riding(from, off), w: a / W, h: a / H, rotation: horizontal ? dir * 90 : dir < 0 ? 0 : 180 }));
      }
    }
  }
  if (o.labels) {
    const look: Partial<TextClip> = { fontSize, bold: true, color: '#ffffff', bgStyle: 'box', bgColor: '#000000', bgOpacity: 0.7, bgRadius: 12, bgPadding: padding, group, ...o.label };
    const label = (text: string, from: number, to: number, over: Partial<TextClip>): void => {
      if (!text.trim() || to - from < 0.3) return;
      overlays.push(textClip({ trackId: o.textTrack, start: start + from, duration: to - from, text, ...look, ...over }));
    };
    // Clear of the phone interface that covers the top of a vertical video.
    const edge = H > W ? 0.13 : 0.1;
    const fade = { fadeIn: 0.12, fadeOut: 0.12 };
    if (mode === 'wipe' || mode === 'cut') {
      // One at a time: the before while it is alone, the after once it has the frame.
      const shown = mode === 'wipe' ? hold + sweep : hold;
      label(o.labels.before, 0, hold, { x: 0.5, y: edge, animIn: 'none', fadeOut: 0.12 });
      label(o.labels.after, shown, D, { x: 0.5, y: edge, animIn: 'pop', animInDur: 0.25 });
    } else if (horizontal) {
      const gap = labelGap;
      if (moving) {
        // Each rides on its own side of the handle.
        label(o.labels.before, 0, D, { ...fade, ...riding(0, -gap), y: edge, anchor: 'right' });
        label(o.labels.after, 0, D, { ...fade, ...riding(0, gap), y: edge, anchor: 'left' });
      } else {
        const p = path[0].p;
        label(o.labels.before, 0, D, { ...fade, x: p / 2, y: edge });
        label(o.labels.after, 0, D, { ...fade, x: (1 + p) / 2, y: edge });
      }
    } else {
      const gap = (64 * px) / H;
      const side = { x: 0.06, anchor: 'left' as const };
      if (moving) {
        label(o.labels.before, 0, D, { ...fade, ...riding(0, -gap), ...side });
        label(o.labels.after, 0, D, { ...fade, ...riding(0, gap), ...side });
      } else {
        const p = path[0].p;
        label(o.labels.before, 0, D, { ...fade, ...side, y: edge });
        label(o.labels.after, 0, D, { ...fade, ...side, y: p + gap });
      }
    }
  }

  const revealFrom = mode === 'wipe' || mode === 'cut' ? start + hold : start;
  const revealTo = mode === 'wipe' ? start + hold + sweep : mode === 'cut' ? start + hold : start;
  return { clips: [back, front, ...sounds, ...overlays], group, before: back.id, after: front.id, start, end, revealFrom, revealTo, usedSound: sounds.length > 0, notes };
}

/**
 * A video track in front of `behind` that is free between start and end; a new
 * one (new tracks go in front) when none is.
 */
export function trackInFront(tracks: Track[], clips: Clip[], behind: string, start: number, end: number): { tracks: Track[]; track: Track } {
  const from = tracks.findIndex((t) => t.id === behind);
  const busy = (id: string): boolean => clips.some((c) => c.trackId === id && c.start < end - 1e-6 && c.start + c.duration > start + 1e-6);
  const found = tracks.find((t, i) => i > from && t.kind === 'video' && !t.locked && !t.hidden && !busy(t.id));
  if (found) return { tracks, track: found };
  const track: Track = { id: uid('tr'), kind: 'video', name: `V${tracks.filter((t) => t.kind === 'video').length + 1}` };
  return { tracks: [...tracks, track], track };
}
