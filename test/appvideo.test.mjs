// A video about an app from one recording of it (src/editor/appVideo.ts): the
// steps found from the clicks, the build arguments for a guide, a product demo
// and a trailer, and what the planner does with a fitted stretch of recording
// and with a part nobody speaks. Run from editor.test.mjs; all of it is pure.
import assert from 'node:assert';
import {
  APP_KINDS,
  LONGFORM_FORMATS,
  MAKE_WAYS,
  MOMENT,
  STRETCH,
  TOOLS,
  TOOL_SPECS,
  appVideoArgs,
  appVideoProblem,
  appVideoPrompt,
  estimateLines,
  findFormat,
  findMoments,
  parsePointer,
  planLongform,
  readingSeconds,
  runAgentTool,
} from './.editor.mjs';

export async function run({ t, ta, approx }) {
  const WIDE = { width: 1920, height: 1080 };
  const format = (id) => LONGFORM_FORMATS.find((f) => f.id === id);
  const end = (c) => c.start + c.duration;
  const call = (tool, args) => runAgentTool({ rid: 1, tool, args, client: 'test' }, () => undefined, new AbortController().signal);
  const pointer = (clicks, duration = 60, moves = [[0, 0.5, 0.5]]) => parsePointer({ v: 1, duration, moves, clicks: clicks.map(([s, x, y]) => [s, x, y, 0]), buttons: true });

  // ── The steps in a recording ──
  t('app video: clicks close together are one step, with room before and after', () => {
    const m = findMoments({ duration: 60, pointer: pointer([[5, 0.2, 0.3], [7, 0.4, 0.3], [20, 0.8, 0.1], [40, 0.5, 0.9]]) });
    assert.strictEqual(m.length, 3);
    assert.deepStrictEqual(m.map((x) => x.clicks), [2, 1, 1]);
    approx(m[0].from, 5 - MOMENT.LEAD);
    approx(m[0].to, 7 + MOMENT.TAIL);
    assert.deepStrictEqual([m[0].at, m[0].x, m[0].y], [5, 0.2, 0.3]);
    approx(m[1].from, 20 - MOMENT.LEAD);
    assert.ok(m.every((x) => !x.guessed && x.to - x.from >= MOMENT.MIN));
  });

  t('app video: steps never overlap, and stay inside the recording', () => {
    // 4.5 s apart: two steps (over the 4 s that joins them), but each one's room runs into the other's.
    const m = findMoments({ duration: 12, pointer: pointer([[0.4, 0.5, 0.5], [6, 0.5, 0.5], [10.6, 0.5, 0.5]], 12) });
    assert.strictEqual(m.length, 3);
    assert.strictEqual(m[0].from, 0);
    assert.ok(m[2].to <= 12);
    for (let i = 1; i < m.length; i++) assert.ok(m[i].from >= m[i - 1].to - 1e-6, `step ${i + 1} starts before step ${i} ends`);
    // The parting line lies between the two clicks, so each step still holds its own click.
    assert.ok(m[1].from < 6 && m[1].to > 6 && m[2].from < 10.6);
  });

  t('app video: more clicks than steps wanted joins the closest', () => {
    const clicks = Array.from({ length: 10 }, (_, i) => [5 + i * 10 + (i === 3 ? -4 : 0), 0.5, 0.5]);
    const m = findMoments({ duration: 120, pointer: pointer(clicks, 120), max: 9 });
    assert.strictEqual(m.length, 9);
    // The two that were 6 s apart (the rest are 10 or more) are the ones that became one.
    assert.strictEqual(m.find((x) => x.clicks === 2).at, 25);
    assert.strictEqual(m.reduce((n, x) => n + x.clicks, 0), 10);
  });

  t('app video: a recording without clicks is split evenly, and says so', () => {
    const none = findMoments({ duration: 31 });
    assert.strictEqual(none.length, 3);
    assert.ok(none.every((x) => x.guessed && x.clicks === 0));
    assert.strictEqual(none[0].from, 0);
    assert.strictEqual(none[2].to, 31);
    // No presses reported, but the pointer came to rest in two places: those are the steps.
    const rest = parsePointer({ v: 1, duration: 20, buttons: false, clicks: [], moves: [[0, 0.1, 0.1], [0.1, 0.12, 0.1], [3, 0.6, 0.6], [3.1, 0.62, 0.6], [12, 0.2, 0.8], [12.1, 0.21, 0.8], [19, 0.21, 0.8]] });
    const rested = findMoments({ duration: 20, pointer: rest });
    assert.ok(rested.length >= 2 && rested.every((x) => !x.guessed && x.clicks === 0));
    assert.deepStrictEqual(findMoments({ duration: 0 }), []);
  });

  t('app video: with what was said, steps follow one another and start at a pause', () => {
    const line = (start, e, text) => ({ start, end: e, text, words: text.split(' ').map((w, i, all) => ({ start: start + ((e - start) * i) / all.length, end: start + ((e - start) * (i + 1)) / all.length, text: w })) });
    const lines = [line(0.5, 4, 'Welcome to the app.'), line(4.6, 9.5, 'First open the settings here.'), line(10.4, 16, 'Then pick the dark theme from this list.'), line(16.8, 21, 'And that is it.')];
    const m = findMoments({ duration: 22, pointer: pointer([[7, 0.9, 0.1], [13.5, 0.5, 0.5]], 22), lines });
    assert.strictEqual(m.length, 2);
    // No gap between the two, and the cut is in the silence between two sentences, not inside one.
    assert.strictEqual(m[0].to, m[1].from);
    assert.ok(lines.every((l) => !(m[1].from > l.start + 0.05 && m[1].from < l.end - 0.05)), `cut at ${m[1].from} is inside a sentence`);
    assert.ok(lines.every((l) => !(m[0].from > l.start + 0.05 && m[0].from < l.end - 0.05)));
    assert.match(m[0].said, /settings/);
    assert.match(m[1].said, /dark theme/);
    assert.ok(m[1].to >= 21);
  });

  // ── The build arguments ──
  const STEPS = [
    { from: 3.8, to: 9.2, heading: 'Open the settings', text: 'The cog is in the top right corner.' },
    { from: 12, to: 18.5, heading: ' Pick a theme ', text: '' },
  ];
  t('app video: a guide in the built-in voice shows each step exactly its stretch', () => {
    const a = appVideoArgs({ kind: 'guide', take: 'm1', title: ' Dark mode in a minute ', opening: 'Two clicks.', steps: STEPS, voice: 'built-in', voiceName: 'kokoro:af_heart', closing: { text: 'That is all.' }, clear: true });
    assert.strictEqual(a.format, 'tutorial');
    assert.strictEqual(a.title, 'Dark mode in a minute');
    assert.strictEqual(a.hook, 'Two clicks.');
    assert.strictEqual(a.clear, true);
    assert.strictEqual(a.silent, undefined);
    assert.strictEqual(a.recording, undefined);
    assert.deepStrictEqual(a.sections[0].visuals, [{ media: 'm1', in_point: 3.8, out_point: 9.2, fit: 'fit' }]);
    // A step without a line of its own still has something to say: its name.
    assert.strictEqual(a.sections[1].heading, 'Pick a theme');
    assert.strictEqual(a.sections[1].text, 'Pick a theme');
    assert.strictEqual(a.outro.text, 'That is all.');
    assert.ok(findFormat(a.format));
  });

  t('app video: a product demo without a voice is silent, lines optional', () => {
    const a = appVideoArgs({ kind: 'demo', take: 'm1', title: 'Notely', steps: STEPS, voice: 'none' });
    assert.strictEqual(a.format, 'product-walkthrough');
    assert.strictEqual(a.silent, true);
    assert.strictEqual(a.sections[0].text, 'The cog is in the top right corner.');
    assert.strictEqual(a.sections[1].text, undefined);
    assert.strictEqual(a.sections[1].visuals[0].out_point, 18.5);
  });

  t('app video: in the recording\'s own voice the steps are stretches of the recording', () => {
    const a = appVideoArgs({ kind: 'guide', take: 'm1', title: 'Dark mode', opening: 'ignored', steps: [...STEPS, { from: 18.6, to: 25, heading: 'Done' }], voice: 'recording', closing: { text: 'ignored too' } });
    assert.strictEqual(a.recording, 'm1');
    assert.strictEqual(a.hook, undefined);
    assert.strictEqual(a.outro.text, undefined);
    // A gap before the next step: this one says where it stops. Steps that touch run on into each other. The last one says where it ends.
    assert.deepStrictEqual(a.sections.map((s) => [s.from, s.to]), [[3.8, 9.2], [12, undefined], [18.6, 25]]);
    assert.ok(a.sections.every((s) => s.visuals === undefined && s.text === undefined));
  });

  t('app video: a trailer shows a few seconds of each feature', () => {
    const a = appVideoArgs({ kind: 'trailer', take: 'm1', title: 'Notely', subtitle: 'Notes that find themselves', opening: 'Lost a note?\nNever again.', steps: [{ from: 2, to: 3.5, heading: 'Find anything', points: ['a', 'b', 'c', 'd'] }, { from: 10, to: 30, heading: 'Share it' }], voice: 'none', closing: { action: 'Download free', where: 'notely.example', note: 'Windows and macOS.' }, logo: 'logo.png' });
    assert.strictEqual(a.format, 'trailer');
    assert.strictEqual(a.voiceover, false);
    assert.strictEqual(a.captions, false);
    assert.deepStrictEqual(a.sections.map((s) => s.seconds), [3, 6]);
    assert.deepStrictEqual(a.sections[0].visuals, [{ media: 'm1', in_point: 2 }]);
    assert.strictEqual(a.sections[0].points.length, 3);
    // A click in the body of the app is what the window moves in on; one on a sidebar or a menu is not.
    const clicked = appVideoArgs({ kind: 'trailer', take: 'm1', title: 'N', steps: [{ from: 2, to: 6, heading: 'In the page', click: { x: 0.612, y: 0.4 } }, { from: 8, to: 12, heading: 'On the sidebar', click: { x: 0.06, y: 0.4 } }, { from: 14, to: 18, heading: 'On the menu', click: { x: 0.5, y: 0.03 } }], voice: 'none' });
    assert.deepStrictEqual(clicked.sections[0].visuals, [{ media: 'm1', in_point: 2, focus_x: 0.61, focus_y: 0.4 }]);
    assert.deepStrictEqual(clicked.sections[1].visuals, [{ media: 'm1', in_point: 8 }]);
    assert.deepStrictEqual(clicked.sections[2].visuals, [{ media: 'm1', in_point: 14 }]);
    assert.deepStrictEqual(a.outro, { title: 'Download free', subtitle: 'notely.example', note: 'Windows and macOS.' });
    assert.strictEqual(a.logo, 'logo.png');
    assert.strictEqual(appVideoArgs({ kind: 'trailer', take: 'm1', title: 'N', steps: STEPS, voice: 'built-in' }).voiceover, true);
  });

  t('app video: what stops a build is said in words', () => {
    const ok = { kind: 'guide', take: 'm1', title: 'T', steps: STEPS, voice: 'built-in' };
    assert.strictEqual(appVideoProblem(ok), null);
    assert.match(appVideoProblem({ ...ok, title: ' ' }), /title/);
    assert.match(appVideoProblem({ ...ok, kind: 'trailer', title: '' }), /name of the app/);
    assert.match(appVideoProblem({ ...ok, steps: [] }), /at least one/);
    assert.match(appVideoProblem({ ...ok, steps: [STEPS[0], { ...STEPS[1], heading: '' }] }), /Step 2 needs a name/);
    assert.match(appVideoProblem({ ...ok, kind: 'demo', steps: [{ ...STEPS[0], to: 4 }] }), /Feature 1 is under a second/);
    assert.match(appVideoProblem({ ...ok, kind: 'trailer', voice: 'recording' }), /cannot use that voice/);
    // Out of order is fine when each step is shown on its own, but not when they are cut from one running voice.
    const swapped = [STEPS[1], STEPS[0]];
    assert.strictEqual(appVideoProblem({ ...ok, steps: swapped }), null);
    assert.match(appVideoProblem({ ...ok, steps: swapped, voice: 'recording' }), /follow one another/);
    for (const k of APP_KINDS) {
      assert.ok(findFormat(k.format), `${k.id} builds with a format that exists`);
      assert.ok(k.voices.includes(k.voice));
      assert.match(appVideoPrompt(k.id, 'take.mp4'), /find_steps/);
    }
  });

  // ── What the planner does with them ──
  const media = new Map([['rec', { kind: 'video', width: 1280, height: 800, duration: 60 }]]);
  const narr = (text, duration, id = 'voice') => ({ mediaId: id, duration, lines: estimateLines(text, duration) });
  const plan = (sections, narration, fmt = 'tutorial') =>
    planLongform({
      script: { title: 'Dark mode', sections },
      format: format(fmt),
      canvas: WIDE,
      narration: { sections: narration },
      media,
      card: { look: 'clean' },
      captions: { patch: { fontSize: 56 }, upper: false },
      transition: { type: 'fade', duration: 0.45 },
      start: 0,
      tracks: { video: 'v', presenter: 'vp', narration: 'an', music: 'am', text: 'tt', captions: 'tc' },
    });
  const shots = (p) => p.clips.filter((c) => c.trackId === 'v' && c.mediaId === 'rec').sort((x, y) => x.start - y.start);

  t('longform: a stretch of recording plays once, fitted to the time it has', () => {
    // 5 s of recording under 4 s of narration (plus the format's gap): a little faster, all of it, nothing looped.
    const gap = format('tutorial').gap;
    const p = plan([{ heading: 'Open the settings', text: 'x', visuals: [{ mediaId: 'rec', inPoint: 11, outPoint: 16, fit: 'fit' }] }], [narr('Open the settings from the cog.', 4)]);
    const s = shots(p);
    assert.strictEqual(s.length, 1);
    approx(s[0].inPoint, 11);
    approx(s[0].duration, 4 + gap);
    approx(s[0].speed, 5 / (4 + gap));
    approx(s[0].inPoint + s[0].duration * s[0].speed, 16);
    assert.strictEqual(s[0].motion, 'none');
    assert.strictEqual(s[0].freezeAt, undefined);
    // Without an out point the old behaviour stands: it plays on at its own speed.
    const loose = shots(plan([{ heading: 'Open', text: 'x', visuals: [{ mediaId: 'rec', inPoint: 10 }] }], [narr('Open the settings from the cog.', 4)]));
    assert.strictEqual(loose[0].speed, 1);
  });

  t('longform: a short stretch under a long line slows to half speed, then holds its last frame', () => {
    const gap = format('tutorial').gap;
    const p = plan([{ heading: 'Pick a theme', text: 'x', visuals: [{ mediaId: 'rec', inPoint: 20, outPoint: 23 }] }], [narr('There is a lot to say about this one small click, far more than the click itself takes.', 12)]);
    const s = shots(p);
    assert.strictEqual(s.length, 2);
    assert.strictEqual(s[0].speed, STRETCH.slow);
    approx(s[0].duration, 3 / STRETCH.slow);
    // The held frame is the stretch's last, starts where the playing piece ends, and nothing dissolves between them.
    approx(s[1].start, end(s[0]));
    approx(end(s[1]), s[0].start + 12 + gap);
    assert.ok(s[1].freezeAt > 22.9 && s[1].freezeAt <= 23);
    assert.ok(!s[1].transition || s[1].transition === 'none');
  });

  t('longform: a short line does not rush a long stretch: the step lasts as long as the stretch needs', () => {
    const p = plan([{ heading: 'Wait for it', text: 'x', visuals: [{ mediaId: 'rec', inPoint: 0, outPoint: 30 }] }], [narr('It loads.', 2)]);
    const s = shots(p);
    assert.strictEqual(s.length, 1);
    approx(s[0].speed, STRETCH.easy);
    approx(s[0].duration, 30 / STRETCH.easy);
    assert.ok(!p.notes.some((n) => /left out/.test(n)), p.notes.join('; '));
    // The voice is as long as it was, at the start of the step.
    const voice = p.clips.find((c) => c.trackId === 'an');
    approx(voice.duration, 2);
    approx(voice.start, s[0].start);
    // Two stretches told to share one short line: the first has only the time until the second comes up, so it is
    // sped up to the limit and the build says what was left out.
    const two = plan([{ heading: 'Both', text: 'x', visuals: [{ mediaId: 'rec', inPoint: 0, outPoint: 30, at: 0 }, { mediaId: 'rec', inPoint: 40, outPoint: 43, at: 4 }] }], [narr('First this, and then that one.', 6)]);
    const first = shots(two)[0];
    assert.strictEqual(first.speed, STRETCH.fast);
    approx(first.duration, 4);
    assert.ok(two.notes.some((n) => /left out/.test(n)), two.notes.join('; '));
  });

  t('longform: a part nobody speaks has no sound clip, takes its time, and shows its words as captions', () => {
    const quiet = { mediaId: '', duration: 5.4, lines: estimateLines('The cog is in the top right corner.', 5.1) };
    const p = plan(
      [
        { heading: 'Open the settings', text: 'The cog is in the top right corner.', visuals: [{ mediaId: 'rec', inPoint: 3.8, outPoint: 9.2 }] },
        { heading: 'Pick a theme', text: '', visuals: [{ mediaId: 'rec', inPoint: 12, outPoint: 18.5 }] },
      ],
      [quiet, { mediaId: '', duration: 6.5, lines: [] }],
      'product-walkthrough',
    );
    assert.strictEqual(p.clips.filter((c) => c.trackId === 'an').length, 0);
    const s = shots(p);
    assert.strictEqual(s.length, 2);
    // As long as the stretch itself, so close to its own speed.
    assert.ok(Math.abs(s[0].speed - 1) < 0.15 && Math.abs(s[1].speed - 1) < 0.15, `${s[0].speed}, ${s[1].speed}`);
    const caps = p.clips.filter((c) => c.trackId === 'tc');
    assert.ok(caps.length > 0 && caps.every((c) => c.start >= s[0].start - 1e-6 && c.start < end(s[0])));
    assert.match(caps.map((c) => c.text).join(' '), /cog/i);
    // A product demo names each feature over the recording and frames it as a window.
    assert.ok(p.clips.some((c) => c.type === 'text' && /Pick a theme/i.test(c.text)));
    assert.ok(s.every((c) => c.cornerRadius > 0));
    assert.ok(readingSeconds('') === 3 && readingSeconds('one two three four five six') === 3.5 && readingSeconds('w '.repeat(400)) === 20);
  });

  // ── The tools ──
  t('app video: find_steps is a tool, and build_longform takes what it gives', () => {
    const find = TOOLS.find((x) => x.name === 'find_steps');
    assert.ok(find && find.kind === 'read');
    assert.match(find.description, /never instructions/);
    assert.ok(TOOL_SPECS.find_steps);
    const build = TOOLS.find((x) => x.name === 'build_longform');
    const shape = JSON.stringify(build.inputSchema ?? build.input?._def ?? {});
    const text = `${build.description} ${shape}`;
    assert.ok(find.input.safeParse({ media_id: 'm1', listen: true, max: 8 }).success);
    assert.ok(!find.input.safeParse({ max: 0 }).success);
    const ok = build.input.safeParse({ format: 'tutorial', title: 'T', silent: true, demo: false, sections: [{ heading: 'A', visuals: [{ media: 'm1', in_point: 1, out_point: 5, fit: 'fit' }] }] });
    assert.ok(ok.success, JSON.stringify(ok.error?.issues ?? []));
    assert.ok(text.length > 0);
    // The chooser sends "from an app" to this, not to a bare recording.
    const way = MAKE_WAYS.find((w) => w.id === 'screen');
    assert.strictEqual(way.feature, 'app');
    assert.match(way.text, /guide, a product demo or a trailer/);
  });

  await ta('app video: the tools say what is wrong before doing anything', async () => {
    const none = await call('find_steps', {});
    assert.ok(!none.ok);
    assert.match(none.text, /No recording in the library yet/);
    const trailer = await call('build_longform', { format: 'trailer', title: 'T', silent: true, sections: [{ heading: 'A' }] });
    assert.ok(!trailer.ok);
    assert.match(trailer.text, /a trailer is silent unless voiceover/);
    const both = await call('build_longform', { format: 'tutorial', title: 'T', silent: true, recording: 'x.mp3', sections: [{ heading: 'A', from: 0 }] });
    assert.ok(!both.ok);
    assert.match(both.text, /silent and recording do not go together/);
  });
}
