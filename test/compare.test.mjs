// Before / after comparisons: the geometry that keeps the two pictures in
// register while the divider moves, and the timing of each mode.
import assert from 'node:assert';
import { CompareError, beyondDivider, clipLayout, coverCrop, planCompare, trackInFront, withKeyframes } from './.editor.mjs';

const video = (over = {}) => ({ mediaId: 'm1', still: false, at: 0, sourceDuration: 20, width: 1920, height: 1080, hasAudio: true, ...over });
const image = (over = {}) => ({ mediaId: 'i1', still: true, at: 0, sourceDuration: 0, width: 1600, height: 1200, hasAudio: false, ...over });
const WIDE = { width: 1920, height: 1080 };
const TALL = { width: 1080, height: 1920 };
const opts = (over = {}) => ({
  mode: 'wipe',
  axis: 'horizontal',
  framing: 'centered',
  start: 0,
  duration: 6,
  hold: 2,
  sweep: 1.2,
  canvas: WIDE,
  labels: { before: 'BEFORE', after: 'AFTER' },
  sound: 'after',
  line: '#ffffff',
  transition: 'flash',
  backTrack: 'v1',
  frontTrack: 'v2',
  soundTrack: 'a1',
  textTrack: 't1',
  ...over,
});

const byId = (plan, id) => plan.clips.find((c) => c.id === id);
const texts = (plan) => plan.clips.filter((c) => c.type === 'text');
const shapes = (plan) => plan.clips.filter((c) => c.type === 'shape');
const line = (plan) => shapes(plan).find((c) => c.shape === 'rect');
const live = (c, t) => t >= c.start - 1e-9 && t < c.start + c.duration;

/** Where a clip puts its picture at time t, and which part of the file it shows there. */
function drawn(clip, t, canvas) {
  const L = clipLayout(withKeyframes(clip, t), clip.sourceWidth, clip.sourceHeight, canvas.width, canvas.height);
  return {
    left: L.cx - L.dw / 2,
    right: L.cx + L.dw / 2,
    top: L.cy - L.dh / 2,
    bottom: L.cy + L.dh / 2,
    // The file's x (0..1) shown at canvas x, and likewise down.
    srcX: (x) => (L.sx + ((x - (L.cx - L.dw / 2)) / L.dw) * L.sw) / clip.sourceWidth,
    srcY: (y) => (L.sy + ((y - (L.cy - L.dh / 2)) / L.dh) * L.sh) / clip.sourceHeight,
  };
}

export async function run({ t, approx }) {
  console.log('before / after');

  t('compare: the crop that fills a shape from the middle of a picture', () => {
    assert.deepStrictEqual(coverCrop(1920, 1080, 16 / 9), { l: 0, r: 0, t: 0, b: 0 });
    const tall = coverCrop(1920, 1080, 9 / 16);
    approx(tall.l, (1 - 81 / 256) / 2, 1e-9);
    assert.ok(tall.l === tall.r && tall.t === 0 && tall.b === 0);
    const wide = coverCrop(1080, 1920, 16 / 9);
    approx(wide.t, (1 - 81 / 256) / 2, 1e-9);
    assert.ok(wide.t === wide.b && wide.l === 0);
    assert.deepStrictEqual(coverCrop(0, 0, 1), { l: 0, r: 0, t: 0, b: 0 });
    assert.deepStrictEqual(beyondDivider({ l: 0.1, r: 0.1, t: 0, b: 0 }, 0.5, 'horizontal'), { cropLeft: 0.5, cropRight: 0.1, cropTop: 0, cropBottom: 0, posX: 0.25, posY: 0 });
  });

  t('compare: while the divider moves, the after stays in register with the frame, either way and on any shape', () => {
    const cases = [
      { axis: 'horizontal', canvas: WIDE, after: video({ width: 1280, height: 720 }) },
      { axis: 'horizontal', canvas: TALL, after: video() }, // a wide file filling a tall frame: cropped hard already
      { axis: 'horizontal', canvas: WIDE, after: image() }, // 4:3 into 16:9: cropped top and bottom
      { axis: 'vertical', canvas: TALL, after: video() },
      { axis: 'vertical', canvas: WIDE, after: image({ width: 1000, height: 1000 }) },
    ];
    for (const mode of ['wipe', 'slider']) {
      for (const c of cases) {
        const plan = planCompare(video(), c.after, opts({ mode, axis: c.axis, canvas: c.canvas, duration: 8 }));
        const front = byId(plan, plan.after);
        const bar = line(plan);
        const { width: W, height: H } = c.canvas;
        // The same file drawn whole, filling the frame: what the after must agree with.
        const cover = coverCrop(front.sourceWidth, front.sourceHeight, W / H);
        const whole = drawn({ ...front, keyframes: [], cropLeft: cover.l, cropRight: cover.r, cropTop: cover.t, cropBottom: cover.b, posX: 0, posY: 0 }, 0, c.canvas);
        let moved = 0;
        for (let time = front.start; time < front.start + front.duration; time += 0.07) {
          if (!live(bar, time)) continue;
          const p = c.axis === 'horizontal' ? withKeyframes(bar, time).x : withKeyframes(bar, time).y;
          const d = drawn(front, time, c.canvas);
          const tag = `${mode} ${c.axis} ${W}x${H} t=${time.toFixed(2)} p=${p.toFixed(3)}`;
          // It covers exactly its side of the divider…
          if (c.axis === 'horizontal') {
            approx(d.left, p * W, 0.6);
            approx(d.right, W, 0.6);
            approx(d.top, 0, 0.6);
            approx(d.bottom, H, 0.6);
          } else {
            approx(d.top, p * H, 0.6);
            approx(d.bottom, H, 0.6);
            approx(d.left, 0, 0.6);
            approx(d.right, W, 0.6);
          }
          // …and shows there what the whole picture would show there.
          for (const f of [0.02, 0.5, 0.98]) {
            const x = c.axis === 'horizontal' ? p * W + f * (1 - p) * W : f * W;
            const y = c.axis === 'horizontal' ? f * H : p * H + f * (1 - p) * H;
            assert.ok(Math.abs(d.srcX(x) - whole.srcX(x)) < 1e-6 && Math.abs(d.srcY(y) - whole.srcY(y)) < 1e-6, tag);
          }
          const kept = withKeyframes(front, time);
          assert.ok(1 - kept.cropLeft - kept.cropRight >= 0.0119 && 1 - kept.cropTop - kept.cropBottom >= 0.0119, `${tag}: cropped to nothing`);
          moved = Math.max(moved, Math.abs(p - 0.5));
        }
        assert.ok(moved > 0.2, `${mode} ${c.axis}: the divider never went anywhere`);
      }
    }
  });

  t('compare: wipe shows the before alone, crosses once, and leaves the after', () => {
    const plan = planCompare(video({ mediaId: 'raw', at: 3 }), video({ mediaId: 'graded', at: 3 }), opts());
    const back = byId(plan, plan.before);
    const front = byId(plan, plan.after);
    assert.deepStrictEqual([plan.start, plan.end, plan.revealFrom], [0, 6, 2]);
    approx(plan.revealTo, 3.2, 1e-9);
    assert.deepStrictEqual([back.trackId, front.trackId], ['v1', 'v2']);
    // The after comes in when the wipe starts, at the same moment of its file as the before is showing.
    assert.deepStrictEqual([back.start, back.inPoint, front.start, front.inPoint], [0, 3, 2, 5]);
    approx(front.start + front.duration, 6, 1e-9);
    assert.ok(back.start + back.duration >= 3.2 && back.start + back.duration < 3.4);
    assert.ok(back.muted && front.muted);
    // Once across, the after is the plain full frame.
    const done = withKeyframes(front, 3.3);
    assert.deepStrictEqual([done.cropLeft, done.posX], [0, 0]);
    // The divider and its handle live for the sweep only.
    const bar = line(plan);
    assert.strictEqual(bar.start, 2);
    approx(bar.duration, 1.2, 1e-9);
    assert.ok(withKeyframes(bar, 2).x > 0.98 && withKeyframes(bar, 3.19).x < 0.01);
    assert.strictEqual(shapes(plan).filter((c) => c.shape === 'ellipse').length, 1);
    assert.deepStrictEqual(shapes(plan).filter((c) => c.shape === 'triangle').map((c) => c.rotation), [-90, 90]);
    // One label at a time.
    const [b, a] = texts(plan);
    assert.deepStrictEqual([b.text, b.start, b.duration], ['BEFORE', 0, 2]);
    assert.deepStrictEqual([a.text, a.start], ['AFTER', 3.2]);
    approx(a.start + a.duration, 6, 1e-9);
    // Sound: the after's, from the top, in step with its picture.
    const sound = plan.clips.filter((c) => c.trackId === 'a1');
    assert.strictEqual(sound.length, 1);
    assert.deepStrictEqual([sound[0].mediaId, sound[0].start, sound[0].inPoint, sound[0].duration, sound[0].muted], ['graded', 0, 3, 6, false]);
    assert.ok(plan.usedSound && plan.clips.every((c) => c.group === plan.group));
    // Asked for the other one, or none.
    assert.strictEqual(planCompare(video({ mediaId: 'raw' }), video(), opts({ sound: 'before' })).clips.find((c) => c.trackId === 'a1').mediaId, 'raw');
    assert.strictEqual(planCompare(video(), video(), opts({ sound: 'none' })).usedSound, false);
    assert.strictEqual(planCompare(video(), video(), opts({ labels: null })).clips.some((c) => c.type === 'text'), false);
  });

  t('compare: slider keeps both on screen, the labels ride their own side, and it ends on the after', () => {
    for (const axis of ['horizontal', 'vertical']) {
      const plan = planCompare(video(), video(), opts({ mode: 'slider', axis, duration: 8, hold: 0.6, sweep: 1.5 }));
      const front = byId(plan, plan.after);
      const back = byId(plan, plan.before);
      assert.deepStrictEqual([back.start, back.duration, front.start, front.duration], [0, 8, 0, 8]);
      const bar = line(plan);
      const [b, a] = texts(plan);
      const pos = (c, time) => (axis === 'horizontal' ? withKeyframes(c, time).x : withKeyframes(c, time).y);
      let lo = 1;
      let hi = 0;
      for (let time = 0; time < 8; time += 0.05) {
        const p = pos(bar, time);
        lo = Math.min(lo, p);
        hi = Math.max(hi, p);
        assert.ok(pos(b, time) < p && p < pos(a, time), `${axis} t=${time}`);
      }
      approx(lo, 0.2, 1e-6);
      approx(hi, 0.8, 1e-6);
      approx(pos(bar, 0.3), 0.5, 1e-9);
      approx(pos(bar, 7.99), 0.2, 0.01);
      if (axis === 'horizontal') assert.deepStrictEqual([b.anchor, a.anchor], ['right', 'left']);
      assert.strictEqual(shapes(plan).length, 4);
    }
    // On a vertical frame the type is smaller and the slider stops short of pushing a label out of it.
    const tall = planCompare(video(), video(), opts({ mode: 'slider', canvas: TALL, duration: 8, labels: { before: 'BEFORE', after: 'EDITED' } }));
    const [b, a] = texts(tall);
    assert.ok(b.fontSize < 40 && b.fontSize > 24, String(b.fontSize));
    const wide = (c) => ((c.text.length * 0.55 * c.fontSize + 2 * c.bgPadding) * (1920 / 1080)) / 1080;
    for (let time = 0; time < 8; time += 0.05) {
      assert.ok(withKeyframes(b, time).x - wide(b) >= 0, `before label leaves the frame at ${time}`);
      assert.ok(withKeyframes(a, time).x + wide(a) <= 1, `after label leaves the frame at ${time}`);
    }
    const p = (time) => withKeyframes(line(tall), time).x;
    assert.ok(p(7.99) > 0.2 && p(7.99) <= 0.4 && Math.max(...[1, 2, 3, 4, 5, 6, 7].map(p)) >= 0.6);
  });

  t('compare: split puts each in its own half, side by side or one above the other', () => {
    const wide = planCompare(video(), image(), opts({ mode: 'split' }));
    const b = drawn(byId(wide, wide.before), 1, WIDE);
    const a = drawn(byId(wide, wide.after), 1, WIDE);
    for (const [got, want] of [[b.left, 0], [b.right, 960], [a.left, 960], [a.right, 1920], [b.top, 0], [b.bottom, 1080], [a.top, 0], [a.bottom, 1080]]) approx(got, want, 0.01);
    // Each half is centred on its own picture.
    approx(b.srcX(480), 0.5, 1e-9);
    approx(a.srcX(1440), 0.5, 1e-9);
    assert.strictEqual(wide.clips.some((c) => c.type !== 'text' && c.keyframes.length > 0), false);
    assert.strictEqual(shapes(wide).length, 1); // a divider, no handle
    assert.deepStrictEqual(texts(wide).map((c) => c.x), [0.25, 0.75]);
    // An image runs as long as asked; with a 20 s video the pair still gets its 6 s.
    assert.strictEqual(wide.end, 6);

    const tall = planCompare(video(), video(), opts({ mode: 'split', axis: 'vertical', canvas: TALL }));
    const top = drawn(byId(tall, tall.before), 1, TALL);
    const low = drawn(byId(tall, tall.after), 1, TALL);
    for (const [got, want] of [[top.top, 0], [top.bottom, 960], [low.top, 960], [low.bottom, 1920], [top.left, 0], [top.right, 1080], [low.left, 0], [low.right, 1080]]) approx(got, want, 0.01);
    assert.ok(texts(tall)[0].y < 0.5 && texts(tall)[1].y > 0.5);

    // One frame cut in two: the after shows the right half of the same framing.
    const same = planCompare(video(), video(), opts({ mode: 'split', framing: 'same' }));
    const half = drawn(byId(same, same.after), 1, WIDE);
    approx(half.left, 960, 0.01);
    approx(half.srcX(960), 0.5, 1e-9);
    approx(drawn(byId(same, same.before), 1, WIDE).right, 1920, 0.01);
  });

  t('compare: cut plays one after the other on one track, each with its own sound', () => {
    const plan = planCompare(video({ mediaId: 'raw' }), video({ mediaId: 'edit', at: 4 }), opts({ mode: 'cut', hold: 0 }));
    const back = byId(plan, plan.before);
    const front = byId(plan, plan.after);
    assert.deepStrictEqual([back.trackId, front.trackId], ['v1', 'v1']);
    assert.deepStrictEqual([back.start, back.duration, front.start, front.duration, front.inPoint], [0, 3, 3, 3, 4]);
    assert.strictEqual(front.transition, 'flash');
    assert.strictEqual(shapes(plan).length, 0);
    const sound = plan.clips.filter((c) => c.trackId === 'a1');
    assert.deepStrictEqual(sound.map((c) => [c.mediaId, c.start, c.duration]), [['raw', 0, 3], ['edit', 3, 3]]);
    assert.ok(back.link && sound[0].link === back.link && front.link && sound[1].link === front.link && back.link !== front.link);
    assert.deepStrictEqual(texts(plan).map((c) => [c.text, c.start]), [['BEFORE', 0], ['AFTER', 3]]);
    assert.deepStrictEqual([plan.revealFrom, plan.revealTo], [3, 3]);
  });

  t('compare: short files shorten it and say so; images have no length to run out of', () => {
    // The after has 4 s left: the whole thing is 4 s.
    const plan = planCompare(video(), video({ sourceDuration: 9, at: 5 }), opts());
    approx(plan.end, 4, 1e-9);
    assert.ok(plan.notes.length === 1 && /4s long, not 6s/.test(plan.notes[0]), plan.notes[0]);
    const front = byId(plan, plan.after);
    assert.ok(front.inPoint + front.duration <= 9 + 1e-9);
    // The before has 1.5 s: the hold gives way, the sweep stays.
    const brief = planCompare(video({ sourceDuration: 1.5 }), video(), opts());
    const back = byId(brief, brief.before);
    assert.ok(back.duration <= 1.5 + 1e-9, String(back.duration));
    approx(brief.revealFrom, 0.3, 1e-9);
    approx(brief.revealTo, 1.5, 1e-9);
    // Two photos.
    const photos = planCompare(image(), image({ mediaId: 'i2' }), opts({ duration: 5 }));
    assert.strictEqual(photos.end, 5);
    assert.strictEqual(photos.usedSound, false);
    assert.deepStrictEqual([byId(photos, photos.before).inPoint, byId(photos, photos.after).inPoint], [0, 0]);
    assert.throws(() => planCompare(video({ sourceDuration: 3, at: 2.8 }), video(), opts()), CompareError);
    assert.throws(() => planCompare(video(), video({ sourceDuration: 0.2 }), opts()), CompareError);
  });

  t('compare: the after goes on a video track in front of the before', () => {
    const tracks = [
      { id: 'v1', kind: 'video', name: 'V1' },
      { id: 'a1', kind: 'audio', name: 'A1' },
      { id: 'v2', kind: 'video', name: 'V2' },
    ];
    assert.strictEqual(trackInFront(tracks, [], 'v1', 0, 5).track.id, 'v2');
    // Nothing in front of the front one: a new track, which goes in front.
    const made = trackInFront(tracks, [], 'v2', 0, 5);
    assert.strictEqual(made.tracks.length, 4);
    assert.deepStrictEqual([made.tracks[3].id, made.track.kind, made.track.name], [made.track.id, 'video', 'V3']);
    // Taken at that time: a new one too.
    const busy = [{ id: 'c', trackId: 'v2', start: 2, duration: 2 }];
    assert.strictEqual(trackInFront(tracks, busy, 'v1', 0, 5).tracks.length, 4);
    assert.strictEqual(trackInFront(tracks, busy, 'v1', 4, 9).track.id, 'v2');
  });
}
