import { create } from 'zustand';

/**
 * Edit styles: named looks an AI agent (or the user, from the AI panel) can
 * apply to a whole project — captions, titles, title cards, transitions,
 * colour grade, clip motion — plus the pacing and audio settings the agent
 * should cut with, and free-form notes.
 *
 * A style is stored in the vocabulary of the MCP tools (snake_case, the same
 * `style` object add_text takes, the same names update_clip takes), so an
 * agent can read one, tweak it and save it back without a translation layer.
 *
 * The active style, the user's standing notes for the agent ("brief") and an
 * optional reference video are kept per app (localStorage) and also travel
 * inside saved projects.
 */

export type CardLook = 'clean' | 'bold' | 'cinematic' | 'neon' | 'retro' | 'minimal';

export const CARD_LOOKS: Array<{ label: string; value: CardLook }> = [
  { label: 'Clean', value: 'clean' },
  { label: 'Bold', value: 'bold' },
  { label: 'Cinematic', value: 'cinematic' },
  { label: 'Neon', value: 'neon' },
  { label: 'Retro', value: 'retro' },
  { label: 'Minimal', value: 'minimal' },
];

/** A text style in tool vocabulary (font, font_size, color, outline_width, anim_in, karaoke…). */
export type StyleText = Record<string, string | number | boolean>;

export interface EditStyle {
  id: string;
  name: string;
  description: string;
  builtin?: boolean;
  /** Caption look; `uppercase` also upper-cases the words. */
  captions?: StyleText;
  /** Look for titles and the text on title cards (font, color, outline, glow, anim_in / anim_out). */
  titles?: StyleText;
  /** Title cards and stingers. */
  card?: { look?: CardLook; background?: string; accent?: string };
  /** Put on every cut between two touching clips ("none" = hard cuts). */
  transition?: { type: string; duration?: number };
  /** Colour grade for every video / image clip (update_clip names). */
  grade?: { brightness?: number; contrast?: number; saturation?: number; hue?: number; vignette?: number; effect?: string };
  /** Camera motion on the footage: every clip, or every other one. */
  motion?: { motion: string; amount?: number; every?: 'all' | 'alternate' };
  /** How to cut: defaults for auto_edit, and the shot length to aim for. */
  pacing?: { preset?: string; mode?: string; min_pause?: number; zoom?: boolean; shot_seconds?: number };
  /** Defaults for duck_audio and export_video. */
  audio?: { duck_db?: number; loudness?: number };
  /** Anything else the editor should know, in plain words. */
  notes?: string;
}

export const STYLE_PARTS = ['captions', 'titles', 'transitions', 'grade', 'motion'] as const;
export type StylePart = (typeof STYLE_PARTS)[number];

export const BUILTIN_STYLES: EditStyle[] = [
  {
    id: 'viral-short',
    name: 'Viral short',
    description: 'Fast TikTok / Shorts / Reels edit: big punchy captions, hard cuts, punch-in zooms.',
    builtin: true,
    captions: { font: 'Impact', font_size: 84, color: '#ffffff', bold: true, outline_width: 8, outline_color: '#000000', y: 0.72, karaoke: 'pop', karaoke_color: '#ffd53d', anim_in: 'pop', uppercase: true },
    titles: { font: 'Impact', color: '#ffffff', outline_width: 8, outline_color: '#000000', anim_in: 'stomp', anim_out: 'fade' },
    card: { look: 'bold', background: '#ffd53d', accent: '#111111' },
    transition: { type: 'none' },
    grade: { contrast: 108, saturation: 116 },
    motion: { motion: 'zoom-in', amount: 1, every: 'alternate' },
    pacing: { preset: 'talking', min_pause: 0.35, zoom: true, shot_seconds: 2.5 },
    audio: { duck_db: -14, loudness: -14 },
    notes: 'Open on the hook: no intro card. Keep every shot under about 3 seconds, cut all dead air, put an emoji sticker or a one-word text hit on punchlines, and use a flash or whip transition only on a real scene change.',
  },
  {
    id: 'cinematic',
    name: 'Cinematic',
    description: 'Slow and moody: serif titles, soft dissolves, a muted grade with a vignette and slow push-ins.',
    builtin: true,
    captions: { font: 'Georgia', font_size: 50, color: '#f5f1e8', bold: false, italic: true, outline_width: 3, outline_color: '#000000', y: 0.88, karaoke: 'none', anim_in: 'fade' },
    titles: { font: 'Georgia', color: '#f5f1e8', bold: false, outline_width: 0, anim_in: 'blur', anim_out: 'fade' },
    card: { look: 'cinematic', background: '#000000', accent: '#d4af37' },
    transition: { type: 'fade', duration: 0.8 },
    grade: { brightness: 96, contrast: 112, saturation: 86, vignette: 0.35 },
    motion: { motion: 'zoom-in', amount: 0.6, every: 'all' },
    pacing: { preset: 'voiceover', min_pause: 1, zoom: false, shot_seconds: 5 },
    audio: { duck_db: -10, loudness: -14 },
    notes: 'Let shots breathe. Dip to black between scenes, open on a title card, no stickers or word-by-word captions.',
  },
  {
    id: 'clean-tutorial',
    name: 'Clean tutorial',
    description: 'Clear and calm how-to: boxed captions, chapter cards, quick fades.',
    builtin: true,
    captions: { font: 'Segoe UI', font_size: 54, color: '#ffffff', bold: true, outline_width: 0, bg_style: 'box', bg_color: '#0f172a', bg_opacity: 0.8, bg_radius: 12, y: 0.88, karaoke: 'none', anim_in: 'none' },
    titles: { font: 'Segoe UI', color: '#ffffff', bold: true, outline_width: 0, anim_in: 'slide', anim_out: 'fade' },
    card: { look: 'clean', background: '#0f172a', accent: '#3b82f6' },
    transition: { type: 'fade', duration: 0.3 },
    pacing: { preset: 'talking', min_pause: 0.6, zoom: false, shot_seconds: 8 },
    audio: { duck_db: -16, loudness: -14 },
    notes: 'A chapter card before each step ("Step 2", then what it covers). Label tools and shortcuts with a short lower-third text. Zoom in (scale keyframes) on small on-screen details instead of cutting.',
  },
  {
    id: 'lecture',
    name: 'Lecture',
    description: 'Long-form teaching video: calm cuts, chapter cards, key points beside the speaker, readable captions.',
    builtin: true,
    captions: { font: 'Segoe UI', font_size: 46, color: '#ffffff', bold: true, outline_width: 0, bg_style: 'box', bg_color: '#0b1220', bg_opacity: 0.78, bg_radius: 10, y: 0.91, karaoke: 'none', anim_in: 'none' },
    titles: { font: 'Segoe UI', color: '#ffffff', bold: true, outline_width: 0, anim_in: 'slide', anim_out: 'fade' },
    card: { look: 'clean', background: '#0b1220', accent: '#38bdf8' },
    transition: { type: 'fade', duration: 0.4 },
    pacing: { preset: 'talking', min_pause: 0.9, zoom: false, shot_seconds: 20 },
    audio: { duck_db: -18, loudness: -14 },
    notes:
      'Structure first: get_transcript, find the sections, then an intro title card, a chapter card at each section (add_title_card with chapter) and an outro. ' +
      'For each section put its two to five takeaways on screen with add_key_points, each point timed to when it is said (layout left or right keeps the speaker in shot; full for a recap). ' +
      'Slides or diagrams: import_slides, then place_slides so each is up while it is talked about, with a slow zoom-in motion. ' +
      'Cut dead air but keep natural pauses (this is not a short). No punch-in zooms, stickers or flashy transitions. Finish with get_chapters and give the user the list for the video description.',
  },
  {
    id: 'podcast-clip',
    name: 'Podcast clip',
    description: 'Talking-head clip for social: word-box captions in the middle third, gentle punch-ins.',
    builtin: true,
    captions: { font: 'Chakra Petch', font_size: 70, color: '#ffffff', bold: true, outline_width: 6, outline_color: '#000000', y: 0.76, karaoke: 'box', karaoke_color: '#a855f7', anim_in: 'none' },
    titles: { font: 'Chakra Petch', color: '#ffffff', bold: true, outline_width: 6, outline_color: '#000000', anim_in: 'pop', anim_out: 'fade' },
    card: { look: 'bold', background: '#a855f7', accent: '#ffffff' },
    transition: { type: 'none' },
    motion: { motion: 'zoom-in', amount: 0.5, every: 'alternate' },
    pacing: { preset: 'podcast', mode: 'speech', min_pause: 0.6, zoom: true, shot_seconds: 6 },
    audio: { duck_db: -12, loudness: -16 },
    notes: 'Start on the strongest line of the clip and add a title with the topic for the first 3 seconds. Keep the speaker framed; reframe to 9:16 with face follow for vertical.',
  },
  {
    id: 'gaming-hype',
    name: 'Gaming hype',
    description: 'Gameplay with commentary: neon glow captions, whip-pan cuts, saturated colour. (Music-only highlights: Gaming montage.)',
    builtin: true,
    captions: { font: 'Chakra Petch', font_size: 76, color: '#ffffff', bold: true, outline_width: 6, outline_color: '#05060f', glow: 14, glow_color: '#22d3ee', y: 0.8, karaoke: 'color', karaoke_color: '#22d3ee', anim_in: 'stomp', uppercase: true },
    titles: { font: 'Chakra Petch', color: '#ffffff', bold: true, glow: 18, glow_color: '#22d3ee', anim_in: 'stomp', anim_out: 'zoom' },
    card: { look: 'neon', background: '#05060f', accent: '#22d3ee' },
    transition: { type: 'whip', duration: 0.35 },
    grade: { contrast: 110, saturation: 126 },
    pacing: { preset: 'gameplay', mode: 'speech', min_pause: 1.2, zoom: true, shot_seconds: 3 },
    audio: { duck_db: -8, loudness: -14 },
    notes: 'On highlight moments: a shake or pulse motion on the clip, a flash transition into it, and a speed ramp (retime_clip bullet or hero). Keep game audio audible under the voice.',
  },
  {
    id: 'gaming-montage',
    name: 'Gaming montage',
    description: 'Frag movie cut to music: every kill lands on a beat with a velocity ramp, a punch-in and a flash cut. No talking.',
    builtin: true,
    titles: { font: 'Impact', font_size: 110, color: '#ffffff', bold: true, outline_width: 8, outline_color: '#05060f', glow: 18, glow_color: '#ff2d55', anim_in: 'stomp', anim_out: 'fade' },
    card: { look: 'neon', background: '#05060f', accent: '#ff2d55' },
    transition: { type: 'flash', duration: 0.15 },
    grade: { contrast: 114, saturation: 128, vignette: 0.2 },
    pacing: { shot_seconds: 2 },
    audio: { loudness: -14 },
    notes:
      'A montage is cut to the music, not to speech: do not auto_edit. The user gives clips and one song (ask for a song if there is none). ' +
      'find_highlights on the footage and look at the frames: keep real kills and plays, drop menus and deaths; moments the user names ("clip 3 at 0:42", "the triple") come first. ' +
      'detect_beats on the song; start a bar or two before its biggest drop (music_start) and order the moments so the best one lands on that drop and the second best closes. ' +
      'build_montage with clear: true when the timeline only holds the raw clips: 4 beats per clip is the default, 2 for a frantic run of quick kills, 8 for a clutch that needs its lead-up; velocity ramps throughout, slowmo on the one best moment. ' +
      'One or two word text hits on the biggest moments only ("ACE", "1v4"), and the player name as a small title over the first clip. Then apply_style for the grade. Game sound stays low (game_volume 0.3). 15 to 40 seconds is the length people watch.',
  },
  {
    id: 'before-after',
    name: 'Before / after',
    description: 'A reveal for Reels and Shorts: the before, a slider wipe, the after. For grades, edits, retouching, transformations.',
    builtin: true,
    titles: { font: 'Impact', font_size: 96, color: '#ffffff', bold: true, outline_width: 6, outline_color: '#000000', anim_in: 'pop', anim_out: 'fade' },
    card: { look: 'bold' },
    transition: { type: 'flash', duration: 0.2 },
    pacing: { shot_seconds: 3 },
    audio: { loudness: -14 },
    notes:
      'The whole video is one comparison, 5 to 9 seconds, made to loop. set_canvas 9:16 for Reels, TikTok and Shorts unless the user wants it wide. ' +
      'before_after builds it. The same shot twice (raw and graded, a photo before and after): mode wipe for one clean reveal, slider when people should study the difference. Different takes or different lengths (raw footage against the finished edit, day 1 against day 90): split or cut. ' +
      'To show what a look does, pass one file as both and put the look on the after clip with update_clip. To show what an edit did, export_video the edit and import_media the export first. ' +
      'Keep the before short: the after is what people stay for. No intro card; a two or three word hook as text over the first second at most ("raw vs edited"). Music helps: add a song on its own audio track and time the reveal to a beat (detect_beats, then hold = the beat time).',
  },
  {
    id: 'retro-vhs',
    name: 'Retro VHS',
    description: 'Camcorder nostalgia: VHS effect, typewriter captions, pixel-font cards.',
    builtin: true,
    captions: { font: 'Courier', font_size: 58, color: '#fef08a', bold: true, outline_width: 5, outline_color: '#000000', y: 0.86, karaoke: 'none', anim_in: 'typewriter' },
    titles: { font: 'Press Start 2P', color: '#fef08a', bold: false, outline_width: 6, outline_color: '#000000', anim_in: 'typewriter', anim_out: 'flicker' },
    card: { look: 'retro', background: '#1a1033', accent: '#ff2d95' },
    transition: { type: 'flash', duration: 0.3 },
    grade: { saturation: 110, effect: 'vhs' },
    pacing: { preset: 'talking', min_pause: 0.6, zoom: false, shot_seconds: 4 },
    audio: { duck_db: -12, loudness: -14 },
    notes: 'A date-stamp text in a corner ("REC  12.03.1998", Press Start 2P, small) sells the look. Set the canvas to 4:5 or keep 16:9; avoid modern-looking stickers.',
  },
  {
    id: 'vlog-warm',
    name: 'Warm vlog',
    description: 'Friendly travel / lifestyle vlog: warm colour, soft crossfades, slow drifting shots.',
    builtin: true,
    captions: { font: 'Trebuchet', font_size: 58, color: '#ffffff', bold: true, outline_width: 5, outline_color: '#3b2314', y: 0.86, karaoke: 'color', karaoke_color: '#ffb86b', anim_in: 'fade' },
    titles: { font: 'Georgia', color: '#fff7ed', bold: false, italic: true, outline_width: 4, outline_color: '#3b2314', anim_in: 'slide', anim_out: 'fade' },
    card: { look: 'minimal', background: '#fff7ed', accent: '#ea580c' },
    transition: { type: 'fade', duration: 0.4 },
    grade: { brightness: 103, contrast: 104, saturation: 110, effect: 'warm' },
    motion: { motion: 'zoom-in', amount: 0.5, every: 'all' },
    pacing: { preset: 'talking', min_pause: 0.7, zoom: false, shot_seconds: 4 },
    audio: { duck_db: -12, loudness: -14 },
    notes: 'Place names and dates as small italic titles in a lower corner. Music carries the b-roll: duck it under speech and let it come up between lines.',
  },
  {
    id: 'documentary',
    name: 'Documentary',
    description: 'Measured and credible: serif lower-thirds, dips to black, slow pans over stills.',
    builtin: true,
    captions: { font: 'Georgia', font_size: 48, color: '#ffffff', bold: false, outline_width: 0, bg_style: 'box', bg_color: '#000000', bg_opacity: 0.6, bg_radius: 4, y: 0.9, karaoke: 'none', anim_in: 'fade' },
    titles: { font: 'Georgia', color: '#ffffff', bold: false, outline_width: 0, anim_in: 'fade', anim_out: 'fade' },
    card: { look: 'cinematic', background: '#0b0b0b', accent: '#e5e5e5' },
    transition: { type: 'dip', duration: 0.7 },
    grade: { contrast: 106, saturation: 92 },
    motion: { motion: 'zoom-in', amount: 0.8, every: 'all' },
    pacing: { preset: 'voiceover', min_pause: 0.9, zoom: false, shot_seconds: 6 },
    audio: { duck_db: -14, loudness: -16 },
    notes: 'Name each speaker with a lower-third (name, then role in a smaller line) the first time they appear. Use pan-left / pan-right motion on photos. Chapter cards between sections.',
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Quiet and modern: small highlighted captions, hard cuts, nothing that moves without a reason.',
    builtin: true,
    captions: { font: 'Arial', font_size: 46, color: '#ffffff', bold: false, outline_width: 0, bg_style: 'highlight', bg_color: '#000000', bg_opacity: 0.55, bg_radius: 6, y: 0.9, karaoke: 'none', anim_in: 'none' },
    titles: { font: 'Arial', color: '#ffffff', bold: false, outline_width: 0, anim_in: 'fade', anim_out: 'fade' },
    card: { look: 'minimal', background: '#ffffff', accent: '#111111' },
    transition: { type: 'none' },
    pacing: { preset: 'talking', min_pause: 0.7, zoom: false, shot_seconds: 5 },
    audio: { duck_db: -12, loudness: -14 },
    notes: 'No effects, no stickers, no zooms. One typeface throughout.',
  },
  {
    id: 'explainer',
    name: 'Explainer',
    description: 'Long-form narrated explainer: bright part cards, takeaways beside the pictures, clear word-by-word captions.',
    builtin: true,
    captions: { font: 'Chakra Petch', font_size: 56, color: '#ffffff', bold: true, outline_width: 6, outline_color: '#0b1020', y: 0.88, karaoke: 'color', karaoke_color: '#5eead4', anim_in: 'none' },
    titles: { font: 'Chakra Petch', color: '#ffffff', bold: true, outline_width: 0, anim_in: 'slide', anim_out: 'fade' },
    card: { look: 'clean', background: '#0b1020', accent: '#5eead4' },
    transition: { type: 'fade', duration: 0.45 },
    grade: { contrast: 104, saturation: 106 },
    motion: { motion: 'zoom-in', amount: 0.6, every: 'all' },
    pacing: { preset: 'voiceover', min_pause: 0.7, zoom: false, shot_seconds: 7 },
    audio: { duck_db: -15, loudness: -14 },
    notes: 'One idea per part, a part card before each, a new picture every 5 to 8 seconds, the takeaways on screen as they are said. build_longform with format explainer makes the whole video from a script.',
  },
  {
    id: 'video-essay',
    name: 'Video essay',
    description: 'Long-form essay: serif type on near-black, slow dissolves and push-ins, small quiet captions.',
    builtin: true,
    captions: { font: 'Georgia', font_size: 44, color: '#f5f1e8', bold: false, italic: true, outline_width: 0, bg_style: 'highlight', bg_color: '#000000', bg_opacity: 0.5, bg_radius: 4, y: 0.9, karaoke: 'none', anim_in: 'fade' },
    titles: { font: 'Georgia', color: '#f5f1e8', bold: false, outline_width: 0, anim_in: 'blur', anim_out: 'fade' },
    card: { look: 'cinematic', background: '#0c0a09', accent: '#d6b36a' },
    transition: { type: 'fade', duration: 0.9 },
    grade: { contrast: 108, saturation: 88, vignette: 28 },
    motion: { motion: 'zoom-in', amount: 0.7, every: 'all' },
    pacing: { preset: 'voiceover', min_pause: 1, zoom: false, shot_seconds: 8 },
    audio: { duck_db: -16, loudness: -16 },
    notes: 'Open cold on the question, then the title. Let pictures breathe; where there is none, put the sentence itself on screen. build_longform with format video-essay makes the whole video from a script.',
  },
  {
    id: 'top-list',
    name: 'Top list',
    description: 'Long-form countdown: big yellow number cards, colour sweeps between entries, loud captions, quick pictures.',
    builtin: true,
    captions: { font: 'Impact', font_size: 66, color: '#ffffff', bold: true, outline_width: 7, outline_color: '#000000', y: 0.86, karaoke: 'color', karaoke_color: '#ffd53d', anim_in: 'none', uppercase: true },
    titles: { font: 'Impact', color: '#111111', outline_width: 0, anim_in: 'stomp', anim_out: 'fade' },
    card: { look: 'bold', background: '#ffd53d', accent: '#111111' },
    transition: { type: 'push', duration: 0.35 },
    grade: { contrast: 108, saturation: 114 },
    motion: { motion: 'zoom-in', amount: 0.9, every: 'all' },
    pacing: { preset: 'talking', min_pause: 0.4, zoom: true, shot_seconds: 4 },
    audio: { duck_db: -13, loudness: -14 },
    notes: 'Count down to number one: a number card and a stinger into every entry, a new picture every 3 to 5 seconds. build_longform with format listicle makes the whole video from a script.',
  },
  {
    id: 'trailer',
    name: 'Launch trailer',
    description: 'A software trailer: big white type on deep indigo, a violet accent, recordings in windows, every cut on the beat.',
    builtin: true,
    captions: { font: 'Chakra Petch', font_size: 52, color: '#ffffff', bold: true, outline_width: 6, outline_color: '#0b1020', y: 0.93, karaoke: 'color', karaoke_color: '#c4b5fd', anim_in: 'none' },
    titles: { font: 'Chakra Petch', color: '#ffffff', bold: true, outline_width: 0, anim_in: 'stomp', anim_out: 'fade' },
    card: { look: 'clean', background: '#0b1020', accent: '#8b5cf6' },
    transition: { type: 'none' },
    grade: { contrast: 104, saturation: 108 },
    pacing: { preset: 'talking', min_pause: 0.3, zoom: false, shot_seconds: 4 },
    audio: { duck_db: -10, loudness: -14 },
    notes: 'Thirty to ninety seconds. Open on a few words, land the name on a hit, then one feature at a time: a headline, then its recording in a window. Say only what the product shows. build_longform with format trailer makes the whole video.',
  },
  {
    id: 'quiz',
    name: 'Quiz',
    description: 'A play-along quiz: deep blue cards, yellow accents, answers in boxes, a countdown, the right answer in green.',
    builtin: true,
    captions: { font: 'Chakra Petch', font_size: 52, color: '#ffffff', bold: true, outline_width: 6, outline_color: '#0b1640', y: 0.9, karaoke: 'color', karaoke_color: '#fde047', anim_in: 'none' },
    titles: { font: 'Chakra Petch', color: '#ffffff', bold: true, outline_width: 0, anim_in: 'pop', anim_out: 'fade' },
    card: { look: 'clean', background: '#0b1640', accent: '#fde047' },
    transition: { type: 'none' },
    pacing: { preset: 'voiceover', min_pause: 0.6, zoom: false, shot_seconds: 8 },
    audio: { duck_db: -14, loudness: -14 },
    notes: 'One question at a time: read it out, show the answers, count down, light up the right one and say a line about it. Easy first, hard last. build_longform with format quiz makes the whole video.',
  },
];

// ── Store ──────────────────────────────────────────────────────────────────
const STORE_KEY = 'krypt.aiStyles';

interface Persisted {
  custom: EditStyle[];
  activeId: string | null;
  brief: string;
  reference: string | null;
}

/** What a project file carries (the active style is embedded so it opens on another machine). */
export interface ProjectAi {
  style?: EditStyle | null;
  brief?: string;
  reference?: string | null;
}

interface StyleState extends Persisted {
  /** Add or replace a custom style (matched by id). */
  save: (style: EditStyle) => void;
  remove: (id: string) => void;
  setActive: (id: string | null) => void;
  setBrief: (brief: string) => void;
  setReference: (path: string | null) => void;
  /** Adopt a project's style, notes and reference (called when a project opens). */
  loadProject: (ai: ProjectAi | undefined) => void;
}

const MAX_BRIEF = 4000;

function isStyle(v: unknown): v is EditStyle {
  const s = v as EditStyle;
  return !!s && typeof s === 'object' && typeof s.id === 'string' && !!s.id && typeof s.name === 'string';
}

function readPersisted(): Persisted {
  const empty: Persisted = { custom: [], activeId: null, brief: '', reference: null };
  try {
    if (typeof localStorage === 'undefined') return empty;
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<Persisted> | null;
    if (!v || typeof v !== 'object') return empty;
    return {
      custom: (Array.isArray(v.custom) ? v.custom : []).filter(isStyle).map((s) => ({ ...s, builtin: undefined })),
      activeId: typeof v.activeId === 'string' ? v.activeId : null,
      brief: typeof v.brief === 'string' ? v.brief.slice(0, MAX_BRIEF) : '',
      reference: typeof v.reference === 'string' && v.reference ? v.reference : null,
    };
  } catch {
    return empty;
  }
}

function persist(s: Persisted): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORE_KEY, JSON.stringify({ custom: s.custom, activeId: s.activeId, brief: s.brief, reference: s.reference }));
  } catch {
    /* storage full or unavailable: the session still works */
  }
}

export const useStyleStore = create<StyleState>((set, get) => {
  const update = (patch: Partial<Persisted>): void => {
    set(patch);
    persist(get());
  };
  return {
    ...readPersisted(),
    save: (style) => {
      const clean: EditStyle = { ...style, builtin: undefined };
      update({ custom: [...get().custom.filter((s) => s.id !== clean.id), clean] });
    },
    remove: (id) => update({ custom: get().custom.filter((s) => s.id !== id), activeId: get().activeId === id ? null : get().activeId }),
    setActive: (id) => update({ activeId: id && findStyle(id) ? findStyle(id)!.id : null }),
    setBrief: (brief) => update({ brief: brief.slice(0, MAX_BRIEF) }),
    setReference: (path) => update({ reference: path || null }),
    loadProject: (ai) => {
      if (!ai || typeof ai !== 'object') return;
      const patch: Partial<Persisted> = {};
      if (typeof ai.brief === 'string') patch.brief = ai.brief.slice(0, MAX_BRIEF);
      if (ai.reference === null || typeof ai.reference === 'string') patch.reference = ai.reference || null;
      if (ai.style === null) patch.activeId = null;
      else if (isStyle(ai.style)) {
        const builtin = BUILTIN_STYLES.find((b) => b.id === ai.style!.id);
        // A custom style travels with the project; a built-in is just named.
        if (!builtin) patch.custom = [...get().custom.filter((s) => s.id !== ai.style!.id), { ...ai.style, builtin: undefined }];
        patch.activeId = ai.style.id;
      }
      update(patch);
    },
  };
});

export function allStyles(): EditStyle[] {
  return [...BUILTIN_STYLES, ...useStyleStore.getState().custom];
}

/** A style by id or name, any case. */
export function findStyle(nameOrId: string): EditStyle | undefined {
  const k = nameOrId.trim().toLowerCase();
  return allStyles().find((s) => s.id.toLowerCase() === k || s.name.toLowerCase() === k);
}

export function activeStyle(): EditStyle | undefined {
  const id = useStyleStore.getState().activeId;
  return id ? findStyle(id) : undefined;
}

/** The part of the style state a project file stores. */
export function projectAi(): ProjectAi | undefined {
  const s = useStyleStore.getState();
  const style = activeStyle();
  if (!style && !s.brief && !s.reference) return undefined;
  return { style: style ?? null, brief: s.brief, reference: s.reference };
}

/** A stable id for a style name ("My Brand Look" → "my-brand-look"), kept clear of the built-ins. */
export function styleId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'style';
  return BUILTIN_STYLES.some((b) => b.id === slug) ? `my-${slug}` : slug;
}

/** What a style sets, in a few words (for the picker and tool results). */
export function styleSummary(s: EditStyle): string {
  const bits: string[] = [];
  if (s.captions) bits.push('captions');
  if (s.titles || s.card) bits.push('titles & cards');
  if (s.transition) bits.push(s.transition.type === 'none' ? 'hard cuts' : `${s.transition.type} transitions`);
  if (s.grade) bits.push('colour grade');
  if (s.motion && s.motion.motion !== 'none') bits.push('clip motion');
  if (s.pacing) bits.push('pacing');
  if (s.audio) bits.push('audio levels');
  return bits.join(', ');
}
