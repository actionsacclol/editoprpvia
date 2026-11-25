// Software trailers (src/editor/trailer.ts), quizzes (src/editor/quiz.ts) and
// videos built from a real recording (narrationSlice in longform.ts). Run from
// editor.test.mjs; everything here is pure, so nothing is spoken or decoded.
import assert from 'node:assert';
import {
  LONGFORM_EXAMPLES,
  LONGFORM_FORMATS,
  QUIZ_RIGHT,
  TOOLS,
  TRAILER_MAX_CALLOUTS,
  TRAILER_MOVE,
  TILT_EYE,
  cascadeProgress,
  cascadeWord,
  clampTilt,
  tiltCss,
  tiltPoint,
  withKeyframes,
  agentPrompt,
  answerIndex,
  evenLines,
  beatTime,
  estimateLines,
  findFormat,
  findStyle,
  heardLines,
  narrationSlice,
  parseScript,
  planLongform,
  planQuiz,
  planTrailer,
  quizDing,
  quizLayout,
  quizTicks,
  revealLine,
  runAgentTool,
  scriptStats,
  snapToPause,
  trailerMusic,
} from './.editor.mjs';

export async function run({ t, ta, approx }) {
  const WIDE = { width: 1920, height: 1080 };
  const TALL = { width: 1080, height: 1920 };
  const format = (id) => LONGFORM_FORMATS.find((f) => f.id === id);
  const media = new Map([
    ['shot', { kind: 'image', width: 1920, height: 1080, duration: 0 }],
    ['rec', { kind: 'video', width: 1280, height: 800, duration: 30 }],
    ['short', { kind: 'video', width: 1280, height: 800, duration: 1.5 }],
    ['logo', { kind: 'image', width: 512, height: 512, duration: 0 }],
    ['flag', { kind: 'image', width: 1200, height: 800, duration: 0 }],
  ]);
  const narr = (id, text, duration) => ({ mediaId: id, duration, lines: estimateLines(text, duration) });
  const end = (c) => c.start + c.duration;
  const call = (tool, args) => runAgentTool({ rid: 1, tool, args, client: 'test' }, () => undefined, new AbortController().signal);

  // ── Trailer ──
  const TRACKS = { video: 'v', narration: 'an', music: 'am', text: 'tt', captions: 'tc' };
  const SCRIPT = {
    title: 'Acme Notes',
    subtitle: 'Notes that find themselves',
    hook: 'You wrote it down somewhere. Now you need it.',
    sections: [
      { heading: 'Find any note in a second', text: 'Search as you type.', points: ['Search as you type', 'Every note', 'Every word', 'One more'], visuals: [{ mediaId: 'rec', inPoint: 4 }] },
      { heading: 'Private by design', points: ['On your device'], visuals: [{ mediaId: 'shot' }, { mediaId: 'short' }] },
      { heading: 'Share with one link' },
    ],
    outro: { title: 'Try it free', subtitle: 'acmenotes.example' },
  };
  const trailer = (over = {}) =>
    planTrailer({ script: SCRIPT, format: format('trailer'), canvas: WIDE, narration: { sections: [] }, media, card: { look: 'clean', background: '#0b1020', accent: '#8b5cf6' }, captions: null, grid: { beats: [], period: 0.5 }, backdropFree: true, start: 0, tracks: TRACKS, ...over });
  const onGrid = (x, period = 0.5) => Math.abs(x / period - Math.round(x / period)) < 1e-6;

  t('trailer: the two new formats are there with styles that exist, and the names people use find them', () => {
    assert.strictEqual(LONGFORM_FORMATS.length, 16);
    for (const id of ['trailer', 'quiz']) {
      assert.strictEqual(format(id).layout, id);
      assert.ok(findStyle(format(id).style), id);
    }
    for (const name of ['Software trailer', 'launch video', 'promo', 'app trailer', 'teaser']) assert.strictEqual(findFormat(name)?.id, 'trailer', name);
    for (const name of ['Quiz', 'trivia', 'quiz video']) assert.strictEqual(findFormat(name)?.id, 'quiz', name);
    // No narrated format was given a layout by accident.
    assert.strictEqual(LONGFORM_FORMATS.filter((f) => f.layout).length, 2);
  });

  t('trailer: beats are the start of the video, then the list, then carried on at the period', () => {
    assert.strictEqual(beatTime({ beats: [], period: 0.5 }, 0), 0);
    assert.strictEqual(beatTime({ beats: [], period: 0.5 }, 7), 3.5);
    const song = { beats: [0.31, 0.83, 1.36, 1.88], period: 0.52 };
    assert.strictEqual(beatTime(song, 0), 0);
    assert.strictEqual(beatTime(song, 2), 1.36);
    approx(beatTime(song, 5), 1.88 + 2 * 0.52, 1e-9);
  });

  /** The window of a feature (the same file also leans behind an opening line). */
  const windowOf = (p, id, section = 0) => p.clips.find((c) => c.trackId === 'v' && c.mediaId === id && c.start >= p.sections[section].start - 1e-6);

  t('trailer: opening lines over the app, the name, a headline and a window per feature, an end card; every cut on the beat', () => {
    const p = trailer();
    const text = p.clips.filter((c) => c.type === 'text');
    const says = (s) => text.find((c) => c.text.replace(/\n/g, ' ') === s);
    // The opening lines come first, one at a time, without their full stop, their words coming up one by one.
    const one = says('You wrote it down somewhere');
    const two = says('Now you need it');
    assert.ok(one && two && one.start === 0 && approx(end(one), two.start, 1e-6) === undefined);
    assert.ok(one.animIn === 'cascade' && two.animIn === 'cascade');
    // Behind each, a feature's recording leaning far back, dimmed, drifting: one per line.
    const heroes = p.clips.filter((c) => c.trackId === 'v' && c.start < p.score.reveal - 1e-6);
    assert.deepStrictEqual(heroes.map((c) => c.mediaId), ['rec', 'shot']);
    for (const [i, h] of heroes.entries()) {
      approx(h.start, [one, two][i].start, 1e-6);
      approx(end(h), end([one, two][i]), 1e-6);
      assert.ok(h.opacity < 0.7 && h.tiltX > 20 && Math.abs(h.tiltY) > 10 && h.scaleX > 1, 'leaning, dim and larger than the frame');
      assert.ok(h.keyframes.some((k) => k.prop === 'posY'), 'it drifts');
    }
    assert.ok(heroes[0].tiltY * heroes[1].tiltY < 0, 'one leans left, the next right');
    assert.strictEqual(heroes[0].inPoint, 4);
    // The name lands when they are done, and the score says so.
    const name = text.find((c) => c.text === 'Acme Notes');
    approx(name.start, p.score.reveal, 1e-6);
    approx(name.start, end(two), 1e-6);
    assert.ok(text.some((c) => c.text === 'Notes that find themselves' && c.start > name.start && c.start < end(name)));
    // Every part starts and ends on a beat.
    for (const s of p.sections) assert.ok(onGrid(s.start) && onGrid(s.end), s.heading);
    for (const c of p.clips.filter((x) => x.trackId === 'v')) assert.ok(onGrid(c.start), `picture at ${c.start}`);
    assert.ok(onGrid(p.score.reveal) && onGrid(p.score.close) && onGrid(p.score.end));
    // A feature with a recording has no card of its own: the recording is there from its first beat, in a
    // window, the headline above it. No flat colour covers the frame anywhere between the name and the end.
    const first = p.sections[0];
    const window = windowOf(p, 'rec');
    approx(window.start, first.start, 1e-6);
    assert.ok(window.inPoint === 4 && window.cornerRadius > 0 && window.shadow > 0 && window.muted);
    assert.ok(!p.clips.some((c) => c.type === 'shape' && c.w > 1 && c.start >= end(name) - 1e-6 && c.start < p.score.close - 1e-6));
    const heads = text.filter((c) => c.text.replace(/\n/g, ' ') === 'Find any note in a second');
    assert.strictEqual(heads.length, 1);
    assert.ok(heads[0].y < 0.2 && heads[0].animIn === 'cascade' && heads[0].chapter === 'Find any note in a second');
    approx(heads[0].start, first.start, 1e-6);
    // The window comes in at an angle, smaller and to one side, and turns to face the viewer in under a second.
    const at = (tau) => withKeyframes(window, window.start + tau);
    assert.ok(Math.abs(at(0).tiltY) > 15 && at(0).tiltX > 5 && at(0).scaleX < at(TRAILER_MOVE.enter).scaleX && at(0).posX !== 0);
    assert.ok(Math.abs(at(TRAILER_MOVE.enter).tiltY) < Math.abs(at(0).tiltY) / 2 && Math.abs(at(TRAILER_MOVE.enter).posX) < 1e-6);
    assert.ok(at(TRAILER_MOVE.enter).posY > 0, 'the window sits low, under the headline');
    // With nothing named to move in on, it stays at a slight angle and is never cropped.
    assert.ok(Math.abs(at(window.duration).tiltY) > 2 && Math.abs(at(window.duration).tiltY) < 12);
    assert.ok(!window.keyframes.some((k) => k.prop.startsWith('crop')) && window.cropLeft === 0);
    // Its line under the headline, and at most three callouts, each on a beat, once the window has turned.
    assert.ok(text.some((c) => c.text === 'Search as you type.' && c.start >= window.start));
    const tags = text.filter((c) => c.bgStyle === 'box' && c.anchor === 'left' && c.start >= window.start && c.start < first.end);
    assert.strictEqual(tags.length, TRAILER_MAX_CALLOUTS);
    for (const c of tags) assert.ok(onGrid(c.start) && c.start >= window.start + TRAILER_MOVE.enter - 1e-6 && approx(end(c), first.end, 1e-6) === undefined);
    assert.ok(p.notes.some((n) => /callouts left out/.test(n)));
    // Two recordings in one feature share its time; a recording shorter than its turn plays again.
    const second = p.sections[1];
    const inSecond = p.clips.filter((c) => c.trackId === 'v' && c.start >= second.start && c.start < second.end);
    assert.deepStrictEqual([...new Set(inSecond.map((c) => c.mediaId))], ['shot', 'short']);
    approx(end(inSecond[inSecond.length - 1]), second.end, 1e-6);
    // …and where it starts again it is where the first pass left it, not coming in a second time.
    const again = inSecond.filter((c) => c.mediaId === 'short');
    assert.ok(again.length >= 2);
    approx(withKeyframes(again[1], again[1].start).tiltY, withKeyframes(again[0], end(again[0]) - 1e-4).tiltY, 0.2);
    // One window comes in from the left, the next from the right.
    assert.ok(withKeyframes(inSecond[0], inSecond[0].start).tiltY * at(0).tiltY < 0);
    // A feature without a recording is its headline alone, on the backdrop.
    assert.strictEqual(p.sections[2].scene, 'text');
    assert.ok(!p.clips.some((c) => c.trackId === 'v' && c.start >= p.sections[2].start && c.start < p.sections[2].end));
    assert.ok(says('Share with one link').animIn === 'cascade' && says('Share with one link').chapter === 'Share with one link');
    // The end card: the name again, the call to action in a box, where to get it.
    const close = text.filter((c) => c.start >= p.score.close);
    assert.ok(close.some((c) => c.text === 'Acme Notes'));
    assert.ok(close.some((c) => c.text === 'Try it free' && c.bgStyle === 'box'));
    assert.ok(close.some((c) => c.text === 'acmenotes.example'));
    approx(Math.max(...p.clips.map(end)), p.end, 1e-6);
    // Nothing is spoken and nothing captioned unless asked.
    assert.ok(!p.clips.some((c) => c.trackId === 'an' || c.trackId === 'tc'));
    // A recording comes in and goes at these moments, between the name and the end card.
    assert.ok(p.score.cuts.length >= 4 && p.score.cuts.every((c) => c > p.score.reveal && c <= p.score.close + 1e-6 && onGrid(c)));
    assert.deepStrictEqual(p.backdrop, format('trailer').backdrop);
  });

  t('trailer: a recording with a focus is moved in on: the window keeps its place and shape, the picture inside grows', () => {
    const focused = { ...SCRIPT, sections: [{ heading: 'Find any note in a second', seconds: 5, visuals: [{ mediaId: 'rec', inPoint: 4, focus: { x: 0.8, y: 0.3 } }] }, { heading: 'Flat', seconds: 4, visuals: [{ mediaId: 'rec', motion: 'none', focus: { x: 0.5, y: 0.5 } }] }, { heading: 'Brief', seconds: 1.2, visuals: [{ mediaId: 'rec', focus: { x: 0.5, y: 0.5 } }] }] };
    const p = trailer({ script: focused });
    const window = windowOf(p, 'rec');
    const at = (tau) => withKeyframes(window, window.start + tau);
    // The time asked for, plus the time it takes to come in.
    assert.ok(window.duration >= 5 + TRAILER_MOVE.enter - 0.5);
    // Face on and whole once it has come in…
    const settled = at(TRAILER_MOVE.enter + 0.05);
    assert.ok(Math.abs(settled.tiltY) < 0.5 && settled.cropLeft === 0 && settled.cropTop === 0);
    // …then in on the focus: 1.6 times, the same share cut from the width as from the height (so the window keeps its shape).
    const last = at(window.duration);
    approx(1 - last.cropLeft - last.cropRight, 1 / TRAILER_MOVE.by, 1e-3);
    approx(1 - last.cropTop - last.cropBottom, 1 / TRAILER_MOVE.by, 1e-3);
    // The part shown has the focus in its middle (0.8 across is near the right edge, which is as far as it can go).
    approx(last.cropLeft + (1 - last.cropLeft - last.cropRight) / 2, 0.8 - (0.8 + 0.5 / TRAILER_MOVE.by - 1 > 0 ? 0.8 + 0.5 / TRAILER_MOVE.by - 1 : 0), 1e-3);
    approx(last.cropTop + (1 - last.cropTop - last.cropBottom) / 2, 0.3 + (0.5 / TRAILER_MOVE.by - 0.3 > 0 ? 0.5 / TRAILER_MOVE.by - 0.3 : 0), 1e-3);
    for (const tau of [0, 1, 2, 3, 4, window.duration]) approx(at(tau).cropLeft + at(tau).cropRight, at(tau).cropTop + at(tau).cropBottom, 1e-4);
    // It leans a little the other way as it goes in, and the music marks the move.
    assert.ok(Math.abs(last.tiltY) > 2 && Math.abs(last.tiltY) < 8 && last.tiltY * at(0).tiltY < 0);
    assert.ok(p.score.cuts.some((c) => c > window.start + TRAILER_MOVE.enter && c < end(window) - 1));
    // motion none: flat and still, whatever else is said.
    const flat = windowOf(p, 'rec', 1);
    assert.ok(!flat.keyframes?.length && !flat.tiltX && !flat.tiltY && flat.cropLeft === 0);
    // Too brief to go in and be looked at: it comes in and stays.
    const brief = windowOf(p, 'rec', 2);
    assert.ok(!brief.keyframes.some((k) => k.prop.startsWith('crop')));
  });

  t('tilt: a leaning picture is seen in perspective, the far side smaller, the same way CSS does it', () => {
    const eye = TILT_EYE * 1080;
    // Flat: nothing moves.
    assert.deepStrictEqual(tiltPoint(300, -200, 0, 0, 0, eye), { x: 300, y: -200, w: 1 });
    // tiltY: the right side tips away (smaller, w over 1), the left comes nearer (larger).
    const right = tiltPoint(500, 300, 0, 30, 0, eye);
    const left = tiltPoint(-500, 300, 0, 30, 0, eye);
    assert.ok(right.w > 1 && left.w < 1);
    assert.ok(Math.abs(right.y) < 300 && Math.abs(left.y) > 300 && right.x < 500 * Math.cos(Math.PI / 6));
    approx(right.x, (500 * Math.cos(Math.PI / 6)) / (1 + (500 * Math.sin(Math.PI / 6)) / eye), 1e-9);
    // tiltX: the top tips away.
    const top = tiltPoint(400, -300, 30, 0, 0, eye);
    const bottom = tiltPoint(400, 300, 30, 0, 0, eye);
    assert.ok(Math.abs(top.x) < 400 && Math.abs(bottom.x) > 400);
    // Turning in the plane of the screen comes after the lean, as in the CSS.
    const turned = tiltPoint(500, 0, 0, 30, 90, eye);
    approx(turned.x, 0, 1e-9);
    approx(turned.y, right.x, 1e-9);
    // Never edge-on.
    assert.strictEqual(clampTilt(200), clampTilt(65));
    assert.match(tiltCss(10, -20, 5, 500), /^perspective\(1100px\) rotate\(5deg\) rotateX\(10deg\) rotateY\(-20deg\)$/);
    // A clip's lean can be keyframed like the rest of its transform.
    const leaning = { type: 'media', start: 2, duration: 4, posX: 0, posY: 0, scaleX: 1, scaleY: 1, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, keyframes: [{ id: 'a', prop: 'tiltY', t: 0, value: 20 }, { id: 'b', prop: 'tiltY', t: 2, value: 0 }] };
    approx(withKeyframes(leaning, 3).tiltY, 10, 1e-9);
    assert.strictEqual(withKeyframes(leaning, 3).tiltX, 0);
  });

  t('word by word: each word comes up after the one before it, and all have landed when the entrance is over', () => {
    const line = { type: 'text', start: 1, duration: 3, animIn: 'cascade', animInDur: 0.6, text: 'Notes that find themselves' };
    assert.strictEqual(cascadeProgress(line, 1), 0);
    approx(cascadeProgress(line, 1.3), 0.5, 1e-9);
    assert.strictEqual(cascadeProgress(line, 1.6), null);
    assert.strictEqual(cascadeProgress({ ...line, animIn: 'fade' }, 1.2), null);
    // Half way: the first word is there, the last has not started, the ones between are part way and still low.
    const half = [0, 1, 2, 3].map((i) => cascadeWord(0.5, i, 4));
    assert.ok(half[0].op === 1 && half[0].dy === 0 && half[3].op === 0 && half[3].dy > 0.4);
    assert.ok(half[1].op > half[2].op && half[2].op > 0 && half[2].dy > 0);
    for (let i = 0; i < 4; i++) assert.deepStrictEqual(cascadeWord(1, i, 4), { op: 1, dy: 0 });
    for (let i = 0; i < 4; i++) assert.strictEqual(cascadeWord(0, i, 4).op, 0);
    // One word alone takes the whole time.
    approx(cascadeWord(0.5, 0, 1).op, 1 - Math.pow(0.5, 3), 1e-9);
  });

  t('trailer: with a song the cuts are its beats; a voice-over is given the time it needs', () => {
    const beats = Array.from({ length: 200 }, (_, i) => 0.21 + i * 0.47 + (i % 2 ? 0.01 : 0));
    const p = trailer({ grid: { beats, period: 0.47 }, music: { mediaId: 'song', duration: 20, volume: 0.85, duckDb: -10 } });
    const marks = new Set([0, ...beats].map((b) => b.toFixed(4)));
    for (const s of p.sections) assert.ok(marks.has(s.start.toFixed(4)) && marks.has(s.end.toFixed(4)), s.heading);
    // The song is shorter than the trailer here, so it plays again; it fades out at the end.
    const bed = p.clips.filter((c) => c.trackId === 'am');
    assert.ok(bed.length >= 2 && bed[bed.length - 1].fadeOut > 0.5);
    approx(end(bed[bed.length - 1]), p.end, 1e-6);

    const spoken = trailer({ narration: { sections: [narr('vo', 'Search as you type, across everything you ever wrote down, in every notebook.', 7.3)] }, captions: { patch: { fontSize: 52 }, upper: false }, music: { mediaId: 'song', duration: 90, volume: 0.6, duckDb: -10 } });
    const voice = spoken.clips.find((c) => c.trackId === 'an');
    const window = windowOf(spoken, 'rec');
    assert.ok(voice.start >= window.start && end(voice) <= spoken.sections[0].end + 1e-6, 'the line fits over its recording');
    assert.ok(spoken.captions > 0 && spoken.clips.some((c) => c.trackId === 'tc'));
    // The music goes down under the voice.
    assert.ok(spoken.clips.find((c) => c.trackId === 'am').keyframes.some((k) => k.prop === 'volume'));
  });

  t('trailer: the logo is on the name card and the end card; where the project keeps its own background the cards cover it', () => {
    const free = trailer({ logo: 'logo' });
    const logos = free.clips.filter((c) => c.mediaId === 'logo');
    assert.strictEqual(logos.length, 2);
    approx(logos[0].start, free.score.reveal, 1e-6);
    approx(logos[1].start, free.score.close, 1e-6);
    assert.ok(logos.every((c) => c.posY < 0 && c.scaleY < 0.5));
    // No full-frame rectangle hides it.
    assert.ok(!free.clips.some((c) => c.type === 'shape' && c.w > 1 && c.start <= free.score.reveal && end(c) > free.score.reveal));

    const kept = trailer({ logo: 'logo', backdropFree: false });
    assert.strictEqual(kept.clips.filter((c) => c.mediaId === 'logo').length, 0);
    assert.ok(kept.notes.some((n) => /logo is left out/.test(n)));
    assert.ok(kept.clips.some((c) => c.type === 'shape' && c.w > 1 && Math.abs(c.start - kept.score.reveal) < 1e-6));
    assert.strictEqual(kept.backdrop, undefined);
  });

  t('trailer: a tall frame keeps the window and the headline inside it', () => {
    const p = trailer({ canvas: TALL });
    const window = windowOf(p, 'rec');
    // A 1280×800 recording fitted to a 1080-wide frame, scaled: its width stays inside the frame, also once it has come in.
    assert.ok(withKeyframes(window, window.start + window.duration).scaleX <= 0.9 * 1.04 + 1e-6);
    for (const c of p.clips.filter((x) => x.type === 'text')) assert.ok(c.y > 0.02 && c.y < 0.98, c.text);
  });

  t('trailer: the beat made for it is as long as the video, quiet before the name and loud after, and the same every time', () => {
    const p = trailer();
    const rate = 22050;
    const a = trailerMusic(p.score, rate);
    approx(a.length / rate, p.score.end + 0.5, 0.01);
    let peak = 0;
    for (const v of a) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak > 0.3 && peak <= 0.83, `peak ${peak}`);
    const rms = (from, to) => {
      let s = 0;
      const i0 = Math.round(from * rate);
      const i1 = Math.min(a.length, Math.round(to * rate));
      for (let i = i0; i < i1; i++) s += a[i] * a[i];
      return Math.sqrt(s / Math.max(1, i1 - i0));
    };
    const quiet = rms(0, Math.max(0.5, p.score.reveal - 1));
    const loud = rms(p.score.reveal + 1, p.score.close);
    assert.ok(quiet > 0.005 && loud > quiet * 1.5, `opening ${quiet}, features ${loud}`);
    // A kick on every beat of the features: louder right on it than just before the next one.
    const beat = p.score.reveal + 4 * p.score.period;
    assert.ok(rms(beat, beat + 0.04) > rms(beat + 0.4, beat + 0.44));
    // It ends by fading, not by stopping.
    assert.ok(Math.abs(a[a.length - 1]) < 0.01);
    // It can be heard on a phone: what is above about 300 Hz (all a small speaker plays) carries a good part of
    // it. The first version was nearly all below 120 Hz and came out as muffled thumps.
    const k = 1 - Math.exp((-2 * Math.PI * 300) / rate);
    let low = 0;
    let lows = 0;
    let highs = 0;
    for (let i = Math.round(p.score.reveal * rate); i < Math.round(p.score.close * rate); i++) {
      low += (a[i] - low) * k;
      lows += low * low;
      highs += (a[i] - low) * (a[i] - low);
    }
    assert.ok(highs > lows * 0.45, `above 300 Hz ${Math.sqrt(highs)}, below ${Math.sqrt(lows)}`);
    const b = trailerMusic(p.score, rate);
    assert.ok(a.every((v, i) => v === b[i]));
    // A trailer with no opening lines and no features still gets one.
    const bare = trailerMusic({ period: 0.5, reveal: 0, close: 3, end: 7.5, cuts: [] }, rate);
    assert.ok(bare.length > 0 && bare.every((v) => Number.isFinite(v)));
  });

  t('trailer: the example script reads as a trailer, and its length is counted in beats, not words', () => {
    const s = parseScript(LONGFORM_EXAMPLES.trailer);
    assert.strictEqual(s.title, 'Acme Notes');
    assert.strictEqual(s.subtitle, 'Notes that find themselves');
    assert.strictEqual(s.sections.length, 3);
    assert.ok(/acmenotes\.example/.test(s.outro.text));
    assert.ok(s.sections[0].points.length === 2);
    const stats = scriptStats({ hook: s.hook, sections: s.sections, outro: s.outro }, format('trailer'));
    assert.ok(stats.seconds >= 20 && stats.seconds <= 45, `${stats.seconds}s`);
    assert.ok(/trailer for \[your product/.test(agentPrompt('Software trailer')));
    assert.ok(/10-question quiz/.test(agentPrompt('Quiz')));
    assert.ok(/5-minute explainer/.test(agentPrompt('Explainer')));
  });

  // ── Quiz ──
  t('quiz: the right answer is found by its text, its letter or its number, and never guessed', () => {
    const options = ['Venus', 'Mercury', 'Mars', 'Earth'];
    assert.strictEqual(answerIndex('Mercury', options), 1);
    assert.strictEqual(answerIndex('mercury.', options), 1);
    assert.strictEqual(answerIndex('B', options), 1);
    assert.strictEqual(answerIndex('b)', options), 1);
    assert.strictEqual(answerIndex('B) Mercury', options), 1);
    assert.strictEqual(answerIndex(2, options), 1);
    assert.strictEqual(answerIndex('2', options), 1);
    assert.strictEqual(answerIndex('Jupiter', options), -1);
    assert.strictEqual(answerIndex('E', options), -1);
    assert.strictEqual(answerIndex(5, options), -1);
    assert.strictEqual(answerIndex('', options), -1);
    assert.strictEqual(answerIndex(undefined, options), -1);
    // Part of one option's text is enough; part of two is not.
    assert.strictEqual(answerIndex('The Pacific', ['The Atlantic Ocean', 'The Pacific Ocean']), 1);
    assert.strictEqual(answerIndex('Ocean', ['The Atlantic Ocean', 'The Pacific Ocean']), -1);
    // An option that is itself a letter is matched as text first.
    assert.strictEqual(answerIndex('C', ['A', 'C', 'B']), 1);
    assert.strictEqual(revealLine('Mercury', 'It circles the Sun in 88 days.'), 'Mercury. It circles the Sun in 88 days.');
    assert.strictEqual(revealLine('Mercury', 'Mercury circles the Sun in 88 days.'), 'Mercury circles the Sun in 88 days.');
    assert.strictEqual(revealLine('Eight.', undefined), 'Eight.');
  });

  t('quiz: the answers never overlap each other, the question or the picture, wide or tall', () => {
    for (const canvas of [WIDE, TALL]) {
      for (const picture of [false, true]) {
        for (const n of [2, 3, 4]) {
          const lay = quizLayout(canvas, picture, n);
          const where = `${canvas.width}x${canvas.height} picture=${picture} n=${n}`;
          assert.strictEqual(lay.boxes.length, n, where);
          const all = [...lay.boxes, ...(lay.picture ? [lay.picture] : [])];
          for (const b of all) assert.ok(b.x - b.w / 2 >= 0.02 && b.x + b.w / 2 <= 0.98 && b.y - b.h / 2 >= 0.02 && b.y + b.h / 2 <= 0.98, where);
          for (let i = 0; i < all.length; i++) {
            for (let j = i + 1; j < all.length; j++) {
              const apart = Math.abs(all[i].x - all[j].x) >= (all[i].w + all[j].w) / 2 - 1e-9 || Math.abs(all[i].y - all[j].y) >= (all[i].h + all[j].h) / 2 - 1e-9;
              assert.ok(apart, `${where}: ${i} and ${j} overlap`);
            }
          }
          const top = Math.min(...lay.boxes.map((b) => b.y - b.h / 2));
          const bottom = Math.max(...lay.boxes.map((b) => b.y + b.h / 2));
          assert.ok(lay.question.y < top && lay.kicker.y < lay.question.y && lay.foot > bottom, where);
          assert.strictEqual(!!lay.picture, picture, where);
        }
      }
    }
  });

  const QTRACKS = { video: 'v', narration: 'an', music: 'am', fx: 'fx', text: 'tt' };
  const QUIZ = {
    title: 'The solar system',
    subtitle: 'Three questions',
    sections: [
      { heading: 'Which planet is closest to the Sun?', options: ['Venus', 'Mercury', 'Mars', 'Earth'], answer: 1, text: 'Mercury circles the Sun in 88 days.' },
      { heading: 'Whose flag is this?', options: ['Italy', 'Ireland', 'Mexico'], answer: 0, visuals: [{ mediaId: 'flag' }] },
      { heading: 'True or false: the Moon has no gravity', options: ['True', 'False'], answer: 1 },
    ],
    outro: { text: 'How many did you get?' },
  };
  const quiz = (over = {}) =>
    planQuiz({
      script: QUIZ,
      format: format('quiz'),
      canvas: WIDE,
      narration: { hook: narr('h', 'Three questions. Five seconds each.', 3), questions: QUIZ.sections.map((s, i) => narr(`q${i}`, s.heading, 2.5)), reveals: QUIZ.sections.map((s, i) => narr(`r${i}`, 'The answer.', 2)), outro: narr('o', 'How many did you get?', 1.5) },
      media,
      card: { look: 'clean', background: '#0b1640', accent: '#fde047' },
      think: 5,
      sounds: { ticks: { mediaId: 'ticks', duration: 5 }, ding: { mediaId: 'ding', duration: 1.3 } },
      start: 0,
      tracks: QTRACKS,
      ...over,
    });

  t('quiz: each question is read, counted down with a clock, and answered with a chime and the right box in green', () => {
    const p = quiz();
    assert.strictEqual(p.sections.length, 3);
    const ticks = p.clips.filter((c) => c.mediaId === 'ticks');
    const dings = p.clips.filter((c) => c.mediaId === 'ding');
    assert.ok(ticks.length === 3 && dings.length === 3 && [...ticks, ...dings].every((c) => c.trackId === 'fx'));
    p.sections.forEach((s, i) => {
      const asked = p.clips.find((c) => c.mediaId === `q${i}`);
      const said = p.clips.find((c) => c.mediaId === `r${i}`);
      const showAt = dings[i].start;
      // In order: the question, the clock, the chime, the line about the answer.
      assert.ok(asked.start >= s.start && end(asked) <= ticks[i].start + 1e-6);
      approx(ticks[i].start + 5, showAt, 1e-6);
      assert.ok(said.start > showAt && end(said) <= s.end);
      // Before the chime no box is green; from it on exactly one is, and it is the right answer's.
      const green = p.clips.filter((c) => c.type === 'shape' && c.fill === QUIZ_RIGHT && c.start >= s.start && c.start < s.end);
      assert.strictEqual(green.length, 1);
      approx(green[0].start, showAt, 1e-6);
      const lay = quizLayout(WIDE, i === 1, QUIZ.sections[i].options.length);
      const box = lay.boxes[QUIZ.sections[i].answer];
      approx(green[0].x, box.x, 1e-9);
      approx(green[0].y, box.y, 1e-9);
      // Every answer is on screen while the clock runs, each with its letter.
      const during = p.clips.filter((c) => c.type === 'text' && c.start < ticks[i].start && end(c) > ticks[i].start && c.start >= s.start);
      for (const option of QUIZ.sections[i].options) assert.ok(during.some((c) => c.text === option), option);
      for (const letter of 'ABCD'.slice(0, QUIZ.sections[i].options.length)) assert.ok(during.some((c) => c.text === letter), letter);
      // The seconds count down to the chime.
      const digits = p.clips.filter((c) => c.type === 'text' && /^[1-5]$/.test(c.text) && c.start >= ticks[i].start - 1e-6 && c.start < showAt);
      assert.deepStrictEqual(digits.sort((a, b) => a.start - b.start).map((c) => c.text), ['5', '4', '3', '2', '1']);
      // The check mark replaces the right answer's letter.
      assert.ok(p.clips.some((c) => c.type === 'text' && c.text === '✓' && Math.abs(c.start - showAt) < 1e-6));
      // It is a chapter of the video.
      assert.ok(p.clips.some((c) => c.chapter === `${i + 1}. ${QUIZ.sections[i].heading}` && Math.abs(c.start - s.start) < 1e-6));
    });
    // The questions follow one another without a gap, between the title and the closing card.
    for (let i = 1; i < 3; i++) approx(p.sections[i].start, p.sections[i - 1].end, 1e-6);
    assert.ok(p.sections[0].start >= 3.5 && p.end >= p.sections[2].end + format('quiz').outroSeconds - 1e-6);
    assert.ok(p.clips.some((c) => c.type === 'text' && c.text === 'How many did you get?'));
    assert.strictEqual(p.captions, 0);
  });

  t('quiz: a picture sits beside its question, and the background is built around it instead of over it', () => {
    const p = quiz();
    const s = p.sections[1];
    const picture = p.clips.find((c) => c.mediaId === 'flag');
    assert.ok(picture && picture.trackId === 'v');
    approx(picture.start, s.start, 1e-6);
    approx(end(picture), s.end, 1e-6);
    const at = { x: 0.5 + picture.posX, y: 0.5 + picture.posY };
    const covers = (c, x, y) => Math.abs(c.x - x) <= c.w / 2 && Math.abs(c.y - y) <= c.h / 2;
    const ground = p.clips.filter((c) => c.type === 'shape' && c.fill === '#0b1640' && Math.abs(c.start - s.start) < 1e-6 && Math.abs(end(c) - s.end) < 1e-6);
    assert.strictEqual(ground.length, 4);
    assert.ok(!ground.some((c) => covers(c, at.x, at.y)), 'nothing over the middle of the picture');
    // …while every corner of the frame and the answers' side is covered.
    for (const [x, y] of [[0.01, 0.01], [0.99, 0.01], [0.01, 0.99], [0.99, 0.99], [0.275, 0.5]]) assert.ok(ground.some((c) => covers(c, x, y)), `${x},${y}`);
    // A question without a picture has one background, over everything.
    const plain = p.clips.filter((c) => c.type === 'shape' && c.fill === '#0b1640' && Math.abs(c.start - p.sections[0].start) < 1e-6 && Math.abs(end(c) - p.sections[0].end) < 1e-6);
    assert.strictEqual(plain.length, 1);
    assert.ok(plain[0].w > 1 && plain[0].h > 1);
  });

  t('quiz: the clock ticks once a second and twice in the last, and the chime rings out', () => {
    const rate = 8000;
    const ticks = quizTicks(5, rate);
    assert.strictEqual(ticks.length, 5 * rate);
    const loud = (at) => {
      let m = 0;
      for (let i = Math.round(at * rate); i < Math.round((at + 0.03) * rate) && i < ticks.length; i++) m = Math.max(m, Math.abs(ticks[i]));
      return m;
    };
    for (const at of [0, 1, 2, 3, 4, 4.5]) assert.ok(loud(at) > 0.2, `tick at ${at}`);
    for (const at of [0.5, 1.5, 2.5, 3.5]) assert.ok(loud(at) < 0.01, `silence at ${at}`);
    const ding = quizDing(rate);
    approx(ding.length / rate, 1.3, 0.01);
    assert.ok(Math.max(...ding.map(Math.abs)) <= 1 && Math.abs(ding[ding.length - 1]) < 1e-3);
  });

  t('quiz: the example script has an answer among the options of every question', () => {
    const s = parseScript(LONGFORM_EXAMPLES.quiz);
    assert.strictEqual(s.sections.length, 3);
    for (const q of s.sections) {
      assert.ok(q.points.length >= 2 && q.points.length <= 4, q.heading);
      assert.ok(answerIndex(q.answer, q.points) >= 0, q.heading);
      assert.ok(q.text.length > 10, q.heading);
    }
    assert.ok(s.outro?.text);
    const stats = scriptStats({ hook: s.hook, sections: s.sections, outro: s.outro }, format('quiz'));
    // Three questions with a five-second wait each cannot be over in twenty seconds.
    assert.ok(stats.seconds > 40 && stats.seconds < 120, `${stats.seconds}s`);
  });

  // ── From a recording ──
  t('recording: what was heard becomes sentences, and a stretch of it a narration of its own', () => {
    const w = (text, start, dur = 0.3) => ({ text, start, end: start + dur });
    const heard = [
      { start: 0.5, end: 2, text: ' Welcome back to', words: [w(' Welcome', 0.5), w(' back', 0.9), w(' to', 1.3)] },
      { start: 2, end: 3.4, text: ' the show.', words: [w(' the', 2), w(' show.', 2.6)] },
      { start: 5, end: 7, text: ' Today we talk about bees.', words: [w(' Today', 5), w(' we', 5.4), w(' talk', 5.8), w(' about', 6.2), w(' bees.', 6.6)] },
      { start: 9.5, end: 11, text: ' Bees see ultraviolet.' },
    ];
    const lines = heardLines(heard);
    assert.deepStrictEqual(lines.map((l) => l.text), ['Welcome back to the show.', 'Today we talk about bees.', 'Bees see ultraviolet.']);
    assert.strictEqual(lines[0].words.length, 5);
    assert.strictEqual(lines[0].words[0].text, 'Welcome');
    assert.strictEqual(lines[2].words.length, 3, 'a phrase without word times has them spread');

    const rec = { mediaId: 'ep', duration: 12, lines };
    const part = narrationSlice(rec, 4.5, 9);
    assert.strictEqual(part.inPoint, 4.5);
    assert.strictEqual(part.sourceDuration, 12);
    approx(part.duration, 4.5, 1e-9);
    assert.deepStrictEqual(part.lines.map((l) => l.text), ['Today we talk about bees.']);
    approx(part.lines[0].start, 0.5, 1e-9);
    approx(part.lines[0].words[4].start, 2.1, 1e-9);
    // A cut in the middle of a sentence: every word lands on one side, none on both.
    const a = narrationSlice(rec, 0, 5.6);
    const b = narrationSlice(rec, 5.6, 12);
    const count = (n) => n.lines.reduce((sum, l) => sum + l.words.length, 0);
    assert.strictEqual(count(a) + count(b), lines.reduce((sum, l) => sum + l.words.length, 0));
    assert.strictEqual(a.lines[a.lines.length - 1].text, 'Today we');
    assert.strictEqual(b.lines[0].text, 'talk about bees.');
    for (const n of [a, b]) for (const l of n.lines) assert.ok(l.start >= 0 && l.end <= n.duration + 1e-9 && l.end > l.start);
    // Out of range is brought in, and an empty stretch has no lines.
    assert.strictEqual(narrationSlice(rec, 7.5, 9).lines.length, 0);
    approx(narrationSlice(rec, 10, 99).duration, 2, 1e-9);
  });

  t('recording: a section plays its stretch of the file, and the plan is laid out on what was said there', () => {
    const rec = { mediaId: 'ep', duration: 60, lines: estimateLines('One thing first. Then a second thing. Then the bees arrive. And they stay all summer.', 60) };
    const sections = [
      { heading: 'The start', text: '', points: ['Second thing'] },
      { heading: 'The bees', text: '' },
    ];
    const p = planLongform({
      script: { title: 'Episode 12', sections },
      format: format('explainer'),
      canvas: WIDE,
      narration: { sections: [narrationSlice(rec, 5, 30), narrationSlice(rec, 30, 60)] },
      media,
      card: { look: 'clean' },
      captions: { patch: { fontSize: 56 }, upper: false },
      transition: { type: 'fade', duration: 0.45 },
      start: 0,
      tracks: { video: 'v', presenter: 'vp', narration: 'an', music: 'am', text: 'tt', captions: 'tc' },
    });
    const voice = p.clips.filter((c) => c.trackId === 'an').sort((x, y) => x.start - y.start);
    assert.strictEqual(voice.length, 2);
    assert.deepStrictEqual(voice.map((c) => [c.mediaId, c.inPoint, c.duration, c.sourceDuration]), [['ep', 5, 25, 60], ['ep', 30, 30, 60]]);
    // What is on screen is timed to the stretch, not to the file: captions under the first section's points, and the
    // second section's own sentences as its picture (it names nothing else to show).
    const caps = p.clips.filter((c) => c.trackId === 'tc');
    assert.ok(caps.length > 0 && caps.every((c) => c.start >= voice[0].start - 1e-6 && c.start < end(voice[0]) + 1));
    assert.ok(caps.some((c) => /first/i.test(c.text)));
    const words = p.clips.filter((c) => c.type === 'text');
    assert.ok(words.filter((c) => c.start >= voice[1].start).some((c) => /summer/i.test(c.text)));
    assert.ok(!words.filter((c) => c.start < end(voice[0])).some((c) => /summer/i.test(c.text)));
  });

  t('recording: a cut goes to the end of a sentence when one is close, and never through a word', () => {
    const w = (text, start, end) => ({ text, start, end });
    const lines = [
      { start: 0, end: 3, text: 'Welcome back to the show.', words: [w('Welcome', 0, 0.5), w('back', 0.5, 0.9), w('to', 0.9, 1.1), w('the', 1.1, 1.3), w('show.', 1.3, 2)] },
      { start: 2.6, end: 9, text: 'Today we talk about bees, at length.', words: [w('Today', 2.6, 3.1), w('we', 3.1, 3.3), w('talk', 3.3, 3.8), w('about', 3.8, 4.4), w('bees,', 4.4, 5.2), w('at', 5.6, 5.9), w('length.', 5.9, 9)] },
      { start: 9.4, end: 10, text: 'Right.', words: [w('Right.', 9.4, 10)] },
    ];
    // A second into the next sentence: back to the pause before it.
    approx(snapToPause(lines, 3.4), 2.3, 1e-9);
    approx(snapToPause(lines, 1.6), 2.3, 1e-9);
    // Too far from any sentence end: left where it is in a gap, moved out of a word otherwise.
    approx(snapToPause(lines, 5.4), 5.4, 1e-9);
    approx(snapToPause(lines, 5.1), 5.4, 1e-9);
    approx(snapToPause(lines, 7.2), 7.2, 1e-9, 'no gap within reach: the time asked for stands');
    // The nearer of two sentence ends.
    approx(snapToPause(lines, 9.3), 9.2, 1e-9);
    // Nothing heard, or a line without word times.
    assert.strictEqual(snapToPause([], 4), 4);
    approx(snapToPause([{ start: 0, end: 2, text: 'One.' }, { start: 3, end: 5, text: 'Two.' }], 3.4), 2.5, 1e-9);
  });

  t('trailer: a large line is broken into lines of about the same length, never wider than it was fitted', () => {
    assert.strictEqual(evenLines('Find any note in a\nsecond'), 'Find any note\nin a second');
    assert.strictEqual(evenLines('You wrote it down\nsomewhere'), 'You wrote it\ndown somewhere');
    assert.strictEqual(evenLines('One line'), 'One line');
    assert.strictEqual(evenLines('Already\nbalanced'), 'Already\nbalanced');
    const three = evenLines('A much longer headline that was\nfitted on three lines by the\nfitter');
    assert.strictEqual(three.split('\n').length, 3);
    assert.ok(Math.max(...three.split('\n').map((l) => l.length)) <= 31);
    assert.strictEqual(three.replace(/\n/g, ' '), 'A much longer headline that was fitted on three lines by the fitter');
  });

  // ── The tool ──
  await ta('build_longform: a trailer, a quiz and a recording are refused before any work when something is missing', async () => {
    const q = (sections, over = {}) => call('build_longform', { title: 'T', format: 'quiz', sections, ...over });
    const none = await q([{ heading: 'Which one?' }]);
    assert.ok(!none.ok && /needs options/.test(none.text), none.text);
    const wrong = await q([{ heading: 'Which one?', options: ['Red', 'Blue'], answer: 'Green' }]);
    assert.ok(!wrong.ok && /has to be one of its options/.test(wrong.text) && /A\) Red, B\) Blue/.test(wrong.text), wrong.text);
    const many = await q([{ heading: 'Which one?', options: ['1', '2', '3', '4', '5'], answer: 1 }]);
    assert.ok(!many.ok && /two to 4 answers/.test(many.text), many.text);
    const drawn = await call('build_longform', { title: 'T', format: 'trailer', visual_style: 'stickman', sections: [{ heading: 'Fast' }] });
    assert.ok(!drawn.ok && /laid out from its own script/.test(drawn.text), drawn.text);
    const auto = await q([{ heading: 'Which one?', options: ['Red', 'Blue'], answer: 'Red' }], { pictures: 'auto' });
    assert.ok(!auto.ok && /laid out from its own script/.test(auto.text), auto.text);
    const both = await call('build_longform', { title: 'T', format: 'trailer', recording: 'C:\\nowhere\\episode.mp3', sections: [{ heading: 'Fast' }] });
    assert.ok(!both.ok && /recording is for the narrated formats/.test(both.text), both.text);
    // A narrated section still needs something to say when there is no recording.
    const silent = await call('build_longform', { title: 'T', sections: [{ heading: 'Nothing here' }] });
    assert.ok(!silent.ok && /needs text/.test(silent.text), silent.text);
  });

  await ta('build_longform takes what the three need, and list_formats says how to write them', async () => {
    const input = TOOLS.find((x) => x.name === 'build_longform').input;
    for (const key of ['recording', 'recording_start', 'voiceover', 'logo', 'think_seconds']) assert.ok(key in input.shape, key);
    const ok = input.safeParse({ title: 'T', format: 'quiz', think_seconds: 5, sections: [{ heading: 'Which one?', options: ['Red', 'Blue'], answer: 'B', text: 'Blue it is.' }] });
    assert.ok(ok.success, JSON.stringify(ok.error?.issues));
    assert.ok(input.safeParse({ title: 'T', recording: 'ep.mp3', sections: [{ heading: 'Start', from: 0, to: 60 }, { heading: 'Next', from: 60 }] }).success);
    assert.ok(input.safeParse({ title: 'T', format: 'trailer', voiceover: true, logo: 'logo.png', music: 'none', sections: [{ heading: 'Fast', seconds: 4, points: ['One'] }], outro: { title: 'Get it', subtitle: 'example.com' } }).success);
    assert.ok(!input.safeParse({ title: 'T', format: 'quiz', sections: [{ heading: 'Which one?', options: ['Only one'], answer: 1 }] }).success);
    const r = await call('list_formats', {});
    assert.ok(r.ok, r.text);
    const by = Object.fromEntries(JSON.parse(r.text).formats.map((f) => [f.id, f]));
    assert.ok(/name, on a hit/.test(by.trailer.opens_with) && /recording in a window/.test(by.trailer.each_section_opens_with));
    assert.ok(by.trailer.also.some((x) => /nothing is spoken unless voiceover/.test(x)));
    assert.ok(/countdown/.test(by.quiz.each_section_opens_with) && by.quiz.also.some((x) => /options and answer are required/.test(x)));
    assert.ok(/no made-up numbers/.test(by.trailer.how_to_write_it) && /source you checked/.test(by.quiz.how_to_write_it));
  });
}
