// Recording: which files a recording becomes, how it is encoded, and where its
// clips land (run from editor.test.mjs). The capture itself needs a browser
// and is tested live.
import assert from 'node:assert';
import { CAMERA_CORNER, clock, describeOutputs, encodeSize, noVisualsYet, planOutputs, planRecordingClips, videoBitrate } from './.editor.mjs';

export async function run({ t, mediaClip, V1, T1, A1 }) {
  const roles = (i) => planOutputs(i).map((o) => `${o.role}:${o.video ?? '-'}+${o.audio ?? '-'}.${o.ext}`);
  const on = (over) => ({ screen: false, camera: false, system: false, mic: false, ...over });

  t('planOutputs: screen and voice share one file', () => {
    assert.deepStrictEqual(roles(on({ screen: true, mic: true })), ['screen:screen+mic.mp4']);
  });
  t('planOutputs: with a camera the voice goes with the face', () => {
    assert.deepStrictEqual(roles(on({ screen: true, camera: true, mic: true })), ['screen:screen+-.mp4', 'camera:camera+mic.mp4']);
  });
  t("planOutputs: the computer's sound takes the screen file, the voice gets its own", () => {
    assert.deepStrictEqual(roles(on({ screen: true, system: true, mic: true })), ['screen:screen+system.mp4', 'voice:-+mic.m4a']);
    assert.deepStrictEqual(roles(on({ screen: true, system: true, mic: true, camera: true })), ['screen:screen+system.mp4', 'camera:camera+mic.mp4']);
  });
  t('planOutputs: camera only, voice only, nothing', () => {
    assert.deepStrictEqual(roles(on({ camera: true, mic: true })), ['camera:camera+mic.mp4']);
    assert.deepStrictEqual(roles(on({ mic: true })), ['voice:-+mic.m4a']);
    assert.deepStrictEqual(roles(on({ screen: true })), ['screen:screen+-.mp4']);
    assert.deepStrictEqual(roles(on({})), []);
  });
  t('planOutputs: every captured track ends up in exactly one file', () => {
    for (let n = 0; n < 16; n++) {
      const i = { screen: !!(n & 1), camera: !!(n & 2), system: !!(n & 4) && !!(n & 1), mic: !!(n & 8) };
      const plan = planOutputs(i);
      const count = (k, v) => plan.filter((o) => o[k] === v).length;
      assert.strictEqual(count('video', 'screen'), i.screen ? 1 : 0);
      assert.strictEqual(count('video', 'camera'), i.camera ? 1 : 0);
      assert.strictEqual(count('audio', 'system'), i.system ? 1 : 0);
      assert.strictEqual(count('audio', 'mic'), i.mic ? 1 : 0);
      assert.ok(plan.every((o) => (o.ext === 'm4a') === (o.video === null)));
    }
  });
  t('describeOutputs says what lands on the timeline', () => {
    assert.match(describeOutputs(on({})), /Pick something/);
    assert.match(describeOutputs(on({ screen: true, mic: true })), /one clip: the screen with your voice/);
    assert.match(describeOutputs(on({ screen: true, camera: true, mic: true })), /2 clips in sync: the screen \(silent\) and the camera in a corner above it with your voice/);
    assert.match(describeOutputs(on({ camera: true })), /one clip: the camera\./);
  });

  t('encodeSize keeps an even source, caps the height, and evens odd windows', () => {
    assert.deepStrictEqual(encodeSize(1920, 1080, null), { width: 1920, height: 1080, resize: false });
    assert.deepStrictEqual(encodeSize(2560, 1440, 1080), { width: 1920, height: 1080, resize: true });
    assert.deepStrictEqual(encodeSize(1280, 720, 1080), { width: 1280, height: 720, resize: false });
    const odd = encodeSize(1283, 721, null);
    assert.ok(odd.resize && odd.width % 2 === 0 && odd.height % 2 === 0 && Math.abs(odd.width - 1283) <= 1 && Math.abs(odd.height - 721) <= 1);
    assert.deepStrictEqual(encodeSize(0, 0, null), { width: 1920, height: 1080, resize: true });
  });
  t('videoBitrate: about 8 Mbps at 1080p30, more for 60 fps and 4K, within bounds', () => {
    const base = videoBitrate(1920, 1080, 30);
    assert.ok(base > 7e6 && base < 9e6, String(base));
    assert.ok(videoBitrate(1920, 1080, 60) > base && videoBitrate(1920, 1080, 60) < base * 2);
    assert.ok(videoBitrate(3840, 2160, 30) > base * 3);
    assert.strictEqual(videoBitrate(320, 240, 30), 2.5e6);
    assert.strictEqual(videoBitrate(7680, 4320, 60), 45e6);
  });

  const src = (role, over = {}) => ({ role, mediaId: `rec-${role}`, duration: 60, width: role === 'voice' ? 0 : 1920, height: role === 'voice' ? 0 : 1080, ...over });
  t('planRecordingClips: screen on the first video track, camera right above it in the corner, both at the same time', () => {
    const r = planRecordingClips([src('screen'), src('camera', { width: 1280, height: 720, duration: 59.9 })], [V1, T1, A1], 12);
    const [screen, camera] = r.clips;
    assert.strictEqual(screen.trackId, V1.id);
    assert.strictEqual(screen.start, 12);
    assert.strictEqual(camera.start, 12);
    assert.strictEqual(screen.scaleX, 1);
    assert.strictEqual(camera.scaleX, CAMERA_CORNER);
    assert.strictEqual(camera.scaleY, CAMERA_CORNER);
    assert.ok(camera.posX > 0.3 && camera.posY > 0.3, 'bottom right');
    const lane = r.tracks.find((x) => x.id === camera.trackId);
    assert.strictEqual(lane.name, 'Camera');
    assert.strictEqual(lane.kind, 'video');
    // Later in the track list is in front: the camera goes directly after the screen's track.
    assert.strictEqual(r.tracks.indexOf(lane), r.tracks.findIndex((x) => x.id === V1.id) + 1);
    assert.strictEqual(r.tracks.length, 4);
    assert.strictEqual(r.main.role, 'screen');
  });
  t('planRecordingClips: a second recording reuses the Camera and Voice tracks', () => {
    const first = planRecordingClips([src('screen'), src('camera'), src('voice')], [V1, T1, A1], 0);
    const again = planRecordingClips([src('screen'), src('camera'), src('voice')], first.tracks, 60);
    assert.strictEqual(again.tracks.length, first.tracks.length);
    assert.deepStrictEqual(
      again.clips.map((c) => c.trackId),
      first.clips.map((c) => c.trackId),
    );
    const voice = first.tracks.find((x) => x.id === first.clips[2].trackId);
    assert.strictEqual(voice.kind, 'audio');
    assert.strictEqual(voice.name, 'Voice');
    assert.notStrictEqual(voice.id, A1.id);
  });
  t('planRecordingClips: a camera alone fills the frame; a voice alone is just audio', () => {
    const cam = planRecordingClips([src('camera')], [V1, T1, A1], 0);
    assert.strictEqual(cam.clips.length, 1);
    assert.strictEqual(cam.clips[0].trackId, V1.id);
    assert.strictEqual(cam.clips[0].scaleX, 1);
    assert.strictEqual(cam.tracks.length, 3);
    const voice = planRecordingClips([src('voice')], [V1, T1, A1], 0);
    assert.strictEqual(voice.main, null);
    assert.strictEqual(voice.tracks.find((x) => x.id === voice.clips[0].trackId).kind, 'audio');
  });
  t('planRecordingClips: makes a video track when the project has none', () => {
    const r = planRecordingClips([src('screen')], [T1, A1], 0);
    assert.strictEqual(r.tracks.find((x) => x.id === r.clips[0].trackId).kind, 'video');
    assert.strictEqual(r.tracks.length, 3);
  });
  t('noVisualsYet: only clips on video tracks count', () => {
    assert.ok(noVisualsYet([], [V1, T1, A1]));
    assert.ok(noVisualsYet([mediaClip({ id: 'a', trackId: A1.id })], [V1, T1, A1]));
    assert.ok(!noVisualsYet([mediaClip({ id: 'v', trackId: V1.id })], [V1, T1, A1]));
  });
  t('clock formats recorded time', () => {
    assert.strictEqual(clock(0), '0:00');
    assert.strictEqual(clock(754.9), '12:34');
    assert.strictEqual(clock(3723), '1:02:03');
  });
}
