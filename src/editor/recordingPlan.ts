import { newMediaClip, soundOf, uid, type Clip, type MediaClip, type Track } from './timelineStore';

/**
 * The decisions behind a recording that need no browser: which finished files
 * a recording becomes, how big and at what bitrate the picture is encoded, and
 * where the clips land on the timeline. recorder.ts does the capturing.
 */

export type RecordingRole = 'screen' | 'camera' | 'voice';

/** What is being captured. */
export interface RecordingInputs {
  screen: boolean;
  camera: boolean;
  /** What the computer plays. */
  system: boolean;
  mic: boolean;
}

export interface RecordingOutput {
  role: RecordingRole;
  video: 'screen' | 'camera' | null;
  audio: 'system' | 'mic' | null;
  ext: 'mp4' | 'm4a';
}

/**
 * One file per thing you would want to edit on its own. The voice stays with
 * the face when there is a camera, rides in the screen file when that is the
 * only other thing, and becomes a file of its own when the screen file already
 * carries the computer's sound (so the two can be mixed, ducked and cut apart).
 */
export function planOutputs(i: RecordingInputs): RecordingOutput[] {
  const out: RecordingOutput[] = [];
  const micWithScreen = i.screen && i.mic && !i.camera && !i.system;
  if (i.screen) out.push({ role: 'screen', video: 'screen', audio: i.system ? 'system' : micWithScreen ? 'mic' : null, ext: 'mp4' });
  if (i.camera) out.push({ role: 'camera', video: 'camera', audio: i.mic ? 'mic' : null, ext: 'mp4' });
  if (i.mic && !i.camera && !micWithScreen) out.push({ role: 'voice', video: null, audio: 'mic', ext: 'm4a' });
  return out;
}

/** In a sentence, what lands on the timeline (shown in the dialog before recording). */
export function describeOutputs(i: RecordingInputs, separateAudio = true): string {
  const plan = planOutputs(i);
  if (plan.length === 0) return 'Pick something to record: a screen, a camera or a microphone.';
  const parts = plan.map((o) => {
    if (o.role === 'screen') return o.audio === 'mic' ? 'the screen with your voice' : o.audio === 'system' ? "the screen with the computer's sound" : 'the screen (silent)';
    if (o.role === 'camera') return `${i.screen ? 'the camera in a corner above it' : 'the camera'}${o.audio ? ' with your voice' : ''}`;
    return 'your voice on its own audio track';
  });
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  const sounds = separateAudio ? plan.filter((o) => o.video && o.audio).length : 0;
  const lanes = sounds === 0 ? '' : sounds === 1 ? ' Its sound gets an audio track of its own, linked to the picture.' : ' Each sound gets an audio track of its own, linked to its picture.';
  return `Lands on the timeline as ${plan.length === 1 ? 'one clip' : `${plan.length} clips in sync`}: ${list}.${lanes}`;
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/**
 * The size a captured picture is encoded at: never bigger than the source,
 * capped at maxHeight when given, and even on both sides (H.264 needs that).
 * `resize` is false when the frames can go to the encoder untouched.
 */
export function encodeSize(width: number, height: number, maxHeight: number | null): { width: number; height: number; resize: boolean } {
  if (!(width > 0) || !(height > 0)) return { width: 1920, height: 1080, resize: true };
  const s = maxHeight && height > maxHeight ? maxHeight / height : 1;
  const w = even(width * s);
  const h = even(height * s);
  return { width: w, height: h, resize: w !== width || h !== height };
}

/**
 * Bitrate for a live H.264 encode. Screens are mostly still, so this is far
 * below what the same size of camera footage would need per pixel; text has to
 * stay sharp though, hence the floor. 1080p30 comes out at about 8 Mbps.
 */
export function videoBitrate(width: number, height: number, fps: number): number {
  const perFrame = width * height * 0.13;
  return Math.round(Math.min(45e6, Math.max(2.5e6, perFrame * 30 * Math.pow(fps / 30, 0.6))));
}

// ── Placement ─────────────────────────────────────────────────────────────

export interface RecordedClipSource {
  role: RecordingRole;
  mediaId: string;
  duration: number;
  width: number;
  height: number;
  /** The sound this video file carries, if any. */
  sound?: 'system' | 'mic' | null;
}

/** How much of the frame the camera takes when it sits over a screen recording. */
export const CAMERA_CORNER = 0.26;

/**
 * Put a finished recording on the timeline, every clip starting at `at`:
 * the screen on the first video track, the camera on a "Camera" track right
 * above it and scaled into the bottom-right corner (full frame when there is
 * no screen), the voice on a "Voice" audio track. A video file that carries
 * sound lands as a picture and a linked sound clip (the voice on "Voice", what
 * the computer played on "Computer sound"), unless separateAudio is off.
 */
export function planRecordingClips(
  sources: RecordedClipSource[],
  tracks: Track[],
  at: number,
  separateAudio = true,
): { tracks: Track[]; clips: MediaClip[]; main: RecordedClipSource | null } {
  let next = tracks;
  const made: MediaClip[] = [];
  const screen = sources.find((s) => s.role === 'screen');
  const camera = sources.find((s) => s.role === 'camera');
  const voice = sources.find((s) => s.role === 'voice');
  const clipFor = (s: RecordedClipSource, trackId: string, over: Partial<MediaClip> = {}): MediaClip =>
    newMediaClip({ mediaId: s.mediaId, trackId, start: at, duration: s.duration, sourceWidth: s.width, sourceHeight: s.height, ...over });
  const firstVideo = (): Track => {
    let t = next.find((x) => x.kind === 'video');
    if (!t) {
      t = { id: uid('tr'), kind: 'video', name: 'V1' };
      next = [t, ...next];
    }
    return t;
  };

  const audioLane = (name: string): Track => {
    let lane = next.find((t) => t.kind === 'audio' && t.name === name);
    if (!lane) {
      lane = { id: uid('tr'), kind: 'audio', name };
      next = [...next, lane];
    }
    return lane;
  };
  const place = (s: RecordedClipSource, picture: MediaClip): void => {
    if (!s.sound || !separateAudio) {
      made.push(picture);
      return;
    }
    const link = uid('l');
    const silent: MediaClip = { ...picture, link, muted: true };
    made.push(silent, soundOf(silent, audioLane(s.sound === 'system' ? 'Computer sound' : 'Voice').id, link));
  };

  const main = screen ?? camera ?? null;
  let mainTrack: Track | null = null;
  if (main) {
    mainTrack = firstVideo();
    place(main, clipFor(main, mainTrack.id));
  }
  if (screen && camera && mainTrack) {
    let lane = next.find((t) => t.kind === 'video' && t.name === 'Camera' && t.id !== mainTrack!.id);
    if (!lane) {
      lane = { id: uid('tr'), kind: 'video', name: 'Camera' };
      const i = next.findIndex((t) => t.id === mainTrack!.id);
      next = [...next.slice(0, i + 1), lane, ...next.slice(i + 1)];
    }
    const size = CAMERA_CORNER;
    place(camera, clipFor(camera, lane.id, { scaleX: size, scaleY: size, posX: 0.5 - size / 2 - 0.022, posY: 0.5 - size / 2 - 0.04 }));
  }
  if (voice) made.push(clipFor(voice, audioLane('Voice').id));
  return { tracks: next, clips: made, main };
}

/** True when nothing with a picture is on a video track yet (the canvas may still follow the first clip). */
export function noVisualsYet(clips: Clip[], tracks: Track[]): boolean {
  const video = new Set(tracks.filter((t) => t.kind === 'video').map((t) => t.id));
  return !clips.some((c) => c.type === 'media' && video.has(c.trackId));
}

/** 754 → "12:34"; an hour or more → "1:02:03". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const two = (n: number): string => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}
