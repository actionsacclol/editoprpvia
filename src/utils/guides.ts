/**
 * The video guides (Guides page) and the ways to start a video (the top bar's
 * "Make a video with AI"). Data only, so both can be checked by a test.
 *
 * The videos are in resources/guides and are served by the app itself
 * (`krypteditor://guides/<file>`), so they play offline. They were made in
 * Krypt Editor: the screen films are narrated by the built-in voice.
 */

/** Something the app can open for the person: a dialog on the editor page, or the agents panel. */
export type Feature = 'longform' | 'web' | 'record' | 'app' | 'agents' | 'import' | 'thumbnail' | 'channel';

export interface GuideChapter {
  /** Seconds into the video. */
  at: number;
  label: string;
}

export interface Guide {
  id: string;
  title: string;
  /** One line under the title. */
  summary: string;
  /** Length of the video. */
  seconds: number;
  /** File names in resources/guides. */
  file: string;
  poster: string;
  chapters: GuideChapter[];
  /** What "Try it now" opens. */
  action: { label: string; feature: Feature };
}

export const GUIDES: Guide[] = [
  {
    id: 'first-edit',
    title: 'Your first edit',
    summary: 'Bring in a clip, cut out a part, add a title and export.',
    seconds: 60,
    file: 'first-edit.mp4',
    poster: 'first-edit.jpg',
    chapters: [
      { at: 0, label: 'Intro' },
      { at: 9.4, label: 'Bring in your clip' },
      { at: 20.5, label: 'Cut out a part' },
      { at: 33.3, label: 'Add a title' },
      { at: 41.5, label: 'Export' },
    ],
    action: { label: 'Import a clip', feature: 'import' },
  },
  {
    id: 'video-from-script',
    title: 'A whole video from a script',
    summary: 'Type what it should say. The voice, titles, pictures and captions are made for you.',
    seconds: 66,
    file: 'video-from-script.mp4',
    poster: 'video-from-script.jpg',
    chapters: [
      { at: 0, label: 'Intro' },
      { at: 11.9, label: 'Open Make a video' },
      { at: 18.2, label: 'Pick a format and a look' },
      { at: 31.3, label: 'Write the script' },
      { at: 43.6, label: 'Build it' },
    ],
    action: { label: 'Open Longform', feature: 'longform' },
  },
  {
    id: 'film-website',
    title: 'Film a website',
    summary: 'Give an address and what to click. It films the page and zooms in on every click.',
    seconds: 62,
    file: 'film-website.mp4',
    poster: 'film-website.jpg',
    chapters: [
      { at: 0, label: 'Intro' },
      { at: 12.4, label: 'Open Film a web page' },
      { at: 18.2, label: 'Give it the address' },
      { at: 28.3, label: 'Say what to do' },
      { at: 39.8, label: 'Film it' },
    ],
    action: { label: 'Film a web page', feature: 'web' },
  },
  {
    id: 'product-demo',
    title: 'Record a product demo',
    summary: 'Record a window. Zooms, click highlights and a window frame are added when it lands.',
    seconds: 59,
    file: 'product-demo.mp4',
    poster: 'product-demo.jpg',
    chapters: [
      { at: 0, label: 'Intro' },
      { at: 11.4, label: 'Open Record' },
      { at: 17.3, label: 'Pick the window' },
      { at: 26.3, label: 'Record and click around' },
      { at: 37.5, label: 'It lands as a product demo' },
    ],
    action: { label: 'Open Record', feature: 'record' },
  },
  {
    id: 'ai-agent',
    title: 'Let an AI agent edit',
    summary: 'Connect Claude, Codex, Cursor or another agent once, then ask for the edit in plain words.',
    seconds: 64,
    file: 'ai-agent.mp4',
    poster: 'ai-agent.jpg',
    chapters: [
      { at: 0, label: 'Intro' },
      { at: 10.4, label: 'Connect your agent' },
      { at: 22.7, label: 'Ask in plain words' },
      { at: 33.1, label: 'Watch it work' },
      { at: 44.6, label: 'You stay in charge' },
    ],
    action: { label: 'Connect an agent', feature: 'agents' },
  },
];

export const findGuide = (id: string | null | undefined): Guide | undefined => GUIDES.find((g) => g.id === id);

/** Where the app serves a guide's file from. */
export const guideUrl = (file: string): string => `krypteditor://guides/${encodeURIComponent(file)}`;

/** The only file names the app serves from the guides folder. */
export const GUIDE_FILE = /^[a-z0-9-]+\.(mp4|jpg)$/;

/** 75 → "1:15". */
export function guideClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The chapter playing at a time (the last one that has started). */
export function chapterAt(guide: Guide, time: number): number {
  let n = -1;
  guide.chapters.forEach((c, i) => {
    if (time + 0.05 >= c.at) n = i;
  });
  return n;
}

export interface MakeWay {
  id: 'script' | 'website' | 'screen' | 'agent';
  title: string;
  text: string;
  /** What it needs before it works, in a few words. */
  needs: string;
  button: string;
  feature: Feature;
  /** The guide that shows it. */
  guide: string;
}

/** The four ways to have a video made, in the order they are offered. */
export const MAKE_WAYS: MakeWay[] = [
  {
    id: 'script',
    title: 'From a script',
    text: 'Type or paste what the video should say. It is read out in a built-in voice, with a title, chapter cards, pictures or drawn scenes, captions and chapters.',
    needs: 'Works offline. No account, no agent.',
    button: 'Write the script',
    feature: 'longform',
    guide: 'video-from-script',
  },
  {
    id: 'website',
    title: 'From a website',
    text: 'Give an address and what to click, one step per line. The page is opened out of sight, filmed, and the video zooms in on every click.',
    needs: 'Needs the page to be reachable from this computer.',
    button: 'Film a web page',
    feature: 'web',
    guide: 'film-website',
  },
  {
    id: 'screen',
    title: 'From an app on your screen',
    text: 'Record any app or website once, clicking through what you want to show. It is cut into steps where you clicked and built into a guide, a product demo or a trailer, zooming in on every click.',
    needs: 'You do the clicking and name the steps; the edit is made for you.',
    button: 'Make a video of an app',
    feature: 'app',
    guide: 'product-demo',
  },
  {
    id: 'agent',
    title: 'Hand it to your AI agent',
    text: 'Connect Claude, Codex, Cursor or another agent once. Then say what you want: it writes the script, films, edits and exports while you watch.',
    needs: 'Needs an AI agent app on this computer.',
    button: 'Connect an agent',
    feature: 'agents',
    guide: 'ai-agent',
  },
];
