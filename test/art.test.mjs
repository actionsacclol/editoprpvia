// Drawn visual styles for long videos (src/editor/art): the catalogue, the director that turns
// narration into beats, and how a drawn scene sits in the plan. Run from editor.test.mjs.
// The drawing itself needs a canvas (and WebGL for the 3D styles): it is checked live, not here.
import assert from 'node:assert';
import { ACTIONS, ART_STYLES, LONGFORM_FORMATS, STICK_POSES, TOOLS, artHelp, cueProblems, directBeats, estimateLines, figureIn, findArt, phraseTime, planLongform, runAgentTool, sceneSize, stickProps, useTimelineStore } from './.editor.mjs';

export async function run({ t, ta, approx }) {
  const TEXT = 'Have you ever wondered how bees find flowers? A single hive visits two million flowers. That is wrong, most people say. You can see it in your own garden.';
  const lines = estimateLines(TEXT, 12);
  const starts = (beats) => beats.map((b) => b.start);

  t('art: eight styles, two engines, found by name and by what people call them', () => {
    assert.deepStrictEqual(ART_STYLES.map((s) => s.id), ['stickman', 'whiteboard', 'chalkboard', 'blueprint', 'night', 'clay', 'cartoon', 'retro']);
    for (const s of ART_STYLES) {
      assert.ok(s.engine === 'stick' ? s.look : s.art, s.id);
      assert.match(s.card.background, /^#[0-9a-f]{6}$/i);
      assert.match(s.highlight, /^#[0-9a-f]{6}$/i);
    }
    assert.strictEqual(findArt('Stickman').id, 'stickman');
    assert.strictEqual(findArt('3d render').id, 'clay');
    assert.strictEqual(findArt('3D').id, 'clay');
    assert.strictEqual(findArt('low poly').id, 'retro');
    assert.strictEqual(findArt('chalk').id, 'chalkboard');
    assert.strictEqual(findArt('3D cartoon').id, 'cartoon');
    assert.strictEqual(findArt('oil painting'), undefined);
    const help = artHelp();
    assert.strictEqual(help.visual_styles.length, 8);
    for (const p of STICK_POSES) assert.ok(help.scenes.includes(p), p);
  });

  t('art: one beat per sentence, back to back, covering the whole picture', () => {
    const beats = directBeats(lines, 13, [], 'stick');
    assert.strictEqual(beats.length, lines.length);
    approx(beats[0].start, 0, 1e-9);
    for (let i = 1; i < beats.length; i++) approx(beats[i - 1].start + beats[i - 1].dur, beats[i].start, 1e-6);
    approx(beats[beats.length - 1].start + beats[beats.length - 1].dur, 13, 1e-6);
    // A beat starts a breath before its line, and knows when in it the line is said (the mouth follows that).
    for (let i = 1; i < beats.length; i++) {
      assert.ok(beats[i].start <= lines[i].start && lines[i].start - beats[i].start < 0.2);
      approx(beats[i].start + beats[i].voStart, lines[i].start, 1e-6);
      approx(beats[i].voDur, lines[i].end - lines[i].start, 1e-6);
      assert.strictEqual(beats[i].say, lines[i].text);
    }
  });

  t('art: the pose is read from the words, never the same twice running', () => {
    const beats = directBeats(lines, 13, [], 'stick');
    assert.ok(['shrug', 'think'].includes(beats[0].pose), beats[0].pose); // a question
    assert.strictEqual(beats[0].props, 'question');
    assert.strictEqual(beats[1].word, '2 MILLION'); // a figure pops in as the big word
    assert.ok(['facepalm', 'sad'].includes(beats[2].pose), beats[2].pose); // "wrong"
    assert.strictEqual(beats[2].camera, 'close');
    assert.ok(['point', 'talk'].includes(beats[3].pose), beats[3].pose); // "you"
    for (const b of beats) assert.ok(STICK_POSES.includes(b.pose), b.pose);
    const flat = directBeats(estimateLines('It is. It was. It will be. It has been. It might be. It could be.', 12), 12, [], 'stick');
    for (let i = 1; i < flat.length; i++) assert.notStrictEqual(flat[i].pose, flat[i - 1].pose);
    assert.strictEqual(figureIn('It costs $3 million a year.'), '$3 MILLION');
    assert.strictEqual(figureIn('About 40 percent of them.'), '40%');
    assert.strictEqual(figureIn('Nothing to count here.'), '');
  });

  t('art: the 3D character only gets actions it has, and no props', () => {
    const text = 'He typed all night. Then he ran for the door. He gave a thumbs up, it works!';
    const beats = directBeats(estimateLines(text, 9), 9, [], 'mascot');
    for (const b of beats) {
      assert.ok(ACTIONS.includes(b.pose), b.pose);
      assert.strictEqual(b.props, '');
    }
    const cued = directBeats(estimateLines(text, 9), 9, [{ pose: 'type', props: 'desk;laptop', word: 'CODE' }], 'mascot');
    assert.strictEqual(cued[0].pose, 'think');
    assert.strictEqual(cued[0].props, '');
    assert.strictEqual(cued[0].word, 'CODE');
  });

  t('art: cues go where they say, and one inside a sentence starts a new beat there', () => {
    const at = (p) => phraseTime(p, lines)?.time ?? null;
    // By phrase: the third sentence.
    const byPhrase = directBeats(lines, 13, [{ when: 'that is wrong', pose: 'angry', word: 'WRONG', props: 'sign=NOPE', camera: 'wide' }], 'stick', at);
    assert.strictEqual(byPhrase.length, lines.length);
    assert.deepStrictEqual({ pose: byPhrase[2].pose, word: byPhrase[2].word, props: byPhrase[2].props, camera: byPhrase[2].camera }, { pose: 'angry', word: 'WRONG', props: 'sign=NOPE', camera: 'wide' });
    // By time, in the middle of the second sentence: it is cut in two, the line carries on.
    const mid = (lines[1].start + lines[1].end) / 2;
    const split = directBeats(lines, 13, [{ at: mid, pose: 'cheer' }], 'stick', at);
    assert.strictEqual(split.length, lines.length + 1);
    approx(split[2].start, mid, 1e-6);
    assert.strictEqual(split[2].pose, 'cheer');
    assert.strictEqual(split[2].say, lines[1].text);
    approx(split[2].start + split[2].voStart, lines[1].start, 1e-6);
    approx(split[1].start + split[1].dur, mid, 1e-6);
    assert.deepStrictEqual(starts(split), [...starts(split)].sort((a, b) => a - b));
    // No time and no phrase: spread over the sentences in order.
    const spread = directBeats(lines, 13, [{ pose: 'wave' }, { pose: 'sleep' }], 'stick', at);
    assert.strictEqual(spread[0].pose, 'wave');
    assert.strictEqual(spread[2].pose, 'sleep');
    // Two figures.
    assert.strictEqual(directBeats(lines, 13, [{ pose: 'think/type' }], 'stick', at)[0].pose, 'think/type');
  });

  t('art: a cue that names nothing the style has is refused in words', () => {
    assert.deepStrictEqual(cueProblems([{ pose: 'wave', props: 'desk;sign=HI' }, {}], 'stick', 'Section "A"'), []);
    assert.match(cueProblems([{ pose: 'backflip' }], 'stick', 'Section "A"')[0], /Section "A": scene 1 has pose "backflip"\. Use one of: idle, talk/);
    assert.match(cueProblems([{ props: 'desk;dragon' }], 'stick', 'Section "A"')[0], /a prop the stickman does not have/);
    assert.match(cueProblems([{ pose: 'backflip' }], 'mascot', 'hook_scenes')[0], /Use one of: talk, point/);
    assert.strictEqual(stickProps('desk;B:phone;sign=FREE;dragon').length, 3);
  });

  t('art: a drawn scene is drawn at the frame shape, capped, with even sides', () => {
    assert.deepStrictEqual(sceneSize({ width: 1920, height: 1080 }), { w: 1920, h: 1080 });
    assert.deepStrictEqual(sceneSize({ width: 1080, height: 1920 }), { w: 1080, h: 1920 });
    assert.deepStrictEqual(sceneSize({ width: 3840, height: 2160 }), { w: 1920, h: 1080 });
    const odd = sceneSize({ width: 1081, height: 1351 });
    assert.ok(odd.w % 2 === 0 && odd.h % 2 === 0);
  });

  t('art: in the plan a drawn scene is one clip played as it is', () => {
    const A = 'Bees see ultraviolet light. Flowers use that to guide them. A single hive visits two million flowers.';
    const plan = planLongform({
      script: { title: 'Bees', sections: [{ heading: 'What bees see', text: A, points: ['Ultraviolet', 'Two million'], visuals: [{ mediaId: 'scene', fit: 'fill' }] }] },
      format: LONGFORM_FORMATS.find((f) => f.id === 'explainer'),
      canvas: { width: 3840, height: 2160 },
      narration: { sections: [{ mediaId: 'n1', duration: 12, lines: estimateLines(A, 12) }] },
      media: new Map([['scene', { kind: 'video', width: 1920, height: 1080, duration: 13.1, generated: true }]]),
      card: { look: 'clean' },
      captions: null,
      transition: { type: 'fade', duration: 0.45 },
      start: 0,
      tracks: { video: 'v', presenter: 'v', narration: 'an', music: '', text: 'tt', captions: '' },
    });
    const drawn = plan.clips.filter((c) => c.type === 'media' && c.mediaId === 'scene');
    assert.strictEqual(drawn.length, 1);
    const voice = plan.clips.find((c) => c.type === 'media' && c.mediaId === 'n1');
    // It starts with the narration (its beats were timed against it) and fills the frame without a slow move.
    approx(drawn[0].start, voice.start, 1e-6);
    assert.ok(drawn[0].duration >= 12 && drawn[0].duration <= 13.1 + 1e-6, JSON.stringify(drawn.map((c) => [c.start, c.duration, c.motion, c.scaleX])));
    assert.strictEqual(drawn[0].motion, 'none');
    assert.strictEqual(drawn[0].inPoint ?? 0, 0);
    // Scale 1 is "fits the frame": drawn at the frame's own shape, it fills it at any canvas size.
    approx(drawn[0].scaleX, 1, 1e-6);
    assert.strictEqual(plan.sections[0].scene, 'pictures');
  });

  await ta('art: build_longform refuses a wrong visual style or cue before any work', async () => {
    const call = (args) => runAgentTool({ rid: 1, tool: 'build_longform', args, client: 'test' }, () => undefined, new AbortController().signal);
    const sections = [{ heading: 'A', text: 'Hello there.' }];
    const before = useTimelineStore.getState().past.length;
    const style = await call({ title: 'T', visual_style: 'oil painting', sections });
    assert.ok(!style.ok && /No visual style "oil painting"\. Use one of: stickman, whiteboard/.test(style.text), style.text);
    const pose = await call({ title: 'T', visual_style: 'stickman', sections: [{ ...sections[0], scenes: [{ pose: 'backflip' }] }] });
    assert.ok(!pose.ok && /scene 1 has pose "backflip"/.test(pose.text), pose.text);
    const loose = await call({ title: 'T', sections: [{ ...sections[0], scenes: [{ pose: 'wave' }] }] });
    assert.ok(!loose.ok && /need visual_style/.test(loose.text), loose.text);
    assert.strictEqual(useTimelineStore.getState().past.length, before);
    const input = TOOLS.find((x) => x.name === 'build_longform').input;
    assert.ok(input.safeParse({ title: 'T', visual_style: 'clay', character_color: '#22c55e', hook_scenes: [{ pose: 'wave' }], sections: [{ heading: 'A', text: 'Hi.', scenes: [{ when: 'hi', pose: 'think/type', word: 'HI', props: 'desk;laptop', camera: 'close' }] }] }).success);
    assert.ok(!input.safeParse({ title: 'T', sections: [{ heading: 'A', text: 'Hi.', scenes: [{ camera: 'sideways' }] }] }).success);
  });
}
