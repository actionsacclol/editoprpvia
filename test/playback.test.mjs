// Preview sync, shuttle playback, preview copies of large video, export
// formats, and the bin's handling of converted files.
import assert from 'node:assert';
import {
  crossCorrelate,
  findSoundOffset,
  soundMatches,
  EQ_RANGE,
  VOICE_PRESET,
  compressorSettings,
  fxSignature,
  routeAudio,
  unrouteAudio,
  hasAudioFx,
  isVoicePreset,
  markSessionReady,
  meterFraction,
  resolveFx,
  runAgentTool,
  toDb,
  HARD_SEEK,
  STEER_MAX,
  STEER_START,
  STEER_STOP,
  exportExtension,
  fitCanvas,
  proxySize,
  steer,
  useMediaStore,
  useTimelineStore,
  wantsProxy,
} from './.editor.mjs';

export async function run({ t, ta, approx, mediaClip }) {
  t('preview sync: small drift is left alone, a larger one is steered out, then released', () => {
    assert.deepStrictEqual(steer(0.01, false), { factor: 1, steering: false });
    assert.deepStrictEqual(steer(-0.02, false), { factor: 1, steering: false });
    // Ahead of the playhead: play slower. Behind: faster.
    const ahead = steer(0.05, false);
    assert.ok(ahead.steering && ahead.factor < 1, JSON.stringify(ahead));
    const behind = steer(-0.05, false);
    assert.ok(behind.steering && behind.factor > 1, JSON.stringify(behind));
    // Once steering, it keeps going inside the start threshold until nearly on time.
    assert.ok(steer(0.02, true).steering);
    assert.ok(!steer(STEER_STOP / 2, true).steering);
    assert.ok(STEER_STOP < STEER_START && STEER_START < HARD_SEEK);
  });

  t('preview sync: the rate is never bent by more than the limit', () => {
    for (const d of [0.04, 0.1, 0.29, -0.04, -0.29]) {
      const s = steer(d, false);
      assert.ok(Math.abs(s.factor - 1) <= STEER_MAX + 1e-9, `${d} -> ${s.factor}`);
    }
    // A 0.1 s lead at the limit is gone in about two seconds of playing.
    approx(0.1 / (1 - steer(0.1, false).factor), 2, 0.5);
  });

  t('shuttle: L and J play each way and double up to 8x; pause and play reset it', () => {
    const st = () => useTimelineStore.getState();
    st().pause();
    st().shuttleBy(1);
    assert.deepStrictEqual([st().playing, st().shuttle], [true, 1]);
    st().shuttleBy(1);
    st().shuttleBy(1);
    assert.strictEqual(st().shuttle, 4);
    st().shuttleBy(1);
    st().shuttleBy(1);
    assert.strictEqual(st().shuttle, 8);
    // The other way starts again at 1x backwards.
    st().shuttleBy(-1);
    assert.strictEqual(st().shuttle, -1);
    st().shuttleBy(-1);
    assert.strictEqual(st().shuttle, -2);
    st().pause();
    assert.deepStrictEqual([st().playing, st().shuttle], [false, 1]);
    st().shuttleBy(-1);
    st().play();
    assert.strictEqual(st().shuttle, 1);
    st().pause();
  });

  t('preview copies: only video above 1080p gets one, sized to 1280 on the long side with even dimensions', () => {
    assert.ok(!wantsProxy(1920, 1080));
    assert.ok(!wantsProxy(1080, 1920));
    assert.ok(!wantsProxy(1920, 1200));
    assert.ok(wantsProxy(2560, 1440));
    assert.ok(wantsProxy(3840, 2160));
    assert.ok(wantsProxy(2160, 3840));
    assert.deepStrictEqual(proxySize(3840, 2160), { width: 1280, height: 720 });
    assert.deepStrictEqual(proxySize(2160, 3840), { width: 720, height: 1280 });
    const odd = proxySize(2704, 1520);
    assert.ok(odd.width % 2 === 0 && odd.height % 2 === 0 && odd.width === 1280, JSON.stringify(odd));
    approx(odd.width / odd.height, 2704 / 1520, 0.01);
  });

  t('a canvas made from a clip follows it up to 4K', () => {
    assert.deepStrictEqual(fitCanvas(3840, 2160), { width: 3840, height: 2160 });
    assert.deepStrictEqual(fitCanvas(2160, 3840), { width: 2160, height: 3840 });
    assert.deepStrictEqual(fitCanvas(7680, 4320), { width: 3840, height: 2160 });
    assert.deepStrictEqual(fitCanvas(1920, 1080), { width: 1920, height: 1080 });
  });

  t('export: the file extension follows the format, and a timeline with no picture writes sound', () => {
    assert.strictEqual(exportExtension('mp4', true), 'mp4');
    assert.strictEqual(exportExtension('webm', true), 'webm');
    assert.strictEqual(exportExtension('m4a', true), 'm4a');
    assert.strictEqual(exportExtension('wav', true), 'wav');
    assert.strictEqual(exportExtension('mp4', false), 'm4a');
    assert.strictEqual(exportExtension('webm', false), 'm4a');
    assert.strictEqual(exportExtension('wav', false), 'wav');
  });

  t('media bin: a converted file is known by the file it came from, and keeps its id when swapped', () => {
    const ms = () => useMediaStore.getState();
    const before = ms().media;
    ms().replaceAll([]);
    const raw = { id: 'mx', name: 'take.mov', kind: 'video', filePath: 'C:/cam/take.mov', sizeBytes: 9, mediaUrl: 'u1', needsConvert: true };
    assert.strictEqual(ms().add([raw]).length, 1);
    ms().setBusy('mx', { label: 'Converting', fraction: 0.4 });
    assert.strictEqual(ms().busy.mx.fraction, 0.4);
    ms().replace({ id: 'mx', name: 'take.mov', kind: 'video', filePath: 'C:/cache/take-abc.mp4', sizeBytes: 5, mediaUrl: 'u2', sourcePath: 'C:/cam/take.mov' });
    ms().setBusy('mx', null);
    assert.deepStrictEqual(ms().busy, {});
    assert.strictEqual(ms().media[0].mediaUrl, 'u2');
    assert.strictEqual(ms().media[0].needsConvert, undefined);
    // Importing the original again, or the copy itself, adds nothing.
    assert.strictEqual(ms().add([{ ...raw, id: 'my' }]).length, 0);
    assert.strictEqual(ms().add([{ id: 'mz', name: 'take-abc.mp4', kind: 'video', filePath: 'C:/cache/take-abc.mp4', sizeBytes: 5, mediaUrl: 'u2' }]).length, 0);
    ms().setProxy('mx', 'p1');
    ms().remove('mx');
    assert.deepStrictEqual([ms().media.length, Object.keys(ms().proxies).length], [0, 0]);
    ms().replaceAll(before);
  });

  t('sound shaping: untouched clips have no chain; settings are held to their ranges', () => {
    assert.ok(!hasAudioFx({}));
    assert.ok(!hasAudioFx({ pan: 0, eqLow: 0, eqMid: 0, eqHigh: 0, comp: 0, lowCut: false }));
    assert.strictEqual(fxSignature({}), '');
    assert.ok(hasAudioFx({ pan: -0.5 }));
    assert.ok(hasAudioFx({ lowCut: true }));
    assert.ok(hasAudioFx({ eqMid: 2 }));
    assert.deepStrictEqual(resolveFx({ pan: 3, eqLow: -40, eqHigh: 99, comp: 7, eqMid: NaN }), { pan: 1, eqLow: -EQ_RANGE, eqMid: 0, eqHigh: EQ_RANGE, lowCut: false, comp: 1 });
    // The signature changes with any setting, and only then.
    assert.notStrictEqual(fxSignature({ eqMid: 2 }), fxSignature({ eqMid: 2.5 }));
    assert.strictEqual(fxSignature({ eqMid: 2, pan: 0 }), fxSignature({ eqMid: 2 }));
  });

  t('sound shaping: the voice preset is recognised, and more compressor means a lower threshold and a higher ratio', () => {
    assert.ok(isVoicePreset({ ...VOICE_PRESET }));
    assert.ok(isVoicePreset({ ...VOICE_PRESET, pan: 0.3 }));
    assert.ok(!isVoicePreset({ ...VOICE_PRESET, eqMid: 4 }));
    assert.ok(!isVoicePreset({}));
    const a = compressorSettings(0.2);
    const b = compressorSettings(0.8);
    assert.ok(b.threshold < a.threshold && b.ratio > a.ratio, JSON.stringify([a, b]));
    assert.deepStrictEqual(compressorSettings(5), compressorSettings(1));
  });

  t('level meter: decibels and where they sit on the scale', () => {
    approx(toDb(1), 0, 1e-9);
    approx(toDb(0.5), -6.02, 0.01);
    assert.strictEqual(toDb(0), -Infinity);
    assert.strictEqual(meterFraction(-Infinity), 0);
    assert.strictEqual(meterFraction(0), 1);
    assert.strictEqual(meterFraction(6), 1);
    approx(meterFraction(-30), 0.5, 1e-9);
    approx(meterFraction(-12), 0.8, 1e-9);
  });

  await ta('agent: voice_enhance asked of a picture lands on its sound clip, and single settings refine it', async () => {
    markSessionReady();
    const sig = new AbortController().signal;
    const tool = (name, args = {}) => runAgentTool({ rid: 1, tool: name, args, client: 'test' }, () => {}, sig);
    const st = () => useTimelineStore.getState();
    const before = { clips: st().clips, tracks: st().tracks, media: useMediaStore.getState().media };
    useMediaStore.getState().replaceAll([{ id: 'm1', name: 'talk.mp4', kind: 'video', filePath: 'C:/v/talk.mp4', sizeBytes: 1, mediaUrl: 'x' }]);
    st().loadDoc({
      clips: [
        mediaClip({ id: 'p', trackId: 'v1', mediaId: 'm1', duration: 10, sourceDuration: 30, muted: true, link: 'L' }),
        mediaClip({ id: 's', trackId: 'a1', mediaId: 'm1', duration: 10, sourceDuration: 30, link: 'L' }),
      ],
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1' },
        { id: 'a1', kind: 'audio', name: 'A1' },
      ],
      canvas: { width: 1920, height: 1080 },
    });
    const clip = (id) => st().clips.find((c) => c.id === id);
    const r = await tool('update_clip', { clip_id: 'p', voice_enhance: true });
    assert.ok(r.ok, r.text);
    assert.ok(isVoicePreset(clip('s')), JSON.stringify(clip('s')));
    assert.ok(!hasAudioFx(clip('p')), 'the silent picture keeps no sound settings');
    await tool('update_clip', { clip_id: 's', eq_high: 40, pan: -0.25, compress: 0.8 });
    assert.deepStrictEqual([clip('s').eqHigh, clip('s').pan, clip('s').comp], [EQ_RANGE, -0.25, 0.8]);
    const seen = JSON.parse((await tool('get_project')).text).clips.find((c) => c.id === 's');
    assert.deepStrictEqual([seen.low_cut, seen.pan, seen.compress], [true, -0.25, 0.8]);
    await tool('update_clip', { clip_id: 's', voice_enhance: false });
    assert.ok(!hasAudioFx({ ...clip('s'), pan: 0 }));
    useMediaStore.getState().replaceAll(before.media);
    st().loadDoc({ clips: before.clips, tracks: before.tracks, canvas: { width: 1920, height: 1080 } });
  });

  // ── sync by sound ─────────────────────────────────────────────────────────
  // A stand-in for a voice: bursts of noise of random length and loudness with gaps between them.
  const RATE = 8000;
  const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const talk = (seconds, seed) => {
    const r = rng(seed);
    const x = new Float32Array(Math.round(seconds * RATE));
    let i = 0;
    while (i < x.length) {
      const burst = Math.round((0.08 + r() * 0.35) * RATE);
      const amp = 0.1 + r() * 0.6;
      for (let j = 0; j < burst && i < x.length; j++, i++) x[i] = (r() * 2 - 1) * amp;
      i += Math.round((0.05 + r() * 0.4) * RATE);
    }
    return x;
  };
  // The same moment as another microphone heard it: later by `delay`, quieter, duller, with its own hiss.
  const other = (x, delay, seconds, seed) => {
    const r = rng(seed);
    const out = new Float32Array(Math.round(seconds * RATE));
    const d = Math.round(delay * RATE);
    let lp = 0;
    for (let i = 0; i < out.length; i++) {
      const src = i + d;
      const v = src >= 0 && src < x.length ? x[src] : 0;
      lp += 0.35 * (v - lp);
      out[i] = lp * 0.4 + (r() * 2 - 1) * 0.01;
    }
    return out;
  };

  t('cross-correlation: the peak is at the lag one series was shifted by', () => {
    const a = new Float32Array(64);
    const b = new Float32Array(40);
    for (const [i, v] of [[10, 1], [17, -2], [30, 3]]) a[i] = v;
    for (const [i, v] of [[4, 1], [11, -2], [24, 3]]) b[i] = v; // a shifted 6 earlier
    const c = crossCorrelate(a, b);
    let best = c.minLag;
    for (let k = c.minLag; k <= c.maxLag; k++) if (c.at(k) > c.at(best)) best = k;
    assert.strictEqual(best, 6);
    approx(c.at(6), 14, 1e-3);
    assert.deepStrictEqual([c.minLag, c.maxLag], [-39, 63]);
  });

  t('sync by sound: a second microphone started 3.217 s into the take is found to the millisecond', () => {
    const cam = talk(40, 7);
    const phone = other(cam, 3.217, 30, 99);
    const r = findSoundOffset(cam, phone, RATE);
    assert.ok(r && soundMatches(r), JSON.stringify(r));
    approx(r.offset, 3.217, 0.002);
  });

  t('sync by sound: a recorder that was started first gives a negative offset', () => {
    const phone = talk(40, 21);
    const cam = other(phone, 5.5, 25, 5); // the camera began 5.5 s after the phone
    const r = findSoundOffset(cam, phone, RATE);
    assert.ok(r && soundMatches(r), JSON.stringify(r));
    approx(r.offset, -5.5, 0.002);
  });

  t('sync by sound: two unrelated recordings are not matched, and scraps are not judged', () => {
    // Unrelated takes throw up several similar peaks; none may pass as a match.
    for (let s = 1; s <= 12; s++) {
      const r = findSoundOffset(talk(40, 3 + s * 7), talk(30, 1000 + s * 13), RATE);
      assert.ok(r && !soundMatches(r), `pair ${s}: ${JSON.stringify(r)}`);
    }
    assert.strictEqual(findSoundOffset(talk(1, 3), talk(40, 4), RATE), null);
  });
  t('preview sound: an element taken out of the mix and put back is heard again', () => {
    // React's development mode runs each player's clean-up once right after it
    // mounts. A media element accepts one source node in its life, so routing
    // it again must reuse that node (a second one throws, and the element's
    // sound would go nowhere).
    const node = () => ({ to: new Set(), gain: { value: 1 }, connect(n) { this.to.add(n); return n; }, disconnect() { this.to.clear(); }, getFloatTimeDomainData() {} });
    const taken = new Set();
    const had = globalThis.AudioContext;
    globalThis.AudioContext = class {
      destination = node();
      state = 'running';
      createGain = node;
      createAnalyser = node;
      createChannelSplitter = node;
      createMediaElementSource(el) {
        if (taken.has(el)) throw new Error('already connected to a source node');
        taken.add(el);
        return (el.node = node());
      }
    };
    try {
      const el = { isConnected: true };
      assert.strictEqual(routeAudio(el, {}), true);
      assert.strictEqual(el.node.to.size, 1);
      unrouteAudio(el);
      assert.strictEqual(el.node.to.size, 0);
      assert.strictEqual(routeAudio(el, {}), true, 'routed again');
      assert.strictEqual(el.node.to.size, 1, 'and connected to the mix again');
      unrouteAudio(el);
    } finally {
      globalThis.AudioContext = had;
    }
  });
}
