/**
 * What the AI cursors do for each agent tool call (the pure half; the moving
 * pictures are in agentCursors.ts). A crew of five cursors shares the work:
 * each tool belongs to one of them, which goes to the same button or clip a
 * person would use, and the others pitch in when a call touches many clips.
 */

export type Role = 'lead' | 'cuts' | 'look' | 'sound' | 'text';

export interface CrewMember {
  role: Role;
  /** Shown on the cursor's tag. The lead shows the connected client's name instead. */
  name: string;
  color: string;
}

export const CREW: readonly CrewMember[] = [
  { role: 'lead', name: 'AI', color: '#A855F7' },
  { role: 'cuts', name: 'Cuts', color: '#FB7185' },
  { role: 'look', name: 'Look', color: '#FBBF24' },
  { role: 'sound', name: 'Sound', color: '#34D399' },
  { role: 'text', name: 'Text', color: '#38BDF8' },
];

/** Somewhere on screen a cursor can go. Resolved against the DOM when it sets off. */
export type Target =
  | { kind: 'anchor'; name: string; spot?: 'left' | 'right' }
  | { kind: 'media'; id: string }
  /** A clip on the timeline; t = a timeline time inside it (default: its head). */
  | { kind: 'clip'; id: string; t?: number }
  /** A timeline time where no clip is. */
  | { kind: 'time'; t: number };

/**
 * What happens on the timeline once the call has run:
 * reveal = new clips stay hidden until a cursor drops them in;
 * seams = cursors tap the new cut points; flash = changed clips light up.
 */
export type After = 'reveal' | 'seams' | 'flash' | 'none';

export interface ToolSpec {
  role: Role;
  label: string;
  /** data-agent name of the control a person would click for this. */
  anchor?: string;
  after: After;
}

const spec = (role: Role, label: string, after: After, anchor?: string): ToolSpec => ({ role, label, after, anchor });

export const TOOL_SPECS: Record<string, ToolSpec> = {
  get_project: spec('lead', 'Reading the timeline', 'none'),
  list_options: spec('lead', 'Browsing the library', 'none', 'library'),
  get_transcript: spec('lead', 'Reading the transcript', 'none', 'tool-transcript'),
  detect_pauses: spec('cuts', 'Finding the pauses', 'none', 'tool-auto-edit'),
  auto_edit: spec('cuts', 'Cutting dead air', 'seams', 'tool-auto-edit'),
  cut_ranges: spec('cuts', 'Cutting', 'seams'),
  import_media: spec('lead', 'Importing media', 'none', 'tool-import'),
  add_clip: spec('lead', 'Adding a clip', 'reveal'),
  add_text: spec('text', 'Adding text', 'reveal', 'tool-text'),
  add_shape: spec('text', 'Adding a shape', 'reveal', 'library'),
  update_clip: spec('look', 'Styling', 'flash'),
  set_keyframes: spec('look', 'Keyframing', 'flash'),
  animate_clip: spec('look', 'Animating', 'flash'),
  add_transitions: spec('look', 'Adding transitions', 'flash'),
  add_title_card: spec('text', 'Adding a title card', 'reveal', 'tool-text'),
  add_stinger: spec('look', 'Adding a stinger', 'reveal'),
  add_key_points: spec('text', 'Adding key points', 'reveal', 'tool-text'),
  set_chapters: spec('text', 'Marking chapters', 'flash', 'tool-chapters'),
  get_chapters: spec('lead', 'Reading the chapters', 'none', 'tool-chapters'),
  import_slides: spec('lead', 'Importing slides', 'none', 'tool-slides'),
  place_slides: spec('text', 'Placing slides', 'reveal', 'tool-slides'),
  list_styles: spec('lead', 'Checking the styles', 'none', 'ai-button'),
  apply_style: spec('look', 'Applying the style', 'flash', 'ai-button'),
  save_style: spec('look', 'Saving the style', 'none', 'ai-button'),
  analyze_reference: spec('lead', 'Studying the reference', 'none', 'preview'),
  detect_beats: spec('sound', 'Finding the beat', 'none'),
  find_highlights: spec('cuts', 'Finding the highlights', 'none', 'library'),
  find_steps: spec('lead', 'Finding the steps', 'none', 'tool-app-video'),
  build_montage: spec('cuts', 'Cutting to the beat', 'reveal'),
  list_formats: spec('lead', 'Reading the formats', 'none'),
  build_longform: spec('lead', 'Building the video', 'reveal', 'tool-longform'),
  send_to_marketo: spec('lead', 'Sending to Krypt Marketo', 'none', 'tool-export'),
  marketo: spec('lead', 'Asking Krypt Marketo', 'none'),
  before_after: spec('look', 'Building the before / after', 'reveal'),
  product_demo: spec('look', 'Zooming in on the clicks', 'reveal', 'tool-demo'),
  capture_web: spec('look', 'Filming the page', 'reveal', 'tool-record'),
  find_images: spec('lead', 'Looking for pictures', 'none', 'tool-images'),
  save_images: spec('lead', 'Saving the pictures', 'none', 'tool-images'),
  generate_images: spec('lead', 'Making the pictures', 'none', 'tool-images'),
  draw_images: spec('lead', 'Drawing', 'none', 'tool-images'),
  study_channel: spec('lead', 'Studying the channel', 'none', 'tool-channel'),
  make_thumbnail: spec('lead', 'Drawing the thumbnail', 'none', 'tool-thumbnail'),
  record_window: spec('look', 'Recording the window', 'reveal', 'tool-record'),
  retime_clip: spec('cuts', 'Retiming', 'flash'),
  split_clips: spec('cuts', 'Splitting', 'seams'),
  duplicate_clip: spec('cuts', 'Duplicating', 'reveal'),
  detach_audio: spec('sound', 'Detaching the audio', 'reveal'),
  sync_audio: spec('sound', 'Syncing by sound', 'flash'),
  delete_clips: spec('cuts', 'Deleting', 'none'),
  edit_track: spec('sound', 'Editing tracks', 'flash', 'tracks'),
  add_captions: spec('text', 'Adding captions', 'reveal', 'tool-captions'),
  add_voiceover: spec('sound', 'Recording a voice-over', 'reveal', 'tool-tts'),
  revoice: spec('sound', 'Re-voicing', 'reveal', 'tool-revoice'),
  reframe: spec('look', 'Reframing', 'flash', 'tool-reframe'),
  duck_audio: spec('sound', 'Ducking the music', 'flash', 'tool-duck'),
  import_lut: spec('look', 'Loading a LUT', 'none', 'inspector'),
  set_canvas: spec('lead', 'Setting the canvas', 'none', 'tool-canvas'),
  preview_frames: spec('lead', 'Checking the frame', 'none', 'preview'),
  undo: spec('lead', 'Undoing', 'flash', 'tool-undo'),
  redo: spec('lead', 'Redoing', 'flash', 'tool-redo'),
  save_project: spec('lead', 'Saving', 'none', 'tool-save'),
  open_project: spec('lead', 'Opening a project', 'none', 'tool-open'),
  export_video: spec('lead', 'Exporting', 'none', 'tool-export'),
};

const words = (tool: string): string => {
  const s = tool.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function toolSpec(tool: string): ToolSpec {
  return TOOL_SPECS[tool] ?? spec('lead', words(tool), 'flash');
}

/** The part of a clip the plan needs (the store's clips fit). */
export interface ClipLite {
  id: string;
  trackId: string;
  start: number;
  duration: number;
}

export interface StagePlan {
  role: Role;
  label: string;
  after: After;
  /** Where the tool's own cursor goes, in order, before the call runs. */
  lead: Target[];
  /** More places the call touches: the rest of the crew takes these. */
  others: Target[];
  /** Clips the call names, so "what changed" can favour them. */
  focus: string[];
  /** What the cursor drags from the media bin (add_clip). */
  carry?: string;
}

type Args = Record<string, unknown>;
const isObj = (v: unknown): v is Args => !!v && typeof v === 'object' && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : typeof v === 'string' && v ? [v] : []);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A timeline time → the clip under it (so the cursor lands on the right track), else the bare time. */
function atTime(t: number, clips: readonly ClipLite[], within?: ReadonlySet<string>): Target {
  const hit = clips.find((c) => (!within || within.has(c.id)) && t >= c.start && t <= c.start + c.duration);
  return hit ? { kind: 'clip', id: hit.id, t } : { kind: 'time', t };
}

export function planStage(tool: string, rawArgs: unknown, clips: readonly ClipLite[], media: ReadonlyArray<{ id: string; name: string }> = []): StagePlan {
  const a: Args = isObj(rawArgs) ? rawArgs : {};
  const s = toolSpec(tool);
  const lead: Target[] = [];
  const touched: Target[] = [];
  let carry: string | undefined;

  if (tool === 'get_project') lead.push({ kind: 'anchor', name: 'lanes', spot: 'left' }, { kind: 'anchor', name: 'lanes', spot: 'right' });
  else if (s.anchor) lead.push({ kind: 'anchor', name: s.anchor });

  // The file a call is about: a clip's source, the first of several, or a montage's song.
  const mediaId = [a.media_id, strs(a.media_ids)[0], a.music_id, a.after_id].find((v): v is string => typeof v === 'string' && !!v);
  if (mediaId && media.some((m) => m.id === mediaId)) {
    lead.push({ kind: 'media', id: mediaId });
    if (tool === 'add_clip') carry = media.find((m) => m.id === mediaId)?.name;
  }

  // Clips the call names. A track_id names every clip on it, except for tools that put something new there.
  const known = new Set(clips.map((c) => c.id));
  const scope = isObj(a.scope) ? a.scope : {};
  const named = [...strs(a.clip_id), ...strs(a.clip_ids), ...strs(a.to_clip_id), ...strs(scope.clip_ids)].filter((id) => known.has(id));
  const trackIds = s.after === 'reveal' ? [] : [...strs(a.track_id), ...strs(a.track_ids), ...strs(scope.track_id)];
  const onTracks = trackIds.length ? clips.filter((c) => trackIds.includes(c.trackId)).map((c) => c.id) : [];
  const focus = [...new Set([...named, ...onTracks])];

  // Cut points come before whole clips: that is where the cursor should land.
  const cutting = s.after === 'seams';
  const times: number[] = [];
  if (cutting) {
    if (isNum(a.at)) times.push(a.at);
    if (isNum(a.time)) times.push(a.time);
    if (Array.isArray(a.times)) times.push(...a.times.filter(isNum));
    if (Array.isArray(a.ranges)) for (const r of a.ranges) if (Array.isArray(r) && isNum(r[0])) times.push(r[0]);
  }
  if (times.length) {
    const within = focus.length ? new Set(focus) : undefined;
    for (const t of times) touched.push(atTime(t, clips, within));
  } else {
    for (const id of focus) touched.push({ kind: 'clip', id });
  }

  if (touched.length) lead.push(touched[0]);
  return { role: s.role, label: s.label, after: s.after, lead, others: touched.slice(1), focus, carry };
}

/** Which clips a call added, removed or changed (clips are immutable, so a new object is a change). */
export function diffClips<T extends { id: string }>(before: readonly T[], after: readonly T[]): { added: string[]; removed: string[]; changed: string[] } {
  const was = new Map(before.map((c) => [c.id, c]));
  const added: string[] = [];
  const changed: string[] = [];
  for (const c of after) {
    const prev = was.get(c.id);
    if (!prev) added.push(c.id);
    else if (prev !== c) changed.push(c.id);
    was.delete(c.id);
  }
  return { added, removed: [...was.keys()], changed };
}

/**
 * Share items (already in screen order) between cursors: each hand gets one
 * unbroken run, cut into at most `stops` groups, one per place it stops. So
 * hands never cross, and every item belongs to exactly one stop.
 */
export function deal<T>(items: readonly T[], hands: number, stops: number): T[][][] {
  const n = items.length;
  const h = Math.max(1, Math.min(Math.floor(hands), n));
  const out: T[][][] = [];
  if (n === 0) return out;
  for (let i = 0; i < h; i++) {
    const run = items.slice(Math.floor((i * n) / h), Math.floor(((i + 1) * n) / h));
    const k = Math.max(1, Math.min(Math.floor(stops), run.length));
    const groups: T[][] = [];
    for (let j = 0; j < k; j++) groups.push(run.slice(Math.floor((j * run.length) / k), Math.floor(((j + 1) * run.length) / k)));
    out.push(groups);
  }
  return out;
}
