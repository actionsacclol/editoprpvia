// Montages cut to music: finding the beat, finding the moments that stand
// out, and landing each moment on a beat through its speed ramp.
import assert from 'node:assert';
import { BEAT_RATE, detectBeats, findHighlights, planMontage, timelineTimeAtSource } from './.editor.mjs';

/** A repeatable noise source. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

/** A drum loop: a kick on every beat (harder on the one), a hat between beats. `gain(t)` scales it over time. */
function song(bpm, seconds, { offset = 0.2, gain = () => 1 } = {}) {
  const rate = BEAT_RATE;
  const x = new Float32Array(Math.round(seconds * rate));
  const noise = rng(7);
  const beat = 60 / bpm;
  const truth = [];
  for (let k = 0; offset + k * beat < seconds - 0.2; k++) {
    const t = offset + k * beat;
    truth.push(t);
    const g = gain(t);
    const accent = k % 4 === 0 ? 1 : 0.55;
    const at = Math.round(t * rate);
    for (let i = 0; i < rate * 0.09 && at + i < x.length; i++) x[at + i] += g * accent * Math.exp(-i / (rate * 0.025)) * Math.sin((2 * Math.PI * 60 * i) / rate);
    const hat = Math.round((t + beat / 2) * rate);
    for (let i = 0; i < rate * 0.02 && hat + i < x.length; i++) x[hat + i] += g * 0.12 * Math.exp(-i / (rate * 0.005)) * noise();
  }
  return { x, truth, beat };
}

const nearest = (xs, v) => xs.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), xs[0]);

export async function run({ t, approx }) {
  console.log('montage');

  t('beats: tempo and beat times of a drum loop, and which beats start a bar', () => {
    for (const bpm of [128, 92, 150]) {
      const { x, truth, beat } = song(bpm, 30);
      const g = detectBeats(x, BEAT_RATE);
      // The pulse may be called at double or half time; either lines up with the music.
      const ratio = g.bpm / bpm;
      assert.ok([0.5, 1, 2].some((r) => Math.abs(ratio - r) < 0.03), `${bpm}: found ${g.bpm}`);
      assert.ok(g.beats.length > (20 / beat) * Math.min(1, ratio) * 0.9, `${bpm}: ${g.beats.length} beats`);
      // Every beat it names is on a real beat (or exactly between two, at double time).
      const grid = ratio > 1.5 ? truth.flatMap((b) => [b, b + beat / 2]) : truth;
      const off = g.beats.filter((b) => Math.abs(nearest(grid, b) - b) > 0.04).length;
      assert.ok(off <= g.beats.length * 0.05, `${bpm}: ${off} of ${g.beats.length} beats off the grid`);
      if (Math.abs(ratio - 1) < 0.03) {
        const ones = truth.filter((_, k) => k % 4 === 0);
        const bar = g.beats[g.barPhase];
        assert.ok(Math.abs(nearest(ones, bar) - bar) < 0.05, `${bpm}: bar start ${bar} is not a "one"`);
      }
      assert.ok(g.confidence > 0.15, `${bpm}: confidence ${g.confidence}`);
    }
  });

  t('beats: a drop is found where the song gets loud; noise has no beat', () => {
    const { x } = song(120, 40, { gain: (time) => (time < 16 ? 0.12 : 1) });
    const g = detectBeats(x, BEAT_RATE);
    assert.ok(g.drops.length >= 1, 'no drop');
    assert.ok(Math.abs(g.drops[0].at - 16.2) < 1.1, `drop at ${g.drops[0].at}`);
    assert.ok(g.drops[0].lift > 8, `lift ${g.drops[0].lift}`);
    const noise = rng(3);
    const hiss = Float32Array.from({ length: BEAT_RATE * 20 }, () => noise() * 0.4);
    assert.ok(detectBeats(hiss, BEAT_RATE).confidence < 0.15);
    assert.deepStrictEqual(detectBeats(new Float32Array(BEAT_RATE), BEAT_RATE).beats, []);
  });

  t('highlights: the bursts that stand out, in time order, a set distance apart', () => {
    const hz = 100;
    const noise = rng(11);
    const env = Float32Array.from({ length: 70 * hz }, () => -42 + noise() * 2);
    const burst = (at, db, len) => {
      for (let i = Math.round(at * hz); i < (at + len) * hz; i++) env[i] = -42 + db + noise() * 2;
    };
    burst(10, 14, 0.8);
    burst(30, 22, 1.2);
    burst(31.6, 20, 0.5); // part of the same fight: too close to count twice
    burst(50, 9, 0.6);
    const hs = findHighlights(env, hz, { count: 5, minGap: 4 });
    assert.deepStrictEqual(hs.map((h) => Math.round(h.at)), [10, 30, 50]);
    for (const h of hs) assert.ok(Math.abs(h.at - Math.round(h.at)) < 0.2 && h.from <= h.at + 0.2 && h.to > h.at, JSON.stringify(h));
    assert.ok(hs[1].score > hs[0].score && hs[0].score > hs[2].score);
    // Asked for one: the loudest.
    assert.deepStrictEqual(findHighlights(env, hz, { count: 1 }).map((h) => Math.round(h.at)), [30]);
    // An even level has nothing to offer, and neither has silence.
    assert.deepStrictEqual(findHighlights(Float32Array.from({ length: 30 * hz }, () => -30 + noise()), hz), []);
    assert.deepStrictEqual(findHighlights(new Float32Array(30 * hz).fill(-100), hz), []);
  });

  const grid = { beats: Array.from({ length: 120 }, (_, k) => 0.25 + k * 0.5), barPhase: 0 };
  const file = (at, over = {}) => ({ mediaId: 'g1', at, sourceDuration: 60, width: 1920, height: 1080, hasAudio: true, ...over });
  const opts = { start: 0, musicStart: 0, beatsPerClip: 4, after: 1, ramp: 'velocity', punch: true, transition: 'flash', gameVolume: 0.35, videoTrack: 'v1', soundTrack: 'a1' };
  const pictures = (plan) => plan.clips.filter((c) => c.trackId === 'v1');

  t('montage: every moment lands on a beat, through its speed ramp, and the clips run back to back', () => {
    for (const ramp of ['velocity', 'slowmo', 'none']) {
      const plan = planMontage([file(20), file(33.3), file(41), file(55)], grid, { ...opts, ramp });
      assert.strictEqual(plan.hits.length, 4);
      assert.strictEqual(plan.left, 0);
      const pics = pictures(plan);
      plan.hits.forEach((h, i) => {
        assert.ok(grid.beats.some((b) => Math.abs(b - h.impact) < 1e-9), `${ramp}: ${h.impact} is not a beat`);
        // The frame on screen at the beat is the moment itself.
        approx(timelineTimeAtSource(pics[i], [20, 33.3, 41, 55][i]), h.impact, 0.02);
        assert.ok(h.impact > h.from && h.impact < h.to);
        if (i > 0) approx(h.from, plan.hits[i - 1].to, 1e-9);
        assert.ok(pics[i].inPoint >= 0 && h.sourceTo <= 60);
        assert.strictEqual(h.note, undefined);
      });
      // One bar apart, the first on a bar start, each cut one beat after its moment.
      assert.strictEqual(plan.hits[0].from, 0);
      approx(plan.hits[1].impact - plan.hits[0].impact, 2, 1e-9);
      approx(plan.hits[0].to - plan.hits[0].impact, 0.5, 1e-9);
      assert.ok(grid.beats.filter((_, k) => k % 4 === 0).some((b) => Math.abs(b - plan.hits[0].impact) < 1e-9));
      approx(plan.end, plan.hits[3].to, 1e-9);
      assert.strictEqual(pics[0].transition, 'none');
      assert.strictEqual(pics[1].transition, 'flash');
      assert.strictEqual(pics.some((c) => c.keyframes.some((k) => k.prop === 'speed')), ramp !== 'none');
    }
  });

  t('montage: game sound is a linked clip with the same timing; none when it is turned off or the file is silent', () => {
    const plan = planMontage([file(20), file(40, { hasAudio: false })], grid, opts);
    const [p1, p2] = pictures(plan);
    const sounds = plan.clips.filter((c) => c.trackId === 'a1');
    assert.strictEqual(sounds.length, 1);
    assert.ok(p1.link && sounds[0].link === p1.link && p1.muted && !sounds[0].muted);
    assert.strictEqual(sounds[0].volume, 0.35);
    assert.strictEqual(sounds[0].start, p1.start);
    assert.strictEqual(sounds[0].duration, p1.duration);
    assert.deepStrictEqual(
      sounds[0].keyframes.map((k) => [k.prop, k.t, k.value]),
      p1.keyframes.filter((k) => k.prop === 'speed').map((k) => [k.prop, k.t, k.value]),
    );
    assert.strictEqual(p2.link, undefined);
    assert.strictEqual(planMontage([file(20)], grid, { ...opts, gameVolume: 0 }).clips.length, 1);
    // The hit: a punch-in that is back to normal size, and a shake that ends where it began.
    const scale = p1.keyframes.filter((k) => k.prop === 'scaleX');
    assert.ok(Math.max(...scale.map((k) => k.value)) > 1.1 && scale[scale.length - 1].value === 1);
    assert.strictEqual(planMontage([file(20)], grid, { ...opts, punch: false }).clips[0].keyframes.some((k) => k.prop === 'scaleX' || k.prop === 'posX'), false);
  });

  t('montage: a moment at the very start or end of its file still lands on its beat', () => {
    const plan = planMontage([file(0.4), file(59.9)], grid, opts);
    const pics = pictures(plan);
    // Too little before it for a fast lead-up: the lead-up is slowed instead.
    approx(timelineTimeAtSource(pics[0], 0.4), plan.hits[0].impact, 0.03);
    assert.ok(pics[0].inPoint >= 0);
    // Too little after it: the way out is slowed, and the clip never runs past the file.
    approx(timelineTimeAtSource(pics[1], 59.9), plan.hits[1].impact, 0.03);
    assert.ok(plan.hits[1].sourceTo <= 60);
    approx(plan.hits[1].to - plan.hits[1].from, pics[1].duration, 1e-9);
  });

  t('montage: clip lengths, where the song starts, and a song that runs out', () => {
    // Half-bar clips, starting 10 seconds into the song, 3 seconds into the timeline.
    const plan = planMontage([file(20), file(30), file(40)], grid, { ...opts, beatsPerClip: 2, start: 3, musicStart: 10 });
    assert.strictEqual(plan.hits[0].from, 3);
    approx(plan.hits[1].impact - plan.hits[0].impact, 1, 1e-9);
    // Song second 10.25 is a beat; on the timeline it is at 3.25.
    assert.ok(plan.hits.every((h) => Math.abs(((h.impact - 3.25) / 0.5) % 1) < 1e-6 || Math.abs((((h.impact - 3.25) / 0.5) % 1) - 1) < 1e-6));
    // One moment asks for two bars of lead-up.
    const long = planMontage([file(20), file(30, { beats: 8 })], grid, opts);
    approx(long.hits[1].impact - long.hits[0].impact, 4, 1e-9);
    // Twelve beats of song hold two one-bar clips, not five.
    const short = planMontage([file(10), file(20), file(30), file(40), file(50)], { beats: grid.beats.slice(0, 12), barPhase: 0 }, opts);
    assert.strictEqual(short.hits.length + short.left, 5);
    assert.ok(short.hits.length >= 2 && short.left >= 2);
    assert.deepStrictEqual(planMontage([], grid, opts).hits, []);
  });
}
