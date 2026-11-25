// Product demo (src/editor/demo.ts): the camera planned from a recording's
// pointer track, the clip keyframes and click marks it becomes, and the click
// sound. Run from editor.test.mjs. The recorder's side (the helper that reads
// the pointer) needs a real desktop: it is checked live, not here.
import assert from 'node:assert';
import { DEMO, boxDecor, cameraAt, clickSound, clipClicks, clipKeys, fitShare, onCanvas, parsePointer, planCamera, pointerAt, reachAt, runAgentTool, settles, transformAt, useMediaStore, useTimelineStore, viewAt } from './.editor.mjs';

export async function run({ t, ta, approx, mediaClip, V1, T1, A1 }) {
  // A 30 s recording: two clicks close together top-left, one much later bottom-right.
  const track = parsePointer({
    v: 1,
    duration: 30,
    buttons: true,
    moves: [
      [0, 0.5, 0.5],
      [4.5, 0.2, 0.2],
      [6, 0.24, 0.22],
      [20, 0.85, 0.8],
    ],
    clicks: [
      [5, 0.2, 0.2, 0],
      [6.2, 0.24, 0.22, 0],
      [20.5, 0.85, 0.8, 0],
    ],
  });
  const events = track.clicks.map(([time, x, y]) => ({ t: time, x, y, click: true }));
  const frame = { scaleX: 1, scaleY: 1, posX: 0, posY: 0, fitW: 1, fitH: 1, zoom: 2 };
  const opts = { zoom: 2, hold: 1.6, view: viewAt(frame) };
  const keys = planCamera(track, events, opts);

  t('demo: a pointer track is read with care, and junk is not one', () => {
    assert.strictEqual(parsePointer(null), null);
    assert.strictEqual(parsePointer({ v: 2, moves: [], clicks: [] }), null);
    assert.strictEqual(parsePointer({ v: 1, moves: [], clicks: [] }), null);
    const p = parsePointer({ v: 1, moves: [[2, 0.5, 0.5], ['x', 1, 1], [1, 0.1, 0.1], [3, NaN, 0]], clicks: [[1, 0.1, 0.1, 0], [1]] });
    assert.deepStrictEqual(p.moves, [[1, 0.1, 0.1], [2, 0.5, 0.5]]);
    assert.strictEqual(p.clicks.length, 1);
    assert.strictEqual(p.duration, 2);
    assert.strictEqual(p.buttons, true);
    // Between two samples close in time it was moving; after a long gap it sat where it was.
    const m = parsePointer({ v: 1, moves: [[0, 0, 0], [0.1, 1, 1], [5, 0.5, 0.5]], clicks: [] });
    approx(pointerAt(m, 0.05).x, 0.5);
    approx(pointerAt(m, 3).x, 1);
    assert.strictEqual(pointerAt(m, -1), null);
  });

  t('demo: the camera is in before each click, stays for clicks close together, and pulls back after', () => {
    assert.ok(keys.length >= 4);
    for (let i = 1; i < keys.length; i++) assert.ok(keys[i].t > keys[i - 1].t, `key ${i} goes back in time`);
    // Whole picture at the start, at the end, and in the long gap between the two visits.
    for (const time of [0, 3, 12, 29]) approx(cameraAt(keys, time).z, 0);
    // Fully in a moment before the first click, and still there for the second: one visit, no pull-back between.
    approx(cameraAt(keys, 5 - DEMO.LEAD).z, 1);
    for (const time of [5, 5.6, 6.2, 7]) approx(cameraAt(keys, time).z, 1);
    approx(cameraAt(keys, 20.5).z, 1);
    const visits = keys.filter((k, i) => k.z === 1 && i > 0 && keys[i - 1].z === 0).length;
    assert.strictEqual(visits, 2);
    // It leaves once the hold is over.
    assert.ok(cameraAt(keys, 6.2 + opts.hold + DEMO.OUT + 0.05).z < 0.01);
  });

  t('demo: the view never leaves the picture, and what is clicked is in view', () => {
    // At 2x half the picture is in view, so the middle of the view stays between 0.25 and 0.75.
    for (const k of keys.filter((x) => x.z === 1)) assert.ok(k.x >= 0.25 - 1e-9 && k.x <= 0.75 + 1e-9 && k.y >= 0.25 - 1e-9 && k.y <= 0.75 + 1e-9, JSON.stringify(k));
    for (const [time, x, y] of track.clicks) {
      const tr = transformAt(frame, cameraAt(keys, time));
      const p = onCanvas(frame, tr, x, y);
      assert.ok(p.x > 0.02 && p.x < 0.98 && p.y > 0.02 && p.y < 0.98, `click at ${time}s lands at ${JSON.stringify(p)}`);
      // The picture covers the canvas: its edges are at or past the canvas edges.
      assert.ok(Math.abs(tr.posX) <= (tr.scaleX - 1) / 2 + 1e-9 && Math.abs(tr.posY) <= (tr.scaleY - 1) / 2 + 1e-9);
    }
    // A click near a corner: the camera goes as far as the corner allows and no further.
    const corner = cameraAt(keys, 20.5);
    approx(corner.x, 0.75);
    approx(corner.y, 0.75);
  });

  t('demo: a click outside the view moves the camera there first; one inside it does not', () => {
    const far = parsePointer({ v: 1, duration: 20, moves: [[0, 0.2, 0.2]], clicks: [[5, 0.2, 0.2, 0], [6.5, 0.22, 0.25, 0], [8, 0.9, 0.85, 0]] });
    const k = planCamera(far, far.clicks.map(([time, x, y]) => ({ t: time, x, y, click: true })), opts);
    const a = cameraAt(k, 5);
    const b = cameraAt(k, 6.5);
    const c = cameraAt(k, 8 - DEMO.LEAD);
    approx(a.x, b.x);
    approx(a.y, b.y);
    assert.ok(c.x > a.x + 0.3 && c.y > a.y + 0.3, JSON.stringify({ a, c }));
    approx(c.z, 1);
    // The pointer wandering off while zoomed in takes the camera with it, clicks or not.
    const wander = parsePointer({ v: 1, duration: 20, moves: [[0, 0.2, 0.2], [5.4, 0.2, 0.2], [5.6, 0.8, 0.8]], clicks: [[5, 0.2, 0.2, 0]] });
    const w = planCamera(wander, [{ t: 5, x: 0.2, y: 0.2, click: true }], { ...opts, hold: 3 });
    assert.ok(cameraAt(w, 7).x > 0.6, JSON.stringify(cameraAt(w, 7)));
  });

  t('demo: clip keyframes carry the camera, and pieces of one recording agree across a cut', () => {
    const whole = clipKeys(keys, frame, { from: 0, to: 30, speed: 1 });
    assert.ok(whole.length > 0 && whole.length % 4 === 0);
    const scale = whole.filter((k) => k.prop === 'scaleX');
    approx(scale[0].value, 1);
    approx(Math.max(...scale.map((k) => k.value)), 2);
    approx(scale[scale.length - 1].value, 1);
    // Cut at 5.5 s, in the middle of the first visit: the left piece ends as the right one begins.
    const left = clipKeys(keys, frame, { from: 0, to: 5.5, speed: 1 });
    const right = clipKeys(keys, frame, { from: 5.5, to: 30, speed: 1 });
    for (const prop of ['scaleX', 'posX', 'posY']) {
      const end = left.filter((k) => k.prop === prop).pop();
      const start = right.find((k) => k.prop === prop);
      approx(end.value, start.value);
      approx(end.t, 5.5);
      approx(start.t, 0);
    }
    // A piece the camera never moves in gets no keyframes at all; at double speed the keys come twice as soon.
    assert.deepStrictEqual(clipKeys(keys, frame, { from: 10, to: 14, speed: 1 }), []);
    const fast = clipKeys(keys, frame, { from: 0, to: 30, speed: 2 }).filter((k) => k.prop === 'scaleX');
    approx(fast[fast.length - 1].t, 15);
  });

  t('demo: a framed or letterboxed picture is handled per axis', () => {
    // A 16:9 recording on a square canvas fits its width; it takes 9/16 of the height.
    const fit = fitShare({ width: 1920, height: 1080 }, { width: 1080, height: 1080 });
    approx(fit.fitW, 1);
    approx(fit.fitH, 0.5625);
    const boxed = { scaleX: 1, scaleY: 1, posX: 0, posY: 0, ...fit, zoom: 1.5 };
    const v = viewAt(boxed);
    approx(v.w, 1 / 1.5);
    // 1.5 x 0.5625 is still less than the canvas height: all of the height stays in view, so no travel up or down.
    approx(v.h, 1);
    const tr = transformAt(boxed, { z: 1, x: 0.2, y: 0.1 });
    approx(tr.posY, 0);
    assert.ok(tr.posX > 0);
    // At rest the clip stays where the user put it.
    const moved = transformAt({ ...frame, posX: 0.1, scaleX: 0.8, scaleY: 0.8 }, { z: 0, x: 0.5, y: 0.5 });
    approx(moved.posX, 0.1);
    approx(moved.scaleX, 0.8);
  });

  t('demo: clicks are marked where they land on screen, at the clip time they happen', () => {
    const marks = clipClicks(track, keys, frame, { from: 0, to: 30, speed: 1 });
    assert.strictEqual(marks.length, 3);
    approx(marks[0].t, 5);
    // Zoomed 2x on a view centred at 0.25, a click at 0.2 shows left of the middle.
    approx(marks[0].x, 0.5 + (0.2 - 0.25) * 2);
    // Only the clicks a piece shows, in its own time.
    const late = clipClicks(track, keys, frame, { from: 18, to: 30, speed: 1 });
    assert.strictEqual(late.length, 1);
    approx(late[0].t, 2.5);
  });

  t('demo: without clicks the camera goes where the pointer comes to rest', () => {
    const quiet = parsePointer({ v: 1, duration: 12, buttons: false, moves: [[0, 0.5, 0.5], [0.1, 0.52, 0.5], [2, 0.2, 0.3], [2.05, 0.2, 0.3], [6, 0.8, 0.7], [6.05, 0.21, 0.3]], clicks: [] });
    const rest = settles(quiet);
    assert.ok(rest.length >= 2, JSON.stringify(rest));
    assert.ok(rest.every((e) => !e.click));
    approx(rest.find((e) => e.t > 2 && e.t < 3).x, 0.2);
  });

  t('demo: the click sound is a short press and a softer release', () => {
    const s = clickSound(48000);
    assert.ok(s.length > 48000 * 0.1 && s.length < 48000 * 0.25);
    const peak = (from, to) => Math.max(...Array.from(s.slice(Math.round(from * 48000), Math.round(to * 48000)), Math.abs));
    assert.ok(peak(0, 0.03) > 0.25 && peak(0, 0.03) <= 1, String(peak(0, 0.03)));
    assert.ok(peak(0.085, 0.11) > 0.1 && peak(0.085, 0.11) < peak(0, 0.03));
    assert.ok(peak(0.05, 0.08) < 0.03, 'quiet between the two');
    assert.ok(Math.abs(s[s.length - 1]) < 0.01);
    assert.deepStrictEqual(Array.from(clickSound(48000).slice(0, 64)), Array.from(s.slice(0, 64)));
  });

  t('demo: a framed picture zooms as a scene, so a click by the edge shows the frame and the backdrop', () => {
    // 6% of backdrop on each side, zoom 1.8.
    const framed = { scaleX: 0.88, scaleY: 0.88, posX: 0, posY: 0, fitW: 1, fitH: 1, zoom: 1.8, scene: true };
    const bare = { ...framed, scene: false };
    const edge = parsePointer({ v: 1, duration: 12, moves: [[0, 0.5, 0.5], [4, 0.03, 0.04]], clicks: [[5, 0.03, 0.04, 0]] });
    const ev = edge.clicks.map(([time, x, y]) => ({ t: time, x, y, click: true }));
    const plan = (f) => planCamera(edge, ev, { zoom: 1.8, hold: 1.6, view: viewAt(f), reach: reachAt(f) });
    // At rest nothing moves: the frame is the clip's own scale.
    assert.deepStrictEqual(transformAt(framed, { z: 0, x: 0.5, y: 0.5 }), { scaleX: 0.88, scaleY: 0.88, posX: 0, posY: 0 });
    const tr = transformAt(framed, cameraAt(plan(framed), 5));
    approx(tr.scaleX, 0.88 * 1.8);
    // The picture's left edge sits where the padding, zoomed, puts it: 0.06 × 1.8 of the canvas in.
    approx(onCanvas(framed, tr, 0, 0).x, 0.06 * 1.8);
    approx(onCanvas(framed, tr, 0, 0).y, 0.06 * 1.8);
    const hit = onCanvas(framed, tr, 0.03, 0.04);
    assert.ok(hit.x > 0.12 && hit.x < 0.5 && hit.y > 0.12 && hit.y < 0.5, JSON.stringify(hit));
    // Without the scene the same picture stops flush with the canvas edge.
    approx(onCanvas(bare, transformAt(bare, cameraAt(plan(bare), 5)), 0, 0).x, 0);
    // A click in the middle looks the same either way.
    approx(transformAt(framed, { z: 1, x: 0.5, y: 0.5 }).posX, 0);
  });

  t('demo: corners and shadow follow the size of the box', () => {
    const c = mediaClip({ cornerRadius: 0.025, shadow: 0.6 });
    const small = boxDecor(c, 1600, 900);
    const big = boxDecor(c, 3200, 1800);
    approx(small.radius, 22.5);
    approx(big.radius, 45);
    approx(big.shadow.blur, small.shadow.blur * 2);
    assert.ok(small.shadow.alpha > 0.3 && small.shadow.alpha < 0.7);
    assert.deepStrictEqual(boxDecor(mediaClip(), 1600, 900), { radius: 0, shadow: null });
    // Never more than a pill.
    approx(boxDecor(mediaClip({ cornerRadius: 3 }), 400, 100).radius, 50);
  });

  await ta('product_demo frames the recording, and takes the frame off again exactly', async () => {
    const sig = new AbortController().signal;
    const call = (args) => runAgentTool({ rid: 1, tool: 'product_demo', args: { sounds: false, zooms: [{ at: 4, x: 0.3, y: 0.3, click: true }], ...args }, client: 'test' }, () => {}, sig);
    const black = { type: 'black', color: '#101018', color2: '#2a2a3a' };
    const seed = (background = black, over = {}) => {
      useMediaStore.setState({ media: [{ id: 'm1', name: 'screen.mp4', kind: 'video', filePath: 'C:/v/screen.mp4', sizeBytes: 1, mediaUrl: 'x' }] });
      useTimelineStore.setState({
        tracks: [V1, T1, A1],
        canvas: { width: 1920, height: 1080 },
        background,
        clips: [mediaClip({ id: 'a', duration: 6, sourceDuration: 20, ...over }), mediaClip({ id: 'b', start: 6, duration: 6, inPoint: 8, sourceDuration: 20, ...over })],
        selectedIds: [],
        playhead: 0,
        past: [],
        future: [],
      });
    };
    const st = () => useTimelineStore.getState();
    const clip = (id) => st().clips.find((c) => c.id === id);

    seed();
    let r = await call({});
    assert.ok(r.ok, r.text);
    assert.match(r.text, /window frame/);
    for (const id of ['a', 'b']) {
      approx(clip(id).scaleX, 0.88);
      approx(clip(id).scaleY, 0.88);
      approx(clip(id).cornerRadius, 0.025);
      approx(clip(id).shadow, 0.6);
      assert.deepStrictEqual(clip(id).demoRest, { scaleX: 1, scaleY: 1, posX: 0, posY: 0, cornerRadius: 0, shadow: 0, background: black });
    }
    assert.strictEqual(st().background.type, 'gradient');
    assert.ok(clip('a').keyframes.some((k) => k.prop === 'scaleX' && Math.abs(k.value - 0.88 * 1.8) < 1e-6), 'zooms in from the framed size');
    assert.ok(clip('a').keyframes.filter((k) => k.prop === 'scaleX').every((k) => k.value >= 0.88 - 1e-9));
    // One undo takes the frame, the zooms and the backdrop away together.
    assert.strictEqual(st().past.length, 1);
    st().undo();
    assert.strictEqual(st().background.type, 'black');
    assert.strictEqual(clip('a').scaleX, 1);
    assert.strictEqual(clip('a').demoRest, undefined);
    st().redo();
    assert.strictEqual(st().background.type, 'gradient');

    // Again with other settings: the frame is not stacked on the old one, and the first background is still remembered.
    r = await call({ padding: 0.1, backdrop_color: '#112233' });
    assert.ok(r.ok, r.text);
    approx(clip('a').scaleX, 0.8);
    assert.deepStrictEqual(st().background, { type: 'gradient', color: '#112233', color2: '#112233' });
    assert.deepStrictEqual(clip('b').demoRest.background, black);

    // frame: false puts the picture and the background back and keeps the zooms.
    r = await call({ frame: false });
    assert.ok(r.ok, r.text);
    assert.strictEqual(clip('a').scaleX, 1);
    assert.strictEqual(clip('a').cornerRadius, undefined);
    assert.strictEqual(clip('a').demoRest, undefined);
    assert.deepStrictEqual(st().background, black);
    assert.ok(clip('a').keyframes.some((k) => k.prop === 'scaleX' && Math.abs(k.value - 1.8) < 1e-6));

    // remove: true after a framed run leaves nothing behind.
    await call({});
    r = await runAgentTool({ rid: 1, tool: 'product_demo', args: { remove: true }, client: 'test' }, () => {}, sig);
    assert.ok(r.ok, r.text);
    assert.match(r.text, /window frame/);
    for (const id of ['a', 'b']) {
      assert.strictEqual(clip(id).scaleX, 1);
      assert.strictEqual(clip(id).shadow, undefined);
      assert.strictEqual(clip(id).demoRest, undefined);
      assert.strictEqual(clip(id).keyframes.length, 0);
    }
    assert.deepStrictEqual(st().background, black);
    assert.ok(!st().clips.some((c) => c.type === 'shape'));

    // A background the user chose, and a clip they had already shrunk and rounded, are respected and restored.
    const mine = { type: 'color', color: '#ff0000', color2: '#00ff00' };
    seed(mine, { scaleX: 0.5, scaleY: 0.5, posX: 0.2, cornerRadius: 0.1 });
    r = await call({});
    assert.ok(r.ok, r.text);
    assert.match(r.text, /left as it is/);
    assert.deepStrictEqual(st().background, mine);
    approx(clip('a').scaleX, 0.44);
    approx(clip('a').posX, 0.2);
    assert.strictEqual(clip('a').demoRest.background, undefined);
    await runAgentTool({ rid: 1, tool: 'product_demo', args: { remove: true }, client: 'test' }, () => {}, sig);
    assert.deepStrictEqual([clip('a').scaleX, clip('a').posX, clip('a').cornerRadius, clip('a').shadow], [0.5, 0.2, 0.1, undefined]);
    assert.deepStrictEqual(st().background, mine);
    useMediaStore.setState({ media: [] });
    useTimelineStore.setState({ clips: [], background: black, past: [], future: [] });
  });

  await ta('product_demo says what it needs when there is nothing to work from', async () => {
    const r = await runAgentTool({ rid: 0, tool: 'product_demo', args: {}, client: 'test' }, () => {}, new AbortController().signal);
    assert.strictEqual(r.ok, false);
    assert.match(r.text, /no video on the timeline/i);
  });
}
