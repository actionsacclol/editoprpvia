// Comic panels in long videos (src/editor/longform.ts, art/bake.ts), thumbnails
// (src/editor/thumbnail.ts) and a channel as the example (shared/channelStudy.ts).
// Run from editor.test.mjs. Nothing here touches the network: feeds are written
// out in YouTube's shape.
import assert from 'node:assert';
import {
  AGENT_TOOL_NAMES,
  LONGFORM_FORMATS,
  MIN_PANEL,
  THUMB,
  balanceLines,
  channelFeedUrl,
  channelIdIn,
  channelTarget,
  describeStudy,
  directBeats,
  estimateLines,
  findFormat,
  fitThumb,
  hexColor,
  inkOn,
  paletteOf,
  panelSlots,
  panelTime,
  parseChannelFeed,
  planLongform,
  runAgentTool,
  studyChannel,
  thumbBox,
  thumbColorsFrom,
  thumbVariants,
  thumbWords,
  titleHabits,
  videoThumbUrl,
} from './.editor.mjs';

export async function run({ t, ta, approx }) {
  const CANVAS = { width: 1920, height: 1080 };
  const TRACKS = { video: 'v', presenter: 'vp', narration: 'an', music: 'am', text: 'tt', captions: 'tc' };
  const STORY = 'The alarm did not go off. Sam ran for the bus and missed it by a second. Then the rain started, slowly at first, and it did not stop for the rest of that long grey morning. He laughed.';
  const comic = LONGFORM_FORMATS.find((f) => f.id === 'comic-story');
  const plan = (format, media, visuals, over = {}) =>
    planLongform({
      script: { title: 'A bad morning', sections: [{ heading: 'The bus', text: STORY, visuals }] },
      format,
      canvas: CANVAS,
      narration: { sections: [{ mediaId: 'n1', duration: 16, lines: estimateLines(STORY, 16) }] },
      media: new Map(media),
      card: { look: 'clean' },
      captions: { patch: { fontSize: 56 }, upper: false },
      transition: { type: 'fade', duration: 0.45 },
      start: 0,
      tracks: TRACKS,
      ...over,
    });
  const pictures = (p) => p.clips.filter((c) => c.type === 'media' && c.trackId === 'v').sort((a, b) => a.start - b.start);

  t('comic: the format is there, drawn as panels by default, and the names people use find it', () => {
    assert.ok(comic);
    assert.strictEqual(comic.panels, true);
    assert.strictEqual(comic.visualStyle, 'stickman');
    for (const name of ['comic', 'Comic story', 'comic book', 'storyboard', 'stickman story']) assert.strictEqual(findFormat(name)?.id, 'comic-story', name);
    // The seconds after which a panel moves: the three-to-five the format is built around.
    assert.ok(comic.hold >= 3 && comic.hold <= 5);
  });

  t('comic: a panel per sentence, cut in on its words; only the ones held long enough move', () => {
    const lines = estimateLines(STORY, 16);
    const beats = directBeats(lines, 16.85, [], 'stick');
    const slots = panelSlots(beats);
    assert.strictEqual(slots.length, 4);
    const media = slots.map((s, i) => [`p${i}`, { kind: 'image', width: 1920, height: 1080, duration: 0, panel: true }]);
    const p = plan(comic, media, slots.map((s, i) => ({ mediaId: `p${i}`, at: s.start, fit: 'fill' })));
    const shown = pictures(p);
    assert.strictEqual(shown.length, 4, JSON.stringify(shown.map((c) => [c.start, c.duration])));
    const voice = p.clips.find((c) => c.type === 'media' && c.mediaId === 'n1');
    shown.forEach((c, i) => {
      // Each comes up where its beat starts, and stays until the next one: no hole, no overlap.
      approx(c.start, voice.start + slots[i].start, 1e-6);
      if (i + 1 < shown.length) approx(c.start + c.duration, shown[i + 1].start, 1e-6);
      // One framing each (a still is not re-framed every few seconds) and a cut, not a dissolve.
      assert.strictEqual(c.transition ?? 'none', 'none');
      approx(c.scaleX, 1, 1e-6);
      // The rule the format is named for.
      assert.strictEqual(c.motion !== 'none', c.duration >= comic.hold, `panel ${i}: ${c.duration}s, ${c.motion}`);
      if (c.motion !== 'none') assert.ok(c.motionAmount <= 0.45, 'slight');
    });
    assert.ok(shown.some((c) => c.motion !== 'none') && shown.some((c) => c.motion === 'none'), JSON.stringify(shown.map((c) => [c.duration, c.motion])));
    assert.strictEqual(p.notes.filter((n) => /left out/.test(n)).length, 0);
  });

  t('comic: the seconds can be changed, and zero means stills only', () => {
    const lines = estimateLines(STORY, 16);
    const slots = panelSlots(directBeats(lines, 16.85, [], 'stick'));
    const media = slots.map((s, i) => [`p${i}`, { kind: 'image', width: 1920, height: 1080, duration: 0, panel: true }]);
    const visuals = slots.map((s, i) => ({ mediaId: `p${i}`, at: s.start, fit: 'fill' }));
    const all = pictures(plan(comic, media, visuals, { panelMoveAfter: 1 }));
    assert.ok(all.every((c) => c.motion !== 'none'));
    const none = pictures(plan(comic, media, visuals, { panelMoveAfter: Infinity }));
    assert.ok(none.every((c) => c.motion === 'none'));
  });

  t('comic: a held panel that was acted out is one clip, played once, drifting', () => {
    const p = plan(
      comic,
      [
        ['a', { kind: 'image', width: 1920, height: 1080, duration: 0, panel: true }],
        ['b', { kind: 'video', width: 1920, height: 1080, duration: 9, generated: true, panel: true }],
        ['c', { kind: 'image', width: 1920, height: 1080, duration: 0, panel: true }],
      ],
      [
        { mediaId: 'a', at: 0, fit: 'fill' },
        { mediaId: 'b', at: 3, fit: 'fill' },
        { mediaId: 'c', at: 12, fit: 'fill' },
      ],
    );
    const [a, b, c] = pictures(p);
    approx(b.start - a.start, 3, 1e-6);
    approx(b.duration, 9, 1e-6);
    assert.strictEqual(b.inPoint ?? 0, 0);
    assert.notStrictEqual(b.motion, 'none');
    assert.strictEqual(b.transition ?? 'none', 'none');
    assert.strictEqual(a.motion, 'none');
    approx(c.start, b.start + b.duration, 1e-6);
  });

  t('comic: the user\'s own pictures are panels too in this format, and ordinary pictures elsewhere', () => {
    const media = [
      ['x', { kind: 'image', width: 1600, height: 900, duration: 0 }],
      ['y', { kind: 'image', width: 1600, height: 900, duration: 0 }],
    ];
    const visuals = [{ mediaId: 'x' }, { mediaId: 'y', at: 3 }];
    const asPanels = pictures(plan(comic, media, visuals));
    assert.strictEqual(asPanels.length, 2);
    assert.strictEqual(asPanels[0].motion, 'none');
    assert.notStrictEqual(asPanels[1].motion, 'none');
    // An explainer re-frames a long still every few seconds instead.
    const explainer = pictures(plan(LONGFORM_FORMATS.find((f) => f.id === 'explainer'), media, visuals));
    assert.ok(explainer.length > 2);
    assert.ok(explainer.every((c) => c.motion !== 'none'));
  });

  t('comic: beats too short to read share the panel before them', () => {
    const slots = panelSlots([
      { start: 0, dur: 2 },
      { start: 2, dur: 0.6 },
      { start: 2.6, dur: 3 },
      { start: 5.6, dur: 0.4 },
    ]);
    assert.deepStrictEqual(slots.map((s) => s.beat), [0, 2]);
    approx(slots[0].dur, 2.6, 1e-9);
    approx(slots[1].dur, 3.4, 1e-9);
    // A short first beat takes the next one's time instead of vanishing.
    const first = panelSlots([
      { start: 0, dur: 0.5 },
      { start: 0.5, dur: 4 },
    ]);
    assert.deepStrictEqual(first, [{ beat: 0, start: 0, dur: 4.5 }]);
    assert.ok(panelSlots([{ start: 0, dur: 9 }]).every((s) => s.dur >= MIN_PANEL));
    // The still is taken once the pose has landed, inside its beat.
    for (const b of [{ start: 4, dur: 0.5 }, { start: 4, dur: 2 }, { start: 4, dur: 12 }]) {
      const at = panelTime(b);
      assert.ok(at >= b.start && at < b.start + b.dur, JSON.stringify([b, at]));
    }
    approx(panelTime({ start: 4, dur: 12 }), 5.6, 1e-9);
  });

  await ta('comic: build_longform refuses a wrong scene mode before any work, and list_formats explains the format', async () => {
    const call = (tool, args) => runAgentTool({ rid: 1, tool, args, client: 'test' }, () => undefined, new AbortController().signal);
    const sections = [{ heading: 'A', text: 'Hello there.' }];
    const bad = await call('build_longform', { title: 'T', format: 'comic-story', scene_mode: 'flipbook', sections });
    assert.ok(!bad.ok && /scene_mode is animated or panels/.test(bad.text), bad.text);
    const motion = await call('build_longform', { title: 'T', format: 'comic-story', panel_motion: 'spin', sections });
    assert.ok(!motion.ok && /panel_motion is animate or drift/.test(motion.text), motion.text);
    const r = await call('list_formats', {});
    const f = JSON.parse(r.text).formats.find((x) => x.id === 'comic-story');
    assert.ok(f.also.some((x) => /comic panels/.test(x)));
    assert.ok(f.also.some((x) => /stickman style/.test(x)));
  });

  // ── Thumbnails ──
  const ruler = (line, size) => line.length * size * 0.55;

  t('thumbnail: starred words take the colour; without stars the figure does, else the last word', () => {
    const flat = (text, upper) => thumbWords(text, upper).flat().map((w) => `${w.accent ? '*' : ''}${w.text}`);
    assert.deepStrictEqual(flat('I tried it for *30 days*'), ['I', 'TRIED', 'IT', 'FOR', '*30', '*DAYS']);
    assert.deepStrictEqual(flat('Why 40% quit'), ['WHY', '*40%', 'QUIT']);
    assert.deepStrictEqual(flat('The worst idea'), ['THE', 'WORST', '*IDEA']);
    assert.deepStrictEqual(flat('quiet', false), ['quiet']);
    // Lines typed are lines kept.
    assert.strictEqual(thumbWords('He said\n*no*').length, 2);
    assert.deepStrictEqual(thumbWords('  \n '), []);
  });

  t('thumbnail: a headline is broken so the longest line is as short as it can be', () => {
    const words = thumbWords('I tried waking up at five')[0];
    const two = balanceLines(words, 2).map((l) => l.map((w) => w.text).join(' '));
    assert.deepStrictEqual(two, ['I TRIED WAKING', 'UP AT FIVE']);
    const three = balanceLines(words, 3).map((l) => l.map((w) => w.text).join(' '));
    assert.strictEqual(three.length, 3);
    assert.ok(Math.max(...three.map((l) => l.length)) <= 9, JSON.stringify(three));
    assert.strictEqual(balanceLines(words, 9).length, words.length);
    assert.deepStrictEqual(balanceLines([], 2), [[]]);
  });

  t('thumbnail: the words fill their box and never leave it', () => {
    for (const layout of ['left', 'right', 'bottom', 'center']) {
      for (const text of ['NO', 'It broke', 'I tried waking up at five for a month', 'One\ntwo three\nfour']) {
        const fit = fitThumb(text, layout, true, ruler);
        const box = thumbBox(layout);
        const widest = Math.max(...fit.lines.map((l) => ruler(l.map((w) => w.text).join(' '), fit.size)));
        assert.ok(widest <= box.w * THUMB.width + 1, `${layout} "${text}" is ${widest} wide`);
        assert.ok(fit.lines.length * fit.lineHeight <= box.h * THUMB.height + 1, `${layout} "${text}" is too tall`);
        assert.ok(fit.size >= 24 && fit.size <= 300);
      }
    }
    // Narrow box, long headline: more lines, larger letters than one line would allow.
    const long = fitThumb('I tried waking up at five for a month', 'left', true, ruler);
    assert.ok(long.lines.length >= 3);
    // Blocks behind the lines need more air.
    assert.ok(fitThumb('It broke', 'left', true, ruler, 'box').size < fitThumb('It broke', 'left', true, ruler).size);
    assert.strictEqual(fitThumb('', 'left', true, ruler).size, 0);
  });

  t('thumbnail: colours are read strictly, taken from a palette, and takes differ', () => {
    assert.strictEqual(hexColor('#fd0'), '#FFDD00');
    assert.strictEqual(hexColor('ffd400'), '#FFD400');
    assert.strictEqual(hexColor('red'), null);
    assert.strictEqual(hexColor('#12345'), null);
    assert.strictEqual(inkOn('#FFD400'), '#111111');
    assert.strictEqual(inkOn('#1B1F3B'), '#FFFFFF');
    const c = thumbColorsFrom(['#101010', '#E8E8E8', '#E62117', 'nonsense']);
    assert.strictEqual(c.accent, '#E62117');
    assert.strictEqual(c.backdrop[0], '#101010');
    const spec = { text: 'x', layout: 'left', plate: 'none', colors: c, font: 'Impact', upper: true, shade: 0.7 };
    const takes = thumbVariants(spec, 3);
    assert.strictEqual(takes.length, 3);
    assert.strictEqual(new Set(takes.map((s) => `${s.layout}/${s.plate}`)).size, 3);
    assert.strictEqual(thumbVariants(spec, 1).length, 1);
  });

  // ── A channel as the example ──
  const entry = (id, title, o = {}) =>
    ` <entry>\n  <id>yt:video:${id}</id>\n  <yt:videoId>${id}</yt:videoId>\n  <yt:channelId>UCaaaaaaaaaaaaaaaaaaaaaa</yt:channelId>\n  <title>${title}</title>\n  <link rel="alternate" href="https://www.youtube.com/${o.short ? 'shorts/' : 'watch?v='}${id}"/>\n  <published>${o.at ?? '2026-11-01T12:00:00+00:00'}</published>\n  <media:group>\n   <media:title>${title}</media:title>\n   <media:thumbnail url="https://i1.ytimg.com/vi/${id}/hqdefault.jpg" width="480" height="360"/>\n   <media:description>${o.about ?? ''}</media:description>\n   <media:community>\n    <media:starRating count="${o.likes ?? 10}" average="5.00" min="1" max="5"/>\n    <media:statistics views="${o.views ?? 1000}"/>\n   </media:community>\n  </media:group>\n </entry>\n`;
  const FEED =
    `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">\n <id>yt:channel:aaaaaaaaaaaaaaaaaaaaaa</id>\n <yt:channelId>aaaaaaaaaaaaaaaaaaaaaa</yt:channelId>\n <title>Paper &amp; Ink</title>\n` +
    entry('aaaaaaaaaa1', 'Why 7 Bridges Broke Mathematics', { at: '2026-11-22T12:00:00+00:00', views: 90000, about: 'The walk nobody could take.\n\n0:00 The town\n2:10 The proof\n\nhttps://example.org/sources #maths #history' }) +
    entry('aaaaaaaaaa2', 'How 1 Number Runs the Internet', { at: '2026-11-15T12:00:00+00:00', views: 30000, about: '0:00 Start\nhttps://example.org #maths' }) +
    entry('aaaaaaaaaa3', 'Why Maps Lie (And Always Will)', { at: '2026-11-08T12:00:00+00:00', views: 28000, about: '00:00 Start\n#maps' }) +
    entry('aaaaaaaaaa4', 'The 4 Colours Nobody Could Prove', { at: '2026-11-01T12:00:00+00:00', views: 31000, about: 'Short one.' }) +
    entry('aaaaaaaaaa5', 'a quick sketch &lt;&amp;&gt; a nap', { at: '2026-10-30T12:00:00+00:00', views: 900, short: true }) +
    entry('bad', 'Not a video id') +
    `</feed>\n`;

  t('channel: links, handles and video links are told apart; anything else is refused', () => {
    assert.deepStrictEqual(channelTarget('https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa/videos'), { kind: 'id', id: 'UCaaaaaaaaaaaaaaaaaaaaaa' });
    assert.deepStrictEqual(channelTarget('UCaaaaaaaaaaaaaaaaaaaaaa'), { kind: 'id', id: 'UCaaaaaaaaaaaaaaaaaaaaaa' });
    assert.deepStrictEqual(channelTarget('@paper.ink'), { kind: 'page', url: 'https://www.youtube.com/@paper.ink' });
    assert.deepStrictEqual(channelTarget('youtube.com/@PaperInk/shorts?x=1'), { kind: 'page', url: 'https://www.youtube.com/@PaperInk' });
    assert.deepStrictEqual(channelTarget('https://m.youtube.com/c/PaperInk'), { kind: 'page', url: 'https://www.youtube.com/c/PaperInk' });
    assert.deepStrictEqual(channelTarget('https://youtu.be/aaaaaaaaaa1?t=3'), { kind: 'video', url: 'https://www.youtube.com/watch?v=aaaaaaaaaa1' });
    assert.deepStrictEqual(channelTarget('https://www.youtube.com/watch?v=aaaaaaaaaa1&list=x'), { kind: 'video', url: 'https://www.youtube.com/watch?v=aaaaaaaaaa1' });
    assert.deepStrictEqual(channelTarget('https://www.youtube.com/shorts/aaaaaaaaaa1'), { kind: 'video', url: 'https://www.youtube.com/watch?v=aaaaaaaaaa1' });
    for (const no of ['', 'paper and ink', 'https://example.org/@name', 'https://youtube.com.example.org/@name', 'https://www.youtube.com/results?search_query=x', 'https://www.youtube.com/channel/short', 'https://www.youtube.com/watch?v=../../x', 'javascript:alert(1)']) assert.strictEqual(channelTarget(no), null, no);
    assert.strictEqual(channelFeedUrl('UCaaaaaaaaaaaaaaaaaaaaaa'), 'https://www.youtube.com/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(videoThumbUrl('aaaaaaaaaa1'), 'https://i.ytimg.com/vi/aaaaaaaaaa1/mqdefault.jpg');
  });

  t('channel: a page names its feed in the head, and nothing else on the page is believed', () => {
    const head = '<link rel="canonical" href="https://www.youtube.com/channel/UCbbbbbbbbbbbbbbbbbbbbbb"><link rel="alternate" type="application/rss+xml" title="RSS" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa">';
    assert.strictEqual(channelIdIn(head), 'UCaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(channelIdIn('<link rel="canonical" href="https://www.youtube.com/channel/UCbbbbbbbbbbbbbbbbbbbbbb">'), 'UCbbbbbbbbbbbbbbbbbbbbbb');
    assert.strictEqual(channelIdIn('<link rel="alternate" type="application/rss+xml" href="https://example.org/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa">'), null);
    assert.strictEqual(channelIdIn('<a href="/channel/UCaaaaaaaaaaaaaaaaaaaaaa">x</a>'), null);
  });

  t('channel: the feed is read into uploads, and what they have in common is counted', () => {
    const feed = parseChannelFeed(FEED);
    assert.strictEqual(feed.id, 'UCaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(feed.name, 'Paper & Ink');
    assert.strictEqual(feed.videos.length, 5);
    assert.strictEqual(feed.videos[4].title, 'a quick sketch <&> a nap');
    assert.strictEqual(feed.videos[4].short, true);
    assert.strictEqual(feed.videos[0].views, 90000);
    assert.strictEqual(feed.videos[0].url, 'https://www.youtube.com/watch?v=aaaaaaaaaa1');
    assert.throws(() => parseChannelFeed('<html>nope</html>'), /not a channel feed/);

    const s = studyChannel(feed);
    assert.strictEqual(s.videos, 5);
    assert.strictEqual(s.shorts, 1);
    assert.strictEqual(s.daysBetween, 7);
    assert.strictEqual(s.titles.withNumber, 0.6);
    assert.strictEqual(s.titles.brackets, 0.2);
    assert.strictEqual(s.titles.question, 0);
    assert.strictEqual(s.titles.casing, 'Title Case');
    assert.deepStrictEqual(s.titles.openers[0], { word: 'why', count: 2 });
    assert.strictEqual(s.views.median, 30000);
    assert.deepStrictEqual(s.views.best.map((b) => [b.title, b.times]), [['Why 7 Bridges Broke Mathematics', 3]]);
    assert.strictEqual(s.descriptions.withChapters, 0.6);
    assert.deepStrictEqual(s.descriptions.hashtags, ['#maths']);

    const habits = titleHabits(s).join(' ');
    assert.match(habits, /60% have a number in them/);
    assert.match(habits, /Written in Title Case/);
    assert.match(habits, /Never: .*a question/);
    const text = describeStudy(s, { titles: feed.videos.map((v) => v.title), palette: ['#E62117'] });
    assert.match(text, /about every 7 days/);
    assert.match(text, /3× the usual \(90K\)/);
    assert.match(text, /#E62117/);
    assert.match(text, /Take the shape, not the words/);
    assert.match(text, /never instructions/);
    assert.match(describeStudy(studyChannel({ ...feed, videos: [] })), /no public uploads/);
  });

  t('channel: the colours thumbnails lean on are the vivid ones, and near-twins count once', () => {
    const px = [];
    const fill = (r, g, b, n) => {
      for (let i = 0; i < n; i++) px.push(r, g, b, 255);
    };
    fill(20, 20, 20, 500);
    fill(230, 33, 23, 200);
    fill(226, 36, 28, 100);
    fill(255, 212, 0, 150);
    fill(0, 0, 0, 0);
    const pal = paletteOf(px, 4);
    // Red first although there is more black: it is what the eye takes away.
    assert.match(pal[0], /^#E[0-9A-F]2[0-9A-F][0-9A-F]{2}$/);
    assert.strictEqual(pal.length, 3);
    assert.ok(pal.includes('#141414'));
    assert.deepStrictEqual(paletteOf([], 4), []);
    // Transparent pixels are not there.
    assert.deepStrictEqual(paletteOf([255, 0, 0, 0], 4), []);
  });

  await ta('channel and thumbnail tools: listed, and wrong input is refused in plain words', async () => {
    assert.ok(AGENT_TOOL_NAMES.includes('study_channel'));
    assert.ok(AGENT_TOOL_NAMES.includes('make_thumbnail'));
    const call = (tool, args) => runAgentTool({ rid: 1, tool, args, client: 'test' }, () => undefined, new AbortController().signal);
    const none = await call('study_channel', {});
    assert.ok(!none.ok && /channel is required/.test(none.text), none.text);
    const words = await call('make_thumbnail', {});
    assert.ok(!words.ok && /text is required/.test(words.text), words.text);
    const style = await call('make_thumbnail', { text: 'No', visual_style: 'oil painting' });
    assert.ok(!style.ok && /No visual style "oil painting"/.test(style.text), style.text);
    const pose = await call('make_thumbnail', { text: 'No', visual_style: 'stickman', pose: 'backflip' });
    assert.ok(!pose.ok && /pose "backflip"/.test(pose.text), pose.text);
    const colour = await call('make_thumbnail', { text: 'No', from: 'plain', accent: 'reddish' });
    assert.ok(!colour.ok && /accent is a colour like/.test(colour.text), colour.text);
    const from = await call('make_thumbnail', { text: 'No', from: 'video' });
    assert.ok(!from.ok && /from is scene, frame, image or plain/.test(from.text), from.text);
  });
}
