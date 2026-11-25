import { create } from 'zustand';
import type { MediaFile } from '@shared/types';
import { probeMedia } from './probe';
import { ensureProxy } from './proxy';
import type { AudioFx } from './audioFx';
import type { ClipMask } from './mask';

/**
 * The timeline — the real editor model. Media from the bin is placed here as
 * clips on tracks; text overlays live as clips on a text track. Everything the
 * user edits (trim, split, move, volume, speed, filters, transform, crop,
 * fades, text, canvas, playhead) lives here with full undo/redo history. The
 * preview engine reads it to render; the timeline UI reads/writes it.
 */

export type TrackKind = 'video' | 'audio' | 'text';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  /** Audio from this track's clips is silenced (video tracks mute their embedded audio). */
  muted?: boolean;
  /** When any track is soloed, only soloed tracks are audible. */
  solo?: boolean;
  /** Clips on this track can't be selected, moved, trimmed, or deleted from the timeline. */
  locked?: boolean;
  /** This track's clips are excluded from the composite (video/text tracks). */
  hidden?: boolean;
}

/** Tracks whose audio should play: solo wins over everything, then mute. */
export function audibleTrackIds(tracks: Track[]): Set<string> {
  const anySolo = tracks.some((t) => t.solo);
  return new Set(tracks.filter((t) => (anySolo ? t.solo : !t.muted)).map((t) => t.id));
}

// ── Blend modes (CSS mix-blend-mode ∩ canvas globalCompositeOperation) ────
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export const BLEND_MODES: Array<{ label: string; value: BlendMode }> = [
  { label: 'Normal', value: 'normal' },
  { label: 'Multiply', value: 'multiply' },
  { label: 'Screen', value: 'screen' },
  { label: 'Overlay', value: 'overlay' },
  { label: 'Darken', value: 'darken' },
  { label: 'Lighten', value: 'lighten' },
  { label: 'Color dodge', value: 'color-dodge' },
  { label: 'Color burn', value: 'color-burn' },
  { label: 'Hard light', value: 'hard-light' },
  { label: 'Soft light', value: 'soft-light' },
  { label: 'Difference', value: 'difference' },
  { label: 'Exclusion', value: 'exclusion' },
  { label: 'Hue', value: 'hue' },
  { label: 'Saturation', value: 'saturation' },
  { label: 'Color', value: 'color' },
  { label: 'Luminosity', value: 'luminosity' },
];

interface ClipBase {
  id: string;
  trackId: string;
  start: number;
  duration: number;
  fadeIn: number;
  fadeOut: number;
  /** Length of the in / out animation, seconds (default ANIM_DUR). */
  animInDur?: number;
  animOutDur?: number;
  /** Motion that runs for the whole clip (slow zoom, pan, pulse, shake…). */
  motion?: MotionAnim;
  /** Motion strength, 1 = the preset's own (0.2..3). */
  motionAmount?: number;
  /**
   * A chapter of the video starts where this clip starts; the value is its
   * title. Kept on the clip (not at a fixed time) so cuts, ripples and inserted
   * cards carry the chapter along with the content it marks.
   */
  chapter?: string;
  /**
   * Shared by the clips of one built scene (a title card, a stinger, a
   * key-points card), so they can be found, restyled or removed together and a
   * style pass knows their text was fitted for that scene.
   */
  group?: string;
  /**
   * Shared by clips that belong together in time: a video's picture and its
   * sound on an audio track, or clips the user linked. They move, trim, split
   * and delete as one (see linkedIds); a link nobody else shares means nothing.
   */
  link?: string;
}

// A media clip also carries its sound shaping (pan, EQ, low cut, compressor): see audioFx.ts.
export interface MediaClip extends ClipBase, AudioFx {
  type: 'media';
  /** Entrance / exit animation (absent on older projects = none). */
  animIn?: TextAnim;
  animOut?: TextAnim;
  mediaId: string;
  inPoint: number;
  sourceDuration: number;
  /** Source pixel dimensions (0 for audio). */
  sourceWidth: number;
  sourceHeight: number;
  speed: number;
  volume: number;
  muted: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
  /** Hue rotation in degrees (0 = unchanged). */
  hue?: number;
  /** Vignette strength 0..1 (0 = off), darkened corners over the visible box. */
  vignette?: number;
  /** Rounded corners: the radius as a share of the visible box's shorter side, 0..0.5 (0 = square). */
  cornerRadius?: number;
  /** Drop shadow strength 0..1 (0 = off), cast by the visible box. */
  shadow?: number;
  /** What a Product demo's window frame changed, so taking the frame off puts it back (agentTools productDemo). */
  demoRest?: { scaleX: number; scaleY: number; posX: number; posY: number; cornerRadius: number; shadow: number; background?: Background };
  /** Effect preset key (see EFFECTS), applied on top of the adjustments. */
  effect: string;
  /** Transform on the canvas. scaleX/scaleY 1 = fit; pos as fraction of canvas; rotation deg. */
  scaleX: number;
  scaleY: number;
  posX: number;
  posY: number;
  rotation: number;
  /**
   * Leaning back in space, degrees (absent = flat): tiltX tips the top away, tiltY the right side, seen in
   * perspective (tilt.ts). Keyframeable, like the rest of the transform.
   */
  tiltX?: number;
  tiltY?: number;
  /** Layer opacity 0..1 — for overlays/fades. Keyframeable via the 'opacity' key. */
  opacity: number;
  /** How this layer composites over the layers below ('normal' when absent).
   * The names are shared by CSS mix-blend-mode and canvas compositing, so
   * preview and export stay identical. */
  blend?: BlendMode;
  /** Crop, as a fraction removed from each source edge (0..1). */
  cropTop: number;
  cropRight: number;
  cropBottom: number;
  cropLeft: number;
  /** Property animation keyframes (transform + opacity). */
  keyframes: Keyframe[];
  /** Transition played at this clip's start, blending with the previous clip. */
  transition: TransitionType;
  transitionDur: number;
  /** Chroma key (green-screen) removal. */
  chromaKey: boolean;
  chromaColor: string;
  /** 0..1 — how close to the key color is removed. */
  chromaSimilarity: number;
  /** 0..1 — edge feather. */
  chromaSmoothness: number;
  /** AI background removal (on-device person segmentation). */
  bgRemove: boolean;
  /** Shape mask over the visible box (linear/rect/ellipse + feather/invert). */
  mask?: ClipMask;
  /** Color LUT (id into the LUT bin) + blend strength 0..1 (default 1). */
  lut?: string;
  lutAmount?: number;
  /** Freeze frame: render this single source time for the whole clip (silent). */
  freezeAt?: number;
  /** On-device noise reduction (spectral gate), applied to this clip's audio at export. */
  denoise?: boolean;
}

export type TextAnim =
  | 'none'
  | 'fade'
  | 'slide'
  | 'slide-down'
  | 'slide-left'
  | 'slide-right'
  | 'pop'
  | 'zoom'
  | 'bounce'
  | 'spin'
  | 'blur'
  | 'typewriter'
  | 'drop'
  | 'stomp'
  | 'swing'
  | 'flicker'
  | 'fly-left'
  | 'fly-right'
  | 'fly-top'
  | 'fly-bottom'
  | 'cascade';

/** Whole-clip motion, on top of the in / out animation. */
export type MotionAnim = 'none' | 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down' | 'pulse' | 'float' | 'shake' | 'wiggle';

export interface TextClip extends ClipBase {
  type: 'text';
  text: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  bold: boolean;
  italic: boolean;
  /** Text outline/stroke. width is px at the 1080 reference height; 0 = off. */
  outlineWidth: number;
  outlineColor: string;
  /** Colored glow. blur is px at the 1080 reference height; 0 = off. */
  glow: number;
  glowColor: string;
  /** Background behind the text: a box behind the block, or per-line highlight. */
  bgStyle: TextBgStyle;
  bgColor: string;
  bgOpacity: number;
  bgRadius: number; // corner radius, px at the 1080 reference height
  bgPadding: number; // px at the 1080 reference height
  align: 'left' | 'center' | 'right';
  x: number;
  y: number;
  /**
   * Which edge of the text block `x` places: absent = its centre. 'left' pins
   * the left edge there (bullet lists, lower thirds: lines of different
   * lengths start at the same place), 'right' the right edge.
   */
  anchor?: 'left' | 'right';
  /** Base opacity (older projects lack it → 1). */
  opacity?: number;
  animIn: TextAnim;
  animOut: TextAnim;
  keyframes: Keyframe[];
  /** Set on clips created by auto-captions / subtitle import, so subtitle
   * export can tell captions apart from titles and stickers. */
  role?: 'caption';
  /** Word-level timings (seconds relative to the clip start) from auto-captions. */
  words?: Array<{ start: number; end: number; text: string }>;
  /** Karaoke styling of the word being spoken ('none'/undefined = off). */
  karaoke?: KaraokeStyle;
  karaokeColor?: string;
}

export type KaraokeStyle = 'none' | 'color' | 'pop' | 'box';

export const KARAOKE_STYLES: Array<{ label: string; value: KaraokeStyle }> = [
  { label: 'None', value: 'none' },
  { label: 'Color', value: 'color' },
  { label: 'Pop', value: 'pop' },
  { label: 'Box', value: 'box' },
];

export const DEFAULT_KARAOKE_COLOR = '#ffd53d';

/** True when a clip can render karaoke (has word timings and a style on). */
export function karaokeActive(clip: TextClip): boolean {
  return !!clip.words && clip.words.length > 0 && !!clip.karaoke && clip.karaoke !== 'none';
}

/** Index of the word being spoken at timeline time t — the most recent word
 *  that has started (held until the next begins), or -1 before the first. */
export function activeWordAt(clip: TextClip, t: number): number {
  const ws = clip.words;
  if (!ws || ws.length === 0) return -1;
  const lt = t - clip.start;
  for (let i = ws.length - 1; i >= 0; i--) if (lt >= ws[i].start) return i;
  return -1;
}

export type TextBgStyle = 'none' | 'box' | 'highlight';

export const TEXT_BG: Array<{ label: string; value: TextBgStyle }> = [
  { label: 'None', value: 'none' },
  { label: 'Box', value: 'box' },
  { label: 'Highlight', value: 'highlight' },
];

export const TEXT_ANIMS: Array<{ label: string; value: TextAnim }> = [
  { label: 'None', value: 'none' },
  { label: 'Fade', value: 'fade' },
  { label: 'Slide up', value: 'slide' },
  { label: 'Slide down', value: 'slide-down' },
  { label: 'Slide left', value: 'slide-left' },
  { label: 'Slide right', value: 'slide-right' },
  { label: 'Pop', value: 'pop' },
  { label: 'Zoom', value: 'zoom' },
  { label: 'Bounce', value: 'bounce' },
  { label: 'Spin', value: 'spin' },
  { label: 'Blur', value: 'blur' },
  { label: 'Typewriter', value: 'typewriter' },
  { label: 'Drop', value: 'drop' },
  { label: 'Stomp', value: 'stomp' },
  { label: 'Swing', value: 'swing' },
  { label: 'Flicker', value: 'flicker' },
  { label: 'Fly · left edge', value: 'fly-left' },
  { label: 'Fly · right edge', value: 'fly-right' },
  { label: 'Fly · top edge', value: 'fly-top' },
  { label: 'Fly · bottom edge', value: 'fly-bottom' },
  { label: 'Word by word', value: 'cascade' },
];

/** In / out animations a video or image clip can use (typewriter and word by word are text only). */
export const CLIP_ANIMS = TEXT_ANIMS.filter((a) => a.value !== 'typewriter' && a.value !== 'cascade');

export const MOTIONS: Array<{ label: string; value: MotionAnim }> = [
  { label: 'None', value: 'none' },
  { label: 'Slow zoom in', value: 'zoom-in' },
  { label: 'Slow zoom out', value: 'zoom-out' },
  { label: 'Pan left', value: 'pan-left' },
  { label: 'Pan right', value: 'pan-right' },
  { label: 'Pan up', value: 'pan-up' },
  { label: 'Pan down', value: 'pan-down' },
  { label: 'Pulse', value: 'pulse' },
  { label: 'Float', value: 'float' },
  { label: 'Shake', value: 'shake' },
  { label: 'Wiggle', value: 'wiggle' },
];

/** Length of a text in/out animation, seconds. */
export const ANIM_DUR = 0.5;

/** Styling applied to every caption clip created by auto-captions / import. */
export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  outlineWidth: number;
  outlineColor: string;
  align: 'left' | 'center' | 'right';
  /** Vertical position as a fraction of the canvas (0 top … 1 bottom). */
  y: number;
  /** Karaoke styling of the spoken word (needs word timings from auto-captions). */
  karaoke: KaraokeStyle;
  karaokeColor: string;
}

// ── Keyframes (property animation) ────────────────────────────────────────
/** Interpolation curve into a keyframe (from the previous one). */
export type Easing = 'linear' | 'in' | 'out' | 'inout';

export const EASINGS: Array<{ label: string; value: Easing }> = [
  { label: 'Linear', value: 'linear' },
  { label: 'Ease in', value: 'in' },
  { label: 'Ease out', value: 'out' },
  { label: 'Ease in-out', value: 'inout' },
];

/** Shape a 0..1 progress by an easing curve. */
export function easeProgress(e: Easing | undefined, r: number): number {
  switch (e) {
    case 'in':
      return r * r;
    case 'out':
      return 1 - (1 - r) * (1 - r);
    case 'inout':
      return r < 0.5 ? 2 * r * r : 1 - ((-2 * r + 2) * (-2 * r + 2)) / 2;
    default:
      return r;
  }
}

export interface Keyframe {
  id: string;
  /** Property name (matches a clip field, e.g. 'posX', 'scaleX', 'opacity'). */
  prop: string;
  /** Time from the clip's start, seconds. */
  t: number;
  value: number;
  /** Easing of the segment leading INTO this keyframe (default linear). */
  ease?: Easing;
}

const KEY_EPS = 0.04;

// ── Transitions (between adjacent clips on a video track) ──────────────────
export type TransitionType =
  | 'none'
  | 'fade'
  | 'dip'
  | 'flash'
  | 'slide'
  | 'slide-right'
  | 'slide-up'
  | 'slide-down'
  | 'push'
  | 'push-right'
  | 'push-up'
  | 'push-down'
  | 'wipe'
  | 'wipe-left'
  | 'wipe-up'
  | 'wipe-down'
  | 'zoom'
  | 'zoom-out'
  | 'spin'
  | 'whip'
  | 'blur';

export const TRANSITIONS: Array<{ label: string; value: TransitionType }> = [
  { label: 'None', value: 'none' },
  { label: 'Crossfade', value: 'fade' },
  { label: 'Dip to black', value: 'dip' },
  { label: 'Flash to white', value: 'flash' },
  { label: 'Slide', value: 'slide' },
  { label: 'Slide right', value: 'slide-right' },
  { label: 'Slide up', value: 'slide-up' },
  { label: 'Slide down', value: 'slide-down' },
  { label: 'Push', value: 'push' },
  { label: 'Push right', value: 'push-right' },
  { label: 'Push up', value: 'push-up' },
  { label: 'Push down', value: 'push-down' },
  { label: 'Wipe', value: 'wipe' },
  { label: 'Wipe left', value: 'wipe-left' },
  { label: 'Wipe up', value: 'wipe-up' },
  { label: 'Wipe down', value: 'wipe-down' },
  { label: 'Zoom', value: 'zoom' },
  { label: 'Zoom out', value: 'zoom-out' },
  { label: 'Spin', value: 'spin' },
  { label: 'Whip pan', value: 'whip' },
  { label: 'Blur', value: 'blur' },
];

/**
 * Effect presets. 'filter' ones are pure CSS color/look filters applied via
 * clipFilter. 'shader' ones (glitch, VHS, …) are GPU effects rendered through
 * the fx shader (see fx.ts) — their CSS filter stays empty and 'swatch' is just
 * a rough CSS approximation used for the library thumbnail.
 */
export interface EffectDef {
  label: string;
  value: string;
  filter: string;
  /** GPU shader effect (rendered via fx.ts), not a CSS filter. */
  shader?: boolean;
  /** CSS approximation for the library swatch only. */
  swatch?: string;
}

export const EFFECTS: EffectDef[] = [
  { label: 'None', value: 'none', filter: '' },
  { label: 'B&W', value: 'bw', filter: 'grayscale(100%)' },
  { label: 'Sepia', value: 'sepia', filter: 'sepia(80%)' },
  { label: 'Vintage', value: 'vintage', filter: 'sepia(40%) contrast(110%) saturate(120%) brightness(105%)' },
  { label: 'Cool', value: 'cool', filter: 'hue-rotate(-18deg) saturate(115%) brightness(102%)' },
  { label: 'Warm', value: 'warm', filter: 'hue-rotate(18deg) saturate(120%) brightness(104%)' },
  { label: 'Vivid', value: 'vivid', filter: 'saturate(165%) contrast(112%)' },
  { label: 'Invert', value: 'invert', filter: 'invert(100%)' },
  { label: 'Blur', value: 'blur', filter: 'blur(6px)' },
  // GPU shader effects (animated; rendered by fx.ts in preview + export).
  { label: 'Glitch', value: 'glitch', filter: '', shader: true, swatch: 'contrast(150%) saturate(170%) hue-rotate(8deg)' },
  { label: 'VHS', value: 'vhs', filter: '', shader: true, swatch: 'saturate(140%) contrast(115%) sepia(18%)' },
  { label: 'Chromatic', value: 'chromatic', filter: '', shader: true, swatch: 'contrast(120%) saturate(135%)' },
  { label: 'CRT lines', value: 'scanlines', filter: '', shader: true, swatch: 'brightness(88%) contrast(125%)' },
  { label: 'Film grain', value: 'grain', filter: '', shader: true, swatch: 'sepia(35%) contrast(110%) brightness(98%)' },
  { label: 'Pixelate', value: 'pixelate', filter: '', shader: true, swatch: 'contrast(108%) saturate(120%)' },
];

export function effectFilter(value: string): string {
  return EFFECTS.find((e) => e.value === value)?.filter ?? '';
}

/** CSS filter for the library swatch (approximation for shader effects). */
export function effectSwatch(value: string): string {
  const e = EFFECTS.find((x) => x.value === value);
  return e?.swatch ?? e?.filter ?? '';
}

/** Full CSS filter string for a media clip (adjustments + effect preset). */
export function clipFilter(clip: MediaClip): string {
  const hue = clip.hue ? ` hue-rotate(${clip.hue}deg)` : '';
  const base = `brightness(${clip.brightness}%) contrast(${clip.contrast}%) saturate(${clip.saturation}%)${hue}`;
  const fx = effectFilter(clip.effect);
  return fx ? `${base} ${fx}` : base;
}

// ── Shapes (vector overlays) ───────────────────────────────────────────────
export type ShapeKind = 'rect' | 'rounded' | 'ellipse' | 'triangle' | 'star' | 'heart' | 'arrow' | 'line';

export const SHAPES: Array<{ label: string; value: ShapeKind }> = [
  { label: 'Rectangle', value: 'rect' },
  { label: 'Rounded', value: 'rounded' },
  { label: 'Ellipse', value: 'ellipse' },
  { label: 'Triangle', value: 'triangle' },
  { label: 'Star', value: 'star' },
  { label: 'Heart', value: 'heart' },
  { label: 'Arrow', value: 'arrow' },
  { label: 'Line', value: 'line' },
];

export interface ShapeClip extends ClipBase {
  type: 'shape';
  shape: ShapeKind;
  fill: string;
  /** Empty string = no fill. */
  stroke: string;
  strokeWidth: number; // px at the 1080 reference height
  opacity: number;
  /** Center, as a fraction of the canvas. */
  x: number;
  y: number;
  /** Size, as a fraction of the canvas. */
  w: number;
  h: number;
  rotation: number;
  animIn: TextAnim;
  animOut: TextAnim;
  keyframes: Keyframe[];
}

// ── Freehand drawing ───────────────────────────────────────────────────────
export interface Stroke {
  color: string;
  /** Brush width, px at the 1080 reference height. */
  width: number;
  /** Flattened [x0,y0,x1,y1,…] points, each a fraction of the canvas. */
  points: number[];
}

export interface DrawClip extends ClipBase {
  type: 'draw';
  strokes: Stroke[];
  opacity: number;
  /** Offset applied to every stroke, as a fraction of the canvas. */
  x: number;
  y: number;
  animIn: TextAnim;
  animOut: TextAnim;
  keyframes: Keyframe[];
}

/** Emoji stickers — inserted as text clips, so they reuse all text rendering. */
export const STICKERS = ['😀', '😂', '😍', '😎', '🥳', '🤯', '👍', '🔥', '✨', '💯', '❤️', '⭐', '🎉', '👀', '💀', '🙌', '🚀', '⚡', '💥', '🎬', '🎵', '📍', '✅', '❌'];

export type Clip = MediaClip | TextClip | ShapeClip | DrawClip;

/** Overlay clips (text/shape/draw) render on top of the video composite. */
export type OverlayClip = TextClip | ShapeClip | DrawClip;

/** The project canvas, in output pixels. */
export interface Canvas {
  width: number;
  height: number;
}

/** Fill behind the composited layers (letterbox/deadspace). */
export type BackgroundType = 'black' | 'color' | 'gradient' | 'blur';
export interface Background {
  type: BackgroundType;
  color: string;
  /** Second stop for the gradient fill. */
  color2: string;
}

export const DEFAULT_BACKGROUND: Background = { type: 'black', color: '#101018', color2: '#2a2a3a' };

export const BACKGROUNDS: Array<{ label: string; value: BackgroundType }> = [
  { label: 'Black', value: 'black' },
  { label: 'Color', value: 'color' },
  { label: 'Gradient', value: 'gradient' },
  { label: 'Blur', value: 'blur' },
];

/** CSS background value for a non-blur background (blur is rendered separately). */
export function backgroundCss(bg: Background): string {
  if (bg.type === 'color') return bg.color;
  if (bg.type === 'gradient') return `linear-gradient(180deg, ${bg.color} 0%, ${bg.color2} 100%)`;
  return '#000000';
}

/** "#rrggbb" + alpha (0..1) → an rgba() string (for text background fills). */
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  const a = Math.max(0, Math.min(1, alpha));
  if (!m) return `rgba(0,0,0,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export const RESOLUTIONS: Array<{ label: string; width: number; height: number; hint: string }> = [
  { label: '16:9', width: 1920, height: 1080, hint: 'YouTube' },
  { label: '9:16', width: 1080, height: 1920, hint: 'TikTok / Reels' },
  { label: '1:1', width: 1080, height: 1080, hint: 'Square' },
  { label: '4:5', width: 1080, height: 1350, hint: 'Instagram' },
];

export const FONTS: Array<{ label: string; value: string }> = [
  { label: 'Chakra Petch', value: '"Chakra Petch", sans-serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Segoe UI', value: '"Segoe UI", sans-serif' },
  { label: 'Trebuchet', value: '"Trebuchet MS", sans-serif' },
  { label: 'Verdana', value: 'Verdana, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times', value: '"Times New Roman", serif' },
  { label: 'Courier', value: '"Courier New", monospace' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", monospace' },
  { label: 'Impact', value: 'Impact, sans-serif' },
  { label: 'Comic Sans', value: '"Comic Sans MS", cursive' },
  { label: 'Press Start 2P', value: '"Press Start 2P", monospace' },
];

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: FONTS[0].value,
  fontSize: 64,
  color: '#ffffff',
  bold: true,
  italic: false,
  // A black outline by default so captions stay readable on any background.
  outlineWidth: 6,
  outlineColor: '#000000',
  align: 'center',
  y: 0.86,
  // Word-by-word color is the look people expect from auto-captions now; it
  // only kicks in when the transcription produced word timings.
  karaoke: 'color',
  karaokeColor: DEFAULT_KARAOKE_COLOR,
};

/** Reference canvas height the editor's px sizes (fontSize) assume. */
export const REF_HEIGHT = 1080;
export const MIN_CLIP = 0.1;
export const MAX_FADE = 3;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
/** Cap auto-derived canvas to keep frame-by-frame export tractable. */
// A canvas made from a clip follows the clip up to 4K (large footage previews through its small copy, see proxy.ts).
const MAX_CANVAS_DIM = 3840;

const DEFAULT_PX_PER_SEC = 60;
export const MIN_PX_PER_SEC = 8;
export const MAX_PX_PER_SEC = 320;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const even = (n: number): number => (n % 2 === 0 ? n : n + 1);

let seq = 0;
export const uid = (p: string): string => `${p}${Date.now().toString(36)}-${++seq}`;

function makeDefaultTracks(): Track[] {
  return [
    { id: 'text-1', kind: 'text', name: 'T1' },
    { id: 'video-1', kind: 'video', name: 'V1' },
    { id: 'audio-1', kind: 'audio', name: 'A1' },
  ];
}

/** Even, capped canvas dimensions for a source of the given size. */
export function fitCanvas(w: number, h: number): Canvas {
  if (w <= 0 || h <= 0) return { width: 1920, height: 1080 };
  const s = Math.min(1, MAX_CANVAS_DIM / Math.max(w, h));
  return { width: even(Math.round(w * s)), height: even(Math.round(h * s)) };
}

export function exportDims(canvas: Canvas): Canvas {
  return { width: even(canvas.width), height: even(canvas.height) };
}

interface Doc {
  clips: Clip[];
  tracks: Track[];
  canvas: Canvas;
  background: Background;
}

export type ClipPatch = Partial<
  Omit<MediaClip, 'id' | 'type'> & Omit<TextClip, 'id' | 'type'> & Omit<ShapeClip, 'id' | 'type'> & Omit<DrawClip, 'id' | 'type'>
>;

interface TimelineState extends Doc {
  /** Project frame rate — drives frame stepping; synced from export settings. */
  fps: number;
  playhead: number;
  playing: boolean;
  /** Playback rate while playing: 1 normally; J / L shuttle it to ±1, ±2, ±4, ±8 (negative plays backwards). */
  shuttle: number;
  /** Selected clip ids (marquee/multi-select). Last item is the "primary". */
  selectedIds: string[];
  /** The selection was made with Alt: edits leave the clips linked to it alone. */
  soloSelect: boolean;
  pxPerSec: number;
  /** True once the user picks a resolution; stops first-clip auto-canvas. */
  canvasUserSet: boolean;
  /** Freehand drawing mode — pointer strokes on the preview become a drawing. */
  drawMode: boolean;
  brush: { color: string; width: number };
  past: Doc[];
  future: Doc[];

  /** Time ranges the auto-edit dialog is about to cut, painted on the timeline. UI state, not document. */
  cutPreview: Array<[number, number]> | null;
  setCutPreview: (ranges: Array<[number, number]> | null) => void;
  /** Replace the clip list as one undoable edit, for planners (auto edit) that build the new document outside the store. */
  commitClips: (clips: Clip[], tracks?: Track[]) => void;

  pushHistory: () => void;
  undo: () => void;
  redo: () => void;

  /**
   * Put a file at the end of the first track of its kind. A video that has
   * sound lands as two linked clips, the picture and (on an audio track) its
   * sound, unless `separateAudio` is false. Returns the picture's clip id.
   */
  addMedia: (media: MediaFile, opts?: { separateAudio?: boolean }) => Promise<string | null>;
  addText: () => void;
  /** Add a vector shape overlay at the playhead. */
  addShape: (shape: ShapeKind) => void;
  /** Add an emoji sticker (a text clip) at the playhead. */
  addSticker: (emoji: string) => void;
  /** Append a freehand stroke; creates/extends a drawing clip. Returns its id. */
  addStroke: (clipId: string | null, stroke: Stroke) => string;
  setDrawMode: (on: boolean) => void;
  setBrush: (patch: Partial<{ color: string; width: number }>) => void;
  addTrack: (kind: TrackKind) => void;
  removeTrack: (id: string) => void;
  /** Toggle per-track flags (mute/solo/lock/hide) or rename. */
  updateTrack: (id: string, patch: Partial<Pick<Track, 'muted' | 'solo' | 'locked' | 'hidden' | 'name'>>) => void;
  duplicateClip: (id: string) => void;
  /** Put a video clip's sound on an audio track as a clip linked to it; the picture goes silent. */
  detachAudio: (id: string) => void;
  /** Link the selected clips (each on a different track) so they edit as one. */
  linkSelected: () => void;
  /** Break the links of the selected clips and of everything linked to them. */
  unlinkSelected: () => void;
  removeClip: (id: string) => void;
  removeByMedia: (mediaId: string) => void;
  /** Delete every selected clip. */
  removeSelected: () => void;
  /** Delete every selected clip and close the gaps left behind — later clips
   * on the same track slide left by the removed time. */
  rippleDeleteSelected: () => void;
  /** Slide a clip (and everything after it on its track) left so it touches
   * the previous clip — i.e. delete the gap before it. */
  closeGapBefore: (id: string) => void;
  /** Select a clip. additive toggles it in/out of the current selection; solo leaves its linked clips out of the edits that follow. */
  selectClip: (id: string | null, additive?: boolean, solo?: boolean) => void;
  /** Replace the whole selection (e.g. from a marquee drag). */
  setSelection: (ids: string[]) => void;
  /** Apply a patch to every selected clip (batch edit). */
  updateSelected: (patch: ClipPatch) => void;

  /** Copy the selected clips to the editor clipboard. Returns how many. */
  copySelected: () => number;
  /** Copy the selected clips, then delete them. Returns how many. */
  cutSelected: () => number;
  /** Paste at the playhead, preserving relative timing. Returns how many. */
  paste: () => number;

  moveClip: (id: string, start: number, trackId: string) => void;
  /** Trim an edge; linked clips follow by the same amount unless `alone`. */
  trimClipStart: (id: string, newStart: number, alone?: boolean) => void;
  trimClipEnd: (id: string, newEnd: number, alone?: boolean) => void;
  /** Replace a media clip's speed keyframes with a velocity preset ('none' = constant). */
  applySpeedPreset: (id: string, preset: string) => void;
  /** Insert a 3s frozen frame at the playhead inside the selected media clip,
   * pushing everything after it on the track right. Returns false if there's
   * no eligible clip under the playhead. */
  freezeFrameAtPlayhead: () => boolean;
  /** Retime every keyframe near fromT (clip-local) to toT — timeline diamond drag. */
  moveKeyframes: (id: string, fromT: number, toT: number) => void;
  /** Delete every keyframe near clip-local time atT. */
  deleteKeyframes: (id: string, atT: number) => void;
  splitSelectedAtPlayhead: () => void;
  updateClip: (id: string, patch: ClipPatch) => void;
  setSpeed: (id: string, speed: number) => void;
  /** Add/replace a keyframe for a property at time t (clip-relative seconds). */
  setKeyframe: (id: string, prop: string, t: number, value: number) => void;
  /** Toggle a keyframe at time t — add if none nearby, remove if one exists. */
  toggleKeyframe: (id: string, prop: string, t: number, value: number) => void;
  /** Set the easing curve of the keyframe at time t. */
  setKeyframeEase: (id: string, prop: string, t: number, ease: Easing) => void;
  /** Bulk-add clips (e.g. captions); ensures a text track exists. */
  addClips: (clips: Clip[]) => void;
  /** Add caption text clips from timed segments onto a text track. */
  addCaptions: (
    segments: Array<{ start: number; end: number; text: string; words?: Array<{ start: number; end: number; text: string }> }>,
    style?: CaptionStyle,
  ) => void;

  setCanvas: (canvas: Canvas) => void;
  setFps: (fps: number) => void;
  setBackground: (patch: Partial<Background>) => void;
  /** Replace the whole timeline document (open project / apply template). */
  loadDoc: (doc: { clips: Clip[]; tracks: Track[]; canvas: Canvas; background?: Background; fps?: number }) => void;
  setPlayhead: (t: number) => void;
  play: () => void;
  pause: () => void;
  /** J / L: play in a direction (1 forwards, -1 backwards); pressing the same way again doubles the speed, up to 8x. */
  shuttleBy: (dir: 1 | -1) => void;
  setZoom: (pxPerSec: number) => void;
  clear: () => void;
}

/** Caption text clips for timestamped segments (timeline seconds), styled uniformly. */
export function captionClipsFor(
  segments: Array<{ start: number; end: number; text: string; words?: Array<{ start: number; end: number; text: string }> }>,
  style: CaptionStyle | undefined,
  trackId: string,
): TextClip[] {
  const st = { ...DEFAULT_CAPTION_STYLE, ...style };
  return segments.map((seg) => {
    const start = Math.max(0, seg.start);
    return {
      type: 'text',
      id: uid('t'),
      trackId,
      start,
      duration: Math.max(0.3, seg.end - seg.start),
      fadeIn: 0,
      fadeOut: 0,
      text: seg.text,
      fontSize: st.fontSize,
      fontFamily: st.fontFamily,
      color: st.color,
      bold: st.bold,
      italic: st.italic,
      outlineWidth: st.outlineWidth,
      outlineColor: st.outlineColor,
      glow: 0,
      glowColor: '#a855f7',
      bgStyle: 'none',
      bgColor: '#000000',
      bgOpacity: 0.6,
      bgRadius: 10,
      bgPadding: 16,
      align: st.align,
      x: 0.5,
      y: st.y,
      animIn: 'none',
      animOut: 'none',
      keyframes: [],
      role: 'caption',
      // Word timings become clip-relative so they survive moving the clip.
      words: seg.words?.map((w) => ({ start: w.start - start, end: w.end - start, text: w.text })),
      karaoke: st.karaoke,
      karaokeColor: st.karaokeColor,
    };
  });
}

/** The clips an edit of the selection applies to: the selection and, unless it was made with Alt, what is linked to it. */
const editScope = (s: Pick<TimelineState, 'clips' | 'tracks' | 'selectedIds' | 'soloSelect'>): string[] =>
  s.soloSelect ? [...s.selectedIds] : linkedIds(s.clips, s.selectedIds, s.tracks);

const snapshot = (s: Doc): Doc => ({ clips: s.clips, tracks: s.tracks, canvas: s.canvas, background: s.background });

// Editor clipboard (session-local). Each entry remembers the kind of track the
// clip lived on, so paste can land it correctly even if that track is gone.
let clipboard: Array<{ clip: Clip; kind: TrackKind }> = [];

export const useTimelineStore = create<TimelineState>((set, get) => ({
  tracks: makeDefaultTracks(),
  clips: [],
  canvas: { width: 1920, height: 1080 },
  fps: 30,
  background: DEFAULT_BACKGROUND,
  canvasUserSet: false,
  drawMode: false,
  brush: { color: '#ff2d55', width: 8 },
  playhead: 0,
  playing: false,
  shuttle: 1,
  selectedIds: [],
  soloSelect: false,
  pxPerSec: DEFAULT_PX_PER_SEC,
  past: [],
  future: [],
  cutPreview: null,

  pushHistory: () => set((s) => ({ past: [...s.past, snapshot(s)].slice(-100), future: [] })),

  setCutPreview: (ranges) => set({ cutPreview: ranges }),

  commitClips: (clips, tracks) => {
    get().pushHistory();
    // A planner that cut a linked pair into pieces leaves every piece with the
    // pair's link; pair them up again piece by piece.
    const next = relinkPieces(clips);
    set((s) => ({
      clips: next,
      tracks: tracks ?? s.tracks,
      selectedIds: s.selectedIds.filter((id) => next.some((c) => c.id === id)),
      playhead: Math.min(s.playhead, timelineDuration(next)),
    }));
  },

  undo: () =>
    set((s) => {
      if (s.past.length === 0) return {};
      const prev = s.past[s.past.length - 1];
      const sel = s.selectedIds.filter((id) => prev.clips.some((c) => c.id === id));
      return { ...prev, past: s.past.slice(0, -1), future: [snapshot(s), ...s.future].slice(0, 100), selectedIds: sel, playing: false };
    }),

  redo: () =>
    set((s) => {
      if (s.future.length === 0) return {};
      const next = s.future[0];
      const sel = s.selectedIds.filter((id) => next.clips.some((c) => c.id === id));
      return { ...next, past: [...s.past, snapshot(s)].slice(-100), future: s.future.slice(1), selectedIds: sel, playing: false };
    }),

  addMedia: async (media, opts) => {
    const info = await probeMedia(media);
    ensureProxy(media, info.width, info.height);
    const kind: TrackKind = media.kind === 'audio' ? 'audio' : 'video';
    const id = uid('c');
    const split = media.kind === 'video' && info.hasAudio === true && (opts?.separateAudio ?? separateAudioDefault());
    get().pushHistory();
    set((s) => {
      // Land on the first track of the right kind; create one if none exists
      // (e.g. an mp3 always goes to an audio track like A1).
      let tracks = s.tracks;
      let track = tracks.find((t) => t.kind === kind);
      if (!track) {
        track = { id: uid('tr'), kind, name: (kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'T') + '1' };
        tracks = [...tracks, track];
      }
      const end = s.clips
        .filter((c) => c.trackId === track!.id)
        .reduce((m, c) => Math.max(m, c.start + c.duration), 0);
      const link = split ? uid('l') : undefined;
      const clip = newMediaClip({ id, mediaId: media.id, trackId: track.id, start: end, duration: info.duration, sourceWidth: info.width, sourceHeight: info.height, ...(link ? { link, muted: true } : {}) });
      const added: Clip[] = [clip];
      if (link) {
        const lane = freeTrack(tracks, s.clips, 'audio', end, end + info.duration);
        tracks = lane.tracks;
        added.push(soundOf(clip, lane.track.id, link));
      }
      // Auto-size the canvas from the first visual clip, until the user picks one.
      const videoTrackIds = new Set(tracks.filter((t) => t.kind === 'video').map((t) => t.id));
      const hadVisual = s.clips.some((c) => c.type === 'media' && videoTrackIds.has(c.trackId));
      const canvas =
        !s.canvasUserSet && kind === 'video' && info.width > 0 && info.height > 0 && !hadVisual
          ? fitCanvas(info.width, info.height)
          : s.canvas;
      return { tracks, clips: [...s.clips, ...added], selectedIds: [id], soloSelect: false, canvas };
    });
    return id;
  },

  addText: () => {
    get().pushHistory();
    set((s) => {
      const track = s.tracks.find((t) => t.kind === 'text') ?? s.tracks[0];
      const clip: TextClip = {
        type: 'text',
        id: uid('t'),
        trackId: track.id,
        start: Math.max(0, s.playhead),
        duration: 3,
        fadeIn: 0,
        fadeOut: 0,
        text: 'Your text',
        fontSize: 80,
        fontFamily: FONTS[0].value,
        color: '#ffffff',
        bold: true,
        italic: false,
        outlineWidth: 0,
        outlineColor: '#000000',
        glow: 0,
        glowColor: '#a855f7',
        bgStyle: 'none',
        bgColor: '#000000',
        bgOpacity: 0.6,
        bgRadius: 10,
        bgPadding: 16,
        align: 'center',
        x: 0.5,
        y: 0.82,
        animIn: 'none',
        animOut: 'none',
        keyframes: [],
      };
      return { clips: [...s.clips, clip], selectedIds: [clip.id] };
    });
  },

  addShape: (shape) => {
    get().pushHistory();
    set((s) => {
      let tracks = s.tracks;
      let track = tracks.find((t) => t.kind === 'text');
      if (!track) {
        track = { id: uid('tr'), kind: 'text', name: 'T1' };
        tracks = [...tracks, track];
      }
      const clip: ShapeClip = {
        type: 'shape',
        id: uid('s'),
        trackId: track.id,
        start: Math.max(0, s.playhead),
        duration: 3,
        fadeIn: 0,
        fadeOut: 0,
        shape,
        fill: shape === 'line' ? '' : '#7c5cff',
        stroke: shape === 'line' ? '#ffffff' : '',
        strokeWidth: shape === 'line' ? 10 : 0,
        opacity: 1,
        x: 0.5,
        y: 0.5,
        w: 0.3,
        h: shape === 'line' ? 0.012 : 0.3,
        rotation: 0,
        animIn: 'none',
        animOut: 'none',
        keyframes: [],
      };
      return { tracks, clips: [...s.clips, clip], selectedIds: [clip.id] };
    });
  },

  addSticker: (emoji) => {
    get().pushHistory();
    set((s) => {
      let tracks = s.tracks;
      let track = tracks.find((t) => t.kind === 'text');
      if (!track) {
        track = { id: uid('tr'), kind: 'text', name: 'T1' };
        tracks = [...tracks, track];
      }
      const clip: TextClip = {
        type: 'text',
        id: uid('t'),
        trackId: track.id,
        start: Math.max(0, s.playhead),
        duration: 3,
        fadeIn: 0,
        fadeOut: 0,
        text: emoji,
        fontSize: 160,
        fontFamily: FONTS[1].value,
        color: '#ffffff',
        bold: false,
        italic: false,
        outlineWidth: 0,
        outlineColor: '#000000',
        glow: 0,
        glowColor: '#a855f7',
        bgStyle: 'none',
        bgColor: '#000000',
        bgOpacity: 0.6,
        bgRadius: 10,
        bgPadding: 16,
        align: 'center',
        x: 0.5,
        y: 0.5,
        animIn: 'pop',
        animOut: 'none',
        keyframes: [],
      };
      return { tracks, clips: [...s.clips, clip], selectedIds: [clip.id] };
    });
  },

  addStroke: (clipId, stroke) => {
    const existing = clipId ? get().clips.find((c) => c.id === clipId) : undefined;
    get().pushHistory();
    if (existing && existing.type === 'draw') {
      const draw = existing;
      set((s) => ({ clips: s.clips.map((c) => (c.id === draw.id ? { ...draw, strokes: [...draw.strokes, stroke] } : c)) }));
      return draw.id;
    }
    const id = uid('d');
    set((s) => {
      let tracks = s.tracks;
      let track = tracks.find((t) => t.kind === 'text');
      if (!track) {
        track = { id: uid('tr'), kind: 'text', name: 'T1' };
        tracks = [...tracks, track];
      }
      const clip: DrawClip = {
        type: 'draw',
        id,
        trackId: track.id,
        start: Math.max(0, s.playhead),
        duration: 5,
        fadeIn: 0,
        fadeOut: 0,
        strokes: [stroke],
        opacity: 1,
        x: 0,
        y: 0,
        animIn: 'none',
        animOut: 'none',
        keyframes: [],
      };
      return { tracks, clips: [...s.clips, clip], selectedIds: [id] };
    });
    return id;
  },

  setDrawMode: (on) => set({ drawMode: on }),
  setBrush: (patch) => set((s) => ({ brush: { ...s.brush, ...patch } })),

  addTrack: (kind) => {
    get().pushHistory();
    set((s) => {
      const count = s.tracks.filter((t) => t.kind === kind).length;
      const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'T';
      const track: Track = { id: uid('tr'), kind, name: `${prefix}${count + 1}` };
      return { tracks: [...s.tracks, track] };
    });
  },

  removeTrack: (id) => {
    get().pushHistory();
    set((s) => {
      const clips = s.clips.filter((c) => c.trackId !== id);
      const tracks = s.tracks.filter((t) => t.id !== id);
      const selectedIds = s.selectedIds.filter((id) => clips.some((c) => c.id === id));
      return { tracks, clips, selectedIds };
    });
  },

  updateTrack: (id, patch) => {
    get().pushHistory();
    set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  },

  duplicateClip: (id) => {
    const s0 = get();
    if (!s0.clips.some((x) => x.id === id)) return;
    get().pushHistory();
    set((s) => {
      // A linked pair is copied as a pair, right after itself.
      const ids = new Set(s.soloSelect && s.selectedIds.includes(id) ? [id] : linkedIds(s.clips, [id], s.tracks));
      const group = s.clips.filter((x) => ids.has(x.id));
      if (group.length === 0) return {};
      const from = Math.min(...group.map((x) => x.start));
      const span = Math.max(...group.map((x) => x.start + x.duration)) - from;
      const link = group.length > 1 ? uid('l') : undefined;
      let primary = '';
      const copies = group.map((c): Clip => {
        const copy: Clip = {
          ...c,
          id: c.type === 'text' ? uid('t') : uid('c'),
          start: c.start + span,
          keyframes: c.keyframes.map((k) => ({ ...k, id: uid('k') })),
          // A copy is more of the same chapter, not the start of another.
          chapter: undefined,
          link,
        };
        if (c.id === id) primary = copy.id;
        return copy;
      });
      return { clips: [...s.clips, ...copies], selectedIds: [primary] };
    });
  },

  detachAudio: (id) => {
    const c0 = get().clips.find((x) => x.id === id);
    if (!c0 || c0.type !== 'media') return;
    const audioLanes = new Set(get().tracks.filter((t) => t.kind === 'audio').map((t) => t.id));
    // Its sound is already a clip of its own.
    if (linkPartners(get().clips, c0).some((x) => audioLanes.has(x.trackId))) return;
    get().pushHistory();
    set((s) => {
      const c = s.clips.find((x) => x.id === id);
      if (!c || c.type !== 'media') return {};
      const lane = freeTrack(s.tracks, s.clips, 'audio', c.start, c.start + c.duration);
      const link = c.link ?? uid('l');
      // The sound as a clip on an audio track, linked to the picture; the
      // picture is muted so the sound isn't heard twice.
      const audio = soundOf({ ...c, muted: false }, lane.track.id, link);
      const clips = s.clips.map((x) => (x.id === id ? { ...x, muted: true, link } : x));
      return { tracks: lane.tracks, clips: [...clips, audio], selectedIds: [audio.id], soloSelect: false };
    });
  },

  linkSelected: () => {
    const s0 = get();
    const sel = s0.clips.filter((c) => s0.selectedIds.includes(c.id));
    if (sel.length < 2 || new Set(sel.map((c) => c.trackId)).size !== sel.length) return;
    // A clip that already belongs with another is unlinked first, or its partner would be left behind.
    if (sel.some((c) => linkPartners(s0.clips, c).length > 0)) return;
    get().pushHistory();
    const link = uid('l');
    const ids = new Set(sel.map((c) => c.id));
    set((s) => ({ clips: s.clips.map((c) => (ids.has(c.id) ? { ...c, link } : c)), soloSelect: false }));
  },

  unlinkSelected: () => {
    const s0 = get();
    const ids = new Set(linkedIds(s0.clips, s0.selectedIds));
    if (!s0.clips.some((c) => ids.has(c.id) && c.link)) return;
    get().pushHistory();
    set((s) => ({ clips: s.clips.map((c) => (ids.has(c.id) && c.link ? withoutLink(c) : c)) }));
  },

  removeClip: (id) => {
    get().pushHistory();
    set((s) => ({
      clips: s.clips.filter((c) => c.id !== id),
      selectedIds: s.selectedIds.filter((x) => x !== id),
    }));
  },

  removeSelected: () => {
    const s0 = get();
    if (s0.selectedIds.length === 0) return;
    get().pushHistory();
    set((s) => {
      const sel = new Set(editScope(s));
      return { clips: s.clips.filter((c) => !sel.has(c.id)), selectedIds: [] };
    });
  },

  rippleDeleteSelected: () => {
    const s0 = get();
    if (s0.selectedIds.length === 0) return;
    get().pushHistory();
    set((s) => {
      const sel = new Set(editScope(s));
      // Merged removed intervals per track; survivors slide left by however
      // much removed time lies before their start.
      const byTrack = new Map<string, Array<[number, number]>>();
      for (const c of s.clips) {
        if (!sel.has(c.id)) continue;
        const arr = byTrack.get(c.trackId) ?? [];
        arr.push([c.start, c.start + c.duration]);
        byTrack.set(c.trackId, arr);
      }
      for (const [trackId, ivs] of byTrack) {
        ivs.sort((a, b) => a[0] - b[0]);
        const merged: Array<[number, number]> = [];
        for (const iv of ivs) {
          const last = merged[merged.length - 1];
          if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
          else merged.push([...iv]);
        }
        byTrack.set(trackId, merged);
      }
      const clips = s.clips
        .filter((c) => !sel.has(c.id))
        .map((c) => {
          const ivs = byTrack.get(c.trackId);
          if (!ivs) return c;
          let shift = 0;
          for (const [a, b] of ivs) shift += Math.max(0, Math.min(b, c.start) - a);
          return shift > 0 ? { ...c, start: c.start - shift } : c;
        });
      return { clips, selectedIds: [] };
    });
  },

  closeGapBefore: (id) => {
    const s0 = get();
    const clip = s0.clips.find((c) => c.id === id);
    if (!clip) return;
    const prevEnd = s0.clips
      .filter((c) => c.trackId === clip.trackId && c.id !== id && c.start + c.duration <= clip.start + 1e-6)
      .reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    const gap = clip.start - prevEnd;
    if (gap <= 1e-6) return;
    get().pushHistory();
    set((s) => {
      // Everything from this clip on slides left, and so does whatever is
      // linked to those clips on other tracks, or their sound would stay behind.
      const onTrack = s.clips.filter((c) => c.trackId === clip.trackId && c.start >= clip.start - 1e-6).map((c) => c.id);
      const ids = new Set(s.soloSelect ? onTrack : linkedIds(s.clips, onTrack, s.tracks));
      return { clips: s.clips.map((c) => (ids.has(c.id) ? { ...c, start: Math.max(0, c.start - gap) } : c)) };
    });
  },

  copySelected: () => {
    const s = get();
    const kindOf = new Map(s.tracks.map((t) => [t.id, t.kind] as const));
    const ids = new Set(editScope(s));
    clipboard = s.clips
      .filter((c) => ids.has(c.id))
      .map((clip) => ({ clip, kind: kindOf.get(clip.trackId) ?? (clip.type === 'media' ? 'video' : 'text') }));
    return clipboard.length;
  },

  cutSelected: () => {
    const n = get().copySelected();
    if (n > 0) get().removeSelected();
    return n;
  },

  paste: () => {
    if (clipboard.length === 0) return 0;
    get().pushHistory();
    const at = get().playhead;
    const minStart = Math.min(...clipboard.map((e) => e.clip.start));
    const pastedIds: string[] = [];
    set((s) => {
      let tracks = s.tracks;
      const trackFor = (e: { clip: Clip; kind: TrackKind }): string => {
        const orig = tracks.find((t) => t.id === e.clip.trackId);
        if (orig && orig.kind === e.kind) return orig.id;
        const existing = tracks.find((t) => t.kind === e.kind);
        if (existing) return existing.id;
        const made: Track = {
          id: uid('tr'),
          kind: e.kind,
          name: (e.kind === 'video' ? 'V' : e.kind === 'audio' ? 'A' : 'T') + (tracks.filter((t) => t.kind === e.kind).length + 1),
        };
        tracks = [...tracks, made];
        return made.id;
      };
      // Pairs that were copied together stay pairs, under links of their own.
      const shared = new Map<string, number>();
      for (const e of clipboard) if (e.clip.link) shared.set(e.clip.link, (shared.get(e.clip.link) ?? 0) + 1);
      const fresh = new Map<string, string>();
      const linkFor = (old: string | undefined): string | undefined => {
        if (!old || (shared.get(old) ?? 0) < 2) return undefined;
        if (!fresh.has(old)) fresh.set(old, uid('l'));
        return fresh.get(old);
      };
      const copies: Clip[] = clipboard.map((e) => {
        const id = uid(e.clip.type === 'text' ? 't' : 'c');
        pastedIds.push(id);
        return {
          ...e.clip,
          id,
          link: linkFor(e.clip.link),
          trackId: trackFor(e),
          start: Math.max(0, at + (e.clip.start - minStart)),
          keyframes: (e.clip.keyframes ?? []).map((k) => ({ ...k, id: uid('k') })),
        } as Clip;
      });
      return { tracks, clips: [...s.clips, ...copies], selectedIds: pastedIds, soloSelect: false };
    });
    return clipboard.length;
  },

  removeByMedia: (mediaId) => {
    get().pushHistory();
    set((s) => {
      const clips = s.clips.filter((c) => !(c.type === 'media' && c.mediaId === mediaId));
      const selectedIds = s.selectedIds.filter((id) => clips.some((c) => c.id === id));
      return { clips, selectedIds };
    });
  },

  selectClip: (id, additive = false, solo = false) =>
    set((s) => {
      if (id === null) return { selectedIds: [], soloSelect: false };
      if (!additive) return { selectedIds: [id], soloSelect: solo };
      const soloSelect = s.selectedIds.length > 0 ? s.soloSelect : solo;
      return s.selectedIds.includes(id)
        ? { selectedIds: s.selectedIds.filter((x) => x !== id), soloSelect }
        : { selectedIds: [...s.selectedIds, id], soloSelect };
    }),

  setSelection: (ids) => set({ selectedIds: ids, soloSelect: false }),

  updateSelected: (patch) =>
    set((s) => {
      const sel = new Set(s.selectedIds);
      return { clips: s.clips.map((c) => (sel.has(c.id) ? ({ ...c, ...patch } as Clip) : c)) };
    }),

  moveClip: (id, start, trackId) =>
    set((s) => {
      const clip = s.clips.find((c) => c.id === id);
      if (!clip) return {};
      const fromKind = s.tracks.find((t) => t.id === clip.trackId)?.kind;
      const toTrack = s.tracks.find((t) => t.id === trackId);
      const destId = toTrack && toTrack.kind === fromKind ? trackId : clip.trackId;
      return { clips: s.clips.map((c) => (c.id === id ? { ...c, start: Math.max(0, start), trackId: destId } : c)) };
    }),

  trimClipStart: (id, newStart, alone = false) =>
    set((s) => {
      const me = s.clips.find((c) => c.id === id);
      if (!me) return {};
      const group = alone ? [me] : s.clips.filter((c) => c.id === id || linkedIds(s.clips, [id], s.tracks).includes(c.id));
      // Linked clips keep their offset: all move by what the tightest one allows.
      const want = newStart - me.start;
      let delta = want;
      for (const c of group) {
        const d = headTrimmed(c, c.start + want).start - c.start;
        if (Math.abs(d) < Math.abs(delta)) delta = d;
      }
      const ids = new Set(group.map((c) => c.id));
      return { clips: s.clips.map((c) => (ids.has(c.id) ? headTrimmed(c, c.start + delta) : c)) };
    }),

  trimClipEnd: (id, newEnd, alone = false) =>
    set((s) => {
      const me = s.clips.find((c) => c.id === id);
      if (!me) return {};
      const group = alone ? [me] : s.clips.filter((c) => c.id === id || linkedIds(s.clips, [id], s.tracks).includes(c.id));
      const want = newEnd - (me.start + me.duration);
      let delta = want;
      for (const c of group) {
        const d = tailTrimmed(c, c.start + c.duration + want).duration - c.duration;
        if (Math.abs(d) < Math.abs(delta)) delta = d;
      }
      const ids = new Set(group.map((c) => c.id));
      return { clips: s.clips.map((c) => (ids.has(c.id) ? tailTrimmed(c, c.start + c.duration + delta) : c)) };
    }),

  splitSelectedAtPlayhead: () => {
    const s0 = get();
    const t = s0.playhead;
    const picked = new Set(s0.selectedIds);
    const sel = new Set(editScope(s0));
    const targets = s0.clips.filter((c) => sel.has(c.id) && t > c.start + MIN_CLIP && t < c.start + c.duration - MIN_CLIP);
    if (targets.length === 0) return;
    const ids = new Set(targets.map((c) => c.id));
    get().pushHistory();
    set((s) => {
      const next: Clip[] = [];
      const newSel: string[] = [];
      for (const c of s.clips) {
        if (!ids.has(c.id)) {
          next.push(c);
          continue;
        }
        const left = sliceClip(c, c.start, t, { keepId: true });
        const right = sliceClip(c, t, c.start + c.duration);
        next.push(left, right);
        if (picked.has(c.id)) newSel.push(right.id);
      }
      // The halves of a linked pair pair up again: left with left, right with right.
      return { clips: relinkPieces(next), selectedIds: newSel };
    });
  },

  updateClip: (id, patch) =>
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? ({ ...c, ...patch } as Clip) : c)) })),

  setKeyframe: (id, prop, t, value) =>
    set((s) => {
      const clips = s.clips.map((c) => {
        if (c.id !== id) return c;
        const ks = c.keyframes ?? [];
        // Keep the existing keyframe's easing when its value is edited in place.
        const prev = ks.find((k) => k.prop === prop && Math.abs(k.t - t) < KEY_EPS);
        const kept = ks.filter((k) => !(k.prop === prop && Math.abs(k.t - t) < KEY_EPS));
        return { ...c, keyframes: [...kept, { id: uid('k'), prop, t, value, ease: prev?.ease }] } as Clip;
      });
      return { clips: prop === 'speed' ? syncSpeed(clips, id, s.tracks) : clips };
    }),

  setKeyframeEase: (id, prop, t, ease) => {
    get().pushHistory();
    set((s) => {
      const clips = s.clips.map((c) => {
        if (c.id !== id) return c;
        return {
          ...c,
          keyframes: (c.keyframes ?? []).map((k) => (k.prop === prop && Math.abs(k.t - t) < KEY_EPS ? { ...k, ease } : k)),
        } as Clip;
      });
      return { clips: prop === 'speed' ? syncSpeed(clips, id, s.tracks) : clips };
    });
  },

  toggleKeyframe: (id, prop, t, value) => {
    get().pushHistory();
    set((s) => {
      const clips = s.clips.map((c) => {
        if (c.id !== id) return c;
        const ks = c.keyframes ?? [];
        const existing = ks.find((k) => k.prop === prop && Math.abs(k.t - t) < KEY_EPS);
        if (existing) return { ...c, keyframes: ks.filter((k) => k !== existing) } as Clip;
        return { ...c, keyframes: [...ks, { id: uid('k'), prop, t, value }] } as Clip;
      });
      return { clips: prop === 'speed' ? syncSpeed(clips, id, s.tracks) : clips };
    });
  },

  addClips: (incoming) => {
    if (incoming.length === 0) return;
    get().pushHistory();
    set((s) => {
      let tracks = s.tracks;
      if (incoming.some((c) => c.type === 'text') && !tracks.some((t) => t.kind === 'text')) {
        tracks = [...tracks, { id: uid('tr'), kind: 'text', name: 'T1' }];
      }
      return { tracks, clips: [...s.clips, ...incoming] };
    });
  },

  addCaptions: (segments, style) => {
    if (segments.length === 0) return;
    get().pushHistory();
    set((s) => {
      let tracks = s.tracks;
      let track = tracks.find((t) => t.kind === 'text');
      if (!track) {
        track = { id: uid('tr'), kind: 'text', name: 'T1' };
        tracks = [...tracks, track];
      }
      return { tracks, clips: [...s.clips, ...captionClipsFor(segments, style, track.id)] };
    });
  },

  freezeFrameAtPlayhead: () => {
    const s0 = get();
    const t = s0.playhead;
    const c = s0.clips.find(
      (x): x is MediaClip => s0.selectedIds.includes(x.id) && x.type === 'media' && t >= x.start && t < x.start + x.duration && x.freezeAt == null,
    );
    if (!c) return false;
    const FREEZE = 3;
    get().pushHistory();
    set((s) => {
      const src = clamp(sourceTimeAt(c, t), 0, Math.max(0, c.sourceDuration - 0.001));
      // The sound linked to this picture is cut at the same point and its
      // second half waits out the freeze with the picture's second half.
      const mates = new Set(s.soloSelect ? [] : linkedIds(s.clips, [c.id], s.tracks).filter((x) => x !== c.id));
      const rightLink = mates.size > 0 ? uid('l') : undefined;
      const lanes = new Set([c.trackId, ...s.clips.filter((x) => mates.has(x.id)).map((x) => x.trackId)]);
      const frozen: MediaClip = {
        ...c,
        id: uid('c'),
        start: t,
        duration: FREEZE,
        inPoint: src,
        freezeAt: src,
        muted: true,
        keyframes: [],
        transition: 'none',
        fadeIn: 0,
        fadeOut: 0,
        link: undefined,
      };
      const leftDur = t - c.start;
      const rightDur = c.duration - leftDur;
      const parts = splitKeyframes(c, leftDur);
      const pieces: Clip[] = [];
      if (leftDur > MIN_CLIP) pieces.push({ ...c, duration: leftDur, fadeOut: 0, keyframes: parts.left });
      pieces.push(frozen);
      if (rightDur > MIN_CLIP) {
        pieces.push({ ...c, id: uid('c'), start: t + FREEZE, inPoint: src, duration: rightDur, fadeIn: 0, keyframes: parts.right, transition: 'none', link: rightLink });
      }
      const clips: Clip[] = [];
      for (const x of s.clips) {
        if (x.id === c.id) {
          clips.push(...pieces);
          continue;
        }
        if (mates.has(x.id)) {
          const end = x.start + x.duration;
          if (t > x.start + MIN_CLIP && t < end - MIN_CLIP) {
            clips.push(sliceClip(x, x.start, t, { keepId: true }), { ...sliceClip(x, t, end), start: t + FREEZE, link: rightLink });
          } else if (x.start >= t - MIN_CLIP) clips.push({ ...x, start: x.start + FREEZE, link: rightLink });
          else clips.push(x);
          continue;
        }
        // Everything after the freeze point on the same track slides right.
        if (lanes.has(x.trackId) && x.start >= t - 1e-6) clips.push({ ...x, start: x.start + FREEZE });
        else clips.push(x);
      }
      return { clips, selectedIds: [frozen.id] };
    });
    return true;
  },

  applySpeedPreset: (id, preset) => {
    get().pushHistory();
    set((s) => ({
      clips: syncSpeed(s.clips.map((c) => {
        if (c.id !== id || c.type !== 'media') return c;
        const kept = (c.keyframes ?? []).filter((k) => k.prop !== 'speed');
        const def = SPEED_PRESETS.find((p) => p.value === preset);
        if (!def || def.points.length === 0) return { ...c, keyframes: kept };
        const keys: Keyframe[] = def.points.map(([f, v]) => ({ id: uid('k'), prop: 'speed', t: f * c.duration, value: v, ease: 'inout' }));
        const next: MediaClip = { ...c, keyframes: [...kept, ...keys] };
        // A curve that runs faster than realtime can exhaust the source early —
        // pull the clip end in so it never freezes on the last frame.
        return { ...next, duration: Math.min(next.duration, maxClipDuration(next)) };
      }), id, s.tracks),
    }));
  },

  moveKeyframes: (id, fromT, toT) =>
    set((s) => {
      const clips = s.clips.map((c) => {
        if (c.id !== id) return c;
        const to = clamp(toT, 0, c.duration);
        return {
          ...c,
          keyframes: (c.keyframes ?? []).map((k) => (Math.abs(k.t - fromT) < KEY_EPS ? { ...k, t: to } : k)),
        } as Clip;
      });
      return { clips: syncSpeed(clips, id, s.tracks) };
    }),

  deleteKeyframes: (id, atT) => {
    get().pushHistory();
    set((s) => {
      const clips = s.clips.map((c) => {
        if (c.id !== id) return c;
        return { ...c, keyframes: (c.keyframes ?? []).filter((k) => Math.abs(k.t - atT) >= KEY_EPS) } as Clip;
      });
      return { clips: syncSpeed(clips, id, s.tracks) };
    });
  },

  setSpeed: (id, speed) =>
    set((s) => {
      const sp = clamp(speed, MIN_SPEED, MAX_SPEED);
      // The sound linked to a picture (or the picture linked to a sound) changes speed with it.
      const ids = new Set(linkedIds(s.clips, [id], s.tracks));
      return {
        clips: s.clips.map((c) =>
          ids.has(c.id) && c.type === 'media' && c.freezeAt == null ? { ...c, speed: sp, duration: (c.duration * c.speed) / sp } : c,
        ),
      };
    }),

  setCanvas: (canvas) => {
    get().pushHistory();
    set({ canvas: exportDims(canvas), canvasUserSet: true });
  },

  setFps: (fps) => set({ fps: clamp(Math.round(fps), 1, 120) }),

  // History is pushed by callers per gesture (pointer-down) so a live color
  // picker drag doesn't create one undo step per pixel.
  setBackground: (patch) => set((s) => ({ background: { ...s.background, ...patch } })),

  loadDoc: (doc) =>
    set({
      clips: doc.clips,
      tracks: doc.tracks,
      canvas: doc.canvas,
      fps: doc.fps ?? 30,
      background: doc.background ?? DEFAULT_BACKGROUND,
      canvasUserSet: true,
      selectedIds: [],
      soloSelect: false,
      playhead: 0,
      playing: false,
      past: [],
      future: [],
    }),

  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  play: () => set({ playing: true, shuttle: 1 }),
  pause: () => set({ playing: false, shuttle: 1 }),
  shuttleBy: (dir) =>
    set((s) => {
      const same = s.playing && Math.sign(s.shuttle) === dir;
      return { playing: true, shuttle: same ? dir * Math.min(8, Math.abs(s.shuttle) * 2) : dir };
    }),
  setZoom: (pxPerSec) => set({ pxPerSec: clamp(pxPerSec, MIN_PX_PER_SEC, MAX_PX_PER_SEC) }),

  clear: () => set({ clips: [], selectedIds: [], playhead: 0, playing: false, past: [], future: [], cutPreview: null }),
}));

// ── Derived selectors (pure) ──────────────────────────────────────────────

// ── Linked clips (a video's picture and its sound) ────────────────────────

const SEPARATE_AUDIO_KEY = 'krypt.editor.separateAudio';

/** Whether a video added to the timeline gets its sound as a clip of its own (on unless turned off in Settings). */
export function separateAudioDefault(): boolean {
  try {
    return globalThis.localStorage?.getItem(SEPARATE_AUDIO_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setSeparateAudioDefault(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(SEPARATE_AUDIO_KEY, on ? '1' : '0');
  } catch {
    /* the choice just lasts for this session */
  }
}

/** The clips linked to this one (not itself). */
export function linkPartners(clips: Clip[], clip: Clip): Clip[] {
  return clip.link ? clips.filter((c) => c.link === clip.link && c.id !== clip.id) : [];
}

/**
 * The given clips plus everything linked to them, the given ones first. Pass
 * the tracks to leave out partners on a locked track: locking the audio track
 * is how the picture gets edited on its own for a while.
 */
export function linkedIds(clips: Clip[], ids: Iterable<string>, tracks?: Track[]): string[] {
  const out = [...new Set(ids)];
  const have = new Set(out);
  const links = new Set<string>();
  for (const c of clips) if (c.link && have.has(c.id)) links.add(c.link);
  if (links.size === 0) return out;
  const locked = new Set((tracks ?? []).filter((t) => t.locked).map((t) => t.id));
  for (const c of clips) if (c.link && links.has(c.link) && !have.has(c.id) && !locked.has(c.trackId)) out.push(c.id);
  return out;
}

function withoutLink<T extends Clip>(c: T): T {
  const { link: _link, ...rest } = c;
  return rest as T;
}

/**
 * A video clip's sound as a clip for an audio track: same file, same timing
 * (speed curve included), none of the picture's looks. Fades and the volume
 * curve go with the sound.
 */
export function soundOf(c: MediaClip, trackId: string, link: string): MediaClip {
  return {
    ...c,
    id: uid('c'),
    trackId,
    link,
    muted: false,
    keyframes: c.keyframes.filter((k) => k.prop === 'speed' || k.prop === 'volume').map((k) => ({ ...k, id: uid('k') })),
    transition: 'none',
    effect: 'none',
    chromaKey: false,
    bgRemove: false,
    animIn: undefined,
    animOut: undefined,
    motion: undefined,
    mask: undefined,
    lut: undefined,
    // One chapter marker and one scene membership per moment, and they stay with the picture.
    chapter: undefined,
    group: undefined,
  };
}

/**
 * The media clips a detector (pauses, speech, captions) can listen to. A
 * picture whose sound is a linked clip of its own is left out, so each stretch
 * of sound is heard once and where it really sits; `silent` names files known
 * to carry no audio at all.
 */
export function listenableClips(clips: Clip[], tracks: Track[], media: MediaFile[], silent: (mediaId: string) => boolean = () => false): MediaClip[] {
  const kind = new Map(media.map((m) => [m.id, m.kind] as const));
  const audioLanes = new Set(tracks.filter((t) => t.kind === 'audio').map((t) => t.id));
  const soundElsewhere = new Set<string>();
  for (const c of clips) if (c.type === 'media' && c.link && audioLanes.has(c.trackId)) soundElsewhere.add(`${c.link}|${c.mediaId}`);
  return clips.filter((c): c is MediaClip => {
    if (c.type !== 'media' || c.freezeAt != null) return false;
    const k = kind.get(c.mediaId);
    if ((k !== 'video' && k !== 'audio') || silent(c.mediaId)) return false;
    return !(c.muted && !!c.link && !audioLanes.has(c.trackId) && soundElsewhere.has(`${c.link}|${c.mediaId}`));
  });
}

/** The track most likely to hold the voice: the first one carrying a video's sound, else the first with any sound. */
export function voiceTrack(tracks: Track[], listenable: MediaClip[], media: MediaFile[]): Track | undefined {
  const kind = new Map(media.map((m) => [m.id, m.kind] as const));
  return (
    tracks.find((t) => t.kind !== 'text' && listenable.some((c) => c.trackId === t.id && kind.get(c.mediaId) === 'video')) ??
    tracks.find((t) => listenable.some((c) => c.trackId === t.id))
  );
}

/** A track of this kind with nothing between start and end; a new one when they are all taken there. */
export function freeTrack(tracks: Track[], clips: Clip[], kind: TrackKind, start: number, end: number): { tracks: Track[]; track: Track } {
  const busy = (id: string): boolean => clips.some((c) => c.trackId === id && c.start < end - 1e-6 && c.start + c.duration > start + 1e-6);
  const found = tracks.find((t) => t.kind === kind && !t.locked && !busy(t.id));
  if (found) return { tracks, track: found };
  const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'T';
  const track: Track = { id: uid('tr'), kind, name: `${prefix}${tracks.filter((t) => t.kind === kind).length + 1}` };
  return { tracks: [...tracks, track], track };
}

/**
 * Give the pieces of a cut-up linked pair links of their own. Splitting or
 * auto-cutting a picture and its sound leaves every piece carrying the pair's
 * link, which would make them all move as one; here each piece on the track
 * with the most pieces is paired with the piece it overlaps most on every
 * other track, and pieces left without a partner lose the link.
 */
export function relinkPieces(clips: Clip[]): Clip[] {
  const groups = new Map<string, Clip[]>();
  for (const c of clips) {
    if (!c.link) continue;
    const g = groups.get(c.link);
    if (g) g.push(c);
    else groups.set(c.link, [c]);
  }
  const next = new Map<string, string | undefined>();
  for (const members of groups.values()) {
    if (members.length === 1) {
      next.set(members[0].id, undefined);
      continue;
    }
    const byTrack = new Map<string, Clip[]>();
    for (const m of members) {
      const lane = byTrack.get(m.trackId);
      if (lane) lane.push(m);
      else byTrack.set(m.trackId, [m]);
    }
    const lanes = [...byTrack.values()];
    if (lanes.every((l) => l.length === 1)) continue;
    for (const l of lanes) l.sort((a, b) => a.start - b.start);
    const anchor = lanes.reduce((a, b) => (b.length > a.length ? b : a));
    const taken = new Set<string>();
    anchor.forEach((piece, i) => {
      const link = i === 0 ? piece.link : uid('l');
      const end = piece.start + piece.duration;
      let paired = false;
      for (const lane of lanes) {
        if (lane === anchor) continue;
        let best: Clip | null = null;
        let bestOverlap = 1e-6;
        for (const other of lane) {
          if (taken.has(other.id)) continue;
          if (other.start >= end) break;
          const overlap = Math.min(end, other.start + other.duration) - Math.max(piece.start, other.start);
          if (overlap > bestOverlap) {
            best = other;
            bestOverlap = overlap;
          }
        }
        if (best) {
          taken.add(best.id);
          next.set(best.id, link);
          paired = true;
        }
      }
      next.set(piece.id, paired ? link : undefined);
    });
    for (const lane of lanes) {
      if (lane === anchor) continue;
      for (const other of lane) if (!taken.has(other.id)) next.set(other.id, undefined);
    }
  }
  if (next.size === 0) return clips;
  return clips.map((c) => {
    if (!next.has(c.id)) return c;
    const link = next.get(c.id);
    if (link === c.link) return c;
    return link ? { ...c, link } : withoutLink(c);
  });
}

/** A clip with its start moved to newStart (as far as its source and length allow), keyframes and in-point following. */
function headTrimmed<T extends Clip>(clip: T, newStart: number): T {
  const c: Clip = clip;
  const end = c.start + c.duration;
  const maxStart = end - MIN_CLIP;
  const minStart = c.type === 'media' ? Math.max(0, c.start - c.inPoint / speedAt(c, 0)) : 0;
  const start = clamp(newStart, minStart, maxStart);
  const delta = start - c.start;
  const keyframes = retimeKeyframesForHeadTrim(c, delta);
  // sourceTimeAt integrates the speed curve; for constant speed it's the
  // exact old formula inPoint + delta * speed.
  if (c.type === 'media') return { ...c, start, inPoint: Math.max(0, sourceTimeAt(c, c.start + delta)), duration: c.duration - delta, keyframes } as T;
  return { ...c, start, duration: c.duration - delta, keyframes } as T;
}

/** A clip with its end moved to newEnd (as far as its source and length allow). */
function tailTrimmed<T extends Clip>(clip: T, newEnd: number): T {
  const c: Clip = clip;
  if (c.type === 'media') return { ...c, duration: clamp(newEnd - c.start, MIN_CLIP, maxClipDuration(c)) } as T;
  return { ...c, duration: Math.max(MIN_CLIP, newEnd - c.start) } as T;
}

/**
 * Copy one clip's speed and speed curve onto the clips linked to it, so a
 * picture and its sound keep the same timing whichever of them was edited.
 */
function syncSpeed(clips: Clip[], id: string, tracks: Track[]): Clip[] {
  const from = clips.find((c) => c.id === id);
  if (!from || from.type !== 'media' || !from.link) return clips;
  const mates = new Set(linkedIds(clips, [id], tracks));
  mates.delete(id);
  if (mates.size === 0) return clips;
  const curve = from.keyframes.filter((k) => k.prop === 'speed');
  const sig = (c: MediaClip): string => `${c.speed}|${c.keyframes.filter((k) => k.prop === 'speed').map((k) => `${k.t}:${k.value}:${k.ease ?? ''}`).sort().join(',')}`;
  const want = sig(from);
  return clips.map((c) => {
    if (!mates.has(c.id) || c.type !== 'media' || c.freezeAt != null || sig(c) === want) return c;
    const mate: MediaClip = { ...c, speed: from.speed, keyframes: [...c.keyframes.filter((k) => k.prop !== 'speed'), ...curve.map((k) => ({ ...k, id: uid('k') }))] };
    return { ...mate, duration: Math.min(c.duration, maxClipDuration(mate)) };
  });
}

export function timelineDuration(clips: Clip[]): number {
  return clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
}

/** A media clip with every setting at its default: the whole file, centred, untouched. */
export function newMediaClip(over: Pick<MediaClip, 'mediaId' | 'trackId' | 'start' | 'duration'> & Partial<MediaClip>): MediaClip {
  return {
    type: 'media',
    id: uid('c'),
    inPoint: 0,
    sourceDuration: over.duration,
    sourceWidth: 0,
    sourceHeight: 0,
    speed: 1,
    volume: 1,
    muted: false,
    brightness: 100,
    contrast: 100,
    saturation: 100,
    effect: 'none',
    scaleX: 1,
    scaleY: 1,
    posX: 0,
    posY: 0,
    rotation: 0,
    opacity: 1,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0,
    cropLeft: 0,
    keyframes: [],
    transition: 'none',
    transitionDur: 0.5,
    chromaKey: false,
    chromaColor: '#00d800',
    chromaSimilarity: 0.4,
    chromaSmoothness: 0.1,
    bgRemove: false,
    fadeIn: 0,
    fadeOut: 0,
    ...over,
  };
}

// ── Chapters ───────────────────────────────────────────────────────────────
export interface Chapter {
  /** Timeline seconds. */
  time: number;
  title: string;
  /** The clip that carries the mark. */
  clipId: string;
}

/**
 * The video's chapters, in order. A chapter is a clip with `chapter` set and
 * begins where that clip starts. When a marked clip has been cut into pieces
 * (an auto edit, a split) every piece still carries the mark, so a run of the
 * same title counts once, at its first piece.
 */
export function chaptersOf(clips: Clip[]): Chapter[] {
  const marked = clips
    .filter((c) => typeof c.chapter === 'string' && c.chapter.trim() !== '')
    .map((c) => ({ time: c.start, title: c.chapter!.trim(), clipId: c.id }))
    .sort((a, b) => a.time - b.time);
  const out: Chapter[] = [];
  for (const m of marked) {
    const last = out[out.length - 1];
    if (last && (last.title === m.title || m.time - last.time < 1e-3)) continue;
    out.push(m);
  }
  return out;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** 0:00 / 12:34 / 1:02:03 — the form video sites read as a chapter timestamp. */
export function chapterStamp(seconds: number, hours: boolean): string {
  const s = Math.max(0, Math.floor(seconds + 1e-6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return hours ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/**
 * The chapter list as pasted into a video description: one "0:00 Title" per
 * line. Sites need the first line at 0:00, so a video whose first chapter
 * starts later gets an opening one (`opening`), and they ignore lists with
 * under three chapters or a chapter shorter than ten seconds: `problems` says
 * which of those apply.
 */
export function chapterList(clips: Clip[], opening = 'Intro'): { text: string; chapters: Chapter[]; problems: string[] } {
  const found = chaptersOf(clips);
  if (found.length === 0) return { text: '', chapters: [], problems: [] };
  const chapters = found[0].time > 0.5 ? [{ time: 0, title: opening, clipId: '' }, ...found] : found;
  const total = timelineDuration(clips);
  const hours = total >= 3600;
  const problems: string[] = [];
  if (chapters.length < 3) problems.push(`only ${chapters.length} chapter${chapters.length === 1 ? '' : 's'} (video sites want at least 3)`);
  chapters.forEach((c, i) => {
    const end = i + 1 < chapters.length ? chapters[i + 1].time : total;
    if (end - c.time < 10) problems.push(`"${c.title}" is under 10 seconds long`);
  });
  return { text: chapters.map((c) => `${chapterStamp(c.time, hours)} ${c.title}`).join('\n'), chapters, problems };
}

const KIND_ORDER: Record<TrackKind, number> = { text: 0, video: 1, audio: 2 };

/**
 * Tracks sorted for display AND compositing: text on top, then video, then
 * audio. Within the video group, newer tracks sit ON TOP — both visually in the
 * timeline and as the frontmost compositing layer — so a freshly added track
 * behaves like an overlay over the main (first) video track.
 */
export function orderedTracks(tracks: Track[]): Track[] {
  const idx = new Map(tracks.map((t, i) => [t.id, i] as const));
  return [...tracks].sort((a, b) => {
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (a.kind === 'video') return (idx.get(b.id) ?? 0) - (idx.get(a.id) ?? 0);
    return (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0);
  });
}

const SLIDE_FRAC = 0.07;
/** How far a fly animation starts from its resting place, in frame sizes (off-screen for anything centred). */
const FLY_FRAC = 1.15;
const ANIM_BLUR = 12; // px at the 1080 reference height
interface AnimPart {
  op: number;
  dx: number;
  dy: number;
  scale: number;
  rot: number;
  blur: number;
}
const IDENTITY: AnimPart = { op: 1, dx: 0, dy: 0, scale: 1, rot: 0, blur: 0 };
// easeOutBack — overshoot used by the bounce animation.
const backOut = (p: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

const animPart = (anim: TextAnim, p: number): AnimPart => {
  switch (anim) {
    case 'fade':
      return { ...IDENTITY, op: p };
    case 'slide':
      return { ...IDENTITY, op: p, dy: (1 - p) * SLIDE_FRAC };
    case 'slide-down':
      return { ...IDENTITY, op: p, dy: -(1 - p) * SLIDE_FRAC };
    case 'slide-left':
      return { ...IDENTITY, op: p, dx: (1 - p) * SLIDE_FRAC };
    case 'slide-right':
      return { ...IDENTITY, op: p, dx: -(1 - p) * SLIDE_FRAC };
    case 'pop':
      return { ...IDENTITY, op: p, scale: 0.55 + 0.45 * p };
    case 'zoom':
      return { ...IDENTITY, op: p, scale: 1.6 - 0.6 * p };
    case 'bounce':
      return { ...IDENTITY, op: Math.min(1, p * 2), scale: 0.3 + 0.7 * backOut(p) };
    case 'spin':
      return { ...IDENTITY, op: p, rot: (1 - p) * 180, scale: 0.6 + 0.4 * p };
    case 'blur':
      return { ...IDENTITY, op: p, blur: (1 - p) * ANIM_BLUR };
    case 'drop':
      // Falls in from above and settles with a small bounce.
      return { ...IDENTITY, op: Math.min(1, p * 3), dy: -(1 - backOut(p)) * 0.22 };
    case 'stomp':
      // Slams down from oversized: the "impact" title look.
      return { ...IDENTITY, op: Math.min(1, p * 4), scale: 1 + 1.4 * Math.pow(1 - p, 4) };
    case 'swing':
      return { ...IDENTITY, op: Math.min(1, p * 3), rot: 28 * (1 - p) * (1 - p) * Math.cos(p * Math.PI * 2.5) };
    case 'flicker':
      // A failing-neon stutter that locks on for the last fifth.
      return { ...IDENTITY, op: p >= 0.8 || Math.floor(p * 10) % 2 === 1 ? 1 : 0.12 };
    case 'fly-left':
      return { ...IDENTITY, dx: -FLY_FRAC * Math.pow(1 - p, 3) };
    case 'fly-right':
      return { ...IDENTITY, dx: FLY_FRAC * Math.pow(1 - p, 3) };
    case 'fly-top':
      return { ...IDENTITY, dy: -FLY_FRAC * Math.pow(1 - p, 3) };
    case 'fly-bottom':
      return { ...IDENTITY, dy: FLY_FRAC * Math.pow(1 - p, 3) };
    default:
      // 'none' and 'typewriter' contribute no transform (typewriter reveals text).
      return IDENTITY;
  }
};

/**
 * Whole-clip motion at clip-local time lt. A video or image usually fills the
 * frame, so the moves that would uncover its edges (pans, shake) also scale it
 * up by just enough to keep them out of shot; overlays only drift.
 */
function motionPart(motion: MotionAnim | undefined, amount: number, lt: number, dur: number, media: boolean): AnimPart {
  if (!motion || motion === 'none') return IDENTITY;
  const a = clamp(amount, 0.2, 3);
  const r = dur > 0 ? clamp(lt / dur, 0, 1) : 0;
  const travel = (media ? 0.05 : 0.03) * a;
  const cover = media ? 1 + travel * 2.4 : 1;
  switch (motion) {
    case 'zoom-in':
      return { ...IDENTITY, scale: 1 + 0.12 * a * r };
    case 'zoom-out':
      return { ...IDENTITY, scale: 1 + 0.12 * a * (1 - r) };
    case 'pan-left':
      return { ...IDENTITY, scale: cover, dx: travel * (1 - 2 * r) };
    case 'pan-right':
      return { ...IDENTITY, scale: cover, dx: travel * (2 * r - 1) };
    case 'pan-up':
      return { ...IDENTITY, scale: cover, dy: travel * (1 - 2 * r) };
    case 'pan-down':
      return { ...IDENTITY, scale: cover, dy: travel * (2 * r - 1) };
    case 'pulse': {
      // A beat every 0.6s: quick hit, exponential settle.
      const phase = (lt % 0.6) / 0.6;
      return { ...IDENTITY, scale: 1 + 0.06 * a * Math.exp(-6 * phase) };
    }
    case 'float':
      return { ...IDENTITY, dy: 0.012 * a * Math.sin((lt * Math.PI * 2) / 3) };
    case 'shake': {
      // Two detuned sines per axis read as hand-held jitter and stay deterministic.
      const k = 0.006 * a;
      return {
        ...IDENTITY,
        scale: media ? 1 + 0.035 * a : 1,
        dx: k * (Math.sin(lt * 37) + Math.sin(lt * 53.3 + 1.3)),
        dy: k * (Math.sin(lt * 41.7 + 0.5) + Math.sin(lt * 29.1 + 2.1)),
        rot: 0.5 * a * Math.sin(lt * 33.3 + 0.7),
      };
    }
    case 'wiggle':
      return { ...IDENTITY, rot: 3 * a * Math.sin(lt * Math.PI * 4) };
    default:
      return IDENTITY;
  }
}

/** A clip's own in/out length: the 0.5s default, or its override held inside the clip. */
const animLen = (override: number | undefined, duration: number): number => (override && override > 0 ? clamp(override, 0.05, Math.max(0.05, duration)) : ANIM_DUR);

/** True when a clip animates on its own (in / out / motion), keyframes aside. */
export function hasClipAnim(clip: Clip): boolean {
  return (!!clip.animIn && clip.animIn !== 'none') || (!!clip.animOut && clip.animOut !== 'none') || (!!clip.motion && clip.motion !== 'none');
}

/** In / out animation and whole-clip motion at time t — every clip type, preview and export. */
export function textAnim(
  clip: { type?: Clip['type']; start: number; duration: number; animIn?: TextAnim; animOut?: TextAnim; animInDur?: number; animOutDur?: number; motion?: MotionAnim; motionAmount?: number },
  t: number,
): { opacity: number; dxFrac: number; dyFrac: number; scale: number; rotate: number; blur: number } {
  const inP = clamp((t - clip.start) / animLen(clip.animInDur, clip.duration), 0, 1);
  const outP = clamp((clip.start + clip.duration - t) / animLen(clip.animOutDur, clip.duration), 0, 1);
  const a = animPart(clip.animIn ?? 'none', inP);
  const b = animPart(clip.animOut ?? 'none', outP);
  const m = motionPart(clip.motion, clip.motionAmount ?? 1, t - clip.start, clip.duration, clip.type === 'media');
  return {
    opacity: a.op * b.op * m.op,
    dxFrac: a.dx + b.dx + m.dx,
    dyFrac: a.dy + b.dy + m.dy,
    scale: a.scale * b.scale * m.scale,
    rotate: a.rot + b.rot + m.rot,
    blur: a.blur + b.blur + m.blur,
  };
}

/**
 * The visible text at time t — the same as clip.text except for the typewriter
 * in-animation, which reveals characters over the clip's first stretch.
 */
export function visibleText(clip: TextClip, t: number): string {
  if (clip.animIn !== 'typewriter') return clip.text;
  const len = clip.text.length;
  if (len === 0) return clip.text;
  const revealDur = clamp(len * 0.05, 0.4, Math.max(0.4, clip.duration * 0.7));
  const p = clamp((t - clip.start) / revealDur, 0, 1);
  return clip.text.slice(0, Math.ceil(p * len));
}

/**
 * The 'cascade' entrance: the words come up one after another, each rising a
 * little as it fades in. How far along the entrance is at time t (0..1), or
 * null when the clip is not in one (another animation, or every word has landed).
 */
export function cascadeProgress(clip: TextClip, t: number): number | null {
  if (clip.animIn !== 'cascade') return null;
  const p = (t - clip.start) / animLen(clip.animInDur, clip.duration);
  return p >= 1 ? null : clamp(p, 0, 1);
}

/** Word `i` of `n` at entrance progress p: its opacity, and how far below its place it still is, in ems. */
export function cascadeWord(p: number, i: number, n: number): { op: number; dy: number } {
  // Each word starts half a word's time after the one before it.
  const each = 1 / (1 + 0.5 * Math.max(0, n - 1));
  const q = clamp((p - i * each * 0.5) / each, 0, 1);
  const e = 1 - Math.pow(1 - q, 3);
  return { op: e, dy: (1 - e) * 0.45 };
}

// ── Keyframe evaluation ───────────────────────────────────────────────────
/** Interpolated value of a property at clip-local time lt, or base if no keys. */
function keyAt(clip: Clip, prop: string, lt: number, base: number): number {
  const f = (clip.keyframes ?? []).filter((k) => k.prop === prop).sort((a, b) => a.t - b.t);
  if (f.length === 0) return base;
  if (lt <= f[0].t) return f[0].value;
  if (lt >= f[f.length - 1].t) return f[f.length - 1].value;
  for (let i = 0; i < f.length - 1; i++) {
    const a = f[i];
    const b = f[i + 1];
    if (lt >= a.t && lt <= b.t) {
      const r = b.t === a.t ? 0 : (lt - a.t) / (b.t - a.t);
      return a.value + (b.value - a.value) * easeProgress(b.ease, r);
    }
  }
  return base;
}

/**
 * Shift a clip's keyframes by -delta (head trim moves the clip start under
 * them). Keys that fall off the front are replaced by one boundary key at 0
 * sampled from the original motion, so the animation doesn't jump.
 */
export function retimeKeyframesForHeadTrim(clip: Clip, delta: number): Keyframe[] {
  const ks = clip.keyframes ?? [];
  if (ks.length === 0 || delta === 0) return ks;
  const out: Keyframe[] = [];
  for (const prop of new Set(ks.map((k) => k.prop))) {
    const mine = ks.filter((k) => k.prop === prop);
    const kept = mine.filter((k) => k.t - delta > KEY_EPS).map((k) => ({ ...k, t: k.t - delta }));
    if (kept.length < mine.length) out.push({ id: uid('k'), prop, t: 0, value: keyAt(clip, prop, delta, 0) });
    out.push(...kept);
  }
  return out;
}

/**
 * Partition a clip's keyframes across a cut at clip-local time `cut`: the left
 * half keeps the keys before it, the right half gets the later keys rebased to
 * 0, and any motion crossing the cut gets a sampled boundary key on both sides
 * so a split leaves the animation looking identical.
 */
export function splitKeyframes(clip: Clip, cut: number): { left: Keyframe[]; right: Keyframe[] } {
  const ks = clip.keyframes ?? [];
  const left: Keyframe[] = [];
  const right: Keyframe[] = [];
  for (const prop of new Set(ks.map((k) => k.prop))) {
    const mine = ks.filter((k) => k.prop === prop);
    const before = mine.filter((k) => k.t < cut - KEY_EPS);
    const after = mine.filter((k) => k.t > cut + KEY_EPS);
    const atCut = mine.length - before.length - after.length;
    const boundary = keyAt(clip, prop, cut, 0);
    left.push(...before);
    // Without keys past the cut the evaluator already clamps, so a boundary
    // key is only needed when motion actually reaches/crosses the cut.
    if (after.length > 0 || atCut > 0) left.push({ id: uid('k'), prop, t: cut, value: boundary });
    if (before.length > 0 || atCut > 0) right.push({ id: uid('k'), prop, t: 0, value: boundary });
    right.push(...after.map((k) => ({ ...k, id: uid('k'), t: k.t - cut })));
  }
  return { left, right };
}

/**
 * The part of a clip between timeline times a..b (clamped to the clip) as a
 * clip of its own: source in-point advanced, keyframes cut and rebased so the
 * motion is unchanged, caption word timings rebased, and fades / the in
 * transition kept only on the edges the slice still touches. Split and the
 * auto-edit planner both build their pieces with this so they can't drift.
 */
export function sliceClip<T extends Clip>(clip: T, a: number, b: number, opts: { keepId?: boolean } = {}): T {
  const clipEnd = clip.start + clip.duration;
  const start = Math.min(Math.max(clip.start, a), clipEnd);
  const end = Math.max(start, Math.min(clipEnd, b));
  const head = start - clip.start; // clip-local cut points
  const tail = end - clip.start;
  const isHead = head <= 1e-6;
  const isTail = clip.duration - tail <= 1e-6;
  let keyframes = clip.keyframes ?? [];
  if (!isTail) keyframes = splitKeyframes({ ...clip, keyframes }, tail).left;
  if (!isHead) keyframes = splitKeyframes({ ...clip, keyframes }, head).right;
  const piece: T = {
    ...clip,
    id: opts.keepId ? clip.id : uid(clip.type === 'media' ? 'c' : 't'),
    start,
    duration: end - start,
    fadeIn: isHead ? clip.fadeIn : 0,
    fadeOut: isTail ? clip.fadeOut : 0,
    keyframes,
  };
  const src: Clip = clip;
  const p: Clip = piece;
  if (src.type === 'media' && p.type === 'media') {
    p.inPoint = sourceTimeAt(src, start);
    if (!isHead) {
      p.transition = 'none';
      p.animIn = undefined;
    }
    if (!isTail) p.animOut = undefined;
  } else if (p.type === 'text' && p.words && !isHead) {
    p.words = p.words.map((w) => ({ ...w, start: w.start - head, end: w.end - head }));
  }
  return piece;
}

export function clipHasKeys(clip: Clip, prop: string): boolean {
  return !!clip.keyframes?.some((k) => k.prop === prop);
}

export function keyframeAt(clip: Clip, prop: string, lt: number): Keyframe | undefined {
  return clip.keyframes?.find((k) => k.prop === prop && Math.abs(k.t - lt) < KEY_EPS);
}

/** The value a keyframed property resolves to at timeline time t. */
export function resolvedValue(clip: Clip, prop: string, t: number, base: number): number {
  return keyAt(clip, prop, t - clip.start, base);
}

/** Effective opacity at time t: the clip's base opacity, animated by keyframes. */
export function keyOpacity(clip: Clip, t: number): number {
  return keyAt(clip, 'opacity', t - clip.start, clip.opacity ?? 1);
}

// ── Variable speed (time remapping) ───────────────────────────────────────
/** Bounds for keyframed speed (wider than the constant slider's 0.25–4). */
export const MIN_KEY_SPEED = 0.1;
export const MAX_KEY_SPEED = 8;

/** CapCut-style velocity presets, as (fraction-of-duration, speed) points. */
export const SPEED_PRESETS: Array<{ label: string; value: string; points: Array<[number, number]> }> = [
  { label: 'Constant', value: 'none', points: [] },
  { label: 'Montage', value: 'montage', points: [[0, 1], [0.35, 2.6], [0.5, 0.45], [0.7, 1.6], [1, 1]] },
  { label: 'Hero', value: 'hero', points: [[0, 1.8], [0.45, 3.2], [0.55, 0.25], [0.8, 0.5], [1, 1.5]] },
  { label: 'Bullet', value: 'bullet', points: [[0, 1], [0.3, 3.5], [0.5, 0.15], [0.7, 3.5], [1, 1]] },
  { label: 'Jump cut', value: 'jump', points: [[0, 3], [0.5, 0.5], [1, 3]] },
];

export function hasSpeedKeys(clip: Clip): boolean {
  return clip.type === 'media' && !!clip.keyframes?.some((k) => k.prop === 'speed');
}

/** Playback rate at clip-local time lt (constant clip.speed when un-keyed). */
export function speedAt(clip: MediaClip, lt: number): number {
  return clamp(keyAt(clip, 'speed', lt, clip.speed), MIN_KEY_SPEED, MAX_KEY_SPEED);
}

// Source-time mapping: sourceTime(lt) = inPoint + ∫₀^lt speed. The integral of
// eased piecewise segments has no closed form worth maintaining, so it's a
// sampled cumulative table, cached per (clip id, speed signature).
const SPEED_TABLE_HZ = 120;
const speedTableCache = new Map<string, { sig: string; table: Float64Array }>();

function speedSignature(clip: MediaClip): string {
  const keys = (clip.keyframes ?? [])
    .filter((k) => k.prop === 'speed')
    .sort((a, b) => a.t - b.t)
    .map((k) => `${k.t}:${k.value}:${k.ease ?? ''}`)
    .join(',');
  return `${clip.speed}|${clip.inPoint}|${clip.duration}|${keys}`;
}

function speedTable(clip: MediaClip): Float64Array {
  const sig = speedSignature(clip);
  const hit = speedTableCache.get(clip.id);
  if (hit && hit.sig === sig) return hit.table;
  const n = Math.max(2, Math.ceil(clip.duration * SPEED_TABLE_HZ) + 1);
  const dt = clip.duration / (n - 1);
  const table = new Float64Array(n);
  let acc = 0;
  let prev = speedAt(clip, 0);
  table[0] = 0;
  for (let i = 1; i < n; i++) {
    const s = speedAt(clip, i * dt);
    acc += ((prev + s) / 2) * dt; // trapezoid
    table[i] = acc;
    prev = s;
  }
  speedTableCache.set(clip.id, { sig, table });
  return table;
}

/**
 * Source time for a media clip at timeline time t. Constant-speed clips use
 * the exact closed form; speed-keyed clips integrate the curve.
 */
export function sourceTimeAt(clip: MediaClip, t: number): number {
  if (clip.freezeAt != null) return clip.freezeAt;
  const lt = t - clip.start;
  if (!hasSpeedKeys(clip)) return clip.inPoint + lt * clip.speed;
  if (lt <= 0) return clip.inPoint + lt * speedAt(clip, 0); // extrapolate for head-extend
  const table = speedTable(clip);
  const pos = Math.min(lt / Math.max(1e-9, clip.duration), 1) * (table.length - 1);
  const i = Math.floor(pos);
  const frac = pos - i;
  const integ = i + 1 < table.length ? table[i] + (table[i + 1] - table[i]) * frac : table[table.length - 1];
  return clip.inPoint + integ;
}

/** Longest duration before the clip's speed curve runs out of source media. */
export function maxClipDuration(clip: MediaClip): number {
  if (clip.freezeAt != null) return Number.POSITIVE_INFINITY; // one frame lasts forever
  if (!hasSpeedKeys(clip)) return (clip.sourceDuration - clip.inPoint) / clip.speed;
  const table = speedTable(clip);
  const budget = clip.sourceDuration - clip.inPoint;
  const consumed = table[table.length - 1];
  // Curve doesn't exhaust the source within the current length: the remainder
  // plays at the curve's final speed.
  if (consumed <= budget) return clip.duration + (budget - consumed) / speedAt(clip, clip.duration);
  const dt = clip.duration / (table.length - 1);
  for (let i = 1; i < table.length; i++) {
    if (table[i] > budget) {
      const over = (table[i] - budget) / Math.max(1e-9, table[i] - table[i - 1]);
      return (i - over) * dt;
    }
  }
  return clip.duration;
}

/** A clip with its animated transform/position applied at time t. */
export function withKeyframes<T extends Clip>(clip: T, t: number): T {
  if (!clip.keyframes || clip.keyframes.length === 0) return clip;
  const lt = t - clip.start;
  if (clip.type === 'media') {
    return {
      ...clip,
      posX: keyAt(clip, 'posX', lt, clip.posX),
      posY: keyAt(clip, 'posY', lt, clip.posY),
      scaleX: keyAt(clip, 'scaleX', lt, clip.scaleX),
      scaleY: keyAt(clip, 'scaleY', lt, clip.scaleY),
      rotation: keyAt(clip, 'rotation', lt, clip.rotation),
      tiltX: keyAt(clip, 'tiltX', lt, clip.tiltX ?? 0),
      tiltY: keyAt(clip, 'tiltY', lt, clip.tiltY ?? 0),
      // A moving crop: a wipe, a before / after slider (compare.ts).
      cropLeft: keyAt(clip, 'cropLeft', lt, clip.cropLeft),
      cropRight: keyAt(clip, 'cropRight', lt, clip.cropRight),
      cropTop: keyAt(clip, 'cropTop', lt, clip.cropTop),
      cropBottom: keyAt(clip, 'cropBottom', lt, clip.cropBottom),
    };
  }
  return { ...clip, x: keyAt(clip, 'x', lt, clip.x), y: keyAt(clip, 'y', lt, clip.y) };
}

// ── Transitions ───────────────────────────────────────────────────────────
export interface TransitionState {
  out: MediaClip | null;
  incoming: MediaClip;
  /** Progress 0..1 across the transition window. */
  p: number;
  type: TransitionType;
}

/** A reveal rectangle as the fraction hidden from each canvas edge (wipe). */
export interface TransReveal {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** How one side of a transition is drawn at progress p. */
export interface TransPart {
  op: number;
  /** Horizontal offset, fraction of canvas width. */
  dx: number;
  /** Extra scale multiplier. */
  scale: number;
  /** Blur radius, px at the 1080 reference height. */
  blur: number;
  reveal?: TransReveal;
  /** Vertical offset, fraction of canvas height. */
  dy?: number;
  /** Extra rotation, degrees. */
  rot?: number;
  /** White flash over the picture, 0..1. */
  flash?: number;
}

const TRANS_BLUR = 24; // px at the 1080 reference height
const flatPart = (op: number): TransPart => ({ op, dx: 0, scale: 1, blur: 0 });
const movePart = (dx: number, dy: number): TransPart => ({ op: 1, dx, dy, scale: 1, blur: 0 });
const revealPart = (reveal: TransReveal): TransPart => ({ op: 1, dx: 0, scale: 1, blur: 0, reveal });
/** Unit direction the picture travels in for each slide / push. */
const TRANS_DIR: Record<string, [number, number]> = {
  slide: [-1, 0],
  'slide-right': [1, 0],
  'slide-up': [0, -1],
  'slide-down': [0, 1],
  push: [-1, 0],
  'push-right': [1, 0],
  'push-up': [0, -1],
  'push-down': [0, 1],
};

/** How the incoming ('in') or outgoing ('out') clip is drawn at progress p. */
export function transitionPart(type: TransitionType, p: number, side: 'in' | 'out'): TransPart {
  const isIn = side === 'in';
  switch (type) {
    case 'dip':
      return flatPart(isIn ? Math.max(0, 2 * p - 1) : Math.max(0, 1 - 2 * p));
    case 'flash': {
      // A hard cut under a white flash that peaks at the midpoint.
      const flash = 1 - Math.abs(2 * p - 1);
      return { ...flatPart(isIn ? (p >= 0.5 ? 1 : 0) : p < 0.5 ? 1 : 0), flash };
    }
    case 'slide':
    case 'slide-right':
    case 'slide-up':
    case 'slide-down': {
      // Incoming slides over the outgoing clip, which holds underneath.
      const [ux, uy] = TRANS_DIR[type];
      return isIn ? movePart(-ux * (1 - p), -uy * (1 - p)) : flatPart(1);
    }
    case 'push':
    case 'push-right':
    case 'push-up':
    case 'push-down': {
      // Both move together — the incoming clip pushes the outgoing one out.
      const [ux, uy] = TRANS_DIR[type];
      return isIn ? movePart(-ux * (1 - p), -uy * (1 - p)) : movePart(ux * p, uy * p);
    }
    case 'whip': {
      // A push with an eased snap and motion blur through the middle.
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      const blur = Math.sin(p * Math.PI) * TRANS_BLUR * 1.6;
      return { ...(isIn ? movePart(1 - e, 0) : movePart(-e, 0)), blur };
    }
    case 'wipe':
      // Incoming is revealed left→right over the (full) outgoing clip.
      return isIn ? revealPart({ l: 0, t: 0, r: 1 - p, b: 0 }) : flatPart(1);
    case 'wipe-left':
      return isIn ? revealPart({ l: 1 - p, t: 0, r: 0, b: 0 }) : flatPart(1);
    case 'wipe-up':
      return isIn ? revealPart({ l: 0, t: 1 - p, r: 0, b: 0 }) : flatPart(1);
    case 'wipe-down':
      return isIn ? revealPart({ l: 0, t: 0, r: 0, b: 1 - p }) : flatPart(1);
    case 'zoom':
      return isIn ? { op: p, dx: 0, scale: 1.3 - 0.3 * p, blur: 0 } : { op: 1 - p, dx: 0, scale: 1 + 0.3 * p, blur: 0 };
    case 'zoom-out':
      return isIn ? { op: p, dx: 0, scale: 0.7 + 0.3 * p, blur: 0 } : { op: 1 - p, dx: 0, scale: 1 - 0.3 * p, blur: 0 };
    case 'spin':
      return isIn ? { op: p, dx: 0, scale: 1.4 - 0.4 * p, blur: 0, rot: -(1 - p) * 24 } : { op: 1 - p, dx: 0, scale: 1 + 0.4 * p, blur: 0, rot: p * 24 };
    case 'blur':
      return isIn ? { op: p, dx: 0, scale: 1, blur: (1 - p) * TRANS_BLUR } : { op: 1 - p, dx: 0, scale: 1, blur: p * TRANS_BLUR };
    case 'fade':
    default:
      return flatPart(isIn ? p : 1 - p);
  }
}

export function activeClipAt(clips: Clip[], tracks: Track[], kind: 'video' | 'audio', t: number): MediaClip | null {
  const audible = audibleTrackIds(tracks);
  const ids = new Set(tracks.filter((tr) => tr.kind === kind && (kind !== 'audio' || audible.has(tr.id))).map((tr) => tr.id));
  let best: MediaClip | null = null;
  for (const c of clips) {
    if (c.type !== 'media' || !ids.has(c.trackId)) continue;
    if (t >= c.start && t < c.start + c.duration && (!best || c.start > best.start)) best = c;
  }
  return best;
}

/** The clip playing on a single track at time t (latest start wins on overlap). */
function activeClipOnTrack(clips: Clip[], trackId: string, t: number): MediaClip | null {
  let best: MediaClip | null = null;
  for (const c of clips) {
    if (c.type !== 'media' || c.trackId !== trackId) continue;
    if (t >= c.start && t < c.start + c.duration && (!best || c.start > best.start)) best = c;
  }
  return best;
}

/** One playing clip per audible audio track at time t — overlapping tracks mix. */
export function activeAudioClips(clips: Clip[], tracks: Track[], t: number): MediaClip[] {
  const audible = audibleTrackIds(tracks);
  const out: MediaClip[] = [];
  for (const tr of tracks) {
    if (tr.kind !== 'audio' || !audible.has(tr.id)) continue;
    const c = activeClipOnTrack(clips, tr.id, t);
    if (c) out.push(c);
  }
  return out;
}

/**
 * The playing audio clips that the <video> of their linked picture can play
 * itself, keyed by the picture's clip id. That holds while the two are still
 * in step (same file, same source time, same speed) and the picture's own
 * sound is off; the preview then needs one element for the pair, and lips
 * can't drift from the voice. A slipped or re-timed sound plays on its own.
 *
 * With `clips` and `tracks`, a picture playing out its tail under a transition
 * carries its sound too (that sound clip has ended, so it is not in `audio`):
 * the caller fades it by the layer's `mix`, and the sound cross-mixes through
 * the transition the way the export does it.
 */
export function carriedSound(layers: VisualLayer[], audio: MediaClip[], t: number, clips?: Clip[], tracks?: Track[]): Map<string, MediaClip> {
  const out = new Map<string, MediaClip>();
  if (clips && tracks) {
    const audible = audibleTrackIds(tracks);
    const audioLanes = new Set(tracks.filter((tr) => tr.kind === 'audio' && audible.has(tr.id)).map((tr) => tr.id));
    for (const L of layers) {
      const c = L.clip;
      if (!c.link || !c.muted || c.freezeAt != null || t < c.start + c.duration) continue;
      const tail = clips.find(
        (p): p is MediaClip =>
          p.type === 'media' &&
          p.link === c.link &&
          p.id !== c.id &&
          p.mediaId === c.mediaId &&
          audioLanes.has(p.trackId) &&
          p.freezeAt == null &&
          Math.abs(p.start - c.start) < 0.02 &&
          Math.abs(p.duration - c.duration) < 0.02 &&
          Math.abs(sourceTimeAt(p, t) - sourceTimeAt(c, t)) < 0.02,
      );
      if (tail) out.set(c.id, tail);
    }
  }
  for (const a of audio) {
    if (!a.link || a.freezeAt != null) continue;
    const host = layers.find(
      (L) =>
        L.clip.link === a.link &&
        L.clip.mediaId === a.mediaId &&
        L.clip.muted &&
        L.clip.freezeAt == null &&
        !out.has(L.clip.id) &&
        t >= L.clip.start &&
        t < L.clip.start + L.clip.duration &&
        Math.abs(speedAt(L.clip, t - L.clip.start) - speedAt(a, t - a.start)) < 1e-3 &&
        Math.abs(sourceTimeAt(L.clip, t) - sourceTimeAt(a, t)) < 0.02,
    );
    if (host) out.set(host.clip.id, a);
  }
  return out;
}

/** The active transition on a single track at time t, if any. */
function trackTransitionAt(clips: Clip[], trackId: string, t: number): TransitionState | null {
  for (const c of clips) {
    if (c.type !== 'media' || c.trackId !== trackId || c.transition === 'none' || c.transitionDur <= 0) continue;
    const d = Math.min(c.transitionDur, c.duration);
    const w0 = c.start;
    const w1 = c.start + d;
    if (t >= w0 && t < w1) {
      const out =
        clips.find(
          (o): o is MediaClip =>
            o.type === 'media' && o.id !== c.id && o.trackId === c.trackId && Math.abs(o.start + o.duration - c.start) < 0.03,
        ) ?? null;
      return { out, incoming: c, p: clamp((t - w0) / d, 0, 1), type: c.transition };
    }
  }
  return null;
}

/** A composited video layer at a given time. */
export interface VisualLayer {
  clip: MediaClip;
  opacity: number;
  /** Horizontal offset as a fraction of canvas width (slide/push transitions). */
  dx: number;
  /** Extra scale multiplier (zoom transition). */
  scale: number;
  /** Blur radius, px at the 1080 reference height (blur transition). */
  blur: number;
  /** Reveal rectangle for a wipe (fraction hidden per edge). */
  reveal?: TransReveal;
  /** Vertical offset as a fraction of canvas height (vertical slides, clip animations). */
  dy?: number;
  /** Extra rotation, degrees (spin transition, clip animations). */
  rot?: number;
  /** White flash over the whole picture, 0..1 (flash transition). */
  flash?: number;
  /** Gain (0..1) for this layer's own audio — crossfades during a transition. */
  audioGain: number;
  /** The transition's share of that gain alone (1 outside a transition): what a linked sound clip cross-mixes by. */
  mix?: number;
}

/** One side of a transition (or a plain clip, part = null) as a layer, with the clip's own animation folded in. */
function visualLayer(clip: MediaClip, t: number, part: TransPart | null, audioGain: number, mix = 1): VisualLayer {
  const L: VisualLayer = {
    clip,
    opacity: (part?.op ?? 1) * fadeFactor(clip, t) * keyOpacity(clip, t),
    dx: part?.dx ?? 0,
    scale: part?.scale ?? 1,
    blur: part?.blur ?? 0,
    reveal: part?.reveal,
    dy: part?.dy,
    rot: part?.rot,
    flash: part?.flash,
    audioGain,
    mix,
  };
  if (hasClipAnim(clip)) {
    const a = textAnim(clip, t);
    L.opacity *= a.opacity;
    L.dx += a.dxFrac;
    L.dy = (L.dy ?? 0) + a.dyFrac;
    L.scale *= a.scale;
    L.rot = (L.rot ?? 0) + a.rotate;
    L.blur += a.blur;
  }
  return L;
}

/**
 * Every visible video layer at time t, ordered BACK→FRONT so a consumer can
 * draw/stack them in array order (last drawn = frontmost). This is the real
 * multi-track compositor: each video track contributes its active clip, or —
 * mid-transition — its outgoing+incoming pair cross-mixing.
 */
export function activeVisualLayers(clips: Clip[], tracks: Track[], t: number): VisualLayer[] {
  // orderedTracks lists video newest-first (front); reverse for back→front draw.
  const videoBackToFront = orderedTracks(tracks)
    .filter((tr) => tr.kind === 'video' && !tr.hidden)
    .reverse();
  const audible = audibleTrackIds(tracks);
  const layers: VisualLayer[] = [];
  for (const track of videoBackToFront) {
    const trackGain = audible.has(track.id) ? 1 : 0;
    const trans = trackTransitionAt(clips, track.id, t);
    if (trans) {
      // Equal-power audio crossfade across the transition, regardless of the
      // visual style (so even a 'slide'/'wipe' cross-mixes the sound cleanly).
      const fadeOut = Math.sqrt(Math.max(0, 1 - trans.p));
      const fadeIn = Math.sqrt(Math.max(0, trans.p));
      if (trans.out) layers.push(visualLayer(trans.out, t, transitionPart(trans.type, trans.p, 'out'), trackGain * fadeOut, fadeOut));
      layers.push(visualLayer(trans.incoming, t, transitionPart(trans.type, trans.p, 'in'), trackGain * fadeIn, fadeIn));
    } else {
      const c = activeClipOnTrack(clips, track.id, t);
      if (c) layers.push(visualLayer(c, t, null, trackGain));
    }
  }
  return layers;
}

/** All overlay clips (text, shapes, drawings) live at time t, in draw order.
 *  Pass tracks to honor hidden text tracks. */
/**
 * Video clips about to start (within `ahead` seconds after t) on visible video
 * tracks, nearest first. The preview mounts these early, parked on their first
 * frame, so the cut to them is instant instead of a black flash while a fresh
 * <video> element loads and seeks.
 */
export function upcomingVideoClips(clips: Clip[], tracks: Track[], t: number, ahead: number, max = 3): MediaClip[] {
  const visible = new Set(tracks.filter((tr) => tr.kind === 'video' && !tr.hidden).map((tr) => tr.id));
  return clips
    .filter((c): c is MediaClip => c.type === 'media' && visible.has(c.trackId) && c.start > t && c.start <= t + ahead)
    .sort((a, b) => a.start - b.start)
    .slice(0, max);
}

export function activeOverlays(clips: Clip[], t: number, tracks?: Track[]): OverlayClip[] {
  const hidden = tracks ? new Set(tracks.filter((tr) => tr.hidden).map((tr) => tr.id)) : null;
  return clips
    .filter(
      (c): c is OverlayClip =>
        (c.type === 'text' || c.type === 'shape' || c.type === 'draw') && t >= c.start && t < c.start + c.duration && !hidden?.has(c.trackId),
    )
    .sort((a, b) => a.start - b.start);
}

export function fadeFactor(clip: Clip, t: number): number {
  const into = t - clip.start;
  const out = clip.start + clip.duration - t;
  let g = 1;
  if (clip.fadeIn > 0) g = Math.min(g, into / clip.fadeIn);
  if (clip.fadeOut > 0) g = Math.min(g, out / clip.fadeOut);
  return clamp(g, 0, 1);
}

/**
 * A media clip's rounded corners and drop shadow, in pixels, for a visible box
 * of bw×bh pixels. Both follow the box's size, so they grow with a zoom.
 * Shared by preview (CSS) and export (canvas) so they match; a blur radius
 * means the same in both (twice the Gaussian's sigma).
 */
export function boxDecor(clip: MediaClip, bw: number, bh: number): { radius: number; shadow: { blur: number; dy: number; alpha: number } | null } {
  const side = Math.max(0, Math.min(bw, bh));
  const radius = Math.min(0.5, Math.max(0, clip.cornerRadius ?? 0)) * side;
  const s = Math.min(1, Math.max(0, clip.shadow ?? 0));
  return { radius, shadow: s > 0 ? { blur: side * 0.09 * s, dy: side * 0.03 * s, alpha: 0.25 + 0.35 * s } : null };
}

/**
 * Geometry for drawing a media clip's (cropped) source into a W×H canvas,
 * honoring scale/position/rotation. Shared by preview and export so they match.
 */
export function clipLayout(
  clip: MediaClip,
  srcW: number,
  srcH: number,
  W: number,
  H: number,
): { sx: number; sy: number; sw: number; sh: number; dw: number; dh: number; cx: number; cy: number; rotation: number } {
  const cropFracW = Math.max(0.01, 1 - clip.cropLeft - clip.cropRight);
  const cropFracH = Math.max(0.01, 1 - clip.cropTop - clip.cropBottom);
  const sw = srcW * cropFracW;
  const sh = srcH * cropFracH;
  const sx = srcW * clip.cropLeft;
  const sy = srcH * clip.cropTop;
  const fit = sw > 0 && sh > 0 ? Math.min(W / sw, H / sh) : 1;
  const dw = sw * fit * clip.scaleX;
  const dh = sh * fit * clip.scaleY;
  return { sx, sy, sw, sh, dw, dh, cx: W / 2 + clip.posX * W, cy: H / 2 + clip.posY * H, rotation: clip.rotation };
}
