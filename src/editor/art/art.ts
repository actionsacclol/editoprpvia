// Visual styles for generated scenes, and the director that turns narration into beats. Pure: no canvas here.
//
// A visual style is a renderer plus a look: the stickman engine (hand-drawn figures and props) in five looks, and
// the 3D mascot in three. A section of a long video that names no pictures is acted out in the chosen style: one
// beat per sentence, the pose read from what is being said, or directed by the script's own scene cues.
import type { SpokenLine } from '../longform';
import { ACTIONS, isAction, type Art } from './mascotVocab';
import { STICK_POSES, STICK_PROPS, isStickPose, stickProps, type StickPose } from './stickVocab';
import type { StickLook } from './stickman';

export type ArtEngine = 'stick' | 'mascot';

export interface ArtStyle {
  id: string;
  name: string;
  about: string;
  engine: ArtEngine;
  look?: StickLook;
  art?: Art;
  /** The big word, the winner and other accents. */
  highlight: string;
  /** Title and chapter cards that sit well next to the scenes. */
  card: { background: string; accent: string };
}

export const ART_STYLES: ArtStyle[] = [
  { id: 'stickman', name: 'Stickman', about: 'Hand-drawn stick figures on paper: ink lines that boil, poses, faces, desks, phones, signs and speech bubbles.', engine: 'stick', look: 'paper', highlight: '#FF6B1A', card: { background: '#F3EFE6', accent: '#FF6B1A' } },
  { id: 'whiteboard', name: 'Whiteboard', about: 'The same figures in black marker on a clean white board, red for what matters.', engine: 'stick', look: 'whiteboard', highlight: '#FF3B30', card: { background: '#FFFFFF', accent: '#FF3B30' } },
  { id: 'chalkboard', name: 'Chalkboard', about: 'Chalk figures on a green board with a yellow highlight: lessons and explainers.', engine: 'stick', look: 'chalkboard', highlight: '#FFC400', card: { background: '#21392E', accent: '#FFC400' } },
  { id: 'blueprint', name: 'Blueprint', about: 'White line figures on a blue drafting grid: how things work, plans, engineering.', engine: 'stick', look: 'blueprint', highlight: '#5EEAD4', card: { background: '#123C7C', accent: '#5EEAD4' } },
  { id: 'night', name: 'Night sketch', about: 'White figures on black with a green highlight: stories, true crime, late-night topics.', engine: 'stick', look: 'night', highlight: '#22C55E', card: { background: '#0B0B0E', accent: '#22C55E' } },
  { id: 'clay', name: '3D render', about: 'A 3D mascot in a soft studio render (clay / toy look) with real shadows, acting out each line.', engine: 'mascot', art: '3d', highlight: '#7C5CFF', card: { background: '#E4DDF7', accent: '#5B3FD6' } },
  { id: 'cartoon', name: '3D cartoon', about: 'The 3D mascot toon-shaded with ink outlines on bright sunburst backdrops.', engine: 'mascot', art: 'cartoon', highlight: '#FFFFFF', card: { background: '#FFC83D', accent: '#161514' } },
  { id: 'retro', name: 'Retro 3D', about: 'The 3D mascot in a low-poly world with fog, dithering and scanlines, like an old console game.', engine: 'mascot', art: 'ps2', highlight: '#FFD53D', card: { background: '#0D1240', accent: '#E58F6A' } },
];

const ART_ALIASES: Record<string, string> = {
  stick: 'stickman',
  'stick-figure': 'stickman',
  'stick-man': 'stickman',
  paper: 'stickman',
  chalk: 'chalkboard',
  blackboard: 'chalkboard',
  marker: 'whiteboard',
  dark: 'night',
  '3d': 'clay',
  '3d-render': 'clay',
  render: 'clay',
  toy: 'clay',
  toon: 'cartoon',
  '3d-cartoon': 'cartoon',
  ps2: 'retro',
  'low-poly': 'retro',
  lowpoly: 'retro',
  'retro-3d': 'retro',
};

export function findArt(id: unknown): ArtStyle | undefined {
  const key = String(id ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return ART_STYLES.find((s) => s.id === key || s.name.toLowerCase().replace(/\s+/g, '-') === key) ?? ART_STYLES.find((s) => s.id === ART_ALIASES[key]);
}

/** What a script may say about a moment of a section. Everything is optional: what is left out is read from the words. */
export interface SceneCue {
  /** When it starts: seconds into the section's narration… */
  at?: number;
  /** …or the words being said as it starts. Neither = the cues are spread over the sentences in order. */
  when?: string;
  /** Stickman: a pose, or "poseA/poseB" for two figures. 3D: an action. */
  pose?: string;
  /** A big word that pops in beside the figure ("FREE", "40%"). */
  word?: string;
  /** Stickman only: "desk;laptop;sign=FREE;bubble=hello". */
  props?: string;
  camera?: 'wide' | 'close';
}

export interface ArtBeat {
  start: number;
  dur: number;
  pose: string;
  word: string;
  props: string;
  say: string;
  /** When in the beat the line is said (negative when the beat starts mid-line). */
  voStart: number;
  voDur: number;
  camera: 'wide' | 'close';
  push: boolean;
}

/** What the words suggest the figure does. First match wins; the order runs from the specific to the general. */
const RULES: Array<[RegExp, StickPose[]]> = [
  [/\b(hello|hi there|welcome|thanks|thank you|goodbye|see you)\b/i, ['wave']],
  [/\b(laugh\w*|funny|joke\w*|hilarious)\b/i, ['laugh']],
  [/\b(angry|furious|hate[sd]?|rage|annoy\w*|outrage\w*)\b/i, ['angry']],
  [/\b(asleep|sleep\w*|tired|exhausted|dream\w*|bedtime)\b/i, ['sleep']],
  [/\b(phone|call(ed|s|ing)?|texts?|message[sd]?|scroll\w*|notification\w*)\b/i, ['phone']],
  [/\b(computer|laptop|keyboard|typ(e|ed|ing)|cod(e|ed|ing)|online|internet|software|website|app|email\w*)\b/i, ['type']],
  [/\b(r[au]n(s|ning)?|rush\w*|hurr\w+|rac(e|ed|ing)|chas\w+|escap\w+|sprint\w*)\b/i, ['run']],
  [/\b(walk\w*|journey|travel\w*|miles|wander\w*|went|goes)\b/i, ['walk']],
  [/\b(fell|falls?|falling|collaps\w+|crash\w*|trip(ped|s)?)\b/i, ['fall']],
  [/\b(wrong|mistake\w*|fail\w*|oops|terrible|worst|disaster|ruin\w*|broke\w*)\b/i, ['facepalm', 'sad']],
  [/\b(sad|lost|alone|lonely|died|death|gone|miss(ed|ing)?|nothing left|empty)\b/i, ['sad']],
  [/\b(w[io]n|wins|best|great|amazing|success\w*|love[sd]?|perfect|finally|free|works?)\b/i, ['cheer', 'thumbsup']],
  [/\b(shock\w*|surpris\w+|suddenly|unbelievable|incredibl\w+|imagine that|no one expected)\b/i, ['shock']],
  [/\b(think\w*|thought|imagine|wonder\w*|consider|maybe|perhaps|what if|question)\b/i, ['think']],
  [/\b(first|second|third|next|then|step|here is|here's|this is|these are|look at|meet)\b/i, ['present', 'point']],
  [/\b(you|your|yours)\b/i, ['point', 'talk']],
];
const ROTATION: StickPose[] = ['talk', 'present', 'talk', 'point', 'think', 'talk', 'shrug'];
const CLOSE: StickPose[] = ['think', 'facepalm', 'sad', 'shock', 'laugh', 'angry'];

/** Stick poses the mascot has no action for. */
const AS_ACTION: Partial<Record<StickPose, string>> = { idle: 'talk', thumbsup: 'cheer', angry: 'shrug', walk: 'present', run: 'shock', sit: 'talk', type: 'think', phone: 'think', sleep: 'sad', fall: 'shock' };

function guess(text: string, i: number, before: string): StickPose {
  const s = text.trim();
  let options: StickPose[] | undefined;
  if (/\?\s*$/.test(s)) options = ['shrug', 'think'];
  else for (const [re, poses] of RULES) if (re.test(s)) {
    options = poses;
    break;
  }
  if (!options && /!\s*$/.test(s)) options = ['shock', 'cheer'];
  options ??= [ROTATION[i % ROTATION.length]];
  // Never the same pose twice running when there is a choice: a held pose reads as a frozen frame.
  return options.find((p) => p !== before) ?? (options[0] === before ? ROTATION[(i + 1) % ROTATION.length] : options[0]);
}

/** A figure worth showing big: "40%", "$3 million", "2,000 years". */
export function figureIn(text: string): string {
  const m = /(\$\s?\d[\d,.]*\s?(?:million|billion|trillion|thousand|k|m|bn)?|\d[\d,.]*\s?%|\d[\d,.]*\s(?:percent|million|billion|trillion|thousand|years|days|hours|miles|times))/i.exec(text);
  if (m) return m[1].replace(/\s?percent/i, '%').replace(/\s+/g, ' ').trim().toUpperCase();
  // Narration is written for the ear, so its numbers are usually words: "two million", "forty percent".
  const w = SPELLED.exec(text);
  if (!w) return '';
  const n = NUMBERS[w[1].toLowerCase()];
  const unit = w[2].toLowerCase();
  return unit === 'percent' ? `${n}%` : unit === 'hundred' ? String(n * 100) : `${n} ${unit.toUpperCase()}`;
}

const NUMBERS: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SPELLED = new RegExp(`\\b(${Object.keys(NUMBERS).join('|')})\\s(hundred|thousand|million|billion|trillion|percent)\\b`, 'i');

const poseFor = (engine: ArtEngine, pose: StickPose): string => (engine === 'stick' ? pose : isAction(pose) ? pose : (AS_ACTION[pose] ?? 'talk'));

/** A cue's pose in the engine's own words, or '' when it names nothing the engine knows. */
export function cuePose(engine: ArtEngine, raw: unknown): string {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!v) return '';
  if (engine === 'mascot') {
    const one = v.split('/')[0].trim();
    return isAction(one) ? one : isStickPose(one) ? poseFor('mascot', one) : '';
  }
  const parts = v.split('/').map((x) => x.trim());
  return parts.length <= 2 && parts.every(isStickPose) ? parts.join('/') : '';
}

/** What is wrong with a script's cues, in words the writer can act on. Empty = fine. */
export function cueProblems(cues: SceneCue[], engine: ArtEngine, where: string): string[] {
  const out: string[] = [];
  cues.forEach((c, i) => {
    if (c.pose && !cuePose(engine, c.pose)) out.push(`${where}: scene ${i + 1} has pose "${c.pose}". Use one of: ${(engine === 'stick' ? STICK_POSES : ACTIONS).join(', ')}${engine === 'stick' ? ' (or "a/b" for two figures)' : ''}.`);
    if (c.props && engine === 'stick') {
      const named = c.props.split(';').map((x) => x.trim()).filter(Boolean).length;
      if (stickProps(c.props).length < named) out.push(`${where}: scene ${i + 1} has a prop the stickman does not have. Use: ${STICK_PROPS.join(', ')} (; between them, =text for sign, bubble, think, arrow).`);
    }
  });
  return out;
}

/**
 * The beats of one stretch of narration: a beat per sentence, the pose read from its words, then the script's cues
 * laid over them (a cue that lands inside a sentence starts a new beat there).
 * `length` is how long the picture has to last (the narration plus the pause after it).
 */
export function directBeats(lines: SpokenLine[], length: number, cues: SceneCue[], engine: ArtEngine, phraseAt: (phrase: string) => number | null = () => null): ArtBeat[] {
  const total = Math.max(0.5, length);
  const beats: ArtBeat[] = [];
  let before = '';
  let words = 0;
  const src = lines.length ? lines : [{ start: 0, end: total, text: '' } as SpokenLine];
  src.forEach((l, i) => {
    // A beat starts a breath before its line, so the figure is already moving as the words begin.
    const start = i === 0 ? 0 : Math.max(beats[i - 1].start + 0.2, l.start - 0.12);
    const pose = guess(l.text, i, before);
    before = pose;
    // A figure in the line pops in as the big word, but not on every beat running.
    const fig = figureIn(l.text);
    const word = fig && words < 1 ? fig : '';
    words = word ? 1 : 0;
    const dur0 = (i + 1 < src.length ? Math.max(start + 0.2, src[i + 1].start - 0.12) : total) - start;
    beats.push({
      start,
      dur: dur0,
      pose: poseFor(engine, pose),
      word,
      props: engine === 'stick' && /\?\s*$/.test(l.text.trim()) ? 'question' : '',
      say: l.text,
      voStart: l.start - start,
      voDur: Math.max(0.1, l.end - l.start),
      camera: CLOSE.includes(pose) && i > 0 ? 'close' : 'wide',
      push: dur0 > 4.5,
    });
  });

  // Cues with a time or a phrase go where they say; the rest are spread over the sentences in order.
  const loose = cues.filter((c) => c.at === undefined && !c.when);
  let k = 0;
  const placed = cues
    .map((c) => {
      let at = c.at;
      if (at === undefined && c.when) at = phraseAt(c.when) ?? undefined;
      if (at === undefined) {
        const line = src[Math.min(src.length - 1, Math.floor((k * src.length) / Math.max(1, loose.length)))];
        k++;
        at = line === src[0] ? 0 : line.start - 0.12;
      }
      // A phrase is found at its first telling word, which is often a word or two into the sentence it opens.
      return { cue: c, at: Math.min(Math.max(0, at), total - 0.3), slack: c.at === undefined && c.when ? 1.3 : 0.6 };
    })
    .sort((x, y) => x.at - y.at);
  for (const { cue, at, slack } of placed) {
    let i = 0;
    for (let n = 0; n < beats.length; n++) if (beats[n].start <= at + 1e-6) i = n;
    let b = beats[i];
    if (at - b.start > slack && b.start + b.dur - at > 0.6) {
      // Mid-sentence: the beat is cut in two there; the second half keeps the line (its mouth keeps moving).
      const rest: ArtBeat = { ...b, start: at, dur: b.start + b.dur - at, voStart: b.voStart - (at - b.start), word: '', push: false };
      b.dur = at - b.start;
      b.push = false;
      beats.splice(i + 1, 0, rest);
      b = rest;
    }
    const pose = cuePose(engine, cue.pose);
    if (pose) b.pose = pose;
    if (cue.word !== undefined) b.word = String(cue.word).trim().slice(0, 40);
    if (cue.props !== undefined && engine === 'stick') b.props = String(cue.props).trim();
    if (cue.camera === 'wide' || cue.camera === 'close') b.camera = cue.camera;
  }
  return beats;
}

/** What list_formats tells an agent about the visual styles. */
export function artHelp(): { visual_styles: Array<{ id: string; name: string; what_it_draws: string }>; scenes: string } {
  return {
    visual_styles: ART_STYLES.map((s) => ({ id: s.id, name: s.name, what_it_draws: s.about })),
    scenes:
      `With visual_style, every section that names no visuals is drawn and acted out: one beat per sentence, the pose read from the words, the mouth moving with the voice, figures like "40%" popping in as a big word. ` +
      `To direct it, give a section scenes: [{ when, pose, word, props, camera }], all optional. when = the words being said as the beat starts (or at = seconds); without either the scenes are spread over the sentences in order. ` +
      `Stickman styles (stickman, whiteboard, chalkboard, blueprint, night): pose is one of ${STICK_POSES.join(', ')}, or "poseA/poseB" to put two figures on stage (keep it two for the whole section); ` +
      `props is a list with ; between them from ${STICK_PROPS.join(', ')}, where =text sets what a sign, bubble, think or arrow says (sign=FREE; bubble=Wait, what?) and chart=up|down|flat draws that chart. sit, type, phone and sleep bring their own chair, desk, laptop or phone. ` +
      `3D styles (clay, cartoon, retro): pose is one of ${ACTIONS.join(', ')}; no props. word = a big word beside the figure, a few characters ("FREE", "3 AM"); camera = wide or close.`,
  };
}
