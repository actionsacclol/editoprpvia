// Long-form videos built from a script (src/editor/longform.ts), the
// build_longform / list_formats tools, and the hand-off to Krypt Marketo
// (src/editor/marketo.ts). Run from editor.test.mjs.
import assert from 'node:assert';
import {
  AGENT_TOOL_NAMES,
  AGENT_VIDEO_PROMPTS,
  ART_STYLES,
  LONGFORM_EXAMPLES,
  agentPrompt,
  directBeats,
  findArt,
  BUILTIN_STYLES,
  LONGFORM_FORMATS,
  MARKETO_TOOLS,
  TOOLS,
  alignLines,
  captionSegments,
  chapterList,
  chaptersOf,
  coverScale,
  estimateLines,
  findFormat,
  handoffArgs,
  joinSpoken,
  longVideoId,
  parseScript,
  phraseTime,
  planLongform,
  pointTimes,
  runAgentTool,
  scriptStats,
  speechParts,
  splitSentences,
  spreadWords,
  trimSilence,
  useHandoffStore,
  useMediaStore,
  useProjectStore,
  useStyleStore,
  useTimelineStore,
  visualStarts,
} from './.editor.mjs';

export async function run({ t, ta, approx }) {
  const CANVAS = { width: 1920, height: 1080 };
  const TRACKS = { video: 'v', presenter: 'vp', narration: 'an', music: 'am', text: 'tt', captions: 'tc' };
  const A = 'Bees see ultraviolet light. Flowers use that to guide them, with marks we cannot see. A single hive visits two million flowers for one jar of honey.';
  const B = 'The waggle dance tells the others where to go. Its angle is the direction, measured against the sun. Its length is the distance.';
  const C = 'Without bees, a third of what we eat would be harder to grow. Almonds depend on them entirely.';
  const narr = (id, text, duration) => ({ mediaId: id, duration, lines: estimateLines(text, duration) });
  const media = new Map([
    ['p1', { kind: 'image', width: 1920, height: 1080, duration: 5 }],
    ['p2', { kind: 'image', width: 1600, height: 1200, duration: 5 }],
    ['p3', { kind: 'image', width: 900, height: 1600, duration: 5 }],
    ['clip', { kind: 'video', width: 1920, height: 1080, duration: 6 }],
    ['kip', { kind: 'video', width: 720, height: 1280, duration: 40 }],
  ]);
  const format = (id) => LONGFORM_FORMATS.find((f) => f.id === id);
  const plan = (over = {}) =>
    planLongform({
      script: {
        title: 'How bees find flowers',
        subtitle: 'In three parts',
        hook: 'Bees find flowers in ways we are only starting to understand.',
        sections: [
          { heading: 'What bees see', text: A, points: ['Ultraviolet light', 'Two million flowers'], visuals: [{ mediaId: 'p1' }, { mediaId: 'p2', when: 'flowers use that' }, { mediaId: 'clip', when: 'a single hive' }] },
          { heading: 'The waggle dance', text: B },
          { heading: 'Why it matters', text: C, points: ['A third of our food', 'Almonds'] },
        ],
        outro: { text: 'Thanks for watching.' },
      },
      format: format('explainer'),
      canvas: CANVAS,
      narration: { hook: narr('n0', 'Bees find flowers in ways we are only starting to understand.', 4), sections: [narr('n1', A, 12), narr('n2', B, 10), narr('n3', C, 7)], outro: narr('n4', 'Thanks for watching.', 1.5) },
      media,
      card: { look: 'clean' },
      captions: { patch: { fontSize: 56 }, upper: false },
      transition: { type: 'fade', duration: 0.45 },
      start: 0,
      tracks: TRACKS,
      ...over,
    });
  const on = (p, track) => p.clips.filter((c) => c.trackId === track).sort((a, b) => a.start - b.start);
  const end = (c) => c.start + c.duration;

  // ── Formats and scripts ──────────────────────────────────────────────────
  t('longform: every format has a style that exists, and the names people use find it', () => {
    assert.strictEqual(new Set(LONGFORM_FORMATS.map((f) => f.id)).size, LONGFORM_FORMATS.length);
    for (const f of LONGFORM_FORMATS) {
      assert.ok(BUILTIN_STYLES.some((s) => s.id === f.style), `${f.id}: style ${f.style}`);
      assert.ok(f.motions.length > 0 && f.hold > 2 && f.write.length > 80, f.id);
    }
    assert.strictEqual(findFormat('Top list').id, 'listicle');
    assert.strictEqual(findFormat('video essay').id, 'video-essay');
    assert.strictEqual(findFormat('how-to').id, 'tutorial');
    assert.strictEqual(findFormat('vlog'), undefined);
  });

  t('longform: a script typed as text becomes title, hook, sections, points, pictures and outro', () => {
    const s = parseScript(
      ['# How bees find flowers', '*In three parts*', '', 'Bees are clever.', 'Very clever.', '', '## What bees see', A, '- Ultraviolet light', '- Two million flowers', '![](C:\\pics\\bee one.png)', 'C:\\pics\\field.mp4', '', '## The waggle dance', 'First paragraph.', '', 'Second paragraph.', '', '## Outro', 'Thanks for watching.'].join('\n'),
    );
    assert.strictEqual(s.title, 'How bees find flowers');
    assert.strictEqual(s.subtitle, 'In three parts');
    assert.strictEqual(s.hook, 'Bees are clever. Very clever.');
    assert.deepStrictEqual(s.sections.map((x) => x.heading), ['What bees see', 'The waggle dance']);
    assert.deepStrictEqual(s.sections[0].points, ['Ultraviolet light', 'Two million flowers']);
    assert.deepStrictEqual(s.sections[0].visuals, ['C:\\pics\\bee one.png', 'C:\\pics\\field.mp4']);
    assert.strictEqual(s.sections[0].text, A);
    assert.strictEqual(s.sections[1].text, 'First paragraph.\n\nSecond paragraph.');
    assert.strictEqual(s.outro.text, 'Thanks for watching.');
    // No headings at all: one section would be nothing to build, and the caller says so.
    assert.strictEqual(parseScript('Just a paragraph.').sections.length, 0);
    const stats = scriptStats(s, format('explainer'));
    assert.ok(stats.words > 30 && stats.seconds > (stats.words / 150) * 60, JSON.stringify(stats));
  });

  t('longform: every format has an example script that builds as it is, short enough to try', () => {
    assert.deepStrictEqual(Object.keys(LONGFORM_EXAMPLES).sort(), LONGFORM_FORMATS.map((f) => f.id).sort());
    for (const f of LONGFORM_FORMATS) {
      const s = parseScript(LONGFORM_EXAMPLES[f.id]);
      assert.ok(s.title && s.subtitle && s.hook, f.id);
      assert.ok(s.sections.length >= 2 && s.sections.length <= 4, `${f.id}: ${s.sections.length} sections`);
      for (const sec of s.sections) assert.ok(sec.text.trim() && sec.visuals.length === 0 && sec.points.length <= 4, `${f.id}: ${sec.heading}`);
      assert.ok(s.outro?.text, f.id);
      // A minute or less: an example is for seeing what the format does, and it is narrated and drawn while they wait.
      const stats = scriptStats(s, f);
      // (A trailer is counted in beats and a quiz waits through its countdowns: neither is measured in words.)
      assert.ok((f.layout || stats.words >= 60) && stats.seconds <= (f.layout === 'quiz' ? 90 : 75), `${f.id}: ${JSON.stringify(stats)}`);
      if (f.layout) continue;
      // Drawn, it is acted rather than only talked through: a few different poses over the script.
      const text = s.sections.map((x) => x.text).join(' ');
      const poses = new Set(directBeats(estimateLines(text, 30), 31, [], 'stick').map((b) => b.pose));
      assert.ok(poses.size >= 3, `${f.id}: ${[...poses]}`);
    }
  });

  t('longform: the prompts offered for an agent name the server, a format and a style that exist', () => {
    const p = agentPrompt('Top list', 'Chalkboard');
    assert.match(p, /^Use krypt-editor to make a 5-minute top list about \[your topic\], drawn in the Chalkboard style\. /);
    assert.ok(!agentPrompt('Explainer').includes('drawn in'));
    assert.ok(AGENT_VIDEO_PROMPTS.length >= 3);
    // Each one asks for a drawn style by a name build_longform understands, or for a format that lays itself out (a quiz).
    for (const q of AGENT_VIDEO_PROMPTS) assert.ok(/\bquiz\b/.test(q) || ART_STYLES.some((a) => q.toLowerCase().includes(a.name.toLowerCase()) && findArt(a.name)?.id === a.id), q);
  });

  // ── Speech ───────────────────────────────────────────────────────────────
  t('longform: narration is spoken a sentence at a time, with a longer pause between paragraphs', () => {
    assert.deepStrictEqual(splitSentences('One. Two!  Three?'), ['One.', 'Two!', 'Three?']);
    const parts = speechParts('One. Two.\n\nThree.');
    assert.deepStrictEqual(parts.map((p) => p.text), ['One.', 'Two.', 'Three.']);
    assert.ok(parts[1].pause > parts[0].pause && parts[2].pause === 0, JSON.stringify(parts));
    const words = spreadWords('Hello there, world', 2, 4);
    assert.deepStrictEqual(words.map((w) => w.text), ['Hello', 'there,', 'world']);
    approx(words[0].start, 2);
    approx(words[2].end, 4);
    for (let i = 1; i < words.length; i++) approx(words[i].start, words[i - 1].end);
  });

  t('longform: joined sentences sit exactly where the recording has them', () => {
    const sr = 1000;
    const tone = (n) => Float32Array.from({ length: n }, () => 0.5);
    const padded = new Float32Array(900);
    padded.set(tone(500), 200);
    const trimmed = trimSilence(padded, sr);
    assert.strictEqual(trimmed.length, 560); // 500 samples of sound and 30 ms kept each side
    assert.strictEqual(trimSilence(new Float32Array(100), sr).length, 0);
    const j = joinSpoken([{ text: 'One two.', audio: tone(1000), pause: 0.3 }, { text: 'Three.', audio: tone(500), pause: 0 }], sr);
    assert.deepStrictEqual(j.lines.map((l) => [l.start, l.end]), [[0.08, 1.08], [1.38, 1.88]]);
    assert.strictEqual(j.audio.length, 2000);
    assert.strictEqual(j.audio[80], 0.5);
    assert.strictEqual(j.audio[1200], 0); // the pause is silence
    assert.deepStrictEqual(j.lines[0].words.map((w) => w.text), ['One', 'two.']);
  });

  t('longform: a recording is timed by what was heard in it, the words stay the script\'s', () => {
    const text = 'Krypt ships fast. It costs 5 dollars.';
    // What a speech model makes of it: a name and a number come out differently.
    const heard = [
      { start: 1, end: 1.4, text: 'Crypt' },
      { start: 1.4, end: 1.8, text: 'ships' },
      { start: 1.8, end: 2.2, text: 'fast.' },
      { start: 3, end: 3.2, text: 'It' },
      { start: 3.2, end: 3.6, text: 'costs' },
      { start: 3.6, end: 3.9, text: 'five' },
      { start: 3.9, end: 4.4, text: 'dollars.' },
    ];
    const r = alignLines(text, heard, 6);
    assert.ok(r.aligned);
    assert.deepStrictEqual(r.lines.map((l) => l.text), ['Krypt ships fast.', 'It costs 5 dollars.']);
    approx(r.lines[0].start, 1, 0.01);
    approx(r.lines[0].end, 2.2, 0.15);
    assert.ok(r.lines[1].start >= 2.2 - 0.15 && r.lines[1].start <= 3.3, `second line starts at ${r.lines[1].start}`);
    approx(r.lines[1].end, 4.4, 0.01);
    for (const l of r.lines) for (let i = 1; i < l.words.length; i++) assert.ok(l.words[i].start >= l.words[i - 1].start);
    // A recording of something else is not trusted: the lines are spread over it instead.
    const other = alignLines(text, [{ start: 0, end: 1, text: 'no' }, { start: 1, end: 2, text: 'this' }, { start: 2, end: 3, text: 'is' }], 6);
    assert.strictEqual(other.aligned, false);
    approx(other.lines[0].start, 0);
    approx(other.lines[1].end, 6, 0.01);
  });

  t('longform: points and pictures land on the words that name them, in order', () => {
    const lines = estimateLines(A, 12);
    const hit = phraseTime('two million flowers', lines);
    assert.strictEqual(hit.line, 2);
    assert.ok(hit.time > lines[2].start && hit.time < lines[2].end);
    const times = pointTimes(['Ultraviolet light', 'Something never said', 'Two million flowers'], lines, 12);
    assert.ok(times[0] < lines[0].end, `first point ${times[0]}`);
    assert.ok(times[1] > times[0] && times[1] < times[2], `unmatched point sits between its neighbours: ${times}`);
    const v = visualStarts([{ mediaId: 'a' }, { mediaId: 'b' }, { mediaId: 'c', when: 'a single hive' }, { mediaId: 'd' }], lines, 12);
    assert.strictEqual(v[0], 0);
    approx(v[1], v[2] / 2, 1e-6); // no cue: half way to the next one
    assert.ok(v[2] >= lines[2].start && v[3] > v[2] && v[3] < 12);
    // A cue that would come before the picture ahead of it is ignored.
    const back = visualStarts([{ mediaId: 'a' }, { mediaId: 'b', at: 8 }, { mediaId: 'c', at: 3 }], lines, 12);
    assert.ok(back[2] > back[1], `${back}`);
  });

  t('longform: captions are one-line phrases of the script, every word once', () => {
    const lines = estimateLines(A, 12);
    const segs = captionSegments(lines, 32);
    assert.strictEqual(segs.map((s) => s.text).join(' '), A);
    for (const s of segs) {
      assert.ok(s.text.length <= 32, `"${s.text}" is ${s.text.length} long`);
      assert.ok(s.end > s.start && s.words.length >= 1);
      // Spaced the way the caption renderer joins them: the words put end to end are the caption.
      assert.strictEqual(s.words.map((w) => w.text).join(''), s.text);
    }
    for (let i = 1; i < segs.length; i++) assert.ok(segs[i].start >= segs[i - 1].end - 1e-6, 'captions never overlap');
    assert.ok(segs.filter((s) => s.words.length === 1).length <= 1, 'no stray one-word captions');
  });

  // ── The plan ─────────────────────────────────────────────────────────────
  t('longform: an explainer is a title, then each part behind its card, then an outro, with nothing overlapping', () => {
    const p = plan();
    const voice = on(p, 'an');
    assert.deepStrictEqual(voice.map((c) => c.mediaId), ['n0', 'n1', 'n2', 'n3', 'n4']);
    for (let i = 1; i < voice.length; i++) assert.ok(voice[i].start >= end(voice[i - 1]) - 1e-6, 'narration never talks over itself');
    assert.strictEqual(voice[0].start, 3.5); // after the title card
    assert.deepStrictEqual(p.sections.map((s) => s.scene), ['pictures', 'text', 'text']);
    assert.deepStrictEqual(chaptersOf(p.clips).map((c) => c.title), ['What bees see', 'The waggle dance', 'Why it matters']);
    p.sections.forEach((s, i) => {
      approx(chaptersOf(p.clips)[i].time, s.start);
      approx(s.speech - s.start, 2.6); // the chapter card
      approx(voice[i + 1].start, s.speech);
    });
    assert.ok(chapterList(p.clips).text.startsWith('0:00 Intro\n'));
    for (const c of p.clips) assert.ok(c.start >= -1e-9 && end(c) <= p.end + 1e-6, `${c.type} ${c.id} runs past the end`);
    approx(p.end, Math.max(...p.clips.map(end)));
  });

  t('longform: pictures fill their section with no gap, and no still sits in one framing for long', () => {
    const p = plan();
    const s = p.sections[0];
    const pics = on(p, 'v');
    assert.strictEqual(s.pictures, 3);
    approx(pics[0].start, s.speech);
    approx(end(pics[pics.length - 1]), s.end);
    for (let i = 1; i < pics.length; i++) approx(pics[i].start, end(pics[i - 1]));
    const f = format('explainer');
    for (const c of pics) {
      assert.ok(c.muted, 'b-roll is silent under the narration');
      if (media.get(c.mediaId).kind === 'image') {
        assert.ok(c.duration <= f.hold * 1.5 + 1e-6, `${c.mediaId} holds ${c.duration}s`);
        assert.ok(c.motion && c.motion !== 'none', 'a still always moves');
        approx(c.sourceDuration, c.duration);
      } else assert.ok(c.duration <= 6 + 1e-6, 'a video never plays past its end');
    }
    // The third picture is a 6 s video cued late: it plays from where the words are, and again if it runs out.
    const video = pics.filter((c) => c.mediaId === 'clip');
    assert.ok(video.length >= 1 && video[0].start > s.speech + 4);
    // A 4:3 picture fills a 16:9 frame; a tall phone screenshot would lose too much, so it is shown whole.
    assert.ok(pics.find((c) => c.mediaId === 'p2').scaleX > 1.3);
    approx(coverScale(1600, 1200, CANVAS), 4 / 3, 1e-6);
    const tall = plan({ script: { title: 'T', sections: [{ heading: 'One', text: A, visuals: [{ mediaId: 'p3' }] }] }, narration: { sections: [narr('n1', A, 12)] } });
    assert.strictEqual(on(tall, 'v')[0].scaleX, 1);
    assert.strictEqual(tall.fitted, true);
    assert.strictEqual(plan().fitted, false);
  });

  t('longform: key points come up as they are said, the picture makes room, captions move clear', () => {
    const p = plan();
    const s = p.sections[0];
    const pics = on(p, 'v');
    const text = on(p, 'tt').filter((c) => c.type === 'text');
    const first = text.find((c) => /Ultraviolet light/.test(c.text));
    const second = text.find((c) => /Two million flowers/.test(c.text));
    assert.ok(first && second && second.start > first.start + 2, 'points appear one after the other');
    assert.ok(first.start >= s.speech && second.start < s.end);
    assert.ok(pics.some((c) => c.keyframes.some((k) => k.prop === 'posX' && k.value > 0.1)), 'the picture slides aside for the panel');
    const caps = on(p, 'tc');
    const beside = caps.filter((c) => c.start > first.start && end(c) < second.start + 2);
    assert.ok(beside.length > 0 && beside.every((c) => c.x > 0.6), 'captions sit in the part of the frame the panel leaves free');
    assert.ok(caps.filter((c) => c.start >= p.sections[1].speech && c.start < p.sections[2].speech).every((c) => c.x === 0.5));
  });

  t('longform: a section with no pictures is designed text, and captions say every spoken word once', () => {
    const p = plan();
    const [, dance, matters] = p.sections;
    const tt = on(p, 'tt');
    // Its own sentences, one at a time, on the card colour.
    const sentences = tt.filter((c) => c.type === 'text' && c.start >= dance.speech - 1e-6 && c.start < dance.end && !c.text.includes('\u2009'));
    assert.strictEqual(sentences.length, 3);
    assert.strictEqual(sentences.map((c) => c.text.replace(/\n/g, ' ')).join(' '), B);
    assert.ok(tt.some((c) => c.type === 'shape' && c.w > 1 && c.start <= dance.speech + 1e-6 && end(c) >= dance.end - 1e-6), 'a full-frame backing');
    // The points of the last section, full screen.
    assert.ok(tt.some((c) => c.type === 'text' && /A third of our food/.test(c.text) && c.start >= matters.speech));
    const caps = on(p, 'tc');
    assert.strictEqual(caps.length, p.captions);
    assert.ok(caps.every((c) => c.role === 'caption' && c.words.length > 0));
    assert.ok(!caps.some((c) => c.start >= dance.speech && c.start < dance.end), 'no captions over sentences that are already on screen');
    // The opening has no pictures either, so its sentence is on screen and needs no caption.
    assert.strictEqual(caps.map((c) => c.text).join(' '), [A, C, 'Thanks for watching.'].join(' '));
    assert.strictEqual(on(plan({ captions: null }), 'tc').length, 0);
    const upper = on(plan({ captions: { patch: { fontSize: 60 }, upper: true } }), 'tc');
    assert.ok(upper.every((c) => c.text === c.text.toUpperCase() && c.words.every((w) => w.text === w.text.toUpperCase())));
  });

  t('longform: a documentary opens cold and names its chapters over the footage', () => {
    const p = plan({ format: format('documentary') });
    const voice = on(p, 'an');
    assert.strictEqual(voice[0].mediaId, 'n0');
    assert.strictEqual(voice[0].start, 0); // the hook plays before the title
    const s = p.sections[0];
    approx(s.speech, s.start); // no chapter card
    const marked = p.clips.filter((c) => c.chapter);
    assert.deepStrictEqual(marked.map((c) => c.chapter), ['What bees see', 'The waggle dance', 'Why it matters']);
    assert.strictEqual(marked[0].type, 'media');
    const lower = on(p, 'tt').filter((c) => c.type === 'text' && c.anchor === 'left' && c.start < s.speech + 1);
    assert.ok(lower.some((c) => c.text === 'What bees see') && lower.some((c) => /C\u2009H\u2009A\u2009P\u2009T\u2009E\u2009R/.test(c.text)), 'a lower third with the chapter and its name');
  });

  t('longform: a top list counts down, a tutorial ends on its steps', () => {
    const list = plan({ format: format('listicle') });
    assert.deepStrictEqual(chaptersOf(list.clips).map((c) => c.title), ['3. What bees see', '2. The waggle dance', '1. Why it matters']);
    assert.ok(on(list, 'tt').some((c) => c.type === 'text' && c.text === '#1'));
    const how = plan({ format: format('tutorial') });
    const recap = on(how, 'tt').filter((c) => c.type === 'text' && c.start >= how.sections[2].end - 1e-6);
    for (const h of ['What bees see', 'The waggle dance', 'Why it matters']) assert.ok(recap.some((c) => c.text.includes(h)), `recap lists "${h}"`);
    assert.ok(on(how, 'tt').some((c) => c.type === 'text' && /S\u2009T\u2009E\u2009P\u2009 \u20092/.test(c.text)), 'step cards');
  });

  t('longform: music runs the whole video, starts over when it is short, and ducks under every sentence', () => {
    const p = plan({ music: { mediaId: 'song', duration: 20, volume: 0.3, duckDb: -12 } });
    const bed = on(p, 'am');
    assert.ok(bed.length >= 3);
    approx(bed[0].start, 0);
    approx(end(bed[bed.length - 1]), p.end);
    for (let i = 1; i < bed.length; i++) approx(bed[i].start, end(bed[i - 1]));
    const first = bed[0];
    const vol = first.keyframes.filter((k) => k.prop === 'volume');
    assert.ok(vol.length >= 4);
    approx(vol[0].value, 0.3); // full under the title card
    approx(Math.min(...vol.map((k) => k.value)), 0.3 * Math.pow(10, -12 / 20), 1e-6);
    assert.ok(p.notes.some((n) => /plays \d+ times/.test(n)));
    assert.strictEqual(on(plan(), 'am').length, 0);
  });

  t('longform: a presenter stands in a corner on the track in front, keyed when on green', () => {
    const script = { title: 'T', sections: [{ heading: 'One', text: A, visuals: [{ mediaId: 'p1' }], presenter: { mediaId: 'kip', greenScreen: true } }] };
    const p = plan({ script, narration: { sections: [narr('n1', A, 12)] } });
    const [who] = on(p, 'vp');
    assert.ok(who.chromaKey && who.muted);
    approx(who.duration, 12);
    assert.ok(who.posX > 0.3 && who.posY > 0.15, `${who.posX}, ${who.posY}`);
    // 55% of the frame's height.
    approx((1280 * Math.min(1920 / 720, 1080 / 1280) * who.scaleY) / 1080, 0.55, 1e-6);
  });

  // ── The tools ────────────────────────────────────────────────────────────
  const sig = new AbortController().signal;
  const call = (tool, args = {}) => runAgentTool({ rid: 1, tool, args, client: 'test' }, () => {}, sig);
  const reset = () => {
    useStyleStore.setState({ custom: [], activeId: null, brief: '', reference: null });
    useMediaStore.setState({ media: [] });
    useProjectStore.setState({ path: null, name: 'Untitled', dirty: false });
    useHandoffStore.setState({ exportPath: null, script: null, sentId: null });
    useTimelineStore.setState({ clips: [], past: [], future: [], selectedIds: [] });
  };

  await ta('list_formats describes every format; build_longform refuses a script it cannot build before doing any work', async () => {
    reset();
    for (const name of ['list_formats', 'build_longform', 'send_to_marketo', 'marketo']) {
      assert.ok(AGENT_TOOL_NAMES.includes(name) && TOOLS.some((x) => x.name === name), name);
    }
    const r = await call('list_formats');
    assert.ok(r.ok, r.text);
    const j = JSON.parse(r.text);
    assert.deepStrictEqual(j.formats.map((f) => f.id), LONGFORM_FORMATS.map((f) => f.id));
    assert.ok(j.formats.every((f) => f.how_to_write_it && f.style));
    const bad = await call('build_longform', { format: 'vlog', title: 'T', sections: [{ heading: 'A', text: 'Hi.' }] });
    assert.ok(!bad.ok && /No format "vlog"/.test(bad.text), bad.text);
    const none = await call('build_longform', { title: 'T', sections: [] });
    assert.ok(!none.ok && /sections is required/.test(none.text), none.text);
    const mute = await call('build_longform', { title: 'T', sections: [{ heading: 'A' }] });
    assert.ok(!mute.ok && /needs text/.test(mute.text), mute.text);
    assert.strictEqual(useTimelineStore.getState().past.length, 0);
    // The schema takes a picture as a path or with its cue.
    const input = TOOLS.find((x) => x.name === 'build_longform').input;
    assert.ok(input.safeParse({ title: 'T', sections: [{ heading: 'A', text: 'Hi.', visuals: ['C:/a.png', { media: 'm1', when: 'hi' }] }] }).success);
    assert.ok(!input.safeParse({ title: 'T', sections: [] }).success);
  });

  // ── Krypt Marketo ────────────────────────────────────────────────────────
  t('marketo: the hand-off carries the file, the project, the script and the chapters', () => {
    const ctx = { exportPath: 'C:/out/bees.mp4', projectPath: 'C:/p/bees.krypt', projectName: 'bees', chapters: '0:00 Intro\n0:12 What bees see', script: { title: 'How bees find flowers', sections: [{ heading: 'What bees see', text: A }] }, sentId: null };
    assert.match(handoffArgs({}, { ...ctx, exportPath: null }).problem, /no exported video yet/);
    assert.match(handoffArgs({ videoPath: 'C:/out/bees.wav' }, ctx).problem, /not a video file/);
    const fresh = handoffArgs({ description: 'How bees find flowers, explained.', tags: [' bees ', ''], visibility: 'unlisted' }, ctx).args;
    assert.deepStrictEqual(fresh, {
      title: 'How bees find flowers',
      sections: [{ heading: 'What bees see', text: A }],
      description: 'How bees find flowers, explained.\n\n0:00 Intro\n0:12 What bees see',
      tags: ['bees'],
      project_path: 'C:/p/bees.krypt',
      video_path: 'C:/out/bees.mp4',
      status: 'edited',
      visibility: 'unlisted',
    });
    // A description that already has chapters is left as written.
    assert.strictEqual(handoffArgs({ description: 'About bees.\n0:00 Start\n1:00 End' }, ctx).args.description, 'About bees.\n0:00 Start\n1:00 End');
    // Sending again updates the same entry and does not overwrite what Marketo holds.
    const again = handoffArgs({}, { ...ctx, sentId: 'lv_abc123' }).args;
    assert.deepStrictEqual(again, { id: 'lv_abc123', project_path: 'C:/p/bees.krypt', video_path: 'C:/out/bees.mp4', status: 'edited' });
    assert.strictEqual(longVideoId('lv_abc123 · "How bees find flowers" · edited · channel Bees · 1 sections\nFolder: C:/x'), 'lv_abc123');
    assert.strictEqual(longVideoId('Something else'), undefined);
  });

  await ta('send_to_marketo saves the video in Marketo and starts the upload; marketo reaches only the long-video tools', async () => {
    reset();
    const had = globalThis.window;
    const calls = [];
    let installed = false;
    globalThis.window = {
      krypt: {
        marketo: {
          status: async () => (installed ? { installed: true, running: true, version: '1.2.3' } : { installed: false, running: false, message: 'Krypt Marketo is not installed on this computer.' }),
          call: async (tool, args) => {
            calls.push({ tool, args });
            if (!installed) return { ok: false, text: 'Krypt Marketo is not installed on this computer.' };
            if (tool === 'save_long_video') return { ok: true, text: `lv_abc123 · "${args.title ?? 'kept'}" · edited · channel Bees · 0 sections` };
            if (tool === 'browser_attach_long') return { ok: true, text: 'Attached the long video in YouTube Studio.' };
            if (tool === 'render_thumbnail') return { ok: true, text: 'Thumbnail drawn.', images: [{ data: 'AAAA', mimeType: 'image/png' }] };
            return { ok: true, text: `ran ${tool}` };
          },
        },
      },
    };
    try {
      const noFile = await call('send_to_marketo', {});
      assert.ok(!noFile.ok && /no exported video yet/.test(noFile.text), noFile.text);
      assert.strictEqual(calls.length, 0);
      useHandoffStore.getState().setExport('C:/out/bees.mp4');
      const absent = await call('send_to_marketo', { title: 'Bees' });
      assert.ok(!absent.ok && /not installed/.test(absent.text), absent.text);
      const off = JSON.parse((await call('marketo')).text);
      assert.deepStrictEqual([off.installed, off.tools], [false, []]);

      installed = true;
      calls.length = 0;
      const sent = await call('send_to_marketo', { title: 'Bees', upload: true });
      assert.ok(sent.ok, sent.text);
      assert.deepStrictEqual(calls.map((c) => c.tool), ['save_long_video', 'browser_attach_long']);
      assert.deepStrictEqual(calls[0].args, { title: 'Bees', video_path: 'C:/out/bees.mp4', status: 'edited' });
      assert.deepStrictEqual(calls[1].args, { id: 'lv_abc123' });
      assert.match(sent.text, /long video lv_abc123/);
      assert.match(sent.text, /Nothing is public until Save/);
      // The second send updates that entry.
      calls.length = 0;
      await call('send_to_marketo', { description: 'About bees.' });
      assert.strictEqual(calls[0].args.id, 'lv_abc123');

      const on = JSON.parse((await call('marketo')).text);
      assert.deepStrictEqual([on.installed, on.running, on.tools], [true, true, [...MARKETO_TOOLS]]);
      const thumb = await call('marketo', { tool: 'render_thumbnail', args: { id: 'lv_abc123' } });
      assert.ok(thumb.ok && thumb.images.length === 1);
      calls.length = 0;
      const posting = await call('marketo', { tool: 'browser_click', args: { ref: 'e1' } });
      assert.ok(!posting.ok && /not reachable from Krypt Editor/.test(posting.text), posting.text);
      assert.strictEqual(calls.length, 0);
      assert.deepStrictEqual(TOOLS.find((x) => x.name === 'marketo').input.shape.tool.unwrap().options, [...MARKETO_TOOLS]);
    } finally {
      if (had === undefined) delete globalThis.window;
      else globalThis.window = had;
    }
  });
}
