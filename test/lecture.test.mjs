// Lecture tools: chapters, key points, slide alignment, and how the project
// listing scales to a long edit (run from editor.test.mjs).
import assert from 'node:assert';
import {
  alignSlides,
  buildCard,
  buildKeyPoints,
  chapterList,
  chapterStamp,
  chaptersOf,
  contentWords,
  makeRoom,
  markChapters,
  planTransitions,
  resolvedValue,
  runAgentTool,
  sliceClip,
  slideTitle,
  timelineDuration,
  useMediaStore,
  useStyleStore,
  useTimelineStore,
} from './.editor.mjs';

export async function run({ t, ta, approx, mediaClip, textClip, V1, T1, A1 }) {
  const KINDS = new Map([
    ['m1', 'video'],
    ['m2', 'video'],
    ['song', 'audio'],
  ]);
  const canvas = { width: 1920, height: 1080 };

  // ── Chapters ─────────────────────────────────────────────────────────────
  t('chapters: in order, the pieces of a cut clip count once, and the list is ready to paste', () => {
    const whole = mediaClip({ id: 'a', duration: 100, sourceDuration: 400, chapter: 'Light reactions' });
    const pieces = [sliceClip(whole, 0, 40, { keepId: true }), { ...sliceClip(whole, 40, 100), start: 40 }];
    assert.strictEqual(pieces[1].chapter, 'Light reactions'); // the mark survives a cut
    const clips = [
      ...pieces.map((c) => ({ ...c, start: c.start + 30 })),
      mediaClip({ id: 'b', start: 130, duration: 60, sourceDuration: 400, inPoint: 200, chapter: 'Calvin cycle' }),
      mediaClip({ id: 'c', start: 190, duration: 50, sourceDuration: 400, inPoint: 300, chapter: '  ' }),
    ];
    assert.deepStrictEqual(chaptersOf(clips).map((c) => [c.time, c.title]), [[30, 'Light reactions'], [130, 'Calvin cycle']]);
    const list = chapterList(clips);
    assert.strictEqual(list.text, '0:00 Intro\n0:30 Light reactions\n2:10 Calvin cycle');
    assert.deepStrictEqual(list.problems, []);
    assert.strictEqual(chapterList(clips, 'Welcome').text.split('\n')[0], '0:00 Welcome');
    assert.deepStrictEqual(chapterList([]), { text: '', chapters: [], problems: [] });
    assert.strictEqual(chapterStamp(3725, true), '1:02:05');
    assert.strictEqual(chapterStamp(59.999999, false), '1:00');
  });

  t('chapters: what a video site would reject is named', () => {
    const clips = [mediaClip({ id: 'a', duration: 5, chapter: 'One' }), mediaClip({ id: 'b', start: 5, duration: 100, chapter: 'Two' })];
    const { problems } = chapterList(clips);
    assert.ok(problems.some((p) => p.includes('only 2 chapters')));
    assert.ok(problems.some((p) => p.includes('"One" is under 10 seconds')));
  });

  t('markChapters: a card that starts there carries the chapter; mid-clip the footage is split and plays straight on', () => {
    const card = buildCard({ title: 'Part 2', start: 60, duration: 3, look: 'clean', canvas, trackId: 't1' });
    const clips = [mediaClip({ id: 'a', duration: 60, sourceDuration: 300 }), mediaClip({ id: 'b', start: 63, duration: 100, sourceDuration: 300, inPoint: 60 }), ...card.clips];
    const r = markChapters(clips, [V1, T1, A1], KINDS, [
      { time: 120, title: 'Calvin cycle' },
      { time: 60, title: 'Light reactions' },
      { time: 500, title: 'Nowhere' },
    ]);
    assert.strictEqual(r.clips.find((c) => c.id === card.background).chapter, 'Light reactions');
    assert.strictEqual(r.splits, 1);
    assert.deepStrictEqual(r.missed, [500]);
    const [left, right] = r.clips.filter((c) => c.type === 'media' && c.start >= 63).sort((x, y) => x.start - y.start);
    assert.strictEqual(left.id, 'b');
    assert.deepStrictEqual([left.start, left.duration, right.start, right.duration], [63, 57, 120, 43]);
    approx(right.inPoint, 117); // the source carries on where the left piece stops
    assert.strictEqual(right.chapter, 'Calvin cycle');
    assert.strictEqual(left.chapter, undefined);
    assert.deepStrictEqual(chaptersOf(r.clips).map((c) => c.title), ['Light reactions', 'Calvin cycle']);
    // That split is not a cut: "a transition on every cut" leaves it alone.
    const tr = planTransitions(r.clips, [V1, T1, A1], KINDS, { types: ['fade'], duration: 0.5 });
    assert.strictEqual(tr.clips.find((c) => c.id === right.id).transition, 'none');
  });

  t('markChapters: same time retitles, replace starts over, and one moment holds one chapter', () => {
    const clips = [mediaClip({ id: 'a', duration: 50, chapter: 'Old' }), mediaClip({ id: 'b', start: 50, duration: 50, inPoint: 80, sourceDuration: 300, chapter: 'Keep' })];
    const retitled = markChapters(clips, [V1], KINDS, [{ time: 0, title: 'New' }]);
    assert.deepStrictEqual(chaptersOf(retitled.clips).map((c) => c.title), ['New', 'Keep']);
    const fresh = markChapters(clips, [V1], KINDS, [{ time: 50, title: 'Only' }], true);
    assert.deepStrictEqual(chaptersOf(fresh.clips).map((c) => [c.time, c.title]), [[50, 'Only']]);
    assert.deepStrictEqual(chaptersOf(markChapters(clips, [V1], KINDS, [], true).clips), []);
    // A locked track is never split or marked.
    const locked = markChapters([mediaClip({ id: 'a', duration: 50 })], [{ ...V1, locked: true }], KINDS, [{ time: 20, title: 'X' }]);
    assert.deepStrictEqual([locked.splits, locked.missed], [0, [20]]);
  });

  // ── Key points ───────────────────────────────────────────────────────────
  const kp = (over = {}) => buildKeyPoints({ heading: 'Limiting factors', points: ['Light intensity', 'Carbon dioxide concentration', 'Temperature'], start: 100, duration: 12, layout: 'full', look: 'clean', canvas, trackId: 't1', ...over });

  t('key points: one left edge, top to bottom, inside the frame, arriving one at a time', () => {
    const r = kp({ reveal: [2, 5, 8] });
    const points = r.points.map((id) => r.clips.find((c) => c.id === id));
    assert.deepStrictEqual(r.times, [102, 105, 108]);
    assert.deepStrictEqual(points.map((p) => p.start), [102, 105, 108]);
    assert.ok(points.every((p) => p.anchor === 'left' && p.x === points[0].x && p.fontSize === points[0].fontSize), 'points line up');
    assert.ok(points[0].y < points[1].y && points[1].y < points[2].y);
    assert.ok(points.every((p) => p.y > 0.1 && p.y < 0.9 && p.x > 0.1 && p.x < 0.5));
    const heading = r.clips.find((c) => c.id === r.heading);
    assert.ok(heading.y < points[0].y && heading.anchor === 'left' && heading.fontSize > points[0].fontSize);
    const panel = r.clips.find((c) => c.id === r.panel);
    assert.deepStrictEqual([r.clips[0].id, panel.start, panel.duration, panel.w >= 1], [r.panel, 100, 12, true]);
    assert.ok(r.clips.every((c) => c.start >= 100 && c.start + c.duration <= 112 + 1e-9));
    assert.strictEqual(new Set(r.clips.map((c) => c.group)).size, 1);
    assert.strictEqual(r.shiftX, 0);
    // Each bullet mark sits beside its point's first line and arrives with it.
    const marks = r.clips.filter((c) => c.type === 'shape' && c.shape === 'ellipse');
    assert.deepStrictEqual(marks.map((m) => m.start), [102, 105, 108]);
    assert.ok(marks.every((m, i) => m.x < points[i].x && Math.abs(m.y - points[i].y) < 0.03));
  });

  t('key points: the point being made stays bright and the earlier ones dim', () => {
    const r = kp({ reveal: [2, 5, 8] });
    const [p1, p2, p3] = r.points.map((id) => r.clips.find((c) => c.id === id));
    approx(resolvedValue(p1, 'opacity', 104, 1), 1);
    assert.ok(resolvedValue(p1, 'opacity', 106, 1) < 0.5);
    approx(resolvedValue(p2, 'opacity', 107, 1), 1);
    assert.ok(resolvedValue(p2, 'opacity', 110, 1) < 0.5);
    assert.strictEqual(p3.keyframes.length, 0); // the last one is never dimmed
    assert.ok(kp({ focus: false }).clips.every((c) => c.keyframes.length === 0));
  });

  t('key points: times default to an even spread, numbers replace bullets, long lists shrink to fit', () => {
    const r = kp();
    assert.ok(r.times[0] > 100 && r.times[0] < r.times[1] && r.times[1] < r.times[2] && r.times[2] < 111);
    approx(r.times[1] - r.times[0], r.times[2] - r.times[1]);
    const numbered = kp({ numbered: true });
    assert.deepStrictEqual(numbered.clips.filter((c) => c.type === 'text' && /^\d$/.test(c.text)).map((c) => c.text), ['1', '2', '3']);
    assert.ok(!numbered.clips.some((c) => c.type === 'shape' && c.shape === 'ellipse'));
    const long = kp({ points: Array.from({ length: 6 }, (_, i) => `Point number ${i + 1} is a rather long sentence that has to wrap onto more than one line to fit`) });
    const texts = long.points.map((id) => long.clips.find((c) => c.id === id));
    assert.ok(texts[0].fontSize < r.clips.find((c) => c.id === r.points[0]).fontSize);
    assert.ok(texts.every((p) => p.text.includes('\n') && p.y < 0.92));
    assert.ok(texts[5].y - texts[0].y < 0.8);
    assert.strictEqual(kp({ points: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }).points.length, 6);
  });

  t('key points: a side panel leaves room for the speaker; a vertical frame gets a lower band', () => {
    const left = kp({ layout: 'left' });
    const panel = left.clips.find((c) => c.id === left.panel);
    assert.ok(panel.w < 0.5 && panel.x < 0.25 && panel.animIn === 'fly-left');
    assert.ok(left.shiftX > 0.15 && left.shiftX < 0.3);
    const pts = left.points.map((id) => left.clips.find((c) => c.id === id));
    assert.ok(pts.every((p) => p.x > 0.03 && p.x < 0.2));
    // The text waits for the panel to arrive and leaves before it goes.
    assert.ok(left.clips.filter((c) => c.type === 'text').every((c) => c.start >= 100.3 && c.start + c.duration < 112));
    const right = kp({ layout: 'right' });
    assert.ok(right.clips.find((c) => c.id === right.panel).x > 0.75 && right.shiftX < -0.15);
    const tall = kp({ layout: 'left', canvas: { width: 1080, height: 1920 } });
    const band = tall.clips.find((c) => c.id === tall.panel);
    assert.ok(band.w >= 1 && band.y > 0.6 && band.h < 0.6 && tall.shiftX === 0);
  });

  t('makeRoom: the footage eases aside for the panel and back, and hand-placed clips are left alone', () => {
    const clips = [
      mediaClip({ id: 'a', duration: 20, sourceDuration: 100 }),
      mediaClip({ id: 'b', start: 20, duration: 10, sourceDuration: 100, inPoint: 25 }),
      mediaClip({ id: 'c', start: 30, duration: 20, sourceDuration: 100, inPoint: 40 }),
      mediaClip({ id: 'far', start: 50, duration: 10, sourceDuration: 100, inPoint: 70 }),
      mediaClip({ id: 'music', trackId: 'a1', duration: 60, mediaId: 'song' }),
    ];
    const r = makeRoom(clips, 'v1', 12, 36, 0.21);
    assert.deepStrictEqual([r.moved, r.skipped], [3, 0]);
    const at = (id, time) => resolvedValue(r.clips.find((c) => c.id === id), 'posX', time, 0);
    approx(at('a', 5), 0);
    approx(at('a', 12), 0);
    approx(at('a', 13), 0.21);
    approx(at('a', 19.9), 0.21);
    approx(at('b', 20), 0.21); // a piece wholly under the panel never moves on screen
    approx(at('b', 29.9), 0.21);
    approx(at('c', 30), 0.21);
    approx(at('c', 35), 0.21);
    approx(at('c', 36), 0);
    approx(at('c', 45), 0);
    assert.strictEqual(r.clips.find((c) => c.id === 'far').keyframes.length, 0);
    assert.strictEqual(r.clips.find((c) => c.id === 'music').keyframes.length, 0);
    const placed = makeRoom([mediaClip({ id: 'a', duration: 20, posX: 0.1 })], 'v1', 5, 15, 0.21);
    assert.deepStrictEqual([placed.moved, placed.skipped, placed.clips[0].keyframes.length], [0, 1, 0]);
  });

  // ── Slides ───────────────────────────────────────────────────────────────
  t('slides: titles are the biggest line, and only meaningful words are compared', () => {
    assert.strictEqual(slideTitle([{ text: 'BIO 101', size: 12 }, { text: 'The Calvin Cycle', size: 40 }, { text: 'Carbon fixation by rubisco', size: 20 }], 3), 'The Calvin Cycle');
    assert.strictEqual(slideTitle([], 7), 'Slide 7');
    assert.strictEqual(slideTitle([{ text: '— —', size: 30 }], 2), 'Slide 2');
    assert.deepStrictEqual(contentWords('The plants are using the ATP and their enzymes'), ['plant', 'atp', 'enzyme']);
  });

  t('alignSlides: each slide comes up when the speaker gets to it', () => {
    const slides = ['Photosynthesis\nHow plants make food from light', 'The light reactions\nChlorophyll absorbs light, water is split, oxygen released', 'The Calvin cycle\nRubisco fixes carbon dioxide into sugar', 'Limiting factors\nLight intensity, carbon dioxide, temperature'];
    const say = (start, text) => ({ start, end: start + 4, text });
    const lines = [
      say(0, 'Welcome to this lecture on photosynthesis.'),
      say(5, 'Today we look at how plants turn light into food.'),
      say(10, 'So, where does this happen? Let us start.'),
      say(15, 'Now for the light reactions. Chlorophyll absorbs light.'),
      say(20, 'The energy is used to split water, which releases oxygen.'),
      say(25, 'Um, and that is quite important.'),
      say(30, 'Next, the Calvin cycle, where rubisco attaches carbon dioxide.'),
      say(35, 'It builds sugar from those molecules.'),
      say(40, 'Finally, what limits photosynthesis? There are three limiting factors.'),
      say(45, 'Light intensity, carbon dioxide concentration and temperature.'),
    ];
    const r = alignSlides(slides, lines);
    assert.deepStrictEqual(r.starts, [0, 15, 30, 40]);
    assert.strictEqual(r.matched, 4);
    // A lead-in after a pause ("To summarise.") brings the slide up, though none of its words are on it.
    const paused = [
      { start: 0, end: 4, text: 'The light reactions happen in the thylakoid.' },
      { start: 4.2, end: 8, text: 'Chlorophyll absorbs the light.' },
      { start: 10, end: 12, text: 'To summarise. Photosynthesis has' },
      { start: 12, end: 16, text: 'two stages, and the rate depends on temperature.' },
    ];
    assert.deepStrictEqual(alignSlides(['The light reactions\nChlorophyll absorbs light in the thylakoid', 'Summary\nTwo stages\nRate depends on temperature'], paused).starts, [0, 10]);
  });

  t('alignSlides: a slide with no text (a diagram) shares the time of the slide it follows', () => {
    const say = (start, text) => ({ start, end: start + 4.5, text });
    const lines = [
      say(0, 'The chloroplast is a small green structure.'),
      say(5, 'It is found in the cells of leaves.'),
      say(10, 'Each chloroplast contains stacks of membranes.'),
      say(15, 'They are surrounded by the stroma.'),
      say(20, 'Now for the light reactions.'),
      say(25, 'Chlorophyll absorbs light.'),
    ];
    const r = alignSlides(['The chloroplast\nA small green structure\nStacks of membranes and the stroma', '', 'The light reactions\nChlorophyll absorbs light'], lines);
    assert.deepStrictEqual(r.starts, [0, 10, 20]); // not squeezed into one phrase
    assert.strictEqual(r.matched, 2);
    // Room after the wording of the slide before goes to the diagram.
    const aside = [say(0, 'The chloroplast is a small green structure.'), say(5, 'Look closely at this picture.'), say(10, 'You can see it is oval.'), say(15, 'Now for the light reactions.')];
    assert.deepStrictEqual(alignSlides(['The chloroplast\nA small green structure', '', 'The light reactions\nChlorophyll'], aside).starts, [0, 5, 15]);
    // Pictures first, then a slide that is talked about from the first word: they share the opening.
    const opening = alignSlides(['', 'The chloroplast\nA small green structure', 'The light reactions'], lines);
    assert.ok(opening.starts[0] === 0 && opening.starts[1] > 3 && opening.starts[1] < opening.starts[2] && opening.starts[2] === 20, String(opening.starts));
  });

  t('alignSlides: slides stay in order with a line each, and an unmatched deck is still placed', () => {
    const lines = [0, 5, 10, 15, 20].map((start) => ({ start, end: start + 4, text: 'nothing relevant is said here' }));
    const r = alignSlides(['Alpha particles', 'Beta decay', 'Gamma rays'], lines);
    assert.strictEqual(r.matched, 0);
    assert.strictEqual(r.starts.length, 3);
    assert.ok(r.starts[0] === 0 && r.starts[0] < r.starts[1] && r.starts[1] < r.starts[2]);
    // More slides than spoken lines: the time is shared out.
    const few = alignSlides(['a', 'b', 'c', 'd'], [{ start: 10, end: 30, text: 'one line' }]);
    assert.deepStrictEqual(few.starts, [10, 15, 20, 25]);
    assert.deepStrictEqual(alignSlides([], lines), { starts: [], matched: 0 });
  });

  // ── The agent tools ──────────────────────────────────────────────────────
  const sig = new AbortController().signal;
  const call = (tool, args = {}) => runAgentTool({ rid: 1, tool, args, client: 'test' }, () => {}, sig);
  const state = () => useTimelineStore.getState();
  const clip = (id) => state().clips.find((c) => c.id === id);
  const reset = (extra = []) => {
    useStyleStore.setState({ custom: [], activeId: null, brief: '', reference: null });
    useMediaStore.setState({
      media: [
        { id: 'm1', name: 'talk.mp4', kind: 'video', filePath: 'C:/v/talk.mp4', sizeBytes: 1, mediaUrl: 'x' },
        { id: 'song', name: 'song.mp3', kind: 'audio', filePath: 'C:/v/song.mp3', sizeBytes: 1, mediaUrl: 'z' },
        ...['s1', 's2', 's3'].map((id) => ({ id, name: `${id}.png`, kind: 'image', filePath: `C:/v/${id}.png`, sizeBytes: 1, mediaUrl: id })),
      ],
    });
    useTimelineStore.setState({
      tracks: [V1, T1, A1],
      canvas: { width: 1920, height: 1080 },
      clips: [mediaClip({ id: 'talk', duration: 300, mediaId: 'm1', sourceDuration: 300 }), mediaClip({ id: 'music', trackId: 'a1', duration: 300, mediaId: 'song', sourceDuration: 400 }), ...extra],
      selectedIds: [],
      playhead: 0,
      past: [],
      future: [],
    });
  };

  await ta('add_key_points: timed points in a side panel, the speaker moved aside, one undo step', async () => {
    reset();
    const r = await call('add_key_points', { heading: 'Limiting factors', points: ['Light', 'Carbon dioxide', 'Temperature'], at: 120, times: [121, 125, 131] });
    assert.ok(r.ok, r.text);
    assert.match(r.text, /3 key points in a panel on the left, 120–134s/);
    assert.match(r.text, /slides right/);
    assert.strictEqual(state().past.length, 1);
    const points = state().clips.filter((c) => c.type === 'text' && ['Light', 'Carbon dioxide', 'Temperature'].includes(c.text));
    assert.deepStrictEqual(points.map((p) => p.start).sort((x, y) => x - y), [121, 125, 131]);
    approx(resolvedValue(clip('talk'), 'posX', 125, 0), 0.21);
    approx(resolvedValue(clip('talk'), 'posX', 60, 0), 0);
    approx(resolvedValue(clip('talk'), 'posX', 200, 0), 0);
    assert.strictEqual(timelineDuration(state().clips), 300); // nothing moved in time
    const group = points[0].group;
    assert.ok(group && state().clips.filter((c) => c.group === group).length >= 8);
    // A style pass leaves the card's fitted text alone.
    const font = points[0].fontFamily;
    await call('apply_style', { style: 'retro-vhs', parts: ['titles'] });
    assert.strictEqual(state().clips.find((c) => c.id === points[0].id).fontFamily, font);
  });

  await ta('add_key_points: refuses times that are out of order or the wrong count, and insert opens a gap', async () => {
    reset();
    assert.match((await call('add_key_points', { points: ['a', 'b'], at: 10, times: [12] })).text, /one timeline time per point \(2\)/);
    assert.match((await call('add_key_points', { points: ['a', 'b'], at: 10, times: [15, 12] })).text, /in order/);
    assert.match((await call('add_key_points', { points: [] })).text, /points is required/);
    assert.strictEqual(state().past.length, 0);
    const r = await call('add_key_points', { points: ['One', 'Two'], at: 100, layout: 'full', mode: 'insert', duration: 6, make_room: true });
    assert.ok(r.ok, r.text);
    assert.strictEqual(timelineDuration(state().clips), 306);
    assert.ok(!state().clips.some((c) => c.type === 'media' && c.keyframes.length)); // a full card needs no room
  });

  await ta('set_chapters / get_chapters: chapters follow their clips through a later cut', async () => {
    reset();
    const card = await call('add_title_card', { title: 'The light reactions', kicker: 'PART 1', at: 60, duration: 4, chapter: true });
    assert.match(card.text, /Chapter "The light reactions" starts here/);
    const set = await call('set_chapters', { chapters: [{ time: 0, title: 'Introduction' }, { time: 184, title: 'The Calvin cycle' }] });
    assert.ok(set.ok, set.text);
    assert.match(set.text, /3 chapters set/);
    assert.match(set.text, /0:00 Introduction\n1:00 The light reactions\n3:04 The Calvin cycle/);
    assert.match(set.text, /1 clip split/);
    const proj = JSON.parse((await call('get_project')).text);
    assert.deepStrictEqual(proj.chapters, [{ time: 0, title: 'Introduction' }, { time: 60, title: 'The light reactions' }, { time: 184, title: 'The Calvin cycle' }]);
    // Twenty seconds of the intro go: the later chapters arrive twenty seconds sooner.
    await call('cut_ranges', { ranges: [[20, 40]] });
    const after = await call('get_chapters');
    assert.match(after.text, /0:00 Introduction\n0:40 The light reactions\n2:44 The Calvin cycle/);
    // Renaming and removing one is an ordinary clip change.
    const calvin = state().clips.find((c) => c.chapter === 'The Calvin cycle');
    await call('update_clip', { clip_id: calvin.id, chapter: 'Building sugar' });
    assert.match((await call('get_chapters')).text, /2:44 Building sugar/);
    await call('update_clip', { clip_id: calvin.id, chapter: '' });
    assert.doesNotMatch((await call('get_chapters')).text, /Building sugar/);
    await call('set_chapters', { chapters: [], replace: true });
    assert.match((await call('get_chapters')).text, /No chapters yet/);
    assert.strictEqual(JSON.parse((await call('get_project')).text).chapters, undefined);
  });

  await ta('get_project: a long edit stays readable (captions counted, a window on request)', async () => {
    const caps = Array.from({ length: 200 }, (_, i) => textClip({ id: `cap${i}`, role: 'caption', start: i * 1.5, duration: 1.4, text: `caption number ${i}` }));
    reset(caps);
    const all = JSON.parse((await call('get_project')).text);
    assert.deepStrictEqual(all.clips.map((c) => c.id), ['talk', 'music']);
    assert.deepStrictEqual([all.captions.count, all.captions.tracks, all.captions.from], [200, ['t1'], 0]);
    const win = JSON.parse((await call('get_project', { from: 30, to: 36, captions: true })).text);
    assert.deepStrictEqual(win.clips.filter((c) => c.caption).map((c) => c.id), ['cap20', 'cap21', 'cap22', 'cap23']);
    assert.match(win.clips_note, /between 30s and 36s/);
    // A handful of captions is still listed as before.
    reset(caps.slice(0, 5));
    const few = JSON.parse((await call('get_project')).text);
    assert.strictEqual(few.clips.filter((c) => c.caption).length, 5);
    assert.strictEqual(few.captions, undefined);
    // And a listing never runs to more than 300 clips.
    reset(Array.from({ length: 400 }, (_, i) => textClip({ id: `x${i}`, start: i * 0.5, duration: 0.4, text: `t${i}` })));
    const big = JSON.parse((await call('get_project')).text);
    assert.strictEqual(big.clips.length, 300);
    assert.match(big.clips_note, /Showing 300 of 402 clips/);
  });

  await ta('place_slides: slides cover the footage in order, and placing again replaces them', async () => {
    reset();
    globalThis.Image = class {
      naturalWidth = 1600;
      naturalHeight = 900;
      decode() {
        return Promise.resolve();
      }
    };
    const r = await call('place_slides', { media_ids: ['s1', 's2', 's3'], starts: [10, 70, 150], end: 240, transition: 'none' });
    assert.ok(r.ok, r.text);
    assert.match(r.text, /Placed 3 slides/);
    const lane = state().tracks.find((x) => x.name === 'Slides');
    assert.strictEqual(state().tracks[state().tracks.length - 1].id, lane.id); // newest video track = on top
    const slides = () => state().clips.filter((c) => c.trackId === lane.id).sort((x, y) => x.start - y.start);
    assert.deepStrictEqual(slides().map((c) => [c.mediaId, c.start, c.duration, c.sourceWidth]), [['s1', 10, 60, 1600], ['s2', 70, 80, 1600], ['s3', 150, 90, 1600]]);
    assert.strictEqual(state().past.length, 1);
    assert.strictEqual(clip('talk').scaleX, 1);
    await call('place_slides', { media_ids: ['s1', 's2'], starts: [10, 100], end: 240, motion: 'zoom-in' });
    assert.deepStrictEqual(slides().map((c) => [c.mediaId, c.start, c.duration, c.motion, c.transition]), [['s1', 10, 90, 'zoom-in', 'none'], ['s2', 100, 140, 'zoom-in', 'fade']]);
    assert.strictEqual(state().tracks.filter((x) => x.name === 'Slides').length, 1);
    assert.match((await call('place_slides', { media_ids: ['s1', 's2'], starts: [50, 20] })).text, /ascending/);
    assert.match((await call('place_slides', { media_ids: ['s1', 'm1'], starts: [5, 20] })).text, /slides are images/);
    assert.match((await call('place_slides', { media_ids: ['s1'] })).text, /pass starts/);
  });

  await ta('place_slides speaker corner: the slides go under the footage, which shrinks into a corner only while they are up', async () => {
    reset();
    const r = await call('place_slides', { media_ids: ['s1', 's2'], starts: [60, 120], end: 200, speaker: 'corner', corner: 'top-left', corner_size: 0.3 });
    assert.ok(r.ok, r.text);
    const tracks = state().tracks;
    const lane = tracks.find((x) => x.name === 'Slides');
    assert.ok(tracks.indexOf(lane) < tracks.findIndex((x) => x.id === 'v1'), 'slides sit below the speaker');
    const pieces = state().clips.filter((c) => c.trackId === 'v1').sort((x, y) => x.start - y.start);
    assert.deepStrictEqual(pieces.map((c) => [c.start, c.duration, c.scaleX]), [[0, 60, 1], [60, 140, 0.3], [200, 100, 1]]);
    assert.ok(pieces[1].posX < -0.3 && pieces[1].posY < -0.25);
    approx(pieces[1].inPoint, 60);
    approx(pieces[2].inPoint, 200);
    assert.strictEqual(state().past.length, 1);
    // Placing again finds the same lane and the same speaker (the slides are not mistaken for the footage).
    const again = await call('place_slides', { media_ids: ['s1', 's2', 's3'], starts: [60, 100, 150], end: 200, speaker: 'corner', corner: 'top-left', corner_size: 0.3 });
    assert.ok(again.ok, again.text);
    assert.strictEqual(state().tracks.filter((x) => x.name === 'Slides').length, 1);
    assert.strictEqual(state().clips.filter((c) => c.trackId === lane.id).length, 3);
    assert.deepStrictEqual(state().clips.filter((c) => c.trackId === 'v1').map((c) => c.scaleX).sort(), [0.3, 1, 1]);
    // The speaker is already tucked in a corner, so a side panel moves nothing.
    const kp = await call('add_key_points', { points: ['One', 'Two'], at: 100 });
    assert.match(kp.text, /already positioned/);
  });

  await ta('add_key_points over a slide that fills the frame moves nothing and says so', async () => {
    reset();
    await call('place_slides', { media_ids: ['s1', 's2'], starts: [0, 100], end: 300 });
    const r = await call('add_key_points', { points: ['One', 'Two'], at: 50, layout: 'right' });
    assert.ok(r.ok, r.text);
    assert.match(r.text, /layout full reads better over slides/);
    assert.ok(!state().clips.some((c) => c.type === 'media' && c.keyframes.length));
  });
}
