// The stickman's vocabulary: pose and prop names and how a props list is read (ported from Krypt Marketo).
// props = "desk;laptop;B:phone;sign=FREE": ; between props, B: = the second figure's, =value is the prop's text.

export const STICK_POSES = [
  'idle', 'talk', 'point', 'present', 'shrug', 'shock', 'cheer', 'think', 'wave', 'facepalm', 'sad', 'laugh',
  'thumbsup', 'angry', 'walk', 'run', 'sit', 'type', 'phone', 'sleep', 'fall',
] as const;
export type StickPose = (typeof STICK_POSES)[number];
export const isStickPose = (v: string): v is StickPose => (STICK_POSES as readonly string[]).includes(v);

export const STICK_PROPS = [
  'desk', 'laptop', 'monitor', 'screen', 'phone', 'chart', 'sign', 'bubble', 'think', 'bulb', 'question', 'exclaim',
  'sweat', 'robot', 'coffee', 'clock', 'zzz', 'fire', 'arrow',
] as const;
export type StickPropKind = (typeof STICK_PROPS)[number];
/** Props that can show the screen recording (value = the second to start at). */
export const SCREEN_PROPS: StickPropKind[] = ['laptop', 'monitor', 'screen', 'phone'];

export const STICK_GEAR = ['cap', 'headphones', 'glasses', 'tie', 'hair'] as const;

export interface StickProp {
  kind: StickPropKind;
  /** 0 = figure A, 1 = figure B. */
  who: 0 | 1;
  value: string;
}

/** A beat's props column. Unknown names are dropped. */
export function stickProps(raw: string): StickProp[] {
  const out: StickProp[] = [];
  for (const part of raw.split(';')) {
    let s = part.trim();
    if (!s) continue;
    let who: 0 | 1 = 0;
    const own = /^([ab])\s*:\s*/i.exec(s);
    if (own) {
      who = own[1].toLowerCase() === 'b' ? 1 : 0;
      s = s.slice(own[0].length);
    }
    const eq = s.indexOf('=');
    const kind = (eq < 0 ? s : s.slice(0, eq)).trim().toLowerCase();
    if (!(STICK_PROPS as readonly string[]).includes(kind)) continue;
    out.push({ kind: kind as StickPropKind, who, value: eq < 0 ? '' : s.slice(eq + 1).trim() });
  }
  return out;
}

/** The second of the screen recording a beat's screen prop starts at, or null when no prop shows it. */
export function stickScreenStart(raw: string): number | null {
  for (const p of stickProps(raw)) {
    if (!SCREEN_PROPS.includes(p.kind)) continue;
    const m = /^(\d+(?:\.\d+)?)/.exec(p.value);
    if (m) return Number(m[1]);
  }
  return null;
}

/** The two poses of a beat ("think/type" = A thinks, B types; one pose = both). Unknown = idle. */
export function stickPoses(visual: string): [StickPose, StickPose] {
  const [a, b] = visual.split('/').map((x) => x.trim().toLowerCase());
  const pa = isStickPose(a) ? a : 'idle';
  const pb = b === undefined ? pa : isStickPose(b) ? b : 'idle';
  return [pa, pb];
}
