// A video's picture and its sound as two linked clips: the pure helpers, the
// store edits that keep the pair together, and what the agent tools do with it.
import assert from 'node:assert';
import {
  activeAudioClips,
  activeVisualLayers,
  carriedSound,
  freeTrack,
  linkPartners,
  linkedIds,
  listenableClips,
  markSessionReady,
  planCuts,
  planRecordingClips,
  describeOutputs,
  relinkPieces,
  runAgentTool,
  soundOf,
  useMediaStore,
  useTimelineStore,
  voiceTrack,
} from './.editor.mjs';

export async function run({ t, ta, approx, mediaClip, textClip, V1, T1, A1 }) {
  const A2 = { id: 'a2', kind: 'audio', name: 'A2' };
  const st = () => useTimelineStore.getState();
  const clip = (id) => st().clips.find((c) => c.id === id);
  const pic = (over = {}) => mediaClip({ id: 'p', trackId: 'v1', mediaId: 'm1', duration: 10, sourceDuration: 30, muted: true, link: 'L', ...over });
  const snd = (over = {}) => mediaClip({ id: 's', trackId: 'a1', mediaId: 'm1', duration: 10, sourceDuration: 30, link: 'L', ...over });
  const video = { id: 'm1', name: 'talk.mp4', kind: 'video', filePath: 'C:/v/talk.mp4', sizeBytes: 1, mediaUrl: 'x' };
  const music = { id: 'm2', name: 'song.mp3', kind: 'audio', filePath: 'C:/v/song.mp3', sizeBytes: 1, mediaUrl: 'y' };
  const load = (clips, tracks = [V1, T1, A1]) => {
    useMediaStore.setState({ media: [video, music] });
    useTimelineStore.setState({ tracks, clips, selectedIds: [], soloSelect: false, playhead: 0, past: [], future: [] });
  };
  const pairs = () => {
    const by = new Map();
    for (const c of st().clips) if (c.link) by.set(c.link, [...(by.get(c.link) ?? []), c]);
    return [...by.values()].filter((g) => g.length > 1);
  };

  // ── helpers ───────────────────────────────────────────────────────────────
  t('linkedIds: the picked clips first, then what is linked; partners on a locked track are left out', () => {
    const clips = [pic(), snd(), mediaClip({ id: 'x', start: 20 })];
    assert.deepStrictEqual(linkedIds(clips, ['p']), ['p', 's']);
    assert.deepStrictEqual(linkedIds(clips, ['s', 'x']), ['s', 'x', 'p']);
    assert.deepStrictEqual(linkedIds(clips, ['x']), ['x']);
    assert.deepStrictEqual(linkedIds(clips, ['p'], [V1, { ...A1, locked: true }]), ['p']);
    assert.deepStrictEqual(linkPartners(clips, clips[0]).map((c) => c.id), ['s']);
    assert.deepStrictEqual(linkPartners(clips, clips[2]), []);
  });

  t('soundOf: same file and timing, the speed and volume curves, none of the looks', () => {
    const k = (prop, tt, value) => ({ id: `${prop}${tt}`, prop, t: tt, value });
    const p = pic({ effect: 'vhs', chapter: 'Intro', group: 'g1', fadeOut: 0.4, inPoint: 3, speed: 2, keyframes: [k('speed', 0, 1), k('posX', 1, 0.2), k('volume', 2, 0.5)], transition: 'fade' });
    const s = soundOf(p, 'a1', 'L');
    assert.notStrictEqual(s.id, p.id);
    assert.deepStrictEqual([s.trackId, s.link, s.muted, s.inPoint, s.speed, s.start, s.duration, s.fadeOut], ['a1', 'L', false, 3, 2, 0, 10, 0.4]);
    assert.deepStrictEqual(s.keyframes.map((x) => x.prop).sort(), ['speed', 'volume']);
    assert.deepStrictEqual([s.effect, s.transition, s.chapter, s.group], ['none', 'none', undefined, undefined]);
  });

  t('freeTrack: the first track of the kind that is empty there, else a new one', () => {
    const busy = [mediaClip({ id: 'm', trackId: 'a1', start: 0, duration: 10 })];
    assert.strictEqual(freeTrack([V1, A1], busy, 'audio', 10, 20).track.id, 'a1');
    const made = freeTrack([V1, A1], busy, 'audio', 5, 20);
    assert.strictEqual(made.tracks.length, 3);
    assert.deepStrictEqual([made.track.kind, made.track.name], ['audio', 'A2']);
    assert.strictEqual(freeTrack([V1, A1, A2], busy, 'audio', 5, 20).track.id, 'a2');
    assert.strictEqual(freeTrack([V1, { ...A1, locked: true }], [], 'audio', 0, 1).tracks.length, 3);
  });

  t('relinkPieces: the pieces of a cut pair pair up again; leftovers lose the link', () => {
    const cut = relinkPieces([
      pic({ id: 'p1', start: 0, duration: 4 }),
      pic({ id: 'p2', start: 4, duration: 6 }),
      snd({ id: 's1', start: 0, duration: 4 }),
      snd({ id: 's2', start: 4, duration: 6 }),
    ]);
    const link = (id) => cut.find((c) => c.id === id).link;
    assert.ok(link('p1') && link('p1') === link('s1'));
    assert.ok(link('p2') && link('p2') === link('s2'));
    assert.notStrictEqual(link('p1'), link('p2'));
    // A sound that was slipped by 0.2s still finds its picture.
    const slipped = relinkPieces([
      pic({ id: 'p1', start: 0, duration: 5 }),
      pic({ id: 'p2', start: 5, duration: 5 }),
      snd({ id: 's1', start: 0.2, duration: 4.8 }),
      snd({ id: 's2', start: 5, duration: 5.2 }),
    ]);
    assert.strictEqual(slipped.find((c) => c.id === 'p2').link, slipped.find((c) => c.id === 's2').link);
    // Only the picture was cut: one half keeps the sound, the other is on its own.
    const one = relinkPieces([pic({ id: 'p1', duration: 5 }), pic({ id: 'p2', start: 5, duration: 5 }), snd()]);
    assert.strictEqual(one.filter((c) => c.link).length, 2);
    assert.strictEqual(one.find((c) => c.id === 'p2').link, undefined);
    // A link nobody shares is dropped; an intact pair is returned untouched.
    assert.strictEqual(relinkPieces([pic()])[0].link, undefined);
    const intact = [pic(), snd()];
    assert.strictEqual(relinkPieces(intact), intact);
  });

  t('listenableClips / voiceTrack: a picture whose sound is its own clip is not listened to twice', () => {
    const clips = [pic(), snd(), mediaClip({ id: 'song', trackId: 'a2', mediaId: 'm2' })];
    const tracks = [V1, T1, A1, A2];
    const heard = listenableClips(clips, tracks, [video, music]);
    assert.deepStrictEqual(heard.map((c) => c.id), ['s', 'song']);
    assert.strictEqual(voiceTrack(tracks, heard, [video, music]).id, 'a1');
    // The old shape (sound inside the video clip) still points at the video track.
    const old = listenableClips([mediaClip({ id: 'v', mediaId: 'm1' }), clips[2]], tracks, [video, music]);
    assert.strictEqual(voiceTrack(tracks, old, [video, music]).id, 'v1');
    // A file known to be silent (a screen recording) is not a voice.
    const silent = listenableClips([mediaClip({ id: 'screen', mediaId: 'm1' }), clips[2]], tracks, [video, music], (id) => id === 'm1');
    assert.deepStrictEqual(silent.map((c) => c.id), ['song']);
  });

  t('carriedSound: an in-step sound plays from its picture; a slipped, re-timed or unmuted one does not', () => {
    const tracks = [V1, T1, A1];
    const at = (clips, time) => {
      const layers = activeVisualLayers(clips, tracks, time);
      return carriedSound(layers, activeAudioClips(clips, tracks, time), time);
    };
    assert.strictEqual(at([pic(), snd()], 3).get('p').id, 's');
    assert.strictEqual(at([pic({ inPoint: 4 }), snd({ inPoint: 4 })], 3).size, 1);
    assert.strictEqual(at([pic(), snd({ start: 0.3 })], 3).size, 0);
    assert.strictEqual(at([pic(), snd({ speed: 2 })], 3).size, 0);
    assert.strictEqual(at([pic({ muted: false }), snd()], 3).size, 0);
    assert.strictEqual(at([pic(), snd({ link: 'other' })], 3).size, 0);
    assert.strictEqual(at([pic(), snd({ mediaId: 'm2' })], 3).size, 0);
    // Under a transition the outgoing picture plays its tail and carries its (ended) sound, faded by the mix.
    const seam = [
      pic({ id: 'p1', duration: 4, link: 'L1' }),
      snd({ id: 's1', duration: 4, link: 'L1' }),
      pic({ id: 'p2', start: 4, duration: 4, inPoint: 10, link: 'L2', transition: 'fade', transitionDur: 1 }),
      snd({ id: 's2', start: 4, duration: 4, inPoint: 10, link: 'L2' }),
    ];
    const layers = activeVisualLayers(seam, tracks, 4.25);
    const got = carriedSound(layers, activeAudioClips(seam, tracks, 4.25), 4.25, seam, tracks);
    assert.deepStrictEqual([got.get('p1').id, got.get('p2').id], ['s1', 's2']);
    const mix = Object.fromEntries(layers.map((L) => [L.clip.id, L.mix]));
    approx(mix.p1 ** 2 + mix.p2 ** 2, 1);
    approx(mix.p2 ** 2, 0.25);
    assert.strictEqual(activeVisualLayers(seam, tracks, 6)[0].mix, 1);
    // The sound's track is muted: nothing to carry out of the cut.
    const mutedLane = [V1, T1, { ...A1, muted: true }];
    assert.strictEqual(carriedSound(activeVisualLayers(seam, mutedLane, 4.25), activeAudioClips(seam, mutedLane, 4.25), 4.25, seam, mutedLane).size, 0);
  });

  // ── store ─────────────────────────────────────────────────────────────────
  t('detachAudio: a linked sound clip on a free audio track; a second call changes nothing', () => {
    load([mediaClip({ id: 'p', mediaId: 'm1', sourceDuration: 30 }), mediaClip({ id: 'song', trackId: 'a1', mediaId: 'm2', start: 2, duration: 4 })]);
    st().detachAudio('p');
    const p = clip('p');
    const s = linkPartners(st().clips, p)[0];
    assert.ok(p.muted && p.link && s && !s.muted);
    // A1 is busy under the clip, so the sound gets a track of its own.
    assert.strictEqual(st().tracks.find((x) => x.id === s.trackId).name, 'A2');
    const n = st().clips.length;
    st().detachAudio('p');
    assert.strictEqual(st().clips.length, n);
    st().undo();
    assert.ok(!clip('p').muted && st().clips.length === 2);
  });

  t('delete, ripple delete, split and duplicate take the linked clip along', () => {
    load([pic(), snd()]);
    st().selectClip('p');
    st().setPlayhead(4);
    st().splitSelectedAtPlayhead();
    assert.strictEqual(st().clips.length, 4);
    assert.strictEqual(pairs().length, 2);
    for (const g of pairs()) assert.deepStrictEqual(g.map((c) => [c.start, c.duration]), [g[0], g[0]].map((c) => [c.start, c.duration]));
    // The selection is the picked clip's right half only.
    assert.strictEqual(st().selectedIds.length, 1);
    assert.strictEqual(clip(st().selectedIds[0]).trackId, 'v1');
    st().rippleDeleteSelected();
    assert.deepStrictEqual(st().clips.map((c) => [c.trackId, c.start, c.duration]), [['v1', 0, 4], ['a1', 0, 4]]);

    load([pic(), snd()]);
    st().selectClip('s');
    st().duplicateClip('s');
    assert.strictEqual(st().clips.length, 4);
    assert.strictEqual(pairs().length, 2);
    assert.deepStrictEqual(st().clips.filter((c) => c.id !== 'p' && c.id !== 's').map((c) => c.start), [10, 10]);
    st().selectClip('p');
    st().removeSelected();
    assert.strictEqual(st().clips.length, 2);
  });

  t('Alt selection edits one side alone; a locked track keeps its clip out of the edit', () => {
    load([pic(), snd()]);
    st().selectClip('s', false, true);
    st().removeSelected();
    assert.deepStrictEqual(st().clips.map((c) => c.id), ['p']);
    load([pic(), snd()], [V1, T1, { ...A1, locked: true }]);
    st().selectClip('p');
    st().removeSelected();
    assert.deepStrictEqual(st().clips.map((c) => c.id), ['s']);
  });

  t('trimming moves both edges together and stops where the tighter clip stops', () => {
    load([pic({ inPoint: 5 }), snd({ inPoint: 5 })]);
    st().trimClipStart('p', 2);
    assert.deepStrictEqual([clip('p').start, clip('s').start, clip('s').inPoint, clip('s').duration], [2, 2, 7, 8]);
    st().trimClipEnd('s', 6);
    assert.deepStrictEqual([clip('p').duration, clip('s').duration], [4, 4]);
    st().trimClipEnd('p', 9, true);
    assert.deepStrictEqual([clip('p').duration, clip('s').duration], [7, 4]);
    // The sound has 1s of source before its in point, the picture 5s: both stop at 1s.
    load([pic({ start: 10, inPoint: 5 }), snd({ start: 10, inPoint: 1 })]);
    st().trimClipStart('p', 0);
    assert.deepStrictEqual([clip('p').start, clip('s').start], [9, 9]);
  });

  t('speed, a speed curve and a freeze frame keep the sound with the picture', () => {
    load([pic(), snd()]);
    st().setSpeed('p', 2);
    assert.deepStrictEqual([clip('s').speed, clip('s').duration], [2, 5]);
    st().applySpeedPreset('s', 'montage');
    const curve = (id) => clip(id).keyframes.filter((k) => k.prop === 'speed').map((k) => [k.t, k.value]);
    assert.ok(curve('s').length > 0);
    assert.deepStrictEqual(curve('p'), curve('s'));
    approx(clip('p').duration, clip('s').duration);

    load([pic(), snd(), mediaClip({ id: 'later', trackId: 'a1', mediaId: 'm2', start: 12, duration: 3 })]);
    st().selectClip('p');
    st().setPlayhead(4);
    assert.ok(st().freezeFrameAtPlayhead());
    const v = st().clips.filter((c) => c.trackId === 'v1').sort((a, b) => a.start - b.start);
    const a = st().clips.filter((c) => c.trackId === 'a1').sort((x, y) => x.start - y.start);
    assert.deepStrictEqual(v.map((c) => [c.start, c.duration]), [[0, 4], [4, 3], [7, 6]]);
    assert.deepStrictEqual(a.map((c) => [c.start, c.duration]), [[0, 4], [7, 6], [15, 3]]);
    approx(a[1].inPoint, 4);
    assert.strictEqual(v[1].link, undefined);
    assert.ok(v[0].link === a[0].link && v[2].link === a[1].link && v[0].link !== v[2].link);
  });

  t('closing a gap, copy and paste, link and unlink', () => {
    load([pic({ id: 'p1', duration: 3, link: 'L1' }), snd({ id: 's1', duration: 3, link: 'L1' }), pic({ id: 'p2', start: 8, duration: 3, link: 'L2' }), snd({ id: 's2', start: 8, duration: 3, link: 'L2' })]);
    st().closeGapBefore('p2');
    assert.deepStrictEqual([clip('p2').start, clip('s2').start], [3, 3]);
    st().selectClip('p2');
    assert.strictEqual(st().copySelected(), 2);
    st().setPlayhead(20);
    st().paste();
    const pasted = st().clips.filter((c) => c.start === 20);
    assert.strictEqual(pasted.length, 2);
    assert.ok(pasted[0].link && pasted[0].link === pasted[1].link && pasted[0].link !== 'L2');
    st().selectClip('p1');
    st().unlinkSelected();
    assert.ok(!clip('p1').link && !clip('s1').link);
    st().selectClip('p1');
    st().removeSelected();
    assert.ok(clip('s1'));
    st().setSelection(['s1', 'p2']);
    st().linkSelected();
    // p2 already belongs with s2: linking it to something else has to start with an unlink.
    assert.strictEqual(clip('s1').link, undefined);
    assert.strictEqual(clip('p2').link, 'L2');
    st().selectClip('p2');
    st().unlinkSelected();
    st().setSelection(['s1', 'p2']);
    st().linkSelected();
    assert.ok(clip('s1').link && clip('s1').link === clip('p2').link);
    assert.strictEqual(clip('s2').link, undefined);
    // Two clips on one track can't be a pair.
    st().setSelection(['s1', 's2']);
    st().linkSelected();
    assert.strictEqual(clip('s2').link, undefined);
  });

  t('an auto cut leaves every piece paired with its own sound', () => {
    load([pic(), snd()]);
    const next = planCuts(st().clips, st().tracks, [video, music], [[2, 3], [6, 7.5]], { remove: true, zoom: null, seamFade: 0, ripple: true });
    st().commitClips(next);
    const groups = pairs();
    assert.strictEqual(groups.length, 3);
    for (const g of groups) {
      assert.strictEqual(g.length, 2);
      approx(g[0].start, g[1].start);
      approx(g[0].duration, g[1].duration);
      approx(g[0].inPoint, g[1].inPoint);
      assert.notStrictEqual(g[0].trackId, g[1].trackId);
    }
  });

  t('a recording lands with each sound on its own named track', () => {
    const src = (role, over = {}) => ({ role, mediaId: `m-${role}`, duration: 60, width: 1920, height: 1080, ...over });
    const r = planRecordingClips([src('screen', { sound: 'system' }), src('camera', { sound: 'mic' })], [V1, T1, A1], 5);
    assert.strictEqual(r.clips.length, 4);
    const names = (id) => r.tracks.find((x) => x.id === id).name;
    const sounds = r.clips.filter((c) => !c.muted);
    assert.deepStrictEqual(sounds.map((c) => names(c.trackId)).sort(), ['Computer sound', 'Voice']);
    for (const s of sounds) {
      const p = r.clips.find((c) => c.link === s.link && c.id !== s.id);
      assert.ok(p.muted && p.mediaId === s.mediaId && p.start === 5 && s.start === 5);
      assert.deepStrictEqual([s.scaleX, s.posX], [p.scaleX, p.posX]);
    }
    const whole = planRecordingClips([src('camera', { sound: 'mic' })], [V1, T1, A1], 0, false);
    assert.strictEqual(whole.clips.length, 1);
    assert.ok(!whole.clips[0].muted && !whole.clips[0].link);
    assert.match(describeOutputs({ screen: true, camera: true, system: true, mic: true }), /Each sound gets an audio track of its own/);
    assert.match(describeOutputs({ screen: true, camera: false, system: false, mic: true }), /Its sound gets an audio track/);
    assert.doesNotMatch(describeOutputs({ screen: true, camera: false, system: false, mic: true }, false), /audio track of its own/);
    assert.doesNotMatch(describeOutputs({ screen: true, camera: false, system: false, mic: false }), /audio track of its own/);
  });

  // ── agent tools ───────────────────────────────────────────────────────────
  markSessionReady();
  const sig = new AbortController().signal;
  const tool = (name, args = {}) => runAgentTool({ rid: 1, tool: name, args, client: 'test' }, () => {}, sig);

  await ta('agent: get_project shows the link; update_clip moves both and sends sound settings to the sound clip', async () => {
    load([pic(), snd()]);
    const p = JSON.parse((await tool('get_project')).text);
    assert.deepStrictEqual(p.clips.map((c) => c.linked), ['L', 'L']);
    const r = await tool('update_clip', { clip_id: 'p', start: 4, volume: 0.5, muted: false, fade_out: 1 });
    assert.ok(r.ok, r.text);
    assert.deepStrictEqual([clip('p').start, clip('s').start], [4, 4]);
    assert.deepStrictEqual([clip('p').muted, clip('p').volume, clip('s').volume, clip('s').muted, clip('s').fadeOut], [true, 1, 0.5, false, 1]);
    assert.match(r.text, /sound clip of p/);
    const sp = await tool('update_clip', { clip_id: 's', speed: 2 });
    assert.ok(sp.ok, sp.text);
    assert.deepStrictEqual([clip('p').speed, clip('p').duration, clip('s').duration], [2, 5, 5]);
    // A fade asked of the sound alone is not a fade of the picture.
    await tool('update_clip', { clip_id: 's', fade_in: 0.5 });
    assert.deepStrictEqual([clip('s').fadeIn, clip('p').fadeIn], [0.5, 0]);
  });

  await ta('agent: split, duplicate and delete treat the pair as one; only_these deletes one side', async () => {
    load([pic(), snd()]);
    const sp = await tool('split_clips', { time: 4, clip_ids: ['p'] });
    assert.ok(sp.ok, sp.text);
    assert.strictEqual(st().clips.length, 4);
    assert.strictEqual(pairs().length, 2);
    load([pic(), snd()]);
    const d = await tool('duplicate_clip', { clip_id: 'p', start: 30 });
    assert.ok(d.ok, d.text);
    assert.deepStrictEqual(st().clips.filter((c) => c.id !== 'p' && c.id !== 's').map((c) => c.start), [30, 30]);
    assert.strictEqual(pairs().length, 2);
    const one = await tool('delete_clips', { clip_ids: ['s'], only_these: true });
    assert.ok(one.ok, one.text);
    assert.ok(clip('p') && !clip('s'));
    load([pic(), snd()]);
    const both = await tool('delete_clips', { clip_ids: ['p'] });
    assert.match(both.text, /Deleted 1 clip and s linked to it/);
    assert.strictEqual(st().clips.length, 0);
  });

  await ta('agent: detach_audio links the sound and says so once', async () => {
    load([mediaClip({ id: 'p', mediaId: 'm1', sourceDuration: 30 })]);
    const r = await tool('detach_audio', { clip_id: 'p' });
    assert.ok(r.ok, r.text);
    const s = linkPartners(st().clips, clip('p'))[0];
    assert.ok(s && clip('p').muted);
    const again = await tool('detach_audio', { clip_id: 'p' });
    assert.match(again.text, /already has its sound/);
    assert.strictEqual(st().clips.length, 2);
    assert.ok(textClip);
  });
}
