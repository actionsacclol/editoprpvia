import { duckKeys, duckSpans, DUCK } from './ducking';
import type { Range } from './autoEdit';
import { sentences } from './kokoro/g2p';
import { buildCard, buildKeyPoints, buildStinger, cardPalette, fitText, makeRoom, rectClip, spacedCaps, textClip, type CardText } from './scenes';
import type { CardLook } from './styles';
import { MIN_CLIP, REF_HEIGHT, captionClipsFor, newMediaClip, uid, type Canvas, type Clip, type MediaClip, type MotionAnim, type TextClip, type TransitionType } from './timelineStore';

/**
 * Long-form videos built whole from a script: a format (explainer,
 * documentary, video essay, top list, tutorial, lecture) says how the video is
 * put together, the script says what is in it, and planLongform lays out every
 * clip: narration, pictures that never sit still for long, chapter cards, key
 * points timed to the words, captions, a music bed ducked under the voice, an
 * intro and an outro.
 *
 * Everything here is pure: the narration has been spoken and measured and the
 * media probed by the caller (agentTools.ts), so a plan is a function of its
 * input and can be tested without the app.
 */

// ── Formats ────────────────────────────────────────────────────────────────
export type Kicker = 'none' | 'part' | 'chapter' | 'step' | 'number' | 'feature' | 'round' | 'story';

export interface LongformFormat {
  id: string;
  name: string;
  description: string;
  /** The edit style it is dressed in when the user has not chosen one. */
  style: string;
  /** card = title card first. cold-open = the hook plays first, then the title. */
  intro: 'card' | 'cold-open';
  /** How a section opens: a full-screen card, a lower third over its first picture, or nothing. */
  chapter: 'card' | 'overlay' | 'none';
  kicker: Kicker;
  /** A top list that counts down to number one. */
  countdown?: boolean;
  /** A colour sweep into each section card. */
  stinger?: boolean;
  /** The section headings as a recap list under the outro narration. */
  recap?: boolean;
  /** Key points as 1 2 3 (steps, ranks). */
  numbered?: boolean;
  /** What the recap list is called (default "Recap"). */
  recapTitle?: string;
  /** Pictures are shown as windows: whole, with rounded corners and a shadow, on the backdrop. */
  framed?: boolean;
  /** A section with two pictures or more shows them in pairs, side by side: the first thing on the left, the second on the right. */
  split?: boolean;
  /** The two colours behind framed or split pictures (top, bottom). */
  backdrop?: [string, string];
  /** Pictures are shown whole unless a visual says fill (charts, documents). */
  whole?: boolean;
  /** The sections' headings as a list under the opening narration, under this heading. */
  rundown?: string;
  /** A bar across the top that fills as the sections go by. */
  progress?: boolean;
  /** A section's figure is its card: the number large, the heading under it. */
  figures?: boolean;
  /** Lines that start "Name:" are spoken in two voices and shown with the speaker's name. */
  speakers?: boolean;
  /**
   * Pictures are comic panels: each cut in on its words and held in one framing; one that stays up `hold` seconds
   * or longer moves a little. Drawn sections are a still per sentence instead of an acted-out scene.
   */
  panels?: boolean;
  /** Sections without pictures are drawn in this visual style unless another (or none) is asked for. */
  visualStyle?: string;
  /**
   * Laid out by a planner of its own instead of planLongform: a trailer (trailer.ts: text and footage cut to a
   * beat, nothing has to be spoken) or a quiz (quiz.ts: question, answers, countdown, reveal).
   */
  layout?: 'trailer' | 'quiz';
  /** Motions the pictures cycle through. */
  motions: MotionAnim[];
  motionAmount: number;
  /** Longest a still stays in one framing, seconds. */
  hold: number;
  introSeconds: number;
  cardSeconds: number;
  outroSeconds: number;
  /** The breath after a section's last word, seconds. */
  gap: number;
  captions: boolean;
  outroTitle: string;
  /** The same advice in a sentence or two for the person typing a script into the dialog. */
  tip: string;
  /** How to write a script for it. */
  write: string;
}

const PACE = 'About 150 spoken words a minute: 750 words is five minutes, 1,500 is ten.';

export const LONGFORM_FORMATS: LongformFormat[] = [
  {
    id: 'explainer',
    name: 'Explainer',
    description: 'A narrated explainer: title, one chapter card per part, pictures with slow moves, the takeaways beside them, captions.',
    style: 'explainer',
    intro: 'card',
    chapter: 'card',
    kicker: 'part',
    motions: ['zoom-in', 'pan-right', 'zoom-out', 'pan-left'],
    motionAmount: 0.6,
    hold: 7,
    introSeconds: 3.5,
    cardSeconds: 2.6,
    outroSeconds: 4,
    gap: 0.45,
    captions: true,
    outroTitle: 'Thanks for watching',
    tip: "Open with two or three sentences on what the viewer will know by the end. Four to seven sections, one idea each, with two to four short key points.",
    write: `hook: two or three sentences that say what the viewer will know by the end. 4 to 7 sections of 100 to 250 words, one idea each, the heading a plain phrase. Two to four points per section, a few words each, in the order they are said. ${PACE}`,
  },
  {
    id: 'documentary',
    name: 'Documentary',
    description: 'A cold open, then the title; chapters named in a lower third over the footage; slow pans over stills, dips between scenes.',
    style: 'documentary',
    intro: 'cold-open',
    chapter: 'overlay',
    kicker: 'chapter',
    motions: ['pan-right', 'zoom-in', 'pan-left', 'zoom-out'],
    motionAmount: 0.8,
    hold: 9,
    introSeconds: 4.5,
    cardSeconds: 3,
    outroSeconds: 5,
    gap: 0.9,
    captions: true,
    outroTitle: 'The end',
    tip: "Open with the most striking moment of the story; it plays before the title. Four to eight chapters told in order, each with several pictures.",
    write: `hook: the most striking moment or question of the story, 30 to 60 words, played before the title. 4 to 8 chapters of 150 to 300 words told in order, each with several pictures (photos, footage, documents). Points only for dates and figures. Measured sentences, no hype. ${PACE}`,
  },
  {
    id: 'video-essay',
    name: 'Video essay',
    description: 'An argument in the first person: a cold open, quiet chapter cards, the words themselves on screen where there is no picture.',
    style: 'video-essay',
    intro: 'cold-open',
    chapter: 'card',
    kicker: 'none',
    motions: ['zoom-in', 'zoom-out'],
    motionAmount: 0.7,
    hold: 8,
    introSeconds: 4,
    cardSeconds: 2.8,
    outroSeconds: 4.5,
    gap: 0.7,
    captions: true,
    outroTitle: 'Thank you for watching',
    tip: "Open with the claim or the question. Three to six sections that build one argument. A section without pictures shows its sentences as text.",
    write: `hook: the claim or the question, in under 50 words. 3 to 6 sections of 200 to 350 words that build one argument, each heading a short phrase. A section without pictures shows its sentences as text, so write sentences worth reading. Points are rarely needed. ${PACE}`,
  },
  {
    id: 'listicle',
    name: 'Top list',
    description: 'A ranked list counted down to number one: a big number card and a colour sweep into every entry, quick pictures, punchy captions.',
    style: 'top-list',
    intro: 'card',
    chapter: 'card',
    kicker: 'number',
    countdown: true,
    stinger: true,
    motions: ['zoom-in', 'pan-left', 'zoom-in', 'pan-right'],
    motionAmount: 0.9,
    hold: 5,
    introSeconds: 3,
    cardSeconds: 2.2,
    outroSeconds: 3.5,
    gap: 0.3,
    captions: true,
    outroTitle: 'Which one was yours?',
    tip: "One section per entry, last place first and number one at the end: the cards count down by themselves. The heading is the entry's name.",
    write: `One section per entry, in the order they are shown: the first section is the LAST place and the final section is number one (the cards count down by themselves). 5 to 10 entries of 60 to 150 words; the heading is the entry's name. hook: what the list ranks and why the top spot is worth waiting for. ${PACE}`,
  },
  {
    id: 'tutorial',
    name: 'Tutorial',
    description: 'A how-to in numbered steps: a step card before each one, screenshots or recordings that stay readable, the steps as a recap at the end.',
    style: 'clean-tutorial',
    intro: 'card',
    chapter: 'card',
    kicker: 'step',
    recap: true,
    numbered: true,
    motions: ['zoom-in', 'zoom-out'],
    motionAmount: 0.4,
    hold: 10,
    introSeconds: 3.5,
    cardSeconds: 2.4,
    outroSeconds: 4,
    gap: 0.5,
    captions: true,
    outroTitle: 'That is it',
    tip: "Open with what the viewer will have made by the end. One section per step, the heading an instruction, with screenshots or screen recordings.",
    write: `hook: what the viewer will have made or fixed by the end, and what they need. One section per step, 60 to 200 words, the heading an instruction ("Install the tool"). Screenshots or screen recordings as visuals, each with when: the words spoken as it should come up. Points are the things to click or type. outro text: one sentence to wrap up (the steps are listed under it). ${PACE}`,
  },
  {
    id: 'lecture',
    name: 'Lecture',
    description: 'A lesson: part cards, slides or diagrams held long enough to read, the key points building beside them, readable captions.',
    style: 'lecture',
    intro: 'card',
    chapter: 'card',
    kicker: 'part',
    motions: ['zoom-in', 'none'],
    motionAmount: 0.4,
    hold: 16,
    introSeconds: 4,
    cardSeconds: 3,
    outroSeconds: 4,
    gap: 0.6,
    captions: true,
    outroTitle: 'Thanks for watching',
    tip: "Open with what the lesson covers and who it is for. Four to eight sections, slides or diagrams as pictures, three to five key points each.",
    write: `hook: what the lesson covers and who it is for. 4 to 8 sections of 200 to 400 words. Slides (import_slides) or diagrams as visuals, each with when: the words spoken as it should come up. Three to five points per section, each a few words, in the order they are said. ${PACE}`,
  },
  {
    id: 'product-walkthrough',
    name: 'Product walkthrough',
    description: 'A product shown feature by feature: each recording in a window frame on a backdrop, the feature named in a lower third, what it does listed at the end.',
    style: 'clean-tutorial',
    intro: 'card',
    chapter: 'overlay',
    kicker: 'feature',
    recap: true,
    recapTitle: 'What it does',
    framed: true,
    backdrop: ['#4F46E5', '#A855F7'],
    motions: ['zoom-in', 'none'],
    motionAmount: 0.25,
    hold: 12,
    introSeconds: 3.5,
    cardSeconds: 2.4,
    outroSeconds: 4,
    gap: 0.5,
    captions: true,
    outroTitle: 'Try it yourself',
    tip: 'Open with the problem the product solves. One section per feature, the heading what it does for the viewer, with a screen recording or screenshot of it.',
    write: `hook: the problem the product solves, in two or three sentences. 3 to 7 sections, one feature each, 50 to 150 words; the heading is what the feature does for the viewer ("Find any note in a second"), not its name in the menu. Each section needs a recording or a screenshot of the feature as its visual: for a website film it with capture_web (demo: false, add_to_timeline: false) and pass the file; for a desktop app, record_window. Say only what the product page or the app itself shows; no made-up numbers. outro text: where to get it. ${PACE}`,
  },
  {
    id: 'comparison',
    name: 'Comparison',
    description: 'X against Y, round by round: both on screen side by side under their names, the winner of each round marked, the verdict listed at the end.',
    style: 'top-list',
    intro: 'card',
    chapter: 'card',
    kicker: 'round',
    recap: true,
    recapTitle: 'The verdict',
    split: true,
    backdrop: ['#0F172A', '#334155'],
    motions: ['zoom-in', 'zoom-out'],
    motionAmount: 0.5,
    hold: 7,
    introSeconds: 3.2,
    cardSeconds: 2.2,
    outroSeconds: 4,
    gap: 0.4,
    captions: true,
    outroTitle: 'Which would you pick?',
    tip: 'Title it "X vs Y". One section per thing you compare them on (price, speed, battery), judged the same way for both. Two pictures in a section show side by side.',
    write: `title: "X vs Y" (the two names label the two sides; or pass sides). hook: who is choosing between them and why it is close. 3 to 6 sections, one per criterion (the heading: "Price", "Battery life"), 60 to 150 words, judging both by the same measure. Per section: two visuals, the first of X and the second of Y, shown side by side; winner: the name of the side that takes the round (or "Tie"). Figures need a source you checked; say when something is your judgement. outro text: who should pick which. ${PACE}`,
  },
  {
    id: 'news-recap',
    name: 'News recap',
    description: 'The stories of the day or week: a rundown of the headlines over the opening, each story named in a lower third, a colour sweep between stories, a quick pace.',
    style: 'explainer',
    intro: 'card',
    chapter: 'overlay',
    kicker: 'story',
    stinger: true,
    rundown: 'In this video',
    motions: ['zoom-in', 'pan-right', 'zoom-in', 'pan-left'],
    motionAmount: 0.7,
    hold: 6,
    introSeconds: 3,
    cardSeconds: 2.2,
    outroSeconds: 3.5,
    gap: 0.35,
    captions: true,
    outroTitle: 'That is the roundup',
    tip: 'Put the date in the subtitle. Open with one sentence per story (the headlines list themselves under it). One section per story: what happened, then why it matters.',
    write: `subtitle: the date or the week. hook: one sentence per story, in order (the headings are listed on screen under it). 3 to 7 sections, one story each, 60 to 160 words: what happened first, then why it matters; the heading is the headline in under eight words. Every claim needs a source you read: name it in the narration ("according to…"). Visuals: your own screenshots of the source pages (capture_web with record: false, or film the page), or pictures you have the right to use. No guesses presented as news. ${PACE}`,
  },
  {
    id: 'data-story',
    name: 'Data story',
    description: 'A story told through numbers: each part opens on its figure, large; charts are shown whole and held long enough to read.',
    style: 'explainer',
    intro: 'cold-open',
    chapter: 'card',
    kicker: 'none',
    figures: true,
    whole: true,
    motions: ['zoom-in', 'none'],
    motionAmount: 0.3,
    hold: 12,
    introSeconds: 3.5,
    cardSeconds: 2.8,
    outroSeconds: 4,
    gap: 0.6,
    captions: true,
    outroTitle: 'The numbers, in short',
    tip: 'Open with the most surprising number. One section per figure: add a line "Figure: 73%" under the heading and it becomes that part\'s card.',
    write: `hook: the most surprising number and the question it raises, under 50 words. 3 to 6 sections, one figure each, 80 to 200 words: what the number is, what it is measured against, what it means. Per section, figure: the number as it should appear ("73%", "$4.2B", "1 in 5"), with the heading saying what it counts. Charts as visuals (they are shown whole, never cropped). Every number needs a source you checked and its year, said in the narration; round honestly. ${PACE}`,
  },
  {
    id: 'timeline',
    name: 'Timeline',
    description: 'A history or a case study in order: each moment under its date, a bar across the top that fills as the story moves on, slow pans over the pictures.',
    style: 'documentary',
    intro: 'cold-open',
    chapter: 'overlay',
    kicker: 'none',
    progress: true,
    motions: ['pan-right', 'zoom-in', 'pan-left', 'zoom-out'],
    motionAmount: 0.7,
    hold: 9,
    introSeconds: 4,
    cardSeconds: 2.8,
    outroSeconds: 4.5,
    gap: 0.7,
    captions: true,
    outroTitle: 'And that is how it happened',
    tip: 'Open with how it ended, then go back to the start. One section per moment, in order: add a line "Date: March 2020" under the heading.',
    write: `hook: where the story ends up, 30 to 60 words, played before the title. 4 to 8 sections in the order things happened, 100 to 250 words each; the heading is what happened, and kicker is when ("March 2020", "Day 3", "Six months in"): it is shown above the heading. For a case study: the situation, the decision, what was done, the result, with the numbers. Dates and figures need a source you checked. ${PACE}`,
  },
  {
    id: 'podcast',
    name: 'Podcast',
    description: 'A conversation between two voices, topic by topic: each line appears with the name of who says it, quiet cards between topics.',
    style: 'podcast-clip',
    intro: 'card',
    chapter: 'card',
    kicker: 'none',
    speakers: true,
    motions: ['zoom-in', 'zoom-out'],
    motionAmount: 0.5,
    hold: 9,
    introSeconds: 3.5,
    cardSeconds: 2.4,
    outroSeconds: 4,
    gap: 0.6,
    captions: true,
    outroTitle: 'Thanks for listening',
    tip: 'Write it as a conversation: start each turn with the speaker\'s name and a colon ("Maya: …", "Tom: …"). Two speakers, short turns, one topic per section.',
    write: `A scripted conversation between two speakers. In every text, start each turn with the speaker's name and a colon ("Maya: So what went wrong?" "Tom: Almost everything."); the first name speaks in voice, the second in voice2. Short turns, one to three sentences, the way people talk: questions, reactions, one idea at a time. hook: the two of them setting up the question. 3 to 6 sections, one topic each, 120 to 300 words; the heading is the topic. These are invented hosts: never put words in a real person's mouth. To cut a real recorded interview instead, use auto_edit and add_title_card on the recording. ${PACE}`,
  },
  {
    id: 'commentary',
    name: 'Commentary',
    description: 'Your take over footage: the clip in a window frame on a backdrop, a presenter in the corner when there is one, each point named in a lower third.',
    style: 'vlog-warm',
    intro: 'cold-open',
    chapter: 'overlay',
    kicker: 'none',
    framed: true,
    backdrop: ['#1F2937', '#0B1120'],
    motions: ['none'],
    motionAmount: 0.2,
    hold: 14,
    introSeconds: 3.2,
    cardSeconds: 2.4,
    outroSeconds: 4,
    gap: 0.5,
    captions: true,
    outroTitle: 'What do you think?',
    tip: 'Open with your opinion in one line. One section per point you make, each with the clip or screenshot you are talking about.',
    write: `hook: your opinion in a sentence or two, before the title. 3 to 6 sections, one point each, 100 to 250 words, in the first person; the heading is the point. Per section, the clip or screenshot being discussed as its visual (in_point picks the moment). presenter (on the whole script): a camera or green-screen recording of the commentator, kept in the corner throughout. Use footage the user has the right to show, in short excerpts that the commentary is actually about, and say whose it is. ${PACE}`,
  },
  {
    id: 'comic-story',
    name: 'Comic story',
    description: 'A story told in comic panels: one drawing per sentence, cut in on the words. A panel that stays up a few seconds pushes in or drifts a little. Drawn for you (stickman unless you pick another style), or your own pictures as the panels.',
    style: 'explainer',
    intro: 'cold-open',
    chapter: 'overlay',
    kicker: 'chapter',
    panels: true,
    visualStyle: 'stickman',
    motions: ['zoom-in', 'pan-right', 'zoom-out', 'pan-left'],
    motionAmount: 0.4,
    hold: 4,
    introSeconds: 3,
    cardSeconds: 2.4,
    outroSeconds: 4,
    gap: 0.35,
    captions: true,
    outroTitle: 'The end',
    tip: "Tell it as a story, in short sentences: every sentence is one panel, so let one thing happen in each. Start in the middle of the action.",
    write: `hook: the first lines of the story, in the middle of the action, played before the title. 3 to 8 sections (the scenes of the story) of 80 to 250 words. Short sentences, 6 to 14 words, one thing happening in each: every sentence becomes one panel, and a long sentence is a panel that sits there. No points. To direct a panel give the section scenes: [{ when, pose, props, word }] (a bubble for what someone says: props "bubble=Not again"; two figures: pose "talk/shock"). With pictures of your own (drawings, AI images), pass them as visuals with when: each is a panel. ${PACE}`,
  },
  {
    id: 'trailer',
    name: 'Software trailer',
    description: 'A launch trailer for an app, a tool or a website, 30 to 90 seconds, cut to a beat: short opening lines that come up word by word over the app leaning back in space, the name landing on a hit, each feature as a headline over its recording in a window (it comes in at an angle, turns to face the viewer and moves in on the part that matters) with callouts, and an end card with where to get it. Text and music carry it; a voice-over is optional. It makes its own beat when no song is given.',
    style: 'trailer',
    layout: 'trailer',
    intro: 'cold-open',
    chapter: 'card',
    kicker: 'none',
    framed: true,
    backdrop: ['#0B1020', '#312E81'],
    motions: ['zoom-in'],
    motionAmount: 0.3,
    hold: 5,
    introSeconds: 3,
    cardSeconds: 1.2,
    outroSeconds: 4.5,
    gap: 0.3,
    captions: false,
    outroTitle: 'Try it today',
    tip: 'The title is the product\'s name and the line under it its tagline. The opening lines are shown large, one at a time. One section per feature: the heading is the headline, a file path under it is the recording shown, bullets are callouts. End with "## Outro" and where to get it.',
    write: `title: the product's name. subtitle: its tagline (under the name, and again on the end card). hook: one to three short lines, a sentence of 3 to 8 words each, shown one at a time, large, before the name lands: the problem or the promise ("Markets move fast. You have a day job."). 3 to 6 sections, one feature each. heading: the headline on screen, 2 to 6 words, what it does for the viewer ("Scans every market for you"). visuals: a recording or a screenshot of exactly that feature (capture_web with demo: false and add_to_timeline: false for a website, record_window for a desktop app; in_point picks the moment), shown in a window for about four seconds (seconds changes it). points: up to three callouts of a few words that pop up over the recording. text: one short sentence, shown under the headline, and spoken when voiceover is true. outro: title is the call to action ("Download free"), subtitle is where ("example.com"), note is small print at the foot (a disclaimer, the platforms). music: a song of the user's (the cuts land on its beat), "none", or leave it out for a beat made for this video. logo: the product's logo file, for the name card and the end card. Say only what the product page or the app itself shows: no made-up numbers, no praise nobody gave, no promises of results. 30 to 90 seconds in all.`,
  },
  {
    id: 'quiz',
    name: 'Quiz',
    description: 'A quiz to play along with: each question read out and shown with its answers, a countdown that ticks, then the right answer lighting up with a line about it. A picture beside the question when there is one.',
    style: 'quiz',
    layout: 'quiz',
    intro: 'card',
    chapter: 'card',
    kicker: 'none',
    stinger: true,
    motions: ['zoom-in'],
    motionAmount: 0.3,
    hold: 8,
    introSeconds: 3.5,
    cardSeconds: 2,
    outroSeconds: 4.5,
    gap: 0.5,
    captions: false,
    outroTitle: 'How many did you get?',
    tip: 'One section per question: the heading is the question, the bullets under it are the answers, then a line "Answer: …" and a sentence to say once it is shown. A file path in a section is a picture beside the question.',
    write: `hook: what the quiz is about, how many questions, and the rule, in two sentences ("Ten questions about space. You get five seconds each."). 5 to 20 sections, one question each. heading: the question, as it is read out and shown, under 16 words. options: two to four answers, a few words each. answer: the right one (its text, its letter, or its number). text: one or two sentences said once the answer is shown: why it is right, or something worth knowing about it. visuals: one picture shown beside the question (a flag, a landmark, a film still), when the question is about it. Easy questions first, the hard ones last. Every answer needs a source you checked: one wrong answer spoils a quiz. Do not give the answer away in the question or the picture's file name. think_seconds changes the countdown (default 5). outro text: how to score yourself, or a question for the comments.`,
  },
];

export function findFormat(nameOrId: unknown): LongformFormat | undefined {
  const k = String(nameOrId ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  const alias: Record<string, string> = {
    'top-list': 'listicle',
    countdown: 'listicle',
    list: 'listicle',
    essay: 'video-essay',
    'how-to': 'tutorial',
    howto: 'tutorial',
    doc: 'documentary',
    walkthrough: 'product-walkthrough',
    'product-demo': 'product-walkthrough',
    'product-tour': 'product-walkthrough',
    'app-walkthrough': 'product-walkthrough',
    versus: 'comparison',
    vs: 'comparison',
    'x-vs-y': 'comparison',
    news: 'news-recap',
    roundup: 'news-recap',
    'weekly-roundup': 'news-recap',
    recap: 'news-recap',
    data: 'data-story',
    'data-video': 'data-story',
    history: 'timeline',
    'case-study': 'timeline',
    interview: 'podcast',
    conversation: 'podcast',
    reaction: 'commentary',
    'commentary-video': 'commentary',
    comic: 'comic-story',
    'comic-book': 'comic-story',
    'story-panels': 'comic-story',
    storyboard: 'comic-story',
    'stickman-story': 'comic-story',
    'software-trailer': 'trailer',
    'app-trailer': 'trailer',
    'launch-video': 'trailer',
    'launch-trailer': 'trailer',
    'product-trailer': 'trailer',
    promo: 'trailer',
    teaser: 'trailer',
    trivia: 'quiz',
    'quiz-video': 'quiz',
    'trivia-quiz': 'quiz',
  };
  return LONGFORM_FORMATS.find((f) => f.id === (alias[k] ?? k) || f.name.toLowerCase().replace(/\s+/g, '-') === k);
}

// ── The script ─────────────────────────────────────────────────────────────
/** A picture for a section. `source` is a media id or a file path until the caller resolves it to `mediaId`. */
export interface LongformVisual {
  mediaId: string;
  /** When it comes up, seconds into the section's narration. */
  at?: number;
  /** …or the words being said as it comes up. */
  when?: string;
  /** Where in a video to start, seconds. */
  inPoint?: number;
  /**
   * Where in a video to stop, seconds: exactly the stretch inPoint..outPoint is shown, once, fitted to the time it
   * has (sped up or slowed, and held on its last frame when the narration runs longer still). For a step of a screen
   * recording, where what happens matters and a loop would show the next step.
   */
  outPoint?: number;
  motion?: MotionAnim;
  /** fill = cover the frame (the edges are cropped); fit = show all of it. */
  fit?: 'fill' | 'fit';
  /** A trailer: the part of the picture that matters (0..1 across and down it). The window moves in on it, `zoom` times larger (default 1.6). */
  focus?: { x: number; y: number; zoom?: number };
}

/** Someone presenting over the pictures: a green-screen clip or a camera, in a corner. */
export interface LongformPresenter {
  mediaId: string;
  greenScreen?: boolean;
  corner?: 'bottom-right' | 'bottom-left';
  /** Height as a fraction of the frame. */
  size?: number;
}

export interface LongformSection {
  heading: string;
  /** What the narrator says. */
  text: string;
  points?: string[];
  visuals?: LongformVisual[];
  presenter?: LongformPresenter;
  /** The small line above the heading, in place of the format's own ("Part 2"): a date, a place. */
  kicker?: string;
  /** A number to open the section on ("73%"), in a format that shows figures. */
  figure?: string;
  /** Who takes this round of a comparison: one of the two sides, or anything else for a tie. */
  winner?: string;
  /** A quiz question's answers, in the order shown. */
  options?: string[];
  /** Which of the options is right (its index). */
  answer?: number;
  /** A trailer: how long this feature's recording is shown, seconds. */
  seconds?: number;
}

export interface LongformScript {
  title: string;
  subtitle?: string;
  /** Someone in the corner through the whole video (a section's own presenter comes first). */
  presenter?: LongformPresenter;
  /** The two things a comparison is between, left and right. Read from a title "X vs Y" when not given. */
  sides?: [string, string];
  /** The opening narration, before the first section. */
  hook?: string;
  hookVisuals?: LongformVisual[];
  sections: LongformSection[];
  outro?: { title?: string; subtitle?: string; text?: string; /** Small print at the foot of a trailer's end card. */ note?: string };
}

/** A script as typed or pasted: the same shape with file paths where the plan wants media ids. */
export interface ParsedScript {
  title: string;
  subtitle?: string;
  hook?: string;
  hookVisuals: string[];
  sections: Array<{ heading: string; text: string; points: string[]; visuals: string[]; kicker?: string; figure?: string; winner?: string; answer?: string }>;
  outro?: { title?: string; text?: string };
}

const MEDIA_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|mp4|mov|m4v|webm|mkv|avi)$/i;
const unquote = (s: string): string => s.trim().replace(/^["'<]+|["'>]+$/g, '');

/**
 * Read a script written as plain text:
 *
 *   # Title               (a line under it in italics or after "Subtitle:" is the subtitle)
 *   Opening narration…    (text before the first section is the hook)
 *   ## Section heading
 *   Narration paragraphs…
 *   - a key point
 *   ![](C:\pictures\one.png)   or a line that is only a file path: a picture for the section
 *   ## Outro              (its text is spoken over the closing card)
 */
export function parseScript(source: string): ParsedScript {
  const out: ParsedScript = { title: '', hookVisuals: [], sections: [] };
  let cur: ParsedScript['sections'][number] | null = null;
  const hook: string[] = [];
  const para = new Map<object, string[]>();
  const say = (line: string): void => {
    if (cur) para.set(cur, [...(para.get(cur) ?? []), line]);
    else hook.push(line);
  };
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      say('');
      continue;
    }
    const h1 = /^#\s+(.+)$/.exec(line);
    const h2 = /^#{2,3}\s+(.+)$/.exec(line);
    const image = /^!\[[^\]]*\]\(([^)]+)\)$/.exec(line) ?? /^\[(?:visual|image|video|picture|b-?roll)\s*:\s*([^\]]+)\]$/i.exec(line);
    const bare = !image && MEDIA_EXT.test(unquote(line)) && /^([a-z]:[\\/]|[\\/~]|\.{1,2}[\\/]|["'])/i.test(line) ? unquote(line) : null;
    const point = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    const sub = /^subtitle\s*:\s*(.+)$/i.exec(line) ?? (!cur && hook.every((l) => !l) ? /^[*_](.+)[*_]$/.exec(line) : null);
    // A section's own facts, each on a line of its own before the narration: "Date: March 2020", "Figure: 73%", "Winner: Phone A", "Answer: Rome".
    const fact = cur && !(para.get(cur) ?? []).some(Boolean) ? /^(date|when|figure|number|winner|answer)\s*:\s*(.{1,90})$/i.exec(line) : null;
    if (fact && cur) {
      const key = fact[1].toLowerCase();
      if (key === 'winner') cur.winner = fact[2].trim();
      else if (key === 'answer') cur.answer = fact[2].trim();
      else if (key === 'figure' || key === 'number') cur.figure = fact[2].trim();
      else cur.kicker = fact[2].trim();
    } else if (h1 && !out.title) out.title = h1[1].trim();
    else if (h2 || h1) {
      cur = { heading: (h2 ?? h1)![1].trim().replace(/[:.]$/, ''), text: '', points: [], visuals: [] };
      out.sections.push(cur);
    } else if (sub && !out.subtitle) out.subtitle = sub[1].trim();
    else if (image || bare) (cur ? cur.visuals : out.hookVisuals).push(unquote(image ? image[1] : bare!));
    else if (point && cur) cur.points.push(point[1].trim());
    else say(line);
  }
  const join = (lines: string[]): string =>
    lines
      .join('\n')
      .split(/\n{2,}/)
      .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
      .filter(Boolean)
      .join('\n\n');
  for (const s of out.sections) s.text = join(para.get(s) ?? []);
  if (join(hook)) out.hook = join(hook);
  // A closing section named Outro is spoken over the end card.
  const last = out.sections[out.sections.length - 1];
  if (last && /^(outro|closing|the end|conclusion|end card|call to action)$/i.test(last.heading) && out.sections.length > 1 && last.visuals.length === 0) {
    out.sections.pop();
    out.outro = { text: last.text || undefined };
  }
  if (!out.title) out.title = out.sections[0]?.heading ?? '';
  return out;
}

const countWords = (s: string | undefined): number => (s?.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
/** A quiz's countdown when none is asked for, seconds. */
export const QUIZ_THINK = 5;
/** Kokoro's pace, measured: words a minute. */
export const WORDS_PER_MINUTE = 150;

/** Words to be spoken, and about how long the video will run. */
export function scriptStats(s: { hook?: string; sections: Array<{ text: string; heading?: string }>; outro?: { text?: string } }, f?: LongformFormat): { words: number; seconds: number } {
  // A trailer runs on its beat, not on its words: a couple of seconds a line, about five and a half a feature.
  if (f?.layout === 'trailer') {
    const shown = countWords(s.hook) + s.sections.reduce((n, x) => n + countWords(x.text) + countWords(x.heading), 0);
    return { words: shown, seconds: Math.round(splitSentences(s.hook ?? '').length * 2 + f.introSeconds + s.sections.length * 5.5 + f.outroSeconds) };
  }
  // A quiz reads the question out too, and waits for the countdown.
  if (f?.layout === 'quiz') {
    const said = countWords(s.hook) + s.sections.reduce((n, x) => n + countWords(x.text) + countWords(x.heading), 0) + countWords(s.outro?.text);
    return { words: said, seconds: Math.round((said / WORDS_PER_MINUTE) * 60 + f.introSeconds + f.outroSeconds + s.sections.length * (QUIZ_THINK + 3)) };
  }
  const words = countWords(s.hook) + s.sections.reduce((n, x) => n + countWords(x.text), 0) + countWords(s.outro?.text);
  const cards = f ? f.introSeconds + f.outroSeconds + (f.chapter === 'card' ? f.cardSeconds : 0) * s.sections.length + f.gap * s.sections.length : 0;
  return { words, seconds: Math.round((words / WORDS_PER_MINUTE) * 60 + cards) };
}

// ── Spoken lines ───────────────────────────────────────────────────────────
export interface SpokenWord {
  start: number;
  end: number;
  text: string;
}
/** One sentence of narration, seconds into its audio. */
export interface SpokenLine {
  start: number;
  end: number;
  text: string;
  words?: SpokenWord[];
  /** Who says it, in a conversation. */
  speaker?: string;
}

/** A turn's opening: a name of one or two words and a colon ("Maya: …", "Dr. Lee: …"). */
const TURN = /^([A-Z][\p{L}\p{N}.'’-]*(?: [\p{L}\p{N}.'’-]+)?):\s+\S/u;

/** The speakers of a conversation: every name that opens a paragraph of the script, in the order they first speak. */
export function speakerNames(texts: Array<string | undefined>): string[] {
  const names: string[] = [];
  for (const text of texts) {
    for (const para of (text ?? '').split(/\n+/)) {
      const m = TURN.exec(para.trim());
      if (m && !names.includes(m[1])) names.push(m[1]);
    }
  }
  if (names.length === 0) return [];
  // Turns written one after another on a line: a name that follows the end of a sentence, twice or more in the script.
  const inline = /[.!?…"”')\]]\s+([A-Z][\p{L}\p{N}.'’-]*(?: [\p{L}\p{N}.'’-]+)?):\s+\S/gu;
  const seen = new Map<string, number>();
  for (const text of texts) for (const m of (text ?? '').matchAll(inline)) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  for (const [name, n] of seen) if (n >= 2 && !names.includes(name)) names.push(name);
  return names.slice(0, 4);
}

/** A text cut into turns at those names. Text before the first name belongs to no one (the narrator). */
export function speakerTurns(text: string, names: string[]): Array<{ speaker?: string; text: string }> {
  if (names.length === 0) return text.trim() ? [{ text: text.trim() }] : [];
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const mark = new RegExp(`(^|\\s)(${esc}):\\s+`, 'gu');
  const turns: Array<{ speaker?: string; text: string }> = [];
  let speaker: string | undefined;
  let from = 0;
  const close = (to: number): void => {
    const said = text.slice(from, to).trim();
    if (said) turns.push(speaker ? { speaker, text: said } : { text: said });
  };
  for (let m = mark.exec(text); m; m = mark.exec(text)) {
    close(m.index);
    speaker = m[2];
    from = m.index + m[0].length;
  }
  close(text.length);
  return turns;
}
/** What a speech model heard, as lines a sentence long: phrases are joined until a full stop, a pause or a long line. The words keep their times. */
export function heardLines(segs: Array<{ start: number; end: number; text: string; words?: SpokenWord[] }>): SpokenLine[] {
  const out: SpokenLine[] = [];
  for (const s of segs) {
    const text = s.text.trim();
    if (!text) continue;
    const words = (s.words?.length ? s.words : spreadWords(text, s.start, s.end)).map((w) => ({ start: w.start, end: Math.max(w.end, w.start), text: w.text.trim() })).filter((w) => w.text);
    const last = out[out.length - 1];
    if (last && s.start - last.end < 0.8 && !/[.!?…]["')\]]?$/.test(last.text) && last.text.length + text.length < 200) {
      last.text = `${last.text} ${text}`;
      last.end = Math.max(last.end, s.end);
      last.words = [...(last.words ?? []), ...words];
    } else out.push({ start: s.start, end: Math.max(s.end, s.start + 0.05), text, words });
  }
  return out;
}

/** A narration recording and what is said in it. */
export interface Narration {
  /** The sound file. Empty when nothing is spoken: the stretch still takes `duration`, and its lines are shown as captions. */
  mediaId: string;
  duration: number;
  lines: SpokenLine[];
  /** A stretch of a longer recording: where it starts in the file, and how long the file is. Line times count from the stretch's start. */
  inPoint?: number;
  sourceDuration?: number;
}

/** How far a cut in a recording is moved to reach the end of a sentence, and to reach any gap between two words. */
export const SNAP_SENTENCE = 1.5;
export const SNAP_WORD = 0.4;

/**
 * A time in a recording, moved to the nearest pause: the end of a sentence when one is close, otherwise the gap
 * between two words when the time falls inside one. A section that starts mid-sentence sounds like a mistake, and
 * times read off a transcript are rarely exact.
 */
export function snapToPause(lines: SpokenLine[], t: number, sentence = SNAP_SENTENCE, word = SNAP_WORD): number {
  const words = lines.flatMap((l) => (l.words?.length ? l.words : [{ text: l.text, start: l.start, end: l.end }])).sort((a, b) => a.start - b.start);
  let best: number | undefined;
  let bestWord: number | undefined;
  for (let i = 0; i + 1 < words.length; i++) {
    const gap = (words[i].end + Math.max(words[i].end, words[i + 1].start)) / 2;
    const far = Math.abs(gap - t);
    if (/[.!?]["')\]]*$/.test(words[i].text.trim()) && far <= sentence && (best === undefined || far < Math.abs(best - t))) best = gap;
    if (far <= word && (bestWord === undefined || far < Math.abs(bestWord - t))) bestWord = gap;
  }
  if (best !== undefined) return best;
  // Not near a sentence end: only moved when it would cut a word in two.
  const inside = words.some((w) => t > w.start + 0.02 && t < w.end - 0.02);
  return inside && bestWord !== undefined ? bestWord : t;
}

/**
 * The stretch [from, to) of a recording as a narration of its own: the lines said in it, their times counted from
 * `from`. A line that runs across an end is cut there, keeping the words inside.
 */
export function narrationSlice(rec: { mediaId: string; duration: number; lines: SpokenLine[] }, from: number, to: number): Narration {
  const a = clamp(from, 0, rec.duration);
  const b = clamp(to, a, rec.duration);
  const lines: SpokenLine[] = [];
  for (const l of rec.lines) {
    if (l.end <= a || l.start >= b) continue;
    const all = l.words?.length ? l.words : spreadWords(l.text, l.start, l.end);
    // A word belongs to the stretch its middle is in, so a cut between two sections never says a word twice.
    const inside = l.start >= a && l.end <= b ? all : all.filter((w) => (w.start + w.end) / 2 >= a && (w.start + w.end) / 2 < b);
    if (inside.length === 0) continue;
    const text = inside.length === all.length ? l.text : inside.map((w) => w.text.trim()).join(' ');
    const start = Math.max(a, inside[0].start) - a;
    const end = Math.min(b, inside[inside.length - 1].end) - a;
    lines.push({ start, end: Math.max(end, start + 0.05), text, words: inside.map((w) => ({ text: w.text.trim(), start: Math.max(a, w.start) - a, end: Math.max(Math.max(a, w.start) - a + 0.02, Math.min(b, w.end) - a) })), ...(l.speaker ? { speaker: l.speaker } : {}) });
  }
  return { mediaId: rec.mediaId, duration: b - a, lines, inPoint: a, sourceDuration: rec.duration };
}

/** The sentences of a narration text, in the order they are spoken (a paragraph break ends a sentence too). */
export function splitSentences(text: string): string[] {
  return sentences(text)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/** How long a word takes to say next to its neighbours (letters; digits are read out long; a comma is a short stop). */
function wordWeight(w: string, last: boolean): number {
  const letters = w.replace(/[^\p{L}\p{N}]/gu, '').length;
  const digits = (w.match(/\d/g) ?? []).length;
  const stop = last ? 0 : /[.!?…]["')\]]*$/.test(w) ? 5 : /[,;:—–]["')\]]*$/.test(w) ? 2.5 : 0;
  return Math.max(1.5, letters + digits * 2.5) + 1 + stop;
}

/** Word timings inside a line whose start and end are known. */
export function spreadWords(text: string, start: number, end: number): SpokenWord[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const weights = words.map((w, i) => wordWeight(w, i === words.length - 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let t = start;
  return words.map((w, i) => {
    const d = ((end - start) * weights[i]) / total;
    const word = { start: t, end: t + d, text: w };
    t += d;
    return word;
  });
}

/** Lines for a recording whose sentence times are not known: spread over its length by how much there is to say. */
export function estimateLines(text: string, duration: number): SpokenLine[] {
  const parts = splitSentences(text);
  if (parts.length === 0 || !(duration > 0)) return [];
  const pause = 4;
  const weights = parts.map((p) => p.split(/\s+/).reduce((n, w, i, all) => n + wordWeight(w, i === all.length - 1), 0));
  const total = weights.reduce((a, b) => a + b, 0) + pause * (parts.length - 1);
  let t = 0;
  return parts.map((text, i) => {
    const d = (duration * weights[i]) / total;
    const line: SpokenLine = { start: t, end: t + d, text, words: spreadWords(text, t, t + d) };
    t += d + (duration * pause) / total;
    return line;
  });
}

/** A narration text as the pieces to speak one at a time, each with the pause that follows it (longer after a paragraph). */
export function speechParts(text: string): Array<{ text: string; pause: number }> {
  const out: Array<{ text: string; pause: number }> = [];
  for (const para of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const parts = splitSentences(para);
    parts.forEach((p, i) => out.push({ text: p, pause: i + 1 < parts.length ? 0.28 : 0.62 }));
  }
  if (out.length) out[out.length - 1].pause = 0;
  return out;
}

/** A spoken sentence without the near-silence a voice model leaves at its ends (a short edge is kept). */
export function trimSilence(audio: Float32Array, sampleRate: number, floor = 0.008, keep = 0.03): Float32Array {
  let a = 0;
  let b = audio.length;
  while (a < b && Math.abs(audio[a]) < floor) a++;
  while (b > a && Math.abs(audio[b - 1]) < floor) b--;
  if (a >= b) return audio.subarray(0, 0);
  const edge = Math.round(keep * sampleRate);
  return audio.subarray(Math.max(0, a - edge), Math.min(audio.length, b + edge));
}

/** Sentences spoken one at a time, joined with their pauses: one recording, and where each sentence sits in it. */
export function joinSpoken(parts: Array<{ text: string; audio: Float32Array; pause: number }>, sampleRate: number): { audio: Float32Array; lines: SpokenLine[] } {
  const lead = Math.round(0.08 * sampleRate);
  const total = parts.reduce((n, p) => n + p.audio.length + Math.round(p.pause * sampleRate), lead) + Math.round(0.12 * sampleRate);
  const audio = new Float32Array(total);
  const lines: SpokenLine[] = [];
  let at = lead;
  for (const p of parts) {
    audio.set(p.audio, at);
    const start = at / sampleRate;
    const end = (at + p.audio.length) / sampleRate;
    if (p.audio.length) lines.push({ start, end, text: p.text, words: spreadWords(p.text, start, end) });
    at += p.audio.length + Math.round(p.pause * sampleRate);
  }
  return { audio, lines };
}

const bare = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Lines for a recording of a known text, from the words a speech model heard
 * in it. The heard words are not trusted as text (names and numbers come out
 * wrong), only as a clock: the two word lists are matched up in order, a
 * script word that was heard takes that word's time, and the ones between two
 * matches share the time between them. When what was heard is clearly not
 * this text, the lines are spread over the recording instead.
 */
export function alignLines(text: string, heard: SpokenWord[], duration: number): { lines: SpokenLine[]; aligned: boolean } {
  const parts = splitSentences(text);
  if (parts.length === 0) return { lines: [], aligned: false };
  const script = parts.flatMap((line, li) => line.split(/\s+/).filter(Boolean).map((w) => ({ text: w, key: bare(w), line: li })));
  const said = heard.filter((w) => bare(w.text) && w.end >= w.start).sort((a, b) => a.start - b.start);
  const n = script.length;
  const m = said.length;
  const spread = (): { lines: SpokenLine[]; aligned: boolean } => ({ lines: estimateLines(text, duration), aligned: false });
  if (m < 3 || n * m > 9e6) return spread();
  // Longest common run of words, in order.
  const keys = said.map((w) => bare(w.text));
  const W = m + 1;
  const best = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) best[i * W + j] = script[i].key === keys[j] ? best[(i + 1) * W + j + 1] + 1 : Math.max(best[(i + 1) * W + j], best[i * W + j + 1]);
  }
  if (best[0] < Math.max(2, n * 0.5)) return spread();
  const match = new Int32Array(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (script[i].key === keys[j]) match[i++] = j++;
    else if (best[(i + 1) * W + j] >= best[i * W + j + 1]) i++;
    else j++;
  }
  const words: SpokenWord[] = new Array(n);
  for (let i = 0; i < n; ) {
    if (match[i] >= 0) {
      const h = said[match[i]];
      words[i] = { start: h.start, end: Math.max(h.end, h.start + 0.02), text: script[i].text };
      i++;
      continue;
    }
    // A run of words that were not heard as written: they share the time between the matches around them.
    let k = i;
    while (k < n && match[k] < 0) k++;
    const prev = i > 0 ? said[match[i - 1]] : undefined;
    const next = k < n ? said[match[k]] : undefined;
    const from = prev ? prev.end : Math.min(said[0].start, next?.start ?? 0);
    const to = Math.max(from, next ? next.start : Math.max(said[m - 1].end, from));
    const weights = script.slice(i, k).map((w, x) => wordWeight(w.text, x === k - i - 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let at = from;
    for (let x = i; x < k; x++) {
      const d = ((to - from) * weights[x - i]) / total;
      words[x] = { start: at, end: Math.max(at + 0.02, at + d), text: script[x].text };
      at += d;
    }
    i = k;
  }
  const lines = parts.map((line, li): SpokenLine => {
    const own = words.filter((_, i) => script[i].line === li);
    return { start: own[0].start, end: Math.max(own[0].start + 0.05, own[own.length - 1].end), text: line, words: own };
  });
  return { lines, aligned: true };
}


const STOP = new Set('a an and are as at be but by for from has have he her his i in into is it its of on or our she so that the their them then there they this to was we were what when which who will with you your not no do does did can could would should than too very just more most also about over out up down off if how why'.split(' '));

/** The words of a phrase that carry its meaning, crudely stemmed. */
export function keyWords(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => !STOP.has(w) && (w.length > 2 || /\d/.test(w)))
    .map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w));
}

/** When a phrase is said: the start of the word where the best match for it begins, seconds into the narration. */
export function phraseTime(phrase: string, lines: SpokenLine[], from = 0): { time: number; line: number; score: number } | null {
  const want = keyWords(phrase);
  if (want.length === 0) return null;
  let best: { time: number; line: number; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.end <= from) continue;
    const words = l.words ?? spreadWords(l.text, l.start, l.end);
    const keys = words.map((w) => keyWords(w.text)[0]);
    const hits = want.filter((k) => keys.includes(k)).length;
    const score = hits / want.length;
    if (score > (best?.score ?? 0) + 1e-9) {
      const first = words.find((w, k) => keys[k] !== undefined && want.includes(keys[k]) && w.start >= from - 1e-6);
      best = { time: first?.start ?? l.start, line: i, score };
    }
  }
  return best;
}

/**
 * When each point is said: points are matched to the narration in order, and
 * one that shares no wording with it takes an even share of the time between
 * its neighbours.
 */
export function pointTimes(points: string[], lines: SpokenLine[], duration: number): number[] {
  const found: Array<number | null> = [];
  let from = 0;
  for (const p of points) {
    const hit = phraseTime(p, lines, from);
    if (hit && hit.score >= 0.34) {
      found.push(hit.time);
      from = hit.time + 0.4;
    } else found.push(null);
  }
  return fillGaps(found, Math.min(1, duration * 0.1), Math.max(1, duration - 2.5));
}

/** Fill the unknown times evenly between the known ones (and the ends), keeping the order. */
function fillGaps(times: Array<number | null>, lo: number, hi: number): number[] {
  const out = [...times];
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== null) continue;
    let j = i;
    while (j < out.length && out[j] === null) j++;
    const a = i > 0 ? (out[i - 1] as number) : lo;
    const b = j < out.length ? (out[j] as number) : Math.max(hi, a);
    const openStart = i === 0;
    const openEnd = j === out.length;
    const n = j - i;
    for (let k = 0; k < n; k++) {
      // Between two known times the unknown ones split the gap; at an open end they run up to it.
      const step = (b - a) / (n + (openStart ? 0 : 1) - (openEnd ? 1 : 0) || 1);
      out[i + k] = openStart ? a + step * k : a + step * (k + 1);
    }
    i = j - 1;
  }
  const done = out as number[];
  for (let i = 1; i < done.length; i++) done[i] = Math.max(done[i], done[i - 1]);
  return done;
}

/** Word timings the way the speech model writes them (and the caption renderer reads them): every word after the first carries its leading space. */
const spaced = (words: SpokenWord[]): SpokenWord[] => words.map((w, i) => (i === 0 ? w : { ...w, text: ` ${w.text}` }));

/** Spoken lines as a transcript of their recording (what Whisper would have returned, with the script's exact words). */
export function transcriptOf(lines: SpokenLine[]): Array<{ start: number; end: number; text: string; words: SpokenWord[] }> {
  return lines.map((l) => ({ start: l.start, end: l.end, text: l.text, words: spaced(l.words?.length ? l.words : spreadWords(l.text, l.start, l.end)) }));
}

/** Caption phrases short enough for one line, each with its word timings. */
export function captionSegments(lines: SpokenLine[], maxChars: number): Array<{ start: number; end: number; text: string; words: SpokenWord[] }> {
  const out: Array<{ start: number; end: number; text: string; words: SpokenWord[] }> = [];
  lines.forEach((l, li) => {
    const words = l.words?.length ? l.words : spreadWords(l.text, l.start, l.end);
    const groups: SpokenWord[][] = [];
    let cur: SpokenWord[] = [];
    let len = 0;
    for (const w of words) {
      const next = len + (cur.length ? 1 : 0) + w.text.length;
      const prev = cur[cur.length - 1]?.text ?? '';
      // Break at the limit, or early after a comma once the line is well filled.
      if (cur.length && (next > maxChars || (len > maxChars * 0.6 && /[,;:—–]$/.test(prev)))) {
        groups.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(w);
      len += (cur.length > 1 ? 1 : 0) + w.text.length;
    }
    if (cur.length) groups.push(cur);
    // No one-word leftovers: the last phrase takes a word from the one before.
    const tail = groups[groups.length - 1];
    const before = groups[groups.length - 2];
    if (groups.length > 1 && tail.length === 1 && before.length > 2 && before[before.length - 1].text.length + 1 + tail[0].text.length <= maxChars) tail.unshift(before.pop()!);
    const lineEnd = Math.min(l.end + 0.3, lines[li + 1]?.start ?? Infinity);
    groups.forEach((g, gi) => {
      out.push({ start: g[0].start, end: gi + 1 < groups.length ? groups[gi + 1][0].start : Math.max(g[g.length - 1].end, lineEnd), text: g.map((w) => w.text).join(' '), words: spaced(g) });
    });
  });
  return out;
}

// ── The plan ───────────────────────────────────────────────────────────────
export interface VisualInfo {
  kind: 'image' | 'video';
  width: number;
  height: number;
  /** A video's length, seconds. */
  duration: number;
  /** A scene drawn for this stretch of narration: played once, as it is (no re-framing, no slow move, no loop). */
  generated?: boolean;
  /**
   * Drawn for one sentence: a comic panel. Fills the frame, cut in, one framing; moves a little when held.
   * A still, or (with generated) the same panel acted out for as long as it is up.
   */
  panel?: boolean;
  /**
   * A drawing brought to the video (not drawn by the scene engine for this layout): a panel in every other way,
   * but nothing was left clear in it, so key points push it aside like any picture.
   */
  drawing?: boolean;
}

export interface LongformPlanInput {
  script: LongformScript;
  format: LongformFormat;
  canvas: Canvas;
  narration: { hook?: Narration; sections: Narration[]; outro?: Narration };
  /** The pictures and presenter clips the script names, by media id. */
  media: Map<string, VisualInfo>;
  card: { look: CardLook; background?: string; accent?: string };
  /** Typography for cards and on-screen text (the active style's titles). */
  cardText?: CardText;
  /** The caption look as a clip patch; `upper` upper-cases the words. Null = no captions. */
  captions: { patch: Partial<TextClip>; upper: boolean } | null;
  /** Between two different pictures. */
  transition: { type: TransitionType; duration: number };
  /** Comic panels: one on screen at least this long moves a little (default: the format's hold; Infinity = never). */
  panelMoveAfter?: number;
  music?: { mediaId: string; duration: number; volume: number; duckDb: number };
  start: number;
  tracks: { video: string; presenter: string; narration: string; music: string; text: string; captions: string };
}

export interface PlannedSection {
  heading: string;
  /** Where the section starts on the timeline (its card, if it has one). */
  start: number;
  /** Where its narration starts. */
  speech: number;
  end: number;
  scene: 'pictures' | 'text';
  pictures: number;
}

export interface LongformPlan {
  clips: Clip[];
  start: number;
  end: number;
  sections: PlannedSection[];
  captions: number;
  /** Any picture shown whole (not filling the frame): the caller gives the project a blurred backdrop. */
  fitted: boolean;
  /** Pictures were framed as windows or put side by side: the two colours the caller puts behind them. */
  backdrop?: [string, string];
  notes: string[];
}

/** How far a stretch of recording is sped up or slowed to fit the time it has (LongformVisual.outPoint). */
export const STRETCH = { slow: 0.5, fast: 2.5, easy: 1.25 } as const;
/** How long a part takes when nothing is spoken and no stretch of recording sets its length: reading time for its words. */
export function readingSeconds(text: string | undefined): number {
  return Math.min(20, Math.max(3, 1.5 + countWords(text) / 3));
}

/** A picture as a window: its share of the frame, its corners and its shadow (as product_demo frames a recording). */
const WINDOW = { scale: 0.86, corner: 0.025, shadow: 0.6 };
/** The mark on the side that takes a round: the same gold in every style, dark text on it. */
const WINNER_GOLD = '#FFD23F';
/** One side of a split screen: the box a picture is fitted into (fractions of the frame) and where its middle is. */
const HALF = { w: 0.455, h: 0.56, x: 0.245, y: -0.03 };

/** The two sides of a comparison: given, or read from a title like "X vs Y". */
export function comparisonSides(script: { title: string; sides?: [string, string] }): [string, string] | null {
  if (script.sides?.[0]?.trim() && script.sides[1]?.trim()) return [script.sides[0].trim(), script.sides[1].trim()];
  const m = /^(.+?)\s+(?:vs\.?|versus|v\.)\s+(.+?)(?:\s*[:(–—|].*)?$/i.exec(script.title.trim());
  return m ? [m[1].trim(), m[2].trim()] : null;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** A picture shown for less than this is dropped rather than flashed. */
const MIN_SLOT = 1.2;

/** The scale at which a picture covers the frame (1 = fits inside it). */
export function coverScale(w: number, h: number, canvas: Canvas): number {
  if (!(w > 0 && h > 0)) return 1;
  const fit = Math.min(canvas.width / w, canvas.height / h);
  return Math.max(canvas.width / (w * fit), canvas.height / (h * fit));
}

/** When each picture of a section comes up, seconds into it: its cue, else an even share between the cues around it. */
export function visualStarts(visuals: LongformVisual[], lines: SpokenLine[], duration: number): number[] {
  const cues = visuals.map((v, i): number | null => {
    if (i === 0) return 0;
    if (typeof v.at === 'number' && Number.isFinite(v.at)) return clamp(v.at, 0, duration);
    const hit = v.when ? phraseTime(v.when, lines) : null;
    return hit && hit.score >= 0.34 ? hit.time : null;
  });
  // A cue that falls before the one ahead of it is not a cue (the pictures play in the order given).
  let last = 0;
  for (let i = 1; i < cues.length; i++) {
    if (cues[i] === null) continue;
    if ((cues[i] as number) < last + MIN_SLOT) cues[i] = null;
    else last = cues[i] as number;
  }
  const out: Array<number | null> = [...cues];
  for (let i = 1; i < out.length; i++) {
    if (out[i] !== null) continue;
    let j = i;
    while (j < out.length && out[j] === null) j++;
    const a = out[i - 1] as number;
    const b = j < out.length ? (out[j] as number) : duration;
    const n = j - i;
    for (let k = 0; k < n; k++) out[i + k] = a + ((b - a) * (k + 1)) / (n + 1);
    i = j - 1;
  }
  return out as number[];
}

const KICKER: Record<Kicker, (n: number) => string> = {
  none: () => '',
  part: (n) => `Part ${n}`,
  chapter: (n) => `Chapter ${n}`,
  step: (n) => `Step ${n}`,
  number: (n) => `Number ${n}`,
  feature: (n) => `Feature ${n}`,
  round: (n) => `Round ${n}`,
  story: (n) => `Story ${n}`,
};

export function planLongform(input: LongformPlanInput): LongformPlan {
  const { script, format: f, canvas, tracks } = input;
  const clips: Clip[] = [];
  const notes: string[] = [];
  const voiced: Range[] = [];
  const captionSegs: Array<{ start: number; end: number; text: string; words: SpokenWord[] }> = [];
  const sections: PlannedSection[] = [];
  const palette = cardPalette(input.card.look, { background: input.card.background, accent: input.card.accent, text: input.cardText });
  const cardBase = { look: input.card.look, canvas, trackId: tracks.text, background: input.card.background, accent: input.card.accent, text: input.cardText };
  const capSize = input.captions?.patch.fontSize ?? 64;
  const maxChars = clamp(Math.floor((canvas.width * 0.84) / (capSize * (canvas.height / REF_HEIGHT) * 0.56)), 14, 52);
  let t = input.start;
  let motionAt = 0;
  const panelMoveAfter = input.panelMoveAfter ?? f.hold;
  let fitted = false;
  /** Set once a picture is framed as a window or put in a split screen. */
  let staged = false;
  const sides = f.split ? comparisonSides(script) : null;
  /** How far into the whole-video presenter's recording the last part got, so the next one carries on from there. */
  let presenterAt = 0;
  /** Where the last picture ended, so the next one knows whether it follows it directly. */
  let pictureEnd = -1;
  /** While a panel of key points is up beside the pictures: they slide aside and the captions move clear of it. */
  const panels: Array<{ from: number; to: number; dx: number; still?: boolean }> = [];
  const portrait = canvas.height > canvas.width;
  const captionsFor = (narr: Narration, from: number, narrow: boolean): void => {
    if (!input.captions) return;
    const max = narrow && !portrait ? Math.max(12, Math.round(maxChars * 0.6)) : maxChars;
    captionSegs.push(...captionSegments(narr.lines, max).map((s) => ({ ...s, start: from + s.start, end: from + s.end, words: s.words.map((w) => ({ ...w, start: from + w.start, end: from + w.end })) })));
  };

  const group = (made: Clip[], kind: string): Clip[] => {
    const id = uid(kind);
    for (const c of made) c.group = id;
    return made;
  };

  const card = (title: string, opts: { subtitle?: string; kicker?: string; duration: number; chapter?: string }): void => {
    clips.push(...buildCard({ ...cardBase, title, subtitle: opts.subtitle, kicker: opts.kicker, start: t, duration: opts.duration, chapter: opts.chapter }).clips);
    t += opts.duration;
  };

  /** One picture's pieces over [from, to): a still is re-framed every `hold` seconds, a short video plays again. */
  const picture = (v: LongformVisual, from: number, to: number, first: boolean): MediaClip[] => {
    const info = input.media.get(v.mediaId);
    if (!info) return [];
    const span = to - from;
    const cover = coverScale(info.width, info.height, canvas);
    // A window on the backdrop: the whole picture, a little smaller than the frame, never cropped.
    const window = f.framed === true && !info.generated && !info.panel && v.fit !== 'fill';
    // A comic panel: a drawn still, or any still in a format that shows its pictures as panels.
    const panel = !window && (info.panel === true || (info.kind === 'image' && f.panels === true));
    // Fill the frame unless that would crop away more than about a third of the picture.
    const fill = !window && (v.fit ? v.fit === 'fill' : f.whole ? false : 1 - 1 / cover <= 0.34);
    if (window) staged = true;
    else if (!fill && cover > 1.02) fitted = true;
    const scale = window ? WINDOW.scale : fill ? cover : 1;
    const base = { mediaId: v.mediaId, trackId: tracks.video, sourceWidth: info.width, sourceHeight: info.height, scaleX: scale, scaleY: scale, muted: true, ...(window ? { cornerRadius: WINDOW.corner, shadow: WINDOW.shadow } : {}) };
    const pieces: MediaClip[] = [];
    if (info.generated) {
      pieces.push(newMediaClip({ ...base, scaleX: cover, scaleY: cover, start: from, duration: Math.min(span, Math.max(MIN_CLIP, info.duration)), sourceDuration: info.duration, motion: info.panel && span >= panelMoveAfter ? (v.motion ?? f.motions[motionAt++ % f.motions.length]) : 'none', motionAmount: Math.min(f.motionAmount, 0.45) }));
    } else if (panel) {
      // One framing for as long as it is up. Held long enough, it moves a little: a still that sits there reads as a frozen video.
      const moving = span >= panelMoveAfter;
      const motion = v.motion ?? (moving ? f.motions[motionAt++ % f.motions.length] : 'none');
      pieces.push(newMediaClip({ ...base, ...(info.panel ? { scaleX: cover, scaleY: cover } : {}), start: from, duration: span, sourceDuration: span, motion, motionAmount: Math.min(f.motionAmount, 0.45) }));
    } else if (info.kind === 'image') {
      // A window is one steady picture: re-framing it would only make the frame jump.
      const n = v.motion || window ? 1 : Math.max(1, Math.round(span / f.hold));
      for (let k = 0; k < n; k++) {
        const motion = v.motion ?? f.motions[motionAt++ % f.motions.length];
        pieces.push(newMediaClip({ ...base, start: from + (span * k) / n, duration: span / n, sourceDuration: span / n, motion, motionAmount: f.motionAmount }));
      }
    } else if (v.outPoint !== undefined && v.outPoint - (v.inPoint ?? 0) >= MIN_CLIP) {
      // One stretch of a recording, played once across the time it has.
      const inPoint = clamp(v.inPoint ?? 0, 0, Math.max(0, info.duration - MIN_CLIP));
      const length = clamp(v.outPoint, inPoint + MIN_CLIP, Math.max(inPoint + MIN_CLIP, info.duration)) - inPoint;
      const speed = clamp(length / span, STRETCH.slow, STRETCH.fast);
      const plays = Math.min(span, length / speed);
      pieces.push(newMediaClip({ ...base, start: from, duration: plays, inPoint, speed, sourceDuration: info.duration, motion: 'none' }));
      // Slower than half speed would drag: the last frame holds for what is left.
      const last = Math.max(inPoint, inPoint + length - 0.04);
      if (span - plays > 0.15) pieces.push(newMediaClip({ ...base, start: from + plays, duration: span - plays, inPoint: last, freezeAt: last, sourceDuration: info.duration, motion: 'none' }));
      else if (length / span > STRETCH.fast + 0.01) notes.push(`a ${Math.round(length)}s stretch of recording had ${Math.round(span * 10) / 10}s to play in: its last ${Math.round(length - plays * speed)}s are left out (a longer line for that step, or a shorter stretch, shows all of it)`);
    } else {
      const inPoint = clamp(v.inPoint ?? 0, 0, Math.max(0, info.duration - MIN_CLIP));
      const avail = Math.max(MIN_CLIP, info.duration - inPoint);
      const motion = v.motion ?? (f.motions[motionAt++ % f.motions.length] === 'zoom-out' ? 'zoom-out' : 'zoom-in');
      for (let at = from; at < to - MIN_CLIP; at += avail) {
        pieces.push(newMediaClip({ ...base, start: at, duration: Math.min(avail, to - at), inPoint, sourceDuration: info.duration, motion, motionAmount: f.motionAmount * 0.5 }));
      }
    }
    pieces.forEach((p, k) => {
      const follows = k > 0 || Math.abs(pictureEnd - p.start) < 0.03;
      const prev = k > 0 ? pieces[k - 1].duration : Infinity;
      if (panel) {
        // Panels cut: the cut is the page turning. Only the first one after something else eases in.
        if (!follows && first) p.fadeIn = Math.min(0.25, p.duration / 3);
      } else if (p.freezeAt != null) {
        // The held last frame of the piece before it: nothing between the two.
      } else if (k > 0) {
        // Two framings of one picture: always a dissolve, a hard cut between them reads as a glitch.
        p.transition = 'fade';
        p.transitionDur = clamp(info.kind === 'image' ? 0.7 : 0.3, 0.1, 0.45 * Math.min(prev, p.duration));
      } else if (follows && input.transition.type !== 'none') {
        p.transition = input.transition.type;
        p.transitionDur = clamp(input.transition.duration, 0.1, 0.45 * p.duration);
      } else if (!follows && first) p.fadeIn = Math.min(0.3, p.duration / 3);
    });
    if (pieces.length) pictureEnd = pieces[pieces.length - 1].start + pieces[pieces.length - 1].duration;
    return pieces;
  };

  /** How a picture sits in one side of a split screen: its scale, and how much of the frame's height it takes. */
  const halfFit = (info: VisualInfo): { scale: number; high: number } => {
    const fit = Math.min(canvas.width / info.width, canvas.height / info.height);
    const high = (info.height * fit) / canvas.height;
    const scale = Math.min(HALF.w / ((info.width * fit) / canvas.width), HALF.h / high);
    return { scale, high: high * scale };
  };

  /** One side of a split screen: the picture whole, in its half, as a small window. */
  const half = (v: LongformVisual, from: number, to: number, side: -1 | 1): MediaClip[] => {
    const info = input.media.get(v.mediaId);
    if (!info) return [];
    const { scale } = halfFit(info);
    const base = { mediaId: v.mediaId, trackId: side < 0 ? tracks.video : tracks.presenter, sourceWidth: info.width, sourceHeight: info.height, scaleX: scale, scaleY: scale, posX: side * HALF.x, posY: HALF.y, muted: true, cornerRadius: 0.035, shadow: 0.5, motion: 'none' as const };
    if (info.kind === 'image') return [newMediaClip({ ...base, start: from, duration: to - from, sourceDuration: to - from, fadeIn: 0.3 })];
    const inPoint = clamp(v.inPoint ?? 0, 0, Math.max(0, info.duration - MIN_CLIP));
    const avail = Math.max(MIN_CLIP, info.duration - inPoint);
    const pieces: MediaClip[] = [];
    for (let at = from; at < to - MIN_CLIP; at += avail) pieces.push(newMediaClip({ ...base, start: at, duration: Math.min(avail, to - at), inPoint, sourceDuration: info.duration, ...(at === from ? { fadeIn: 0.3 } : {}) }));
    return pieces;
  };

  /** The names over the two sides of a split screen, and a mark on the one that takes the round. */
  const sideLabels = (from: number, to: number, winner: string | undefined, winAt: number, top: number): Clip[] => {
    if (!sides) return [];
    const box = { bgStyle: 'box' as const, bgColor: '#000000', bgOpacity: 0.55, bgRadius: 8, bgPadding: 12 };
    const made: Clip[] = [];
    const won = winner ? sides.findIndex((s) => s.toLowerCase() === winner.trim().toLowerCase() || s.toLowerCase().includes(winner.trim().toLowerCase()) || winner.toLowerCase().includes(s.toLowerCase())) : -1;
    sides.forEach((name, i) => {
      const x = 0.5 + (i === 0 ? -1 : 1) * HALF.x;
      const k = fitText(name, 38, palette.fontFamily, true, canvas, { widthFrac: HALF.w - 0.04, maxLines: 1 });
      made.push(textClip({ trackId: tracks.text, start: from + 0.15, duration: Math.max(MIN_CLIP, to - from - 0.3), fontFamily: palette.fontFamily, text: k.text, fontSize: k.fontSize, bold: true, color: '#ffffff', x, y: top - 0.115, ...box, animIn: 'fade', animOut: 'fade' }));
      if (i === won && to - winAt > 1) made.push(textClip({ trackId: tracks.text, start: winAt, duration: to - winAt - 0.15, fontFamily: palette.fontFamily, text: spacedCaps('Winner'), fontSize: 26, bold: true, color: '#111111', x, y: top - 0.048, bgStyle: 'box', bgColor: WINNER_GOLD, bgOpacity: 1, bgRadius: 8, bgPadding: 10, animIn: 'pop', animOut: 'fade' }));
    });
    made.push(textClip({ trackId: tracks.text, start: from + 0.3, duration: Math.max(MIN_CLIP, to - from - 0.6), fontFamily: palette.fontFamily, text: 'VS', fontSize: 30, bold: true, color: '#ffffff', x: 0.5, y: 0.5 + HALF.y, ...box, animIn: 'pop', animOut: 'fade' }));
    return group(made, 'sides');
  };

  /** The narration's own sentences as the picture: for a part of the script that names no visuals. */
  const statements = (lines: SpokenLine[], heading: string | undefined, from: number, to: number): Clip[] => {
    const made: Clip[] = [rectClip({ trackId: tracks.text, start: from, duration: to - from, fill: palette.background, w: 1.01, h: 1.01, fadeIn: 0.25, fadeOut: 0.25 })];
    const type = { fontFamily: palette.fontFamily, italic: input.cardText?.italic ?? false };
    if (heading) {
      const k = fitText(heading.toUpperCase(), 30, palette.fontFamily, true, canvas, { maxLines: 1, spread: 1.4, widthFrac: 0.8 });
      made.push(textClip({ trackId: tracks.text, start: from + 0.1, duration: Math.max(MIN_CLIP, to - from - 0.3), ...type, text: spacedCaps(heading), fontSize: k.fontSize, bold: true, color: palette.accent, y: 0.13, animIn: 'fade', animOut: 'fade' }));
      made.push(rectClip({ trackId: tracks.text, start: from + 0.2, duration: Math.max(MIN_CLIP, to - from - 0.4), fill: palette.accent, x: 0.5, y: 0.185, w: Math.min(0.5, (90 * (canvas.height / REF_HEIGHT)) / canvas.width), h: 4 / REF_HEIGHT, animIn: 'pop', animOut: 'fade' }));
    }
    lines.forEach((l, i) => {
      const start = from + (i === 0 ? Math.min(l.start, 0.15) : l.start);
      const end = i + 1 < lines.length ? from + lines[i + 1].start : to - 0.25;
      if (end - start < MIN_CLIP) return;
      const fit = fitText(palette.upper ? l.text.toUpperCase() : l.text, 62, palette.fontFamily, palette.bold, canvas, { widthFrac: 0.76, maxLines: 5 });
      // In a conversation, who is speaking: above the line, and held while the same person goes on.
      if (l.speaker && lines[i - 1]?.speaker !== l.speaker) {
        let j = i;
        while (j + 1 < lines.length && lines[j + 1].speaker === l.speaker) j++;
        const until = j + 1 < lines.length ? from + lines[j + 1].start : to - 0.25;
        if (until - start >= MIN_CLIP) made.push(textClip({ trackId: tracks.text, start, duration: until - start, ...type, text: spacedCaps(l.speaker), fontSize: 30, bold: true, color: palette.accent, y: 0.3, animIn: 'fade', animOut: 'fade', animInDur: 0.25, animOutDur: 0.2 }));
      }
      made.push(textClip({ trackId: tracks.text, start, duration: end - start, ...type, text: fit.text, fontSize: fit.fontSize, bold: palette.bold, color: palette.color, y: 0.54, animIn: 'fade', animOut: 'fade', animInDur: 0.35, animOutDur: 0.2, motion: 'zoom-in', motionAmount: 0.35 }));
    });
    return group(made, 'scene');
  };

  /** A section named over its first picture: a bar, a small line and the heading, bottom left. */
  const lowerThird = (kicker: string, heading: string, at: number, length: number): Clip[] => {
    const h = fitText(heading, 56, palette.fontFamily, palette.bold, canvas, { widthFrac: 0.6, maxLines: 2 });
    const lineH = (h.fontSize * 1.18) / REF_HEIGHT;
    const top = 0.8 - h.lines * lineH;
    const box = { bgStyle: 'box' as const, bgColor: '#000000', bgOpacity: 0.55, bgRadius: 6, bgPadding: 12 };
    const text = { trackId: tracks.text, fontFamily: palette.fontFamily, anchor: 'left' as const, align: 'left' as const, x: 0.07, ...box };
    const made: Clip[] = [rectClip({ trackId: tracks.text, start: at, duration: length, fill: input.card.accent ?? palette.accent, x: 0.052, y: top + (h.lines * lineH) / 2 - (kicker ? 0.025 : 0), w: 0.005, h: h.lines * lineH + (kicker ? 0.07 : 0.02), animIn: 'fade', animOut: 'fade' })];
    if (kicker) made.push(textClip({ ...text, start: at + 0.1, duration: Math.max(MIN_CLIP, length - 0.1), text: spacedCaps(kicker), fontSize: 26, bold: true, color: '#ffffff', y: top - 0.045, animIn: 'fade', animOut: 'fade' }));
    made.push(textClip({ ...text, start: at + 0.2, duration: Math.max(MIN_CLIP, length - 0.2), text: h.text, fontSize: h.fontSize, bold: palette.bold, color: '#ffffff', y: top + (h.lines * lineH) / 2, animIn: 'slide', animOut: 'fade' }));
    return group(made, 'lower');
  };

  /** One stretch of narration and everything on screen while it plays. */
  const block = (narr: Narration, o: { heading?: string; visuals?: LongformVisual[]; points?: string[]; presenter?: LongformPresenter; chapter?: string; lower?: { kicker: string; heading: string }; under?: 'card'; winner?: string }): { scene: 'pictures' | 'text'; pictures: number } => {
    const from = t;
    // A part that shows stretches of a recording lasts long enough to play them at an easy pace: a short line does not
    // rush what is being shown, the picture simply runs on after the words.
    const stretches = (o.visuals ?? []).reduce((n, v) => n + (v.outPoint !== undefined && input.media.get(v.mediaId)?.kind === 'video' ? Math.max(0, v.outPoint - (v.inPoint ?? 0)) : 0), 0);
    const to = from + Math.max(narr.duration + f.gap, stretches / STRETCH.easy);
    if (narr.mediaId) {
      clips.push(newMediaClip({ mediaId: narr.mediaId, trackId: tracks.narration, start: from, duration: narr.duration, inPoint: narr.inPoint ?? 0, sourceDuration: narr.sourceDuration ?? narr.duration }));
      for (const l of narr.lines) voiced.push([from + l.start, from + l.end]);
    }
    t = to;
    if (o.under === 'card') {
      captionsFor(narr, from, false);
      return { scene: 'text', pictures: 0 };
    }

    const visuals = (o.visuals ?? []).filter((v) => input.media.has(v.mediaId));
    const points = (o.points ?? []).map((p) => p.trim()).filter(Boolean).slice(0, 6);
    const times = points.length ? pointTimes(points, narr.lines, narr.duration) : [];
    let carrier: Clip | undefined;
    let spoken = true;
    let shown = 0;
    let beside = false;
    // Side by side: the pictures in twos, the first of each pair on the left.
    const pairs = f.split === true && visuals.length >= 2;
    if (pairs) {
      const lefts = visuals.filter((_, i) => i % 2 === 0);
      const starts = visualStarts(lefts, narr.lines, narr.duration);
      const made: MediaClip[] = [];
      let splitUntil = from;
      // The top edge of the tallest window, so the names sit just above it.
      let top = 0.5 + HALF.y;
      lefts.forEach((left, i) => {
        const right = visuals[i * 2 + 1];
        const a = from + starts[i];
        const b = i + 1 < lefts.length ? from + starts[i + 1] : to;
        if (b - a < MIN_SLOT && i > 0) return;
        if (right) {
          made.push(...half(left, a, b, -1), ...half(right, a, b, 1));
          for (const v of [left, right]) top = Math.min(top, 0.5 + HALF.y - halfFit(input.media.get(v.mediaId)!).high / 2);
          splitUntil = b;
          shown += 2;
        } else {
          // An odd one out has the frame to itself.
          made.push(...picture(left, a, b, false));
          shown++;
        }
      });
      staged = true;
      pictureEnd = -1;
      // The winner is marked once the case has been made: late in the narration, but while both are still on screen.
      const winAt = Math.max(from + 1.2, Math.min(from + Math.max(1.5, narr.duration * 0.62), splitUntil - 2.5));
      clips.push(...made, ...sideLabels(from, splitUntil, o.winner, winAt, top));
      carrier = made.find((c) => c.trackId === tracks.video) ?? made[0];
      if (points.length) notes.push(`${o.heading ?? 'the opening'}: its points are not shown (a split screen has no room beside it); say them in the narration`);
    } else if (visuals.length) {
      const starts = visualStarts(visuals, narr.lines, narr.duration);
      const made: MediaClip[] = [];
      visuals.forEach((v, i) => {
        const a = from + starts[i];
        const b = i + 1 < visuals.length ? from + starts[i + 1] : to;
        if (b - a < MIN_SLOT && i > 0) return;
        made.push(...picture(v, a, b, made.length === 0));
        shown++;
      });
      // A picture dropped for being too short leaves its time to the one before it.
      made.sort((x, y) => x.start - y.start);
      for (let i = 0; i < made.length; i++) {
        const next = made[i + 1]?.start ?? to;
        const gap = next - (made[i].start + made[i].duration);
        if (gap > 1e-3 && input.media.get(made[i].mediaId)?.kind === 'image') {
          made[i].duration += gap;
          made[i].sourceDuration = made[i].duration;
        }
      }
      if (shown < visuals.length) notes.push(`${o.heading ?? 'the opening'}: ${visuals.length - shown} of ${visuals.length} pictures left out (under ${MIN_SLOT}s each would be a flash)`);
      clips.push(...made);
      carrier = made[0];
      if (points.length) {
        // Beside the pictures; after the lower third has gone, when there is one.
        const earliest = from + (o.lower ? 5.4 : 0.5);
        const at = clamp(from + times[0] - 0.8, earliest, Math.max(earliest, to - 4));
        const end = Math.min(to - 0.15, from + times[times.length - 1] + 4.5);
        if (end - at >= 3) {
          const built = buildKeyPoints({ ...cardBase, heading: o.heading, points, start: at, duration: end - at, reveal: times.map((x) => from + x - at), layout: 'left', backgroundOpacity: 0.9, numbered: f.numbered, focus: true });
          clips.push(...built.clips);
          // A drawn scene fills the frame and was drawn with its left side clear: the panel lies over it instead of pushing it aside.
          const drawnScene = made.every((c) => {
            const m = input.media.get(c.mediaId);
            return (m?.generated || m?.panel) && !m?.drawing;
          });
          panels.push({ from: at, to: end, dx: built.shiftX, still: drawnScene });
          beside = true;
        }
      }
    } else if (points.length) {
      const built = buildKeyPoints({ ...cardBase, heading: o.heading, points, start: from, duration: to - from, reveal: times, layout: 'full', numbered: f.numbered, focus: true });
      clips.push(...built.clips);
      carrier = built.clips[0];
    } else {
      const made = statements(narr.lines, o.heading, from, to);
      clips.push(...made);
      carrier = made[0];
      spoken = false;
    }
    if (o.chapter && carrier) carrier.chapter = o.chapter;
    if (o.lower && visuals.length) clips.push(...lowerThird(o.lower.kicker, o.lower.heading, from + 0.35, Math.min(4.8, narr.duration)));

    const who = o.presenter && input.media.get(o.presenter.mediaId);
    if (o.presenter && who && !pairs) {
      const green = o.presenter.greenScreen === true;
      const size = clamp(o.presenter.size ?? (green ? 0.55 : 0.3), 0.12, 0.9);
      const fit = Math.min(canvas.width / who.width, canvas.height / who.height);
      const scale = (size * canvas.height) / (who.height * fit);
      const wide = (who.width * fit * scale) / canvas.width;
      const side = o.presenter.corner === 'bottom-left' ? -1 : 1;
      // The presenter of the whole video carries on where the last part left their recording, and starts over when it runs out.
      const whole = o.presenter === script.presenter && who.kind === 'video';
      if (whole && presenterAt > who.duration - 1) presenterAt = 0;
      const inPoint = whole ? presenterAt : 0;
      const length = who.kind === 'video' ? Math.min(narr.duration, who.duration - inPoint) : narr.duration;
      if (whole) presenterAt += length + f.gap;
      clips.push(
        newMediaClip({
          mediaId: o.presenter.mediaId,
          trackId: tracks.presenter,
          start: from,
          duration: Math.max(MIN_CLIP, length),
          inPoint,
          sourceDuration: who.kind === 'video' ? who.duration : 0,
          sourceWidth: who.width,
          sourceHeight: who.height,
          scaleX: scale,
          scaleY: scale,
          posX: side * (0.5 - wide / 2 - (green ? 0.01 : 0.025)),
          posY: 0.5 - size / 2 - (green ? 0.005 : 0.04),
          muted: true,
          ...(green ? { chromaKey: true, chromaColor: '#00d800', chromaSimilarity: 0.38 } : { fadeIn: 0.25, fadeOut: 0.25 }),
        }),
      );
    }
    // Captions, except where the sentences themselves are the picture.
    if (spoken) captionsFor(narr, from, beside);
    return { scene: visuals.length ? 'pictures' : 'text', pictures: shown };
  };

  // ── Opening ──
  const hook = input.narration.hook;
  const titleCard = (): void => card(script.title, { subtitle: script.subtitle, duration: f.introSeconds });
  // A rundown: the headings listed under the opening words, when the opening has no pictures of its own.
  const rundown = f.rundown && !script.hookVisuals?.length && script.sections.length >= 2 ? { heading: f.rundown, points: script.sections.map((x) => x.heading).slice(0, 6) } : undefined;
  const opening = { visuals: script.hookVisuals, presenter: script.presenter, ...rundown };
  if (hook && f.intro === 'cold-open') {
    block(hook, opening);
    titleCard();
  } else {
    titleCard();
    if (hook) block(hook, opening);
  }

  // ── Sections ──
  const count = script.sections.length;
  script.sections.forEach((s, i) => {
    const narr = input.narration.sections[i];
    if (!narr) return;
    const n = f.countdown ? count - i : i + 1;
    const kicker = s.kicker?.trim() || KICKER[f.kicker](n);
    const start = t;
    // Between two stories told over pictures, the sweep covers the cut.
    if (f.stinger && (f.chapter === 'card' || i > 0)) clips.push(...buildStinger({ at: t, direction: 'right', colors: [palette.accent, palette.background], sweep: 0.28, canvas, trackId: tracks.text }).clips);
    if (f.chapter === 'card') {
      // A top list leads with the number itself; a data story with the figure.
      if (f.kicker === 'number') card(`#${n}`, { subtitle: s.heading, duration: f.cardSeconds, chapter: `${n}. ${s.heading}` });
      else if (f.figures && s.figure?.trim()) card(s.figure.trim(), { subtitle: s.heading, kicker: kicker || undefined, duration: f.cardSeconds, chapter: s.heading });
      else card(s.heading, { kicker: kicker || undefined, duration: f.cardSeconds, chapter: s.heading });
    }
    const speech = t;
    const r = block(narr, {
      heading: s.heading,
      visuals: s.visuals,
      points: s.points,
      presenter: s.presenter ?? script.presenter,
      chapter: f.chapter === 'card' ? undefined : s.heading,
      lower: f.chapter === 'overlay' ? { kicker, heading: s.heading } : undefined,
      winner: s.winner,
    });
    if (f.progress && count >= 2) {
      // How far through the story this is: a thin bar along the top, filled up to here.
      const bar = { trackId: tracks.text, start: speech, duration: Math.max(MIN_CLIP, t - speech), y: 0.03, h: 6 / REF_HEIGHT, fadeIn: 0.3, fadeOut: 0.3 };
      const share = (i + 1) / count;
      // White on a dark track, so it reads over a bright picture and a dark one alike.
      clips.push(...group([rectClip({ ...bar, fill: '#000000', opacity: 0.55, x: 0.5, w: 0.9 + 4 / REF_HEIGHT, h: 12 / REF_HEIGHT }), rectClip({ ...bar, fill: '#ffffff', x: 0.05 + (0.9 * share) / 2, w: 0.9 * share })], 'progress'));
    }
    if (r.scene === 'text' && !(s.points ?? []).length) notes.push(`"${s.heading}" names no pictures, so its sentences are the picture: add visuals for a richer video`);
    sections.push({ heading: s.heading, start, speech, end: t, scene: r.scene, pictures: r.pictures });
  });

  // ── Close ──
  const outroTitle = script.outro?.title?.trim() || f.outroTitle;
  const outro = input.narration.outro;
  if (outro && f.recap && count >= 2) {
    // The steps once more while the narrator wraps up, then the closing card.
    const from = t;
    // A comparison's recap is the verdict: who took each round.
    const heads = script.sections.map((s) => (f.split && s.winner?.trim() ? `${s.heading}: ${s.winner.trim()}` : s.heading)).slice(0, 6);
    const length = outro.duration + f.gap;
    clips.push(...buildKeyPoints({ ...cardBase, heading: f.recapTitle ?? 'Recap', points: heads, start: from, duration: length, layout: 'full', numbered: f.numbered, focus: false }).clips);
    block(outro, { under: 'card' });
    card(outroTitle, { subtitle: script.outro?.subtitle, duration: f.outroSeconds });
  } else if (outro) {
    const from = t;
    const length = Math.max(f.outroSeconds, outro.duration + 1);
    card(outroTitle, { subtitle: script.outro?.subtitle, duration: length });
    t = from;
    block(outro, { under: 'card' });
    t = from + length;
  } else card(outroTitle, { subtitle: script.outro?.subtitle, duration: f.outroSeconds });
  const end = t;

  // The pictures slide aside while a panel is up beside them.
  for (const p of panels) {
    if (p.dx === 0 || p.still) continue;
    const moved = makeRoom(clips, tracks.video, p.from, p.to, p.dx).clips;
    clips.splice(0, clips.length, ...moved);
  }

  // ── Captions ──
  let captions = 0;
  if (input.captions) {
    const look = input.captions;
    const made = captionClipsFor(captionSegs, undefined, tracks.captions).map((c): TextClip => {
      const next: TextClip = { ...c, ...look.patch };
      if (look.upper) {
        next.text = next.text.toUpperCase();
        next.words = next.words?.map((w) => ({ ...w, text: w.text.toUpperCase() }));
      }
      // Clear of a panel of key points: beside it, or above it on a tall frame.
      const mid = next.start + next.duration / 2;
      const panel = panels.find((p) => mid >= p.from && mid < p.to);
      if (panel && portrait) next.y = 0.44;
      else if (panel) next.x = 0.5 + panel.dx;
      return next;
    });
    captions = made.length;
    clips.push(...made);
  }

  // ── Music ──
  if (input.music && input.music.duration > 1) {
    const m = input.music;
    const settings = { ...DUCK, amountDb: clamp(m.duckDb, -40, -1) };
    const spans = duckSpans(voiced, settings);
    const bed: MediaClip[] = [];
    for (let at = input.start; at < end - 0.2; at += m.duration) {
      bed.push(newMediaClip({ mediaId: m.mediaId, trackId: tracks.music, start: at, duration: Math.min(m.duration, end - at), sourceDuration: m.duration, volume: clamp(m.volume, 0, 2) }));
    }
    bed.forEach((c, i) => {
      // The song starting over is covered by a short dip, the video's ends by a longer one.
      c.fadeIn = i === 0 ? Math.min(1, c.duration / 4) : Math.min(0.4, c.duration / 4);
      c.fadeOut = i === bed.length - 1 ? Math.min(2.5, c.duration / 3) : Math.min(0.4, c.duration / 4);
      c.keyframes = duckKeys(c, spans, settings) ?? [];
    });
    if (bed.length > 1) notes.push(`the music is ${Math.round(m.duration)}s long, so it plays ${bed.length} times`);
    clips.push(...bed);
  }

  return { clips, start: input.start, end, sections, captions, fitted, backdrop: staged ? (f.backdrop ?? ['#1F2937', '#0B1120']) : undefined, notes };
}
