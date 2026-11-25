// The longform formats added after the first six (src/editor/longform.ts):
// product walkthrough, comparison, news recap, data story, timeline, podcast,
// commentary. What each one puts on screen beyond the usual. Run from
// editor.test.mjs; the narration is estimated, so plans are pure.
import assert from 'node:assert';
import { AGENT_CAPTURE_PROMPTS, AGENT_TOOL_NAMES, LONGFORM_EXAMPLES, LONGFORM_FORMATS, comparisonSides, estimateLines, findFormat, parseScript, planLongform, runAgentTool, speakerNames, speakerTurns } from './.editor.mjs';

export async function run({ t, ta, approx }) {
  const CANVAS = { width: 1920, height: 1080 };
  const TRACKS = { video: 'v', presenter: 'vp', narration: 'an', music: 'am', text: 'tt', captions: 'tc' };
  const A = 'The first one opens in a second. You type a few words and it finds the note. Nothing else is needed.';
  const B = 'The second one takes longer to start. It asks you to sign in first. After that it is quick.';
  const C = 'Both of them cost the same. One of them gives you more for it.';
  const narr = (id, text, duration, speakers) => ({ mediaId: id, duration, lines: estimateLines(text, duration).map((l, i) => (speakers ? { ...l, speaker: speakers[i % speakers.length] } : l)) });
  const media = new Map([
    ['shot', { kind: 'image', width: 1920, height: 1080, duration: 5 }],
    ['tall', { kind: 'image', width: 900, height: 1600, duration: 5 }],
    ['rec', { kind: 'video', width: 1280, height: 800, duration: 30 }],
    ['rec2', { kind: 'video', width: 1280, height: 800, duration: 4 }],
    ['cam', { kind: 'video', width: 1280, height: 720, duration: 20 }],
  ]);
  const format = (id) => LONGFORM_FORMATS.find((f) => f.id === id);
  const plan = (id, script, over = {}) =>
    planLongform({
      script: { title: 'Acme vs Bolt', hook: 'Two tools for one job.', outro: { text: 'That is all.' }, ...script },
      format: format(id),
      canvas: CANVAS,
      narration: { hook: narr('n0', 'Two tools for one job.', 3), sections: script.sections.map((s, i) => narr(`n${i + 1}`, s.text, 10)), outro: narr('nz', 'That is all.', 1.5) },
      media,
      card: { look: 'clean' },
      captions: { patch: { fontSize: 56 }, upper: false },
      transition: { type: 'fade', duration: 0.45 },
      start: 0,
      tracks: TRACKS,
      ...over,
    });
  const on = (p, track) => p.clips.filter((c) => c.trackId === track).sort((a, b) => a.start - b.start);
  const texts = (p) => p.clips.filter((c) => c.type === 'text').map((c) => c.text);
  const end = (c) => c.start + c.duration;

  t('formats: the seven new ones are there, and the names people use find them', () => {
    const ids = ['product-walkthrough', 'comparison', 'news-recap', 'data-story', 'timeline', 'podcast', 'commentary'];
    for (const id of ids) assert.ok(format(id), id);
    assert.strictEqual(LONGFORM_FORMATS.length, 16);
    assert.strictEqual(findFormat('Product walkthrough').id, 'product-walkthrough');
    assert.strictEqual(findFormat('walkthrough').id, 'product-walkthrough');
    assert.strictEqual(findFormat('X vs Y').id, 'comparison');
    assert.strictEqual(findFormat('versus').id, 'comparison');
    assert.strictEqual(findFormat('weekly roundup').id, 'news-recap');
    assert.strictEqual(findFormat('news').id, 'news-recap');
    assert.strictEqual(findFormat('data story').id, 'data-story');
    assert.strictEqual(findFormat('case study').id, 'timeline');
    assert.strictEqual(findFormat('interview').id, 'podcast');
    assert.strictEqual(findFormat('reaction').id, 'commentary');
    // Every format that frames or splits its pictures says what goes behind them.
    for (const f of LONGFORM_FORMATS) if (f.framed || f.split) assert.ok(f.backdrop?.length === 2, f.id);
  });

  t('formats: a section\'s own facts are read from the typed script', () => {
    const s = parseScript(['# Paper vs Screen', '', 'Hook.', '', '## Focus', 'Winner: Paper', 'A book does one thing.', '', '## The first flight', 'Date: March 1903', 'It flew.', 'Date: this is said, not a date line', '', '## Of the surface', 'Figure: 71%', 'Water.'].join('\n'));
    assert.strictEqual(s.sections[0].winner, 'Paper');
    assert.strictEqual(s.sections[0].text, 'A book does one thing.');
    assert.strictEqual(s.sections[1].kicker, 'March 1903');
    // Only before the narration starts: later it is just a sentence.
    assert.strictEqual(s.sections[1].text, 'It flew. Date: this is said, not a date line');
    assert.strictEqual(s.sections[2].figure, '71%');
    // The examples carry them.
    assert.ok(parseScript(LONGFORM_EXAMPLES.comparison).sections.every((x) => x.winner));
    assert.ok(parseScript(LONGFORM_EXAMPLES['data-story']).sections.every((x) => x.figure));
    assert.ok(parseScript(LONGFORM_EXAMPLES.timeline).sections.every((x) => x.kicker));
  });

  t('product walkthrough: recordings are windows on a backdrop, named in a lower third, with what it does at the end', () => {
    const p = plan('product-walkthrough', { title: 'Meet Acme', sections: [{ heading: 'Find any note', text: A, visuals: [{ mediaId: 'rec' }] }, { heading: 'Sign in once', text: B, visuals: [{ mediaId: 'shot' }, { mediaId: 'tall' }] }] });
    const pics = on(p, 'v');
    assert.ok(pics.length >= 3);
    for (const c of pics) {
      approx(c.scaleX, 0.86, 1e-6);
      assert.strictEqual(c.cornerRadius, 0.025);
      assert.strictEqual(c.shadow, 0.6);
    }
    // One steady picture per visual: a window is not re-framed.
    assert.strictEqual(pics.filter((c) => c.mediaId === 'shot').length, 1);
    assert.deepStrictEqual(p.backdrop, ['#4F46E5', '#A855F7']);
    assert.strictEqual(p.fitted, false);
    const said = texts(p);
    assert.ok(said.some((x) => /F\s*E\s*A\s*T\s*U\s*R\s*E\s+1/i.test(x)), 'the lower third counts features');
    assert.ok(said.includes('Find any note') && said.some((x) => /what it does/i.test(x)), said.join(' | '));
  });

  t('comparison: two pictures sit side by side under the two names, and the winner is marked', () => {
    assert.deepStrictEqual(comparisonSides({ title: 'Acme vs Bolt' }), ['Acme', 'Bolt']);
    assert.deepStrictEqual(comparisonSides({ title: 'iPhone vs. Pixel: which camera wins?' }), ['iPhone', 'Pixel']);
    assert.deepStrictEqual(comparisonSides({ title: 'Tea versus Coffee' }), ['Tea', 'Coffee']);
    assert.deepStrictEqual(comparisonSides({ title: 'Which is best', sides: ['Left one', 'Right one'] }), ['Left one', 'Right one']);
    assert.strictEqual(comparisonSides({ title: 'Just a title' }), null);

    const p = plan('comparison', {
      sections: [
        { heading: 'Speed', text: A, winner: 'Acme', visuals: [{ mediaId: 'rec' }, { mediaId: 'rec2' }] },
        { heading: 'Sign in', text: B, winner: 'bolt', visuals: [{ mediaId: 'shot' }, { mediaId: 'tall' }, { mediaId: 'shot' }] },
        { heading: 'Price', text: C, winner: 'Tie', points: ['Both: ten a month'] },
      ],
    });
    const s0 = p.sections[0];
    const left = on(p, 'v').filter((c) => c.start >= s0.speech - 1e-6 && c.start < s0.end);
    const right = on(p, 'vp').filter((c) => c.start >= s0.speech - 1e-6 && c.start < s0.end);
    assert.ok(left.length >= 1 && right.length >= 1);
    assert.ok(left.every((c) => c.posX < -0.2) && right.every((c) => c.posX > 0.2));
    // Each fits its half: under half the frame wide, never cropped.
    for (const c of [...left, ...right]) {
      const fit = Math.min(1920 / c.sourceWidth, 1080 / c.sourceHeight);
      const wide = (c.sourceWidth * fit * c.scaleX) / 1920;
      const high = (c.sourceHeight * fit * c.scaleY) / 1080;
      assert.ok(wide <= 0.4551 && high <= 0.5601 && c.cornerRadius > 0 && c.shadow > 0, `${wide} × ${high}`);
      // Inside its own half of the frame.
      assert.ok(Math.abs(c.posX) + wide / 2 < 0.5 && Math.abs(c.posX) - wide / 2 > 0);
    }
    // The short clip on the right plays again until the section ends.
    assert.ok(right.length >= 2 && Math.abs(end(right[right.length - 1]) - s0.end) < 0.05);
    assert.ok(p.backdrop);
    const in0 = p.clips.filter((c) => c.type === 'text' && c.start >= s0.speech && c.start < s0.end);
    const name = (n) => in0.find((c) => c.text === n);
    assert.ok(name('Acme').x < 0.5 && name('Bolt').x > 0.5 && in0.some((c) => c.text === 'VS'));
    const badge = in0.filter((c) => /W\s*I\s*N\s*N\s*E\s*R/.test(c.text));
    assert.strictEqual(badge.length, 1);
    assert.ok(badge[0].x < 0.5 && badge[0].start > s0.speech + 1, 'the mark is on the winner, once the case is made');
    // Second round: the other side wins (any capitals); the odd third picture has the frame to itself.
    const s1 = p.sections[1];
    const badge1 = p.clips.filter((c) => c.type === 'text' && c.start >= s1.speech && c.start < s1.end && /W\s*I\s*N\s*N\s*E\s*R/.test(c.text));
    assert.ok(badge1.length === 1 && badge1[0].x > 0.5);
    const alone = on(p, 'v').filter((c) => c.start >= s1.speech && c.start < s1.end && Math.abs(c.posX ?? 0) < 1e-6);
    assert.ok(alone.length >= 1);
    // A tie marks no one. The verdict lists who took each round.
    const s2 = p.sections[2];
    assert.ok(!p.clips.some((c) => c.type === 'text' && c.start >= s2.speech && c.start < s2.end && /W\s*I\s*N\s*N\s*E\s*R/.test(c.text)));
    const said = texts(p);
    assert.ok(said.some((x) => /verdict/i.test(x)) && said.some((x) => x.includes('Speed: Acme')) && said.some((x) => /R\s*O\s*U\s*N\s*D\s+2/i.test(x) || /Round 2/i.test(x)), said.join(' | '));
    // No two clips on one lane at once.
    for (const lane of ['v', 'vp']) {
      const c = on(p, lane);
      for (let i = 1; i < c.length; i++) assert.ok(c[i].start >= end(c[i - 1]) - 0.5, `${lane}: ${c[i - 1].start}+${c[i - 1].duration} then ${c[i].start}`);
    }
  });

  t('news recap: the headlines are listed under the opening, and a sweep covers each change of story', () => {
    const script = { title: 'The week', sections: [{ heading: 'The bakery has a new owner', text: A, visuals: [{ mediaId: 'shot' }] }, { heading: 'The bridge is open again', text: B, visuals: [{ mediaId: 'shot' }] }, { heading: 'The library stays open late', text: C, visuals: [{ mediaId: 'shot' }] }] };
    const p = plan('news-recap', script);
    const said = texts(p);
    assert.ok(said.some((x) => /in this video/i.test(x)), said.join(' | '));
    // Each headline twice: in the rundown and in its lower third.
    for (const s of script.sections) assert.ok(said.filter((x) => x.replace(/\n/g, ' ').includes(s.heading)).length >= 2, s.heading);
    const sweeps = new Set(p.clips.filter((c) => c.type === 'shape' && c.group && c.w >= 1 && c.duration < 2).map((c) => c.group));
    assert.ok(sweeps.size >= 2, `sweeps: ${sweeps.size}`);
    // With pictures for the opening there is no rundown: the pictures have the frame.
    const q = plan('news-recap', { ...script, hookVisuals: [{ mediaId: 'shot' }] });
    assert.ok(!texts(q).some((x) => /in this video/i.test(x)));
  });

  t('data story: each part opens on its figure, and a chart is never cropped', () => {
    const p = plan('data-story', { title: 'Water', sections: [{ heading: 'Of the surface is water', figure: '71%', text: A, visuals: [{ mediaId: 'tall' }] }, { heading: 'No figure here', text: B }] });
    const cards = p.clips.filter((c) => c.type === 'text');
    const big = cards.find((c) => c.text === '71%');
    const label = cards.find((c) => c.text.replace(/\n/g, ' ') === 'Of the surface is water' && Math.abs(c.start - big.start) < 0.6);
    assert.ok(big && label && big.fontSize > label.fontSize, 'the figure is the large line, the heading under it');
    const chart = on(p, 'v').find((c) => c.mediaId === 'tall');
    approx(chart.scaleX, 1, 1e-6);
    assert.strictEqual(p.fitted, true);
    assert.strictEqual(p.backdrop, undefined);
    // The same tall picture fills the frame in an explainer.
    const e = plan('explainer', { title: 'Water', sections: [{ heading: 'A', text: A, visuals: [{ mediaId: 'tall', fit: 'fill' }] }] });
    assert.ok(on(e, 'v').find((c) => c.mediaId === 'tall').scaleX > 1.5);
  });

  t('timeline: the date stands above the heading, and a bar fills as the story goes', () => {
    const p = plan('timeline', { title: 'Flight', sections: [{ heading: 'The first flight', kicker: '1903', text: A, visuals: [{ mediaId: 'shot' }] }, { heading: 'Across the ocean', kicker: '1927', text: B, visuals: [{ mediaId: 'shot' }] }, { heading: 'On the Moon', kicker: '1969', text: C }] });
    const said = texts(p);
    for (const year of ['1903', '1927']) assert.ok(said.some((x) => x.replace(/\s/g, '') === year), `${year}: ${said.join(' | ')}`);
    const bars = p.sections.map((s) => p.clips.filter((c) => c.type === 'shape' && c.y < 0.05 && c.h < 0.02 && Math.abs(c.start - s.speech) < 1e-6));
    bars.forEach((b, i) => {
      assert.strictEqual(b.length, 2, `section ${i + 1}`);
      const fill = b.find((c) => c.fill === '#ffffff');
      const track = b.find((c) => c !== fill);
      // A third, two thirds, all of it; from the left edge of a track that spans the frame.
      approx(fill.w, (0.9 * (i + 1)) / 3, 1e-6);
      approx(fill.x - fill.w / 2, 0.05, 1e-6);
      assert.ok(track.w >= 0.9 && track.h > fill.h && track.opacity < 1);
    });
    // A kicker of one's own works in any format.
    const e = plan('explainer', { title: 'T', sections: [{ heading: 'One', kicker: 'Berlin', text: A }, { heading: 'Two', text: B }] });
    assert.ok(texts(e).some((x) => x.replace(/\s/g, '') === 'BERLIN' || x.replace(/\s/g, '') === 'Berlin'));
  });

  t('podcast: turns are found by name, and each line is shown with who says it', () => {
    const hook = 'Maya: Tom, you just yawned. Why?\n\nTom: Nobody is sure.';
    const body = 'Maya: So what is a yawn for? Tom: One idea is that it cools the brain. Here is the thing: it is a guess. Maya: Like opening a window.';
    assert.deepStrictEqual(speakerNames([hook, body]), ['Maya', 'Tom']);
    // A colon in a sentence is not a speaker; nor is a script without any turns.
    assert.deepStrictEqual(speakerNames(['Here is the thing: it works. Another point: it is cheap.']), []);
    assert.deepStrictEqual(speakerNames([undefined, '']), []);
    assert.deepStrictEqual(speakerTurns(body, ['Maya', 'Tom']), [
      { speaker: 'Maya', text: 'So what is a yawn for?' },
      { speaker: 'Tom', text: 'One idea is that it cools the brain. Here is the thing: it is a guess.' },
      { speaker: 'Maya', text: 'Like opening a window.' },
    ]);
    assert.deepStrictEqual(speakerTurns('Welcome back. Maya: Hello.', ['Maya']), [{ text: 'Welcome back.' }, { speaker: 'Maya', text: 'Hello.' }]);
    assert.deepStrictEqual(speakerTurns('No names here.', []), [{ text: 'No names here.' }]);
    // The example is a conversation between two.
    const ex = parseScript(LONGFORM_EXAMPLES.podcast);
    assert.deepStrictEqual(speakerNames([ex.hook, ...ex.sections.map((x) => x.text), ex.outro?.text]), ['Maya', 'Tom']);

    const text = 'So what is a yawn for? One idea is that it cools the brain. And it stretches the jaw. Like opening a window.';
    const p = plan('podcast', { title: 'Why do we yawn?', sections: [{ heading: 'What a yawn does', text }, { heading: 'Why it spreads', text: B }] }, { narration: { sections: [{ ...narr('n1', text, 10), lines: estimateLines(text, 10).map((l, i) => ({ ...l, speaker: ['Maya', 'Tom', 'Tom', 'Maya'][i] })) }, narr('n2', B, 8)] } });
    const s0 = p.sections[0];
    const names = p.clips.filter((c) => c.type === 'text' && c.start >= s0.speech && c.start < s0.end && /^(M\s*A\s*Y\s*A|T\s*O\s*M)$/i.test(c.text.trim()));
    // Maya, Tom (held over his two lines), Maya.
    assert.strictEqual(names.length, 3, names.map((c) => c.text).join(' | '));
    assert.ok(names[1].duration > names[0].duration, 'the name stays while the same person goes on');
    // A part with no speakers shows no names.
    const s1 = p.sections[1];
    assert.ok(!p.clips.some((c) => c.type === 'text' && c.start >= s1.speech && c.start < s1.end && /^(M\s*A\s*Y\s*A|T\s*O\s*M)$/i.test(c.text.trim())));
  });

  t('commentary: the clips are framed, and the presenter of the whole video carries on from part to part', () => {
    const cam = { mediaId: 'cam' };
    const p = plan('commentary', { title: 'My take', presenter: cam, sections: [{ heading: 'You see less', text: A, visuals: [{ mediaId: 'rec' }] }, { heading: 'You hear less', text: B, visuals: [{ mediaId: 'rec' }] }, { heading: 'Own camera', text: C, visuals: [{ mediaId: 'shot' }], presenter: { mediaId: 'cam', corner: 'bottom-left' } }] });
    assert.ok(on(p, 'v').every((c) => c.cornerRadius > 0 && Math.abs(c.scaleX - 0.86) < 1e-6));
    assert.ok(p.backdrop);
    const cams = on(p, 'vp');
    // The opening and three sections.
    assert.strictEqual(cams.length, 4);
    assert.strictEqual(cams[0].inPoint, 0);
    assert.ok(cams[1].inPoint >= cams[0].duration - 1e-6, 'the second part starts where the first left the recording');
    assert.ok(cams[2].inPoint > cams[1].inPoint || cams[2].inPoint === 0);
    for (const c of cams.slice(0, 3)) assert.ok(c.inPoint + c.duration <= 20 + 1e-6 && c.posX > 0);
    // A section's own presenter is used as given.
    assert.ok(cams[3].posX < 0 && cams[3].inPoint === 0);
  });

  t('formats: the prompts for footage the agent makes name tools that exist', () => {
    assert.ok(AGENT_CAPTURE_PROMPTS.length >= 2);
    for (const name of ['capture_web', 'record_window', 'build_longform', 'product_demo']) assert.ok(AGENT_TOOL_NAMES.includes(name), name);
  });

  await ta('list_formats says what each new format adds', async () => {
    const r = await runAgentTool({ rid: 0, tool: 'list_formats', args: {}, client: 'test' }, () => undefined, new AbortController().signal);
    assert.ok(r.ok, r.text);
    const by = Object.fromEntries(JSON.parse(r.text).formats.map((f) => [f.id, f]));
    assert.ok(by.comparison.also.some((x) => /side by side/.test(x)));
    assert.ok(by['product-walkthrough'].also.some((x) => /window frame/.test(x)));
    assert.ok(by.podcast.also.some((x) => /two voices/.test(x)));
    assert.ok(by.timeline.also.some((x) => /bar/.test(x)));
    assert.match(by['data-story'].each_section_opens_with, /figure/);
    assert.strictEqual(by.explainer.also, undefined);
  });
}
