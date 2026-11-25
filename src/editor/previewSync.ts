/**
 * Keeping a media element on the playhead.
 *
 * The playhead runs on the wall clock and the <video> / <audio> elements play
 * on their own; these are the rules that tie them together:
 *
 * - Paused (scrubbing, stepping frames): the element is seeked to the exact
 *   source time, so the frame on screen is the frame the export renders.
 * - Playing: a small drift is steered out by playing a few percent faster or
 *   slower (pitch is preserved), which keeps picture, sound and overlays
 *   within about a frame of each other without the jump of a seek. Only a
 *   large gap (a stall, a jump in the timeline) is seeked across.
 */

/** Past this much drift while playing, seek instead of steering. */
export const HARD_SEEK = 0.3;
/** Steering starts beyond this drift (seconds)… */
export const STEER_START = 0.03;
/** …and stops once back inside this. */
export const STEER_STOP = 0.008;
/** The most the playback rate is bent to catch up or fall back. */
export const STEER_MAX = 0.05;
/** Paused, the element may be this far from the playhead before it is seeked (well under a frame). */
export const PAUSED_TOLERANCE = 0.002;

/**
 * How much to bend the playback rate for a drift (element time minus where it
 * should be, in source seconds). `steering` is whether a correction is already
 * under way: the two thresholds stop it from switching on and off around one.
 */
export function steer(drift: number, steering: boolean): { factor: number; steering: boolean } {
  const off = Math.abs(drift);
  const on = steering ? off > STEER_STOP : off > STEER_START;
  if (!on) return { factor: 1, steering: false };
  const bend = Math.max(-STEER_MAX, Math.min(STEER_MAX, drift * 0.6));
  return { factor: 1 - bend, steering: true };
}

interface ElState {
  /** A seek asked for while another was still running: the latest wins when that one lands. */
  want: number | null;
  steering: boolean;
}

const states = new WeakMap<HTMLMediaElement, ElState>();

function stateOf(el: HTMLMediaElement): ElState {
  let st = states.get(el);
  if (!st) {
    const made: ElState = { want: null, steering: false };
    st = made;
    states.set(el, made);
    el.addEventListener('seeked', () => {
      const w = made.want;
      made.want = null;
      if (w != null && Math.abs(el.currentTime - w) > PAUSED_TOLERANCE) seekTo(el, w);
    });
    // A new source makes any queued seek meaningless.
    el.addEventListener('emptied', () => {
      made.want = null;
      made.steering = false;
    });
  }
  return st;
}

/**
 * Seek, one at a time. Scrubbing asks for a new time on every pointer move; a
 * seek that is cut short by the next never shows a frame, so while one is
 * running the newest request waits and goes out the moment it lands.
 */
export function seekTo(el: HTMLMediaElement, t: number): void {
  const st = stateOf(el);
  if (el.seeking && el.readyState >= 1) {
    st.want = t;
    return;
  }
  st.want = null;
  try {
    el.currentTime = t;
  } catch {
    /* not ready: the next sync asks again */
  }
}

/**
 * Put an element where the playhead says (`local`, source seconds) and set its
 * rate (`base` is the clip's own speed at this moment).
 */
export function follow(el: HTMLMediaElement, local: number, base: number, playing: boolean): void {
  const st = stateOf(el);
  const pending = st.want ?? el.currentTime;
  const drift = pending - local;
  if (!playing) {
    st.steering = false;
    if (el.playbackRate !== base) el.playbackRate = base;
    if (Math.abs(drift) > PAUSED_TOLERANCE) seekTo(el, local);
    return;
  }
  if (Math.abs(drift) > HARD_SEEK) {
    st.steering = false;
    if (el.playbackRate !== base) el.playbackRate = base;
    seekTo(el, local);
    return;
  }
  // Not moving yet (still buffering or just told to play): bending the rate does nothing useful.
  const s = el.paused || el.seeking ? { factor: 1, steering: false } : steer(drift, st.steering);
  st.steering = s.steering;
  const rate = Math.max(0.0625, Math.min(16, base * s.factor));
  if (Math.abs(el.playbackRate - rate) > 1e-4) el.playbackRate = rate;
}
