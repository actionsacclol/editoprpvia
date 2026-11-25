// Animations, transitions, title cards, stingers, edit styles and reference
// analysis (run from editor.test.mjs, which owns the fixtures and the counter).
import assert from 'node:assert';
import {
  AGENT_TOOL_NAMES,
  BUILTIN_STYLES,
  CARD_LOOKS,
  CLIP_ANIMS,
  MOTIONS,
  STYLE_PARTS,
  TEXT_ANIMS,
  TOOLS,
  TRANSITIONS,
  activeVisualLayers,
  averageTone,
  buildCard,
  buildProfile,
  buildStinger,
  countBlackDips,
  detectCuts,
  fitText,
  frameDistance,
  frameStats,
  frameTimes,
  gradeTowards,
  hasClipAnim,
  insertGap,
  nearestAspect,
  planTransitions,
  readableOn,
  resolvedValue,
  runAgentTool,
  sliceClip,
  soundCoverage,
  styleId,
  suggestStyle,
  textAnim,
  timelineDuration,
  transitionPart,
  useMediaStore,
  useStyleStore,
  useTimelineStore,
} from './.editor.mjs';

export async function run({ t, ta, approx, mediaClip, textClip, V1, T1, A1 }) {
  const z = (x) => Math.round(x * 1e9) / 1e9 + 0; // -0 and 0.9999999999999999 are 0 and 1 to a renderer
  // ── Transitions ──────────────────────────────────────────────────────────
  t('every transition starts on the outgoing clip and ends on the incoming one, untouched', () => {
    for (const { value } of TRANSITIONS) {
      if (value === 'none') continue;
      const end = transitionPart(value, 1, 'in');
      const hidden = end.reveal ? end.reveal.l + end.reveal.r + end.reveal.t + end.reveal.b : 0;
      assert.deepStrictEqual([end.op, end.dx, end.dy ?? 0, end.scale, end.rot ?? 0, hidden].map(z), [1, 0, 0, 1, 0, 0], `${value} in @1`);
      assert.ok(Math.abs(end.blur) < 1e-9 && Math.abs(end.flash ?? 0) < 1e-9, `${value} in @1 is clean`);
      const start = transitionPart(value, 0, 'out');
      assert.deepStrictEqual([start.op, start.dx, start.dy ?? 0, start.scale, start.rot ?? 0].map(z), [1, 0, 0, 1, 0], `${value} out @0`);
      assert.ok(Math.abs(start.blur) < 1e-9 && Math.abs(start.flash ?? 0) < 1e-9, `${value} out @0 is clean`);
    }
  });

  t('directional transitions travel the way they are named', () => {
    assert.strictEqual(transitionPart('slide', 0, 'in').dx, 1); // from the right, moving left
    assert.strictEqual(transitionPart('slide-right', 0, 'in').dx, -1);
    assert.strictEqual(transitionPart('slide-up', 0, 'in').dy, 1); // from below, moving up
    assert.strictEqual(transitionPart('slide-down', 0, 'in').dy, -1);
    assert.strictEqual(transitionPart('slide-up', 0.5, 'out').dy ?? 0, 0); // a slide leaves the old clip in place
    assert.strictEqual(transitionPart('push-down', 1, 'out').dy, 1); // a push carries it out
    assert.strictEqual(transitionPart('push-right', 1, 'out').dx, 1);
    assert.deepStrictEqual(transitionPart('wipe-left', 0.25, 'in').reveal, { l: 0.75, t: 0, r: 0, b: 0 });
    assert.deepStrictEqual(transitionPart('wipe-down', 0.25, 'in').reveal, { l: 0, t: 0, r: 0, b: 0.75 });
  });

  t('flash cuts under a white peak; whip blurs through the middle; spin turns', () => {
    approx(transitionPart('flash', 0.5, 'in').flash, 1);
    assert.strictEqual(transitionPart('flash', 0.49, 'in').op, 0);
    assert.strictEqual(transitionPart('flash', 0.49, 'out').op, 1);
    assert.strictEqual(transitionPart('flash', 0.51, 'in').op, 1);
    assert.strictEqual(transitionPart('flash', 0.51, 'out').op, 0);
    assert.ok(transitionPart('whip', 0.5, 'in').blur > 30);
    approx(transitionPart('whip', 0.5, 'in').dx, 0.5);
    assert.ok(transitionPart('spin', 0.5, 'out').rot > 0 && transitionPart('spin', 0.5, 'in').rot < 0);
  });

  // ── Clip animations ──────────────────────────────────────────────────────
  t('every in / out animation settles on the clip exactly as placed', () => {
    for (const { value } of TEXT_ANIMS) {
      const c = textClip({ start: 2, duration: 4, animIn: value, animOut: value });
      const mid = textAnim(c, 4);
      assert.deepStrictEqual([mid.opacity, mid.dxFrac, mid.dyFrac, mid.scale, mid.blur].map(z), [1, 0, 0, 1, 0], value);
      assert.ok(Math.abs(mid.rotate) < 1e-9, value);
    }
    assert.ok(!CLIP_ANIMS.some((a) => a.value === 'typewriter' || a.value === 'cascade') && CLIP_ANIMS.length === TEXT_ANIMS.length - 2);
  });

  t('fly comes in from off-screen; stomp lands from oversized; custom lengths are honoured', () => {
    const fly = textClip({ start: 0, duration: 4, animIn: 'fly-left' });
    assert.ok(textAnim(fly, 0).dxFrac < -1, 'starts past the left edge');
    assert.strictEqual(textAnim(fly, 0).opacity, 1);
    assert.ok(textAnim(textClip({ start: 0, duration: 4, animOut: 'fly-bottom' }), 4).dyFrac > 1, 'leaves through the bottom');
    assert.ok(textAnim(textClip({ start: 0, duration: 4, animIn: 'stomp' }), 0).scale > 2);
    const slow = textClip({ start: 0, duration: 6, animIn: 'fade', animInDur: 2 });
    approx(textAnim(slow, 1).opacity, 0.5);
    approx(textAnim(textClip({ start: 0, duration: 6, animIn: 'fade' }), 0.25).opacity, 0.5); // 0.5s default
  });

  t('motion: slow zoom grows over the clip; pans on footage scale up enough to hide the edges', () => {
    const zoom = mediaClip({ duration: 10, motion: 'zoom-in' });
    approx(textAnim(zoom, 0).scale, 1);
    approx(textAnim(zoom, 10).scale, 1.12);
    approx(textAnim(mediaClip({ duration: 10, motion: 'zoom-in', motionAmount: 0.5 }), 10).scale, 1.06);
    approx(textAnim(mediaClip({ duration: 10, motion: 'zoom-out' }), 10).scale, 1);
    for (const motion of ['pan-left', 'pan-right', 'pan-up', 'pan-down', 'shake']) {
      for (const amount of [0.5, 1, 3]) {
        const c = mediaClip({ duration: 8, motion, motionAmount: amount });
        for (let time = 0; time <= 8; time += 0.05) {
          const a = textAnim(c, time);
          const room = (a.scale - 1) / 2;
          assert.ok(Math.abs(a.dxFrac) <= room + 1e-9 && Math.abs(a.dyFrac) <= room + 1e-9, `${motion} ×${amount} uncovers an edge at ${time}`);
        }
      }
    }
    // Overlays drift without growing.
    assert.strictEqual(textAnim(textClip({ start: 0, duration: 4, motion: 'pan-left' }), 1).scale, 1);
    assert.ok(MOTIONS.every((m) => m.value === 'none' || hasClipAnim(mediaClip({ motion: m.value }))));
  });

  t('the compositor folds a clip\'s animation into its layer, with a transition on top', () => {
    const tracks = [V1];
    const plain = activeVisualLayers([mediaClip({ id: 'a', duration: 4 })], tracks, 1)[0];
    assert.deepStrictEqual([plain.opacity, plain.dx, plain.scale, plain.dy ?? 0, plain.rot ?? 0], [1, 0, 1, 0, 0]);
    const faded = activeVisualLayers([mediaClip({ id: 'a', duration: 4, animIn: 'fade' })], tracks, 0.25)[0];
    approx(faded.opacity, 0.5);
    const flying = activeVisualLayers([mediaClip({ id: 'a', duration: 4, animOut: 'fly-top', animOutDur: 1 })], tracks, 3.999)[0];
    assert.ok(flying.dy < -1);
    // Crossfade into a clip that also zooms in: both apply.
    const clips = [mediaClip({ id: 'a', duration: 4 }), mediaClip({ id: 'b', start: 4, duration: 4, transition: 'fade', transitionDur: 1, motion: 'zoom-in' })];
    const [out, inc] = activeVisualLayers(clips, tracks, 4.5);
    approx(out.opacity, 0.5);
    approx(inc.opacity, 0.5);
    approx(inc.scale, 1 + 0.12 * (0.5 / 4));
  });

  t('splitting a clip keeps its entrance on the first piece and its exit on the last', () => {
    const c = mediaClip({ duration: 10, animIn: 'pop', animOut: 'fade', motion: 'zoom-in' });
    const left = sliceClip(c, 0, 4, { keepId: true });
    const right = sliceClip(c, 4, 10);
    assert.deepStrictEqual([left.animIn, left.animOut, right.animIn, right.animOut], ['pop', undefined, undefined, 'fade']);
    assert.strictEqual(right.motion, 'zoom-in');
  });

  // ── Title cards, stingers, transitions on every cut ──────────────────────
  const wide = { width: 1920, height: 1080 };
  const tall = { width: 1080, height: 1920 };

  t('fitText breaks lines to the frame and shrinks type that still will not fit', () => {
    const short = fitText('Day One', 120, 'Arial, sans-serif', true, wide);
    assert.deepStrictEqual([short.text, short.fontSize, short.lines], ['Day One', 120, 1]);
    const long = fitText('How I rebuilt my entire editing workflow in a single weekend', 120, 'Arial, sans-serif', true, tall);
    assert.ok(long.lines > 1 && long.lines <= 3, `lines ${long.lines}`);
    assert.ok(long.fontSize < 120, 'shrunk to fit a vertical frame');
    assert.strictEqual(long.text.replace(/\n/g, ' '), 'How I rebuilt my entire editing workflow in a single weekend');
    // A pixel font is twice as wide per letter, so it gets smaller type than a condensed one.
    const pixel = fitText('GAME OVER PLAYER ONE', 100, '"Press Start 2P", monospace', false, tall, { maxLines: 2 });
    const narrow = fitText('GAME OVER PLAYER ONE', 100, 'Impact, sans-serif', false, tall, { maxLines: 2 });
    assert.ok(pixel.fontSize < narrow.fontSize);
  });

  t('readableOn keeps a colour that reads and swaps one that does not', () => {
    assert.strictEqual(readableOn('#ffffff', '#000000'), '#ffffff');
    assert.strictEqual(readableOn('#ffffff', '#fff7ed'), '#111111');
    assert.strictEqual(readableOn('#111111', '#05060f'), '#ffffff');
  });

  t('a title card is a full-frame background with its text stacked and centred on top', () => {
    for (const { value: look } of CARD_LOOKS) {
      for (const canvas of [wide, tall]) {
        const { clips, background, title } = buildCard({ title: 'The Long Road Home', subtitle: 'A film about going back', kicker: 'Chapter 2', start: 10, duration: 3, look, canvas, trackId: 't1' });
        const bg = clips[0];
        assert.strictEqual(bg.id, background);
        assert.ok(bg.type === 'shape' && bg.w >= 1 && bg.h >= 1 && bg.start === 10 && bg.duration === 3, `${look} background`);
        const texts = clips.filter((c) => c.type === 'text');
        assert.strictEqual(texts.length, 3, `${look}: kicker, title, subtitle`);
        assert.ok(texts.some((c) => c.id === title));
        for (const c of clips.slice(1)) {
          assert.ok(c.start > bg.start, `${look}: drawn after the background`);
          approx(c.start + c.duration, 13, 1e-9);
          assert.ok(c.y > 0.08 && c.y < 0.92, `${look}: inside the frame (${c.y})`);
        }
        const ys = texts.map((c) => c.y);
        assert.deepStrictEqual([...ys].sort((a, b) => a - b), ys, `${look}: kicker above title above subtitle`);
        approx((ys[0] + ys[2]) / 2, 0.5, 0.08);
        // Bare type must contrast with the card.
        const tc = texts.find((c) => c.id === title);
        assert.strictEqual(readableOn(tc.color, bg.fill), tc.color, `${look}: title colour reads on its background`);
      }
    }
  });

  t('a card takes its type from the caller, and letter-spaces the cinematic look', () => {
    const { clips, title } = buildCard({ title: 'Home', start: 0, duration: 3, look: 'cinematic', canvas: wide, trackId: 't1' });
    assert.strictEqual(clips.find((c) => c.id === title).text, 'H\u2009O\u2009M\u2009E');
    const styled = buildCard({ title: 'Home', start: 0, duration: 3, look: 'clean', canvas: wide, trackId: 't1', background: '#ffd53d', text: { fontFamily: 'Impact, sans-serif', color: '#ffffff', outlineWidth: 8, animIn: 'stomp' } });
    const tc = styled.clips.find((c) => c.id === styled.title);
    assert.deepStrictEqual([tc.fontFamily, tc.color, tc.outlineWidth, tc.animIn], ['Impact, sans-serif', '#ffffff', 8, 'stomp']); // outlined white stays white on yellow
    assert.strictEqual(styled.clips[0].fill, '#ffd53d');
  });

  t('insertGap splits what plays through the point, slides the rest, leaves kept and locked tracks', () => {
    const tracks = [V1, T1, A1, { id: 'a2', kind: 'audio', name: 'A2', locked: true }];
    const clips = [
      mediaClip({ id: 'a', duration: 10 }),
      mediaClip({ id: 'b', start: 10, duration: 5, inPoint: 10, sourceDuration: 20 }),
      textClip({ id: 'cap', start: 5, duration: 2 }),
      mediaClip({ id: 'music', trackId: 'a1', duration: 15, sourceDuration: 60 }),
      mediaClip({ id: 'vo', trackId: 'a2', duration: 15, sourceDuration: 60 }),
    ];
    const out = insertGap(clips, tracks, 6, 3, new Set(['a1']));
    const by = (id) => out.find((c) => c.id === id);
    approx(by('a').duration, 6);
    const rest = out.find((c) => c.trackId === 'v1' && c.id !== 'a' && c.id !== 'b');
    assert.deepStrictEqual([rest.start, rest.duration, rest.inPoint], [9, 4, 6]);
    approx(by('b').start, 13);
    // The caption straddles the point too: split, second half after the gap.
    approx(by('cap').duration, 1);
    assert.ok(out.some((c) => c.type === 'text' && c.id !== 'cap' && c.start === 9 && c.duration === 1));
    assert.deepStrictEqual([by('music').start, by('music').duration], [0, 15]);
    assert.deepStrictEqual([by('vo').start, by('vo').duration], [0, 15]);
    approx(timelineDuration(out), 18);
  });

  t('a stinger covers the frame at the cut and is gone either side of it', () => {
    const { clips, start, end } = buildStinger({ at: 10, direction: 'right', colors: ['#111111', '#ff0055'], canvas: wide, trackId: 't1' });
    const panels = clips.filter((c) => c.type === 'shape');
    assert.strictEqual(panels.length, 2);
    approx(resolvedValue(panels[0], 'x', 10, 0.5), 0.5, 1e-9); // first panel dead centre on the cut
    assert.ok(resolvedValue(panels[0], 'x', start, 0.5) < -0.5, 'starts off the left edge');
    assert.ok(resolvedValue(panels[1], 'x', end, 0.5) > 1.5, 'ends off the right edge');
    assert.ok(panels[1].start > panels[0].start, 'second panel trails, drawn on top');
    // With a label the frame holds, and the words sit inside the hold.
    const held = buildStinger({ at: 10, direction: 'up', colors: ['#111111', '#ffd53d'], label: 'Three hours later', canvas: tall, trackId: 't1' });
    const label = held.clips.find((c) => c.type === 'text');
    assert.ok(label && label.start < 10 && label.start + label.duration > 10, 'label is up across the cut');
    assert.strictEqual(label.color, '#111111'); // white would not read on the yellow top panel
    for (const p of held.clips.filter((c) => c.type === 'shape')) {
      if (p.start + 0.3 <= label.start + 1e-9) approx(resolvedValue(p, 'y', label.start, 0.5), 0.5, 1e-9);
    }
    assert.strictEqual(buildStinger({ at: 0.1, direction: 'left', colors: ['#000000'], canvas: wide, trackId: 't1' }).start, 0);
  });

  t('planTransitions: only where clips touch, capped by the shorter clip, cycling, skipping jump cuts', () => {
    const kinds = new Map([['m1', 'video'], ['m2', 'video'], ['song', 'audio']]);
    const clips = [
      mediaClip({ id: 'a', duration: 10, mediaId: 'm1', sourceDuration: 30 }),
      mediaClip({ id: 'b', start: 10, duration: 0.8, mediaId: 'm1', inPoint: 10.5, sourceDuration: 30 }), // jump cut: same take, 0.5s later
      mediaClip({ id: 'c', start: 10.8, duration: 6, mediaId: 'm2', sourceDuration: 30 }),
      mediaClip({ id: 'd', start: 20, duration: 5, mediaId: 'm2', sourceDuration: 30 }), // gap before it
      mediaClip({ id: 'song', trackId: 'a1', duration: 25, mediaId: 'song', sourceDuration: 60 }),
    ];
    const all = planTransitions(clips, [V1, A1], kinds, { types: ['fade', 'whip'], duration: 1 });
    const by = (r, id) => r.clips.find((c) => c.id === id);
    assert.deepStrictEqual([all.cuts, all.changed, all.jumpCuts], [2, 2, 0]);
    assert.deepStrictEqual([by(all, 'b').transition, by(all, 'c').transition, by(all, 'd').transition], ['fade', 'whip', 'none']);
    approx(by(all, 'b').transitionDur, 0.36); // 45% of the 0.8s clip
    approx(by(all, 'c').transitionDur, 0.36);
    const scenes = planTransitions(clips, [V1, A1], kinds, { types: ['dip'], duration: 0.3, skipJumpCuts: true });
    assert.deepStrictEqual([scenes.changed, scenes.jumpCuts, by(scenes, 'b').transition, by(scenes, 'c').transition], [1, 1, 'none', 'dip']);
    const cleared = planTransitions(all.clips, [V1, A1], kinds, { types: ['none'], duration: 0.5 });
    assert.ok(cleared.clips.every((c) => c.transition === 'none'));
  });

  // ── Reference analysis ───────────────────────────────────────────────────
  // A tiny "frame": one flat colour with a little per-pixel variation.
  const frame = (r, g, b, jitter = 6, seed = 1) => {
    const px = new Uint8ClampedArray(16 * 9 * 4);
    let s = seed;
    for (let i = 0; i < px.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const j = (s % (jitter * 2 + 1)) - jitter;
      px[i] = r + j;
      px[i + 1] = g + j;
      px[i + 2] = b + j;
      px[i + 3] = 255;
    }
    return frameStats(px);
  };

  t('frameStats measures tone; identical frames are 0 apart, different scenes far apart', () => {
    const grey = frame(128, 128, 128, 0);
    approx(grey.luma, 128 / 255, 1e-6);
    assert.ok(grey.spread < 1e-6 && grey.saturation === 0 && grey.warmth === 0);
    const orange = frame(230, 130, 40, 0);
    assert.ok(orange.saturation > 0.8 && orange.warmth > 0.6);
    assert.ok(frame(40, 130, 230, 0).warmth < -0.6);
    assert.strictEqual(frameDistance(grey, frame(128, 128, 128, 0)), 0);
    assert.strictEqual(frameDistance(grey, orange), 1);
  });

  t('detectCuts finds scene changes and ignores movement inside a shot', () => {
    const fps = 5;
    const stats = [];
    // 4s red, 2s blue, 6s green that flickers between two close shades (a shaky shot).
    for (let i = 0; i < 20; i++) stats.push(frame(200, 30, 30, 6, i + 1));
    for (let i = 0; i < 10; i++) stats.push(frame(30, 30, 200, 6, i + 50));
    for (let i = 0; i < 30; i++) stats.push(i % 2 ? frame(40, 190, 40, 30, i + 90) : frame(60, 196, 60, 30, i + 90));
    const times = stats.map((_, i) => i / fps);
    assert.deepStrictEqual(detectCuts(stats, times), [4, 6]);
    const p = buildProfile({ duration: 12, width: 1080, height: 1920, stats, times, soundCoverage: 0.97 });
    assert.deepStrictEqual([p.shots, p.aspect, p.cuts], [3, '9:16', [4, 6]]);
    approx(p.analysed, 12);
    approx(p.cutsPerMinute, 10);
    approx(p.medianShot, 4);
    assert.deepStrictEqual([p.shortestShot, p.longestShot, p.pace], [2, 6, 'medium']);
  });

  t('black dips are counted between scenes, not at the head and tail', () => {
    const lit = frame(120, 120, 120);
    const black = frame(2, 2, 2, 1);
    assert.strictEqual(countBlackDips([black, black, lit, lit, black, lit, lit, black, black, lit, black]), 2);
    assert.strictEqual(countBlackDips([lit, lit, lit]), 0);
    approx(averageTone([lit, black, black]).brightness, lit.luma, 1e-9); // black frames don't drag the average
  });

  t('the suggested style follows the measured pace, and grades towards the reference', () => {
    assert.deepStrictEqual(nearestAspect(1920, 1080), '16:9');
    assert.deepStrictEqual(nearestAspect(1080, 1350), '4:5');
    assert.deepStrictEqual(nearestAspect(720, 720), '1:1');
    const ref = { brightness: 0.5, contrast: 0.24, saturation: 0.45, warmth: 0.1 };
    const own = { brightness: 0.4, contrast: 0.2, saturation: 0.3, warmth: 0 };
    assert.deepStrictEqual(gradeTowards(ref, own), { brightness: 125, contrast: 120, saturation: 150 });
    assert.deepStrictEqual(gradeTowards(ref, { ...ref, contrast: 0.235 }), {}); // within an eye's tolerance
    assert.strictEqual(gradeTowards({ ...ref, saturation: 0.9 }, { ...own, saturation: 0.1 }).saturation, 170); // held to a sane range
    const base = { duration: 60, analysed: 60, width: 1080, height: 1920, aspect: '9:16', shots: 40, cutsPerMinute: 39, averageShot: 1.5, shortestShot: 0.4, longestShot: 5, blackDips: 0, tone: ref, soundCoverage: 1, cuts: [] };
    const fast = suggestStyle({ ...base, medianShot: 1.2, pace: 'very fast' }, own);
    assert.deepStrictEqual(fast.pacing, { min_pause: 0.3, zoom: true, shot_seconds: 1.2 });
    assert.deepStrictEqual([fast.transition, fast.motion.every, fast.grade.saturation], [{ type: 'none' }, 'alternate', 150]);
    const slow = suggestStyle({ ...base, medianShot: 9, pace: 'slow', blackDips: 4 }, null);
    assert.deepStrictEqual([slow.pacing.zoom, slow.transition.type, slow.motion.every, slow.grade], [false, 'dip', 'all', undefined]);
  });

  t('frames to look at come from the long shots, spread across the video; sound coverage reads the envelope', () => {
    assert.deepStrictEqual(frameTimes([4, 6], 12, 3), [2, 5, 9]);
    const many = frameTimes(Array.from({ length: 59 }, (_, i) => i + 1), 60, 6);
    assert.strictEqual(many.length, 6);
    many.forEach((time, k) => assert.ok(time >= k * 10 && time < (k + 1) * 10, `frame ${k} at ${time}`));
    assert.strictEqual(frameTimes([], 30, 4).length, 4); // one long take is still covered
    assert.strictEqual(soundCoverage(new Float32Array(0)), null);
    approx(soundCoverage(Float32Array.from([-20, -18, -70, -90])), 0.5);
  });

  // ── Edit styles + the agent tools ────────────────────────────────────────
  const sig = new AbortController().signal;
  const call = (tool, args = {}) => runAgentTool({ rid: 1, tool, args, client: 'test' }, () => {}, sig);
  const clip = (id) => useTimelineStore.getState().clips.find((c) => c.id === id);
  const caption = (over) => textClip({ role: 'caption', words: [{ start: 0, end: 0.5, text: 'hello' }, { start: 0.5, end: 1, text: ' there' }], text: 'hello there', ...over });
  const reset = () => {
    useStyleStore.setState({ custom: [], activeId: null, brief: '', reference: null });
    useMediaStore.setState({
      media: [
        { id: 'm1', name: 'talk.mp4', kind: 'video', filePath: 'C:/v/talk.mp4', sizeBytes: 1, mediaUrl: 'x' },
        { id: 'm2', name: 'broll.mp4', kind: 'video', filePath: 'C:/v/broll.mp4', sizeBytes: 1, mediaUrl: 'y' },
        { id: 'song', name: 'song.mp3', kind: 'audio', filePath: 'C:/v/song.mp3', sizeBytes: 1, mediaUrl: 'z' },
      ],
    });
    useTimelineStore.setState({
      tracks: [V1, T1, A1],
      canvas: { width: 1920, height: 1080 },
      clips: [
        mediaClip({ id: 'a', duration: 10, mediaId: 'm1', sourceDuration: 30 }),
        mediaClip({ id: 'b', start: 10, duration: 5, mediaId: 'm1', inPoint: 10.4, sourceDuration: 30 }),
        mediaClip({ id: 'c', start: 15, duration: 5, mediaId: 'm2', sourceDuration: 30 }),
        caption({ id: 'cap1', start: 1, duration: 2 }),
        caption({ id: 'cap2', start: 11, duration: 2 }),
        textClip({ id: 'title', start: 0, duration: 3, text: 'Day 1', fontSize: 120, y: 0.3 }),
        textClip({ id: 'fire', start: 4, duration: 1, text: '🔥', fontSize: 160 }),
        mediaClip({ id: 'music', trackId: 'a1', duration: 20, mediaId: 'song', sourceDuration: 60 }),
      ],
      selectedIds: [],
      playhead: 0,
      past: [],
      future: [],
    });
  };

  await ta('every tool has a handler, and the schemas offer exactly the looks and parts the editor has', async () => {
    assert.deepStrictEqual([...AGENT_TOOL_NAMES].sort(), TOOLS.map((x) => x.name).sort());
    const tool = (name) => TOOLS.find((x) => x.name === name);
    assert.deepStrictEqual(tool('add_title_card').input.shape.look.unwrap().options, CARD_LOOKS.map((l) => l.value));
    assert.deepStrictEqual(tool('apply_style').input.shape.parts.unwrap().element.options, [...STYLE_PARTS]);
  });

  await ta('every built-in style applies cleanly (its fonts, transitions, effects and motions all exist)', async () => {
    assert.strictEqual(new Set(BUILTIN_STYLES.map((s) => s.id)).size, BUILTIN_STYLES.length);
    for (const s of BUILTIN_STYLES) {
      reset();
      const r = await call('apply_style', { style: s.id });
      assert.ok(r.ok, `${s.id}: ${r.text}`);
      assert.strictEqual(useTimelineStore.getState().past.length, 1, `${s.id}: one undo step`);
      assert.strictEqual(useStyleStore.getState().activeId, s.id);
      // And each one can dress a title card.
      const card = await call('add_title_card', { title: 'A fairly long title for the intro card', subtitle: 'and a subtitle' });
      assert.ok(card.ok, `${s.id} card: ${card.text}`);
    }
    assert.strictEqual(styleId('Viral short'), 'my-viral-short'); // a saved style can't shadow a built-in
    assert.strictEqual(styleId('  My Brand — Look! '), 'my-brand-look');
  });

  await ta('apply_style restyles captions and titles, grades, moves and transitions the footage in one undo step', async () => {
    reset();
    const r = await call('apply_style', { style: 'Viral short' });
    assert.ok(r.ok, r.text);
    assert.match(r.text, /2 captions restyled/);
    assert.match(r.text, /auto_edit now defaults to preset talking, min_pause 0\.35, zoom on/);
    assert.match(r.text, /Notes: Open on the hook/);
    const cap = clip('cap1');
    assert.deepStrictEqual([cap.fontFamily, cap.fontSize, cap.karaoke, cap.karaokeColor, cap.text, cap.words[1].text], ['Impact, sans-serif', 84, 'pop', '#ffd53d', 'HELLO THERE', ' THERE']);
    assert.strictEqual(clip('title').fontFamily, 'Impact, sans-serif');
    assert.strictEqual(clip('title').animIn, 'stomp');
    assert.strictEqual(clip('title').fontSize, 120, 'size and position are the title\'s own');
    assert.strictEqual(clip('fire').fontFamily, 'Inter', 'stickers are left alone');
    assert.deepStrictEqual([clip('a').contrast, clip('a').saturation, clip('c').saturation], [108, 116, 116]);
    assert.deepStrictEqual([clip('a').motion, clip('b').motion, clip('c').motion], ['none', 'zoom-in', 'none']); // every other clip
    assert.strictEqual(clip('music').saturation, 100, 'audio is not graded');
    assert.strictEqual(useTimelineStore.getState().past.length, 1);
    useTimelineStore.getState().undo();
    assert.strictEqual(clip('cap1').text, 'hello there');

    // A style with a transition dresses scene changes and leaves the jump cut inside the take alone.
    const cine = await call('apply_style', { style: 'cinematic', parts: ['transitions', 'grade'] });
    assert.match(cine.text, /fade on 1 of 2 cuts \(1 jump cut inside a take left clean\)/);
    assert.deepStrictEqual([clip('b').transition, clip('c').transition, clip('c').transitionDur], ['none', 'fade', 0.8]);
    assert.deepStrictEqual([clip('a').brightness, clip('a').vignette, clip('a').saturation], [96, 0.35, 86]);
    assert.strictEqual(clip('cap1').fontFamily, 'Inter', 'parts limits what is touched');
    // Switching to a graded style without an effect clears the old one.
    await call('apply_style', { style: 'retro-vhs', parts: ['grade'] });
    assert.strictEqual(clip('a').effect, 'vhs');
    await call('apply_style', { style: 'cinematic', parts: ['grade'] });
    assert.strictEqual(clip('a').effect, 'none');
    const bad = await call('apply_style', { style: 'nope' });
    assert.ok(!bad.ok && /viral-short/.test(bad.text), bad.text);
  });

  await ta('get_project and list_styles carry the active style, the brief and the reference', async () => {
    reset();
    let p = JSON.parse((await call('get_project')).text);
    assert.ok(!('style' in p) && !('brief' in p) && !('reference_video' in p));
    useStyleStore.getState().setActive('podcast-clip');
    useStyleStore.getState().setBrief('Brand purple is #a855f7. Never use the glitch effect.');
    useStyleStore.getState().setReference('C:/refs/target.mp4');
    p = JSON.parse((await call('get_project')).text);
    assert.deepStrictEqual([p.style.id, p.style.captions.karaoke, p.brief, p.reference_video], ['podcast-clip', 'box', 'Brand purple is #a855f7. Never use the glitch effect.', 'C:/refs/target.mp4']);
    const l = JSON.parse((await call('list_styles')).text);
    assert.deepStrictEqual([l.active, l.reference_video], ['podcast-clip', 'C:/refs/target.mp4']);
    assert.ok(l.styles.length === BUILTIN_STYLES.length && l.styles.every((s) => s.builtin));
    const o = JSON.parse((await call('list_options')).text);
    assert.ok(o.clip_animations.includes('fly-left') && !o.clip_animations.includes('typewriter') && o.motions.includes('zoom-in') && o.card_looks.includes('neon') && o.styles.includes('cinematic') && o.transitions.includes('whip'));
  });

  await ta('save_style keeps a named look, captures the project\'s own, and refuses names the editor lacks', async () => {
    reset();
    await call('update_clip', { track_id: 'v1', contrast: 115, effect: 'grain' });
    await call('add_transitions', { transition: 'wipe', duration: 0.4 });
    const r = await call('save_style', { name: 'My Brand', description: 'house look', from_project: true, captions: { font: 'Georgia', color: '#00ff88', uppercase: true }, pacing: { shot_seconds: 2, zoom: true }, notes: 'Logo sting at the end.' });
    assert.ok(r.ok, r.text);
    assert.match(r.text, /Saved style "My Brand" \(id my-brand\)/);
    const s = useStyleStore.getState();
    assert.strictEqual(s.activeId, 'my-brand');
    const st = s.custom[0];
    assert.deepStrictEqual(st.captions, { font: 'Georgia', color: '#00ff88', uppercase: true }); // what was passed wins over the project's
    assert.deepStrictEqual([st.titles.font_size, st.transition, st.grade, st.pacing, st.notes], [120, { type: 'wipe', duration: 0.4 }, { contrast: 115, effect: 'grain' }, { zoom: true, shot_seconds: 2 }, 'Logo sting at the end.']);
    assert.match((await call('save_style', { name: 'my brand', notes: 'v2' })).text, /Updated/);
    assert.strictEqual(useStyleStore.getState().custom.length, 1);
    assert.strictEqual(useStyleStore.getState().custom[0].description, 'house look');
    const font = await call('save_style', { name: 'x', captions: { font: 'Helvetica Neue' } });
    assert.ok(!font.ok && /Unknown font/.test(font.text), font.text);
    const trans = await call('save_style', { name: 'x', transition: { type: 'star-wipe' } });
    assert.ok(!trans.ok && /Unknown transition/.test(trans.text), trans.text);
    assert.ok(!(await call('save_style', { name: 'empty' })).ok);
    // Removing the active style clears the selection.
    useStyleStore.getState().remove('my-brand');
    assert.strictEqual(useStyleStore.getState().activeId, null);
  });

  await ta('animate_clip sets entrances, exits and motion on footage and overlays alike', async () => {
    reset();
    const r = await call('animate_clip', { clip_ids: ['c', 'title', 'music'], anim_in: 'Fly · left edge', anim_out: 'typewriter', motion: 'float', in_duration: 0.8, amount: 2 });
    assert.ok(r.ok, r.text);
    assert.match(r.text, /Animated 2 clips/);
    assert.match(r.text, /Typewriter is text only/);
    assert.match(r.text, /Skipped 1 audio clip/);
    assert.deepStrictEqual([clip('c').animIn, clip('c').animOut, clip('c').motion, clip('c').animInDur, clip('c').motionAmount], ['fly-left', 'fade', 'float', 0.8, 2]);
    assert.strictEqual(clip('title').animOut, 'typewriter');
    assert.strictEqual(clip('music').motion, undefined);
    assert.strictEqual(useTimelineStore.getState().past.length, 1);
    const p = JSON.parse((await call('get_project')).text);
    assert.deepStrictEqual([p.clips.find((x) => x.id === 'c').anim, p.clips.find((x) => x.id === 'c').motion], [['fly-left', 'fade'], 'float']);
    assert.match((await call('animate_clip', { clip_id: 'c', motion: 'none' })).text, /motion none/);
    const bad = await call('animate_clip', { clip_id: 'c', motion: 'orbit' });
    assert.ok(!bad.ok && /Unknown motion/.test(bad.text));
    assert.ok(!(await call('animate_clip', { clip_id: 'c' })).ok);
    assert.ok(!(await call('animate_clip', { clip_id: 'music', anim_in: 'fade' })).ok);
  });

  await ta('add_transitions covers every cut, or only the scene changes', async () => {
    reset();
    const r = await call('add_transitions', { transition: ['Crossfade', 'whip'], duration: 0.6 });
    assert.ok(r.ok, r.text);
    assert.deepStrictEqual([clip('a').transition, clip('b').transition, clip('c').transition, clip('c').transitionDur], ['none', 'fade', 'whip', 0.6]);
    useTimelineStore.getState().undo();
    const s = await call('add_transitions', { transition: 'flash', skip_jump_cuts: true });
    assert.match(s.text, /1 of 2 cuts; 1 jump cut/);
    assert.deepStrictEqual([clip('b').transition, clip('c').transition], ['none', 'flash']);
    assert.ok(!(await call('add_transitions', { transition: 'fade', track_id: 'a1' })).ok);
    assert.ok(!(await call('add_transitions', { transition: 'star-wipe' })).ok);
  });

  await ta('add_title_card inserts a card and moves the edit along, or lays one over it', async () => {
    reset();
    const r = await call('add_title_card', { title: 'Part Two', kicker: 'Chapter 2', subtitle: 'Where it gets hard', at: 12, duration: 4, look: 'cinematic', keep_playing_track_ids: ['a1'] });
    assert.ok(r.ok, r.text);
    const s = useTimelineStore.getState();
    assert.strictEqual(s.past.length, 1, 'one undo step');
    approx(timelineDuration(s.clips), 24);
    approx(clip('b').duration, 2); // split at 12
    approx(clip('c').start, 19);
    approx(clip('cap2').duration, 1); // the caption playing through 12 is split too
    assert.deepStrictEqual([clip('music').start, clip('music').duration], [0, 20]); // the music plays on under the card
    const bg = s.clips.find((c) => c.type === 'shape' && c.w >= 1);
    assert.deepStrictEqual([bg.start, bg.duration, bg.fill], [12, 4, '#000000']);
    assert.ok(s.clips.some((c) => c.type === 'text' && c.text === 'P\u2009A\u2009R\u2009T\u2009 \u2009T\u2009W\u2009O'));
    assert.ok(!s.clips.some((c) => c.type === 'media' && c.trackId === 'v1' && c.start < 16 - 1e-6 && c.start + c.duration > 12 + 1e-6), 'no footage under an inserted card');
    s.undo();
    approx(timelineDuration(useTimelineStore.getState().clips), 20);

    // Overlay: nothing moves, the card fades over the footage.
    const o = await call('add_title_card', { title: 'Subscribe', at: 16, mode: 'overlay', background: '#000000', background_opacity: 0.6 });
    assert.match(o.text, /nothing moved/);
    approx(timelineDuration(useTimelineStore.getState().clips), 20);
    const over = useTimelineStore.getState().clips.find((c) => c.type === 'shape');
    assert.deepStrictEqual([over.opacity, over.fadeIn, over.start], [0.6, 0.25, 16]);

    // The active style dresses a card unless a different design is asked for.
    reset();
    useStyleStore.getState().setActive('viral-short');
    await call('add_title_card', { title: 'big news' });
    let st = useTimelineStore.getState();
    assert.strictEqual(st.clips.find((c) => c.type === 'shape').fill, '#ffd53d');
    assert.ok(st.clips.some((c) => c.type === 'text' && c.text === 'BIG NEWS' && c.fontFamily === 'Impact, sans-serif' && c.animIn === 'stomp'));
    approx(clip('a').start, 3); // default: a 3s intro at 0
    reset();
    useStyleStore.getState().setActive('viral-short');
    await call('add_title_card', { title: 'big news', look: 'minimal' });
    st = useTimelineStore.getState();
    assert.strictEqual(st.clips.find((c) => c.type === 'shape').fill, '#ffffff');
    assert.ok(st.clips.some((c) => c.type === 'text' && c.text === 'big news' && c.fontFamily === 'Arial, sans-serif'));
    // A style applied afterwards leaves card text as it was fitted.
    await call('apply_style', { style: 'cinematic', parts: ['titles'] });
    assert.ok(useTimelineStore.getState().clips.some((c) => c.type === 'text' && c.text === 'big news' && c.fontFamily === 'Arial, sans-serif'));
    assert.strictEqual(clip('title').fontFamily, 'Georgia, serif');
    assert.ok(!(await call('add_title_card', { title: 'x', look: 'vaporwave' })).ok);
  });

  await ta('add_stinger lays panels over a cut without moving anything, in the style\'s colours', async () => {
    reset();
    useTimelineStore.setState({ tracks: [V1, A1], clips: useTimelineStore.getState().clips.filter((c) => c.type === 'media') });
    useStyleStore.getState().setActive('gaming-hype');
    const r = await call('add_stinger', { at: 15, direction: 'up', label: 'Round 2' });
    assert.ok(r.ok, r.text);
    const s = useTimelineStore.getState();
    assert.strictEqual(s.past.length, 1);
    const tt = s.tracks.find((tr) => tr.kind === 'text');
    assert.ok(tt, 'a text track was made for it');
    const panels = s.clips.filter((c) => c.type === 'shape');
    assert.deepStrictEqual(panels.map((p) => p.fill), ['#05060f', '#22d3ee']);
    assert.ok(panels.every((p) => p.trackId === tt.id && p.keyframes.every((k) => k.prop === 'y')));
    assert.ok(s.clips.some((c) => c.type === 'text' && c.text === 'Round 2'));
    approx(clip('c').start, 15);
    approx(timelineDuration(s.clips), 20);
    assert.deepStrictEqual((await call('add_stinger', { at: 10, colors: ['#ff0000'] })).ok, true);
    assert.ok(!(await call('add_stinger', {})).ok);
  });

  useStyleStore.setState({ custom: [], activeId: null, brief: '', reference: null });
}
