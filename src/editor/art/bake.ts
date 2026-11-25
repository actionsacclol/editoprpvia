// Draws a scene frame by frame and encodes it: a generated scene reaches the timeline as an ordinary video file.
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, canEncodeVideo } from 'mediabunny';
import type { ArtBeat, ArtStyle } from './art';
import { drawStickScene, type StickScene } from './stickman';
import type { MascotScene } from './mascot';

export interface SceneJob {
  style: ArtStyle;
  beats: ArtBeat[];
  /** Seconds of picture to make. */
  duration: number;
  /** Where in the scene the picture starts, seconds (a stretch of a scene: one panel that moves). Default 0. */
  from?: number;
  /** Which scene of the video this is (backdrops and camera sides vary with it). */
  index: number;
  /** 3D styles: the character's body colour. */
  color?: string;
  /** Share of a wide frame's width kept clear on the left, for a panel of key points. */
  inset?: number;
}

/** The longest side a scene is drawn at. Flat art scales up cleanly, and H.264 encoders stop being hardware ones past this. */
const MAX_SIDE = 1920;

export function sceneSize(canvas: { width: number; height: number }): { w: number; h: number } {
  const k = Math.min(1, MAX_SIDE / Math.max(canvas.width, canvas.height));
  const even = (n: number): number => Math.max(2, Math.round((n * k) / 2) * 2);
  return { w: even(canvas.width), h: even(canvas.height) };
}

/** Draws a scene at time `t` (seconds) into a context of `size`. */
export type SceneDraw = (ctx: CanvasRenderingContext2D, size: { w: number; h: number }, t: number) => void;

let used3d = false;

/** Lets the 3D stages (WebGL contexts) go. Call after the last scene of a build. */
export async function releaseScenes(): Promise<void> {
  if (!used3d) return;
  used3d = false;
  (await import('./char3d')).disposeCharacters();
}

/** The function that draws a scene. It stays good after releaseScenes: the 3D stage is rebuilt on the next frame. */
export async function sceneDrawer(job: SceneJob): Promise<SceneDraw> {
  const { style, beats } = job;
  if (style.engine === 'stick') {
    const scene: StickScene = {
      look: style.look ?? 'paper',
      highlight: style.highlight,
      seed: 7 + job.index * 13,
      inset: job.inset,
      beats: beats.map((b) => ({ start: b.start, dur: b.dur, visual: b.pose, b: b.props, word: b.word, say: b.say, voStart: b.voStart, voDur: b.voDur, cam: b.camera, push: b.push })),
    };
    return (ctx, size, t) => drawStickScene(ctx, size, scene, t);
  }
  // three.js is only loaded when a 3D style is asked for.
  const { drawMascotScene } = await import('./mascot');
  const scene: MascotScene = {
    art: style.art ?? '3d',
    color: job.color || '#7C5CFF',
    accent: style.art === '3d' ? '#3B2A8C' : style.highlight,
    index: job.index,
    inset: job.inset,
    beats: beats.map((b) => ({ start: b.start, dur: b.dur, action: b.pose, word: b.word, say: b.say, voStart: b.voStart, voDur: b.voDur, camera: b.camera })),
  };
  return (ctx, size, t) => {
    used3d = true;
    drawMascotScene(ctx, size, scene, t);
  };
}

/** One frame of a scene as a canvas (previews, tests). */
export async function sceneFrame(job: SceneJob, canvas: { width: number; height: number }, t: number): Promise<HTMLCanvasElement> {
  const size = sceneSize(canvas);
  const el = document.createElement('canvas');
  el.width = size.w;
  el.height = size.h;
  const draw = await sceneDrawer(job);
  draw(el.getContext('2d')!, size, t);
  return el;
}

/**
 * When in a beat its still is taken: after the figure has reached the pose and the big word has landed, before the
 * next beat starts pulling it away.
 */
export function panelTime(beat: { start: number; dur: number }): number {
  return beat.start + Math.min(Math.max(0, beat.dur - 0.08), Math.max(0.9, Math.min(1.6, beat.dur * 0.55)));
}

/** The shortest a panel stays up, seconds: a beat shorter than this is told inside the panel before it. */
export const MIN_PANEL = 1.25;

export interface PanelSlot {
  /** The beat it shows. */
  beat: number;
  start: number;
  dur: number;
}

/** Which beats get a panel of their own, and how long each stays up. */
export function panelSlots(beats: Array<{ start: number; dur: number }>): PanelSlot[] {
  const slots: PanelSlot[] = [];
  beats.forEach((b, i) => {
    const last = slots[slots.length - 1];
    // Too short to read: the panel before it stays (or, at the very start, this one takes the next beat's time too).
    if (last && (b.dur < MIN_PANEL || last.dur < MIN_PANEL)) last.dur = b.start + b.dur - last.start;
    else slots.push({ beat: i, start: b.start, dur: b.dur });
  });
  return slots;
}

export interface Panel {
  /** Seconds into the narration it comes up, and how long it stays. */
  at: number;
  dur: number;
  kind: 'image' | 'video';
  data: Uint8Array;
}

/**
 * A scene as comic panels: one still per beat (JPEG), drawn by the same engine that would have acted it out.
 * A panel that stays up `aliveAfter` seconds or longer is not a still: that stretch is acted out (the figure
 * settles into the pose, the lines boil, the mouth moves), so nothing sits frozen for long. Infinity = stills only.
 */
export async function scenePanels(job: SceneJob, canvas: { width: number; height: number }, fps: number, aliveAfter: number, signal: AbortSignal, onPanel: (done: number) => void): Promise<Panel[]> {
  const size = sceneSize(canvas);
  const el = document.createElement('canvas');
  el.width = size.w;
  el.height = size.h;
  const ctx = el.getContext('2d', { alpha: false })!;
  const draw = await sceneDrawer(job);
  const slots = panelSlots(job.beats);
  const out: Panel[] = [];
  for (let i = 0; i < slots.length; i++) {
    if (signal.aborted) throw new Error('Cancelled.');
    const slot = slots[i];
    if (slot.dur >= aliveAfter) {
      const data = await bakeScene({ ...job, from: slot.start, duration: slot.dur }, canvas, fps, signal, (d) => onPanel((i + d) / slots.length));
      out.push({ at: slot.start, dur: slot.dur, kind: 'video', data });
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      draw(ctx, size, Math.min(job.duration, panelTime(job.beats[slot.beat])));
      const blob = await new Promise<Blob | null>((done) => el.toBlob(done, 'image/jpeg', 0.92));
      if (!blob) throw new Error('A panel could not be drawn.');
      out.push({ at: slot.start, dur: slot.dur, kind: 'image', data: new Uint8Array(await blob.arrayBuffer()) });
    }
    onPanel((i + 1) / slots.length);
    // Let the window breathe: the progress bar and the Cancel button live on this thread.
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

/** The scene as an MP4 (H.264, no sound). `onFrame` is told how far along it is, 0..1. */
export async function bakeScene(job: SceneJob, canvas: { width: number; height: number }, fps: number, signal: AbortSignal, onFrame: (done: number) => void): Promise<Uint8Array> {
  const size = sceneSize(canvas);
  if (!(await canEncodeVideo('avc', { width: size.w, height: size.h }).catch(() => false))) throw new Error('This computer cannot encode H.264 video, which drawn scenes need.');
  const el = document.createElement('canvas');
  el.width = size.w;
  el.height = size.h;
  const ctx = el.getContext('2d', { alpha: false })!;
  const draw = await sceneDrawer(job);
  const out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(el, { codec: 'avc', bitrate: QUALITY_HIGH });
  out.addVideoTrack(source, { frameRate: fps });
  await out.start();
  try {
    const frames = Math.max(1, Math.ceil(job.duration * fps));
    for (let n = 0; n < frames; n++) {
      if (signal.aborted) throw new Error('Cancelled.');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      draw(ctx, size, (job.from ?? 0) + n / fps);
      await source.add(n / fps, 1 / fps);
      if (n % 15 === 0) {
        onFrame(n / frames);
        // Let the window breathe: the progress bar and the Cancel button live on this thread.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await out.finalize();
  } catch (e) {
    await out.cancel().catch(() => undefined);
    throw e;
  }
  const buf = (out.target as BufferTarget).buffer;
  if (!buf) throw new Error('The scene could not be encoded.');
  return new Uint8Array(buf);
}
