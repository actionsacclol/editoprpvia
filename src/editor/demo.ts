// Product demo: a screen recording that looks directed. The camera pushes in on
// what is clicked, follows the pointer while it stays there, and pulls back when
// the work moves on; each click gets a highlight and a click sound.
//
// Pure: this plans from a recording's pointer track (where the pointer was and
// when it was pressed, written next to the file by the recorder) and returns
// ordinary keyframes and times. Everything it makes is clips on the timeline.

import { easeProgress, type Easing } from './timelineStore';

/** Where the pointer was during a recording, relative to the recorded picture. */
export interface PointerTrack {
  v: 1;
  /** Seconds of recording the track covers. */
  duration: number;
  /** [seconds, x, y]: 0..1 from the picture's top-left; outside the picture is below 0 or above 1. */
  moves: Array<[number, number, number]>;
  /** [seconds, x, y, button]: presses. Button 0 is the main one. */
  clicks: Array<[number, number, number, number]>;
  /** False when this computer could not report presses: no clicks then means "unknown", not "none". */
  buttons: boolean;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A pointer track read from disk, or null when it is not one. Rows that make no sense are dropped. */
export function parsePointer(raw: unknown): PointerTrack | null {
  if (!raw || typeof raw !== 'object') return null;
  const j = raw as Record<string, unknown>;
  if (j.v !== 1 || !Array.isArray(j.moves) || !Array.isArray(j.clicks)) return null;
  const rows = (list: unknown[], n: number): number[][] => list.filter((r): r is number[] => Array.isArray(r) && r.length >= n && r.slice(0, n).every(finite) && r[0] >= 0 && Math.abs(r[1]) < 20 && Math.abs(r[2]) < 20).map((r) => r.slice(0, n));
  const moves = rows(j.moves, 3).sort((a, b) => a[0] - b[0]) as PointerTrack['moves'];
  const clicks = rows(j.clicks, 4).sort((a, b) => a[0] - b[0]) as PointerTrack['clicks'];
  if (moves.length === 0 && clicks.length === 0) return null;
  const last = Math.max(moves.length ? moves[moves.length - 1][0] : 0, clicks.length ? clicks[clicks.length - 1][0] : 0);
  return { v: 1, duration: finite(j.duration) && j.duration > 0 ? Math.max(j.duration, last) : last, moves, clicks, buttons: j.buttons !== false };
}

/** Where the pointer was at `t`, or null before the first sample. */
export function pointerAt(track: PointerTrack, t: number): { x: number; y: number } | null {
  const m = track.moves;
  if (m.length === 0 || t < m[0][0]) return null;
  let lo = 0;
  let hi = m.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (m[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = m[lo];
  const b = m[lo + 1];
  // The pointer is sampled when it moves, so between two samples close in time it was on its way; after a long gap it sat still.
  if (!b || b[0] - a[0] > 0.25) return { x: a[1], y: a[2] };
  const r = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
  return { x: a[1] + (b[1] - a[1]) * r, y: a[2] + (b[2] - a[2]) * r };
}

export interface FocusEvent {
  /** Seconds into the recording. */
  t: number;
  x: number;
  y: number;
  /** A real press (it gets a highlight and a sound) rather than a place the camera was sent. */
  click: boolean;
}

const inPicture = (x: number, y: number): boolean => x >= 0 && x <= 1 && y >= 0 && y <= 1;

/**
 * Places the pointer came to rest after travelling, for recordings without
 * presses (another computer's helper could not read them): the camera goes
 * where the work is, there is just no click to mark.
 */
export function settles(track: PointerTrack): FocusEvent[] {
  const out: FocusEvent[] = [];
  const m = track.moves;
  // The pointer is sampled when it moves: a gap between two samples is it sitting still.
  const WAIT = 0.7;
  let from: { x: number; y: number } | null = null;
  for (let i = 0; i < m.length; i++) {
    const [t, x, y] = m[i];
    const until = i + 1 < m.length ? m[i + 1][0] : track.duration;
    if (until - t < WAIT || !inPicture(x, y)) continue;
    const far = !from || Math.hypot(x - from.x, y - from.y) > 0.12;
    if (far) out.push({ t: t + 0.15, x, y, click: false });
    from = { x, y };
  }
  return out;
}

export interface CameraOptions {
  /** How far in the camera goes: 1 = the whole picture, 2 = half of it across. */
  zoom: number;
  /** Seconds the camera stays after the last click before pulling back. */
  hold: number;
  /** The share of the picture in view at full zoom, per axis (1 = all of it: no travel on that axis). */
  view: { w: number; h: number };
  /**
   * How close to the picture's edges the middle of the view may go, as the
   * share of the picture kept between them (default: `view`, which stops the
   * view at the picture's edge). Smaller for a framed picture (reachAt).
   */
  reach?: { w: number; h: number };
}

/** The camera at one moment: `z` 0 = the whole picture, 1 = fully in; x, y = the point of the picture in the middle of the view. */
export interface CameraKey {
  t: number;
  z: number;
  x: number;
  y: number;
  /** Easing of the move that ends here. */
  ease: Easing;
}

export const DEMO = {
  /** Seconds a push in or a pull back takes. */
  IN: 0.65,
  OUT: 0.8,
  /** Seconds a move between two places takes while in. */
  PAN: 0.5,
  /** The camera has arrived this long before the click, so the click is seen. */
  LEAD: 0.15,
  /** A click highlight's life, seconds. */
  RIPPLE: 0.45,
} as const;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * The camera over a whole recording. Clicks close in time are one visit: push
 * in before the first, move only when a click or the pointer would leave the
 * view, pull back after the last. Always starts and ends on the whole picture.
 */
export function planCamera(track: PointerTrack, events: FocusEvent[], opts: CameraOptions): CameraKey[] {
  const hx = Math.min(0.5, opts.view.w / 2);
  const hy = Math.min(0.5, opts.view.h / 2);
  const rx = Math.min(0.5, Math.max(0, (opts.reach ?? opts.view).w / 2));
  const ry = Math.min(0.5, Math.max(0, (opts.reach ?? opts.view).h / 2));
  const centre = (x: number, y: number): { x: number; y: number } => ({ x: clamp(x, rx, 1 - rx), y: clamp(y, ry, 1 - ry) });
  const seen = (p: { x: number; y: number }, cam: { x: number; y: number }, share: number): boolean => Math.abs(p.x - cam.x) <= hx * share && Math.abs(p.y - cam.y) <= hy * share;
  const list = events.filter((e) => inPicture(e.x, e.y) && e.t >= 0 && e.t <= track.duration + 1).sort((a, b) => a.t - b.t);
  const keys: CameraKey[] = [];
  const push = (t: number, z: number, p: { x: number; y: number }, ease: Easing): void => {
    const last = keys[keys.length - 1];
    if (last && t <= last.t + 1e-3) {
      // Two things at once: the later one wins, at the same moment.
      keys[keys.length - 1] = { t: last.t, z, x: p.x, y: p.y, ease: last.ease };
      return;
    }
    keys.push({ t, z, x: p.x, y: p.y, ease });
  };
  const WIDE = { x: 0.5, y: 0.5 };
  // Leaving and coming straight back costs more than staying.
  const together = opts.hold + DEMO.OUT + DEMO.IN + 0.5;
  let free = 0;
  for (let i = 0; i < list.length; ) {
    let j = i + 1;
    while (j < list.length && list[j].t - list[j - 1].t <= together) j++;
    const visit = list.slice(i, j);
    i = j;
    const first = visit[0];
    const arrive = Math.max(free + 0.3, first.t - DEMO.LEAD);
    let cam = centre(first.x, first.y);
    push(Math.max(free, arrive - DEMO.IN), 0, WIDE, 'linear');
    push(arrive, 1, cam, 'inout');
    let at = arrive;
    const end = visit[visit.length - 1].t + opts.hold;
    const move = (to: { x: number; y: number }, by: number): void => {
      const t1 = Math.max(at + 0.15, by);
      push(Math.max(at, t1 - DEMO.PAN), 1, cam, 'linear');
      cam = centre(to.x, to.y);
      push(t1, 1, cam, 'inout');
      at = t1;
    };
    let n = 1;
    for (let t = arrive; t < end; t += 0.2) {
      // A click is coming up: be there before it lands.
      while (n < visit.length && visit[n].t <= t + DEMO.PAN + DEMO.LEAD + 0.2) {
        const e = visit[n++];
        if (!seen(e, cam, 0.62)) move(e, e.t - DEMO.LEAD);
      }
      // The pointer is working at the edge of the view or has left it: go with it.
      if (t > at + 0.2) {
        const p = pointerAt(track, t);
        if (p && inPicture(p.x, p.y) && !seen(p, cam, 0.9)) move(p, t + DEMO.PAN);
      }
    }
    const leave = Math.max(at, end);
    push(leave, 1, cam, 'linear');
    push(leave + DEMO.OUT, 0, WIDE, 'inout');
    free = leave + DEMO.OUT;
  }
  return keys;
}

/** The camera at `t`: the whole picture outside every visit. */
export function cameraAt(keys: CameraKey[], t: number): { z: number; x: number; y: number } {
  if (keys.length === 0 || t <= keys[0].t) return keys.length && t === keys[0].t ? keys[0] : { z: 0, x: 0.5, y: 0.5 };
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (t > b.t) continue;
    const a = keys[i - 1];
    const r = easeProgress(b.ease, (t - a.t) / Math.max(1e-6, b.t - a.t));
    return { z: a.z + (b.z - a.z) * r, x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r };
  }
  const last = keys[keys.length - 1];
  return { z: last.z, x: last.x, y: last.y };
}

/** How a picture sits on the canvas at rest, and how far in the camera goes. */
export interface DemoFrame {
  /** The clip's own scale and position (scale 1 = fits the canvas; position = offset as a fraction of the canvas). */
  scaleX: number;
  scaleY: number;
  posX: number;
  posY: number;
  /** The share of the canvas the picture takes at scale 1, per axis (1 on the axis it fits). */
  fitW: number;
  fitH: number;
  zoom: number;
  /**
   * The picture sits in a window frame on a backdrop: the camera then moves
   * over the whole scene, so a zoom towards an edge shows the frame's edge and
   * the backdrop past it, instead of stopping the picture flush with the canvas.
   */
  scene?: boolean;
}

/** The share of the canvas a picture of this shape takes when it fits inside it. */
export function fitShare(source: { width: number; height: number }, canvas: { width: number; height: number }): { fitW: number; fitH: number } {
  if (!(source.width > 0 && source.height > 0 && canvas.width > 0 && canvas.height > 0)) return { fitW: 1, fitH: 1 };
  const s = source.width / source.height;
  const c = canvas.width / canvas.height;
  return s >= c ? { fitW: 1, fitH: c / s } : { fitW: s / c, fitH: 1 };
}

/** The share of the picture in view at full zoom (for planCamera). */
export function viewAt(frame: DemoFrame): { w: number; h: number } {
  return { w: Math.min(1, 1 / (frame.scaleX * frame.zoom * frame.fitW)), h: Math.min(1, 1 / (frame.scaleY * frame.zoom * frame.fitH)) };
}

/**
 * How far the camera may travel (planCamera's `reach`). A bare picture: its
 * edge stops at the canvas edge. A framed one: the scene's edge does, so the
 * view may run past the picture by the frame's padding, zoomed.
 */
export function reachAt(frame: DemoFrame): { w: number; h: number } {
  if (!frame.scene) return viewAt(frame);
  const share = (size: number): number => clamp(1 - (frame.zoom - 1) / Math.max(1e-6, size), 0, 1);
  return { w: share(frame.scaleX * frame.zoom * frame.fitW), h: share(frame.scaleY * frame.zoom * frame.fitH) };
}

/** The clip transform that shows the camera's view. Never lets the canvas show past the picture's edge once the picture covers it (past the scene's edge, for a framed picture). */
export function transformAt(frame: DemoFrame, cam: { z: number; x: number; y: number }): { scaleX: number; scaleY: number; posX: number; posY: number } {
  const k = 1 + (frame.zoom - 1) * cam.z;
  const scaleX = frame.scaleX * k;
  const scaleY = frame.scaleY * k;
  const axis = (rest: number, c: number, size: number): number => {
    const room = Math.max(0, ((frame.scene ? k : size) - 1) / 2);
    const want = clamp((0.5 - c) * size, -room, room);
    // At rest the picture stays where the user put it; the further in, the more the camera decides.
    return rest * (1 - cam.z) + want * cam.z;
  };
  return { scaleX, scaleY, posX: axis(frame.posX, cam.x, scaleX * frame.fitW), posY: axis(frame.posY, cam.y, scaleY * frame.fitH) };
}

/** Where a point of the picture lands on the canvas (0..1) under a transform. */
export function onCanvas(frame: DemoFrame, tr: { scaleX: number; scaleY: number; posX: number; posY: number }, x: number, y: number): { x: number; y: number } {
  return { x: 0.5 + tr.posX + (x - 0.5) * tr.scaleX * frame.fitW, y: 0.5 + tr.posY + (y - 0.5) * tr.scaleY * frame.fitH };
}

export interface DemoKey {
  prop: 'scaleX' | 'scaleY' | 'posX' | 'posY';
  /** Seconds from the clip's start. */
  t: number;
  value: number;
  ease: Easing;
}

/** The piece of a recording a clip shows: recording seconds `from`..`to`, played at `speed`. */
export interface DemoPiece {
  from: number;
  to: number;
  speed: number;
}

/**
 * Keyframes for one clip of the recording. A clip cut out of the middle of a
 * move starts and ends on the camera as it was at those moments, so pieces of
 * one recording still agree across a cut. Empty when the camera never moves in it.
 */
export function clipKeys(keys: CameraKey[], frame: DemoFrame, piece: DemoPiece): DemoKey[] {
  const inside = keys.filter((k) => k.t > piece.from + 1e-3 && k.t < piece.to - 1e-3);
  const head = cameraAt(keys, piece.from);
  const tail = cameraAt(keys, piece.to);
  if (inside.length === 0 && head.z < 1e-3 && tail.z < 1e-3) return [];
  const next = keys.find((k) => k.t >= piece.to - 1e-3);
  const stops: Array<{ t: number; cam: { z: number; x: number; y: number }; ease: Easing }> = [
    { t: piece.from, cam: head, ease: 'linear' },
    ...inside.map((k) => ({ t: k.t, cam: k, ease: k.ease })),
    { t: piece.to, cam: tail, ease: next?.ease ?? 'linear' },
  ];
  const out: DemoKey[] = [];
  for (const s of stops) {
    const tr = transformAt(frame, s.cam);
    const t = Math.max(0, (s.t - piece.from) / Math.max(0.01, piece.speed));
    for (const prop of ['scaleX', 'scaleY', 'posX', 'posY'] as const) out.push({ prop, t, value: tr[prop], ease: s.ease });
  }
  return out;
}

export interface DemoClick {
  /** Seconds from the clip's start. */
  t: number;
  /** Where the click shows on the canvas, 0..1. */
  x: number;
  y: number;
  button: number;
}

/** The clicks a clip shows, placed where they land on the canvas under the camera at that moment. Clicks out of frame are left out. */
export function clipClicks(track: PointerTrack, keys: CameraKey[], frame: DemoFrame, piece: DemoPiece): DemoClick[] {
  const out: DemoClick[] = [];
  for (const [t, x, y, button] of track.clicks) {
    if (t < piece.from || t >= piece.to - 0.05 || !inPicture(x, y)) continue;
    const p = onCanvas(frame, transformAt(frame, cameraAt(keys, t)), x, y);
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) continue;
    out.push({ t: (t - piece.from) / Math.max(0.01, piece.speed), x: p.x, y: p.y, button });
  }
  return out;
}

/**
 * A mouse click: the press and, a moment later, the softer release. Made here
 * rather than shipped as a file, so there is nothing to license and it is the
 * same on every computer. Mono samples, -1..1.
 */
export function clickSound(rate = 48000): Float32Array {
  const out = new Float32Array(Math.round(rate * 0.16));
  let seed = 0x2f6e2b1;
  const noise = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x80000000 - 1;
  };
  const tick = (at: number, gain: number, pitch: number): void => {
    const from = Math.round(at * rate);
    let low = 0;
    for (let i = 0; from + i < out.length && i < rate * 0.06; i++) {
      const t = i / rate;
      const attack = Math.min(1, t / 0.0006);
      // A little body from the switch, and the snap on top of it.
      low += (noise() - low) * 0.35;
      const snap = low * Math.exp(-t / 0.004);
      const body = Math.sin(2 * Math.PI * pitch * t) * Math.exp(-t / 0.009) + 0.5 * Math.sin(2 * Math.PI * pitch * 0.42 * t) * Math.exp(-t / 0.014);
      out[from + i] += gain * attack * (0.55 * snap + 0.45 * body);
    }
  };
  tick(0.002, 0.8, 2300);
  tick(0.085, 0.42, 2900);
  return out;
}
