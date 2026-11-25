// Drawings an agent makes itself (src/editor/drawing.ts): the rules a drawing is
// held to and how a tagged part moves. Run from editor.test.mjs. The part that
// needs a browser (parsing, turning into pixels) is tested live, not here.
import assert from 'node:assert';
import {
  AGENT_TOOL_NAMES,
  DRAWING_ELEMENTS,
  DRAWING_MAX_CHARS,
  DRAWING_MOVES,
  MAX_DRAWINGS,
  boilSeed,
  combineMoves,
  drawingAttributeOk,
  drawingPivot,
  drawingPixels,
  drawingProblem,
  drawingSlug,
  drawingStyleText,
  moveAt,
  movePhase,
  moveStyle,
  runAgentTool,
  withNamespaces,
} from './.editor.mjs';

const SVG = '<svg viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#fdfaf2"/><circle cx="960" cy="400" r="46"/></svg>';

export async function run({ t, ta, approx }) {
  t('drawing: text that cannot be a drawing is refused with a reason', () => {
    assert.strictEqual(drawingProblem(SVG), null);
    assert.match(drawingProblem(''), /SVG text/);
    assert.match(drawingProblem(42), /SVG text/);
    assert.match(drawingProblem('<div>hello</div>'), /no <svg>/);
    assert.match(drawingProblem(`<!DOCTYPE svg [<!ENTITY a "aaaa">]>${SVG}`), /DOCTYPE/);
    assert.match(drawingProblem(`<svg>${'x'.repeat(DRAWING_MAX_CHARS)}</svg>`), /thousand characters/);
  });

  t('drawing: forgotten namespaces are added, declared ones are left alone', () => {
    assert.ok(withNamespaces(SVG).startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox='));
    const own = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>';
    assert.strictEqual(withNamespaces(own), own);
    assert.match(withNamespaces('<svg viewBox="0 0 10 10"><use xlink:href="#a"/></svg>'), /xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink"/);
  });

  t('drawing: nothing that runs or points outside the drawing is kept', () => {
    assert.ok(drawingAttributeOk('stroke-width', '16'));
    assert.ok(drawingAttributeOk('fill', 'url(#sky)'));
    assert.ok(drawingAttributeOk('fill', "url( '#sky' )"));
    assert.ok(drawingAttributeOk('href', '#figure'));
    assert.ok(drawingAttributeOk('data-move', 'bob sway'));
    assert.ok(!drawingAttributeOk('onload', 'alert(1)'));
    assert.ok(!drawingAttributeOk('onClick', 'x()'));
    assert.ok(!drawingAttributeOk('href', 'https://example.com/a.png'));
    assert.ok(!drawingAttributeOk('xlink:href', 'data:image/png;base64,AAAA'));
    assert.ok(!drawingAttributeOk('fill', 'url(https://example.com/p.svg#a)'));
    assert.ok(!drawingAttributeOk('style', 'background: url("//example.com/x")'));
    assert.ok(!drawingAttributeOk('style', 'width: expression(alert(1))'));
    for (const no of ['script', 'foreignObject', 'image', 'a', 'animate', 'animateTransform', 'set', 'iframe', 'feImage']) assert.ok(!DRAWING_ELEMENTS.has(no), no);
    for (const yes of ['svg', 'g', 'path', 'circle', 'text', 'linearGradient', 'clipPath', 'use']) assert.ok(DRAWING_ELEMENTS.has(yes), yes);
    const css = drawingStyleText('@import url("https://example.com/a.css"); .a { fill: url(#g); background: url(https://example.com/b.png) }');
    assert.ok(!/example\.com/.test(css), css);
    assert.ok(css.includes('url(#g)'), css);
  });

  t('drawing: a pivot is a word about the part\'s own box, or two percentages', () => {
    assert.deepStrictEqual(drawingPivot('bottom'), [50, 100]);
    assert.deepStrictEqual(drawingPivot('Top Left'), [0, 0]);
    assert.deepStrictEqual(drawingPivot('left-top'), [0, 0]);
    assert.deepStrictEqual(drawingPivot('30% 80%'), [30, 80]);
    assert.deepStrictEqual(drawingPivot('30, 80'), [30, 80]);
    assert.deepStrictEqual(drawingPivot('', 'bottom'), [50, 100]);
    assert.deepStrictEqual(drawingPivot(null), [50, 50]);
    assert.strictEqual(drawingPivot('the shoulder'), null);
    assert.strictEqual(drawingPivot('900 400'), null);
  });

  t('drawing: every move is slight, steady in time, and the same frame every time it is asked for', () => {
    for (const m of DRAWING_MOVES) {
      assert.ok(drawingPivot('', m.pivot), m.id);
      let moved = false;
      for (let n = 0; n <= 300; n++) {
        const at = n / 30;
        const s = moveAt(m.id, at, { phase: 0.2 });
        assert.deepStrictEqual(s, moveAt(m.id, at, { phase: 0.2 }), m.id);
        for (const v of Object.values(s)) assert.ok(Number.isFinite(v), `${m.id} at ${at}`);
        assert.ok(Math.abs(s.x) <= 45 && Math.abs(s.y) <= 10, `${m.id} shift at ${at}`);
        if (m.id !== 'spin') assert.ok(Math.abs(s.rotate) <= 14, `${m.id} turn at ${at}`);
        assert.ok(s.sx > 0.9 && s.sx < 1.1 && s.sy > 0.05 && s.sy < 1.3, `${m.id} size at ${at}`);
        assert.ok(s.opacity >= 0.15 && s.opacity <= 1, `${m.id} opacity at ${at}`);
        if (JSON.stringify(s) !== JSON.stringify(moveAt(m.id, 0, { phase: 0.2 }))) moved = true;
      }
      assert.ok(moved, `${m.id} never moves`);
    }
    assert.deepStrictEqual(moveAt('moonwalk', 2), { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 });
    // More of it, and a smaller drawing: distances follow the drawing's own units.
    approx(moveAt('bob', 0.5, { amount: 2 }).y, 2 * moveAt('bob', 0.5).y, 1e-9);
    approx(moveAt('bob', 0.5, { unit: 0.1 }).y, 0.1 * moveAt('bob', 0.5).y, 1e-9);
    assert.strictEqual(moveAt('bob', 0.5, { amount: 99 }).y, moveAt('bob', 0.5, { amount: 3 }).y);
    // Eyes are shut for a moment, then open for seconds.
    const shut = Array.from({ length: 340 }, (_, n) => moveAt('blink', n / 100).sy < 0.5).filter(Boolean).length;
    assert.ok(shut >= 10 && shut <= 20, String(shut));
    // Two parts do not start in step.
    assert.notStrictEqual(movePhase(1), movePhase(2));
    assert.ok(movePhase(7) >= 0 && movePhase(7) < 1);
  });

  t('drawing: a move becomes CSS on the part\'s wrapper, and nothing at rest', () => {
    assert.strictEqual(moveStyle({ x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 }, [50, 100]), '');
    assert.strictEqual(moveStyle({ x: 0, y: -4.5, rotate: 2, sx: 1, sy: 1, opacity: 1 }, [50, 100]), 'transform-box: fill-box; transform-origin: 50% 100%; transform: translate(0px, -4.5px) rotate(2deg)');
    assert.strictEqual(moveStyle({ x: 0, y: 0, rotate: 0, sx: 1, sy: 0.1, opacity: 0.8 }, [50, 50]), 'transform-box: fill-box; transform-origin: 50% 50%; transform: scale(1, 0.1); opacity: 0.8');
    const both = combineMoves([moveAt('bob', 0.4), moveAt('sway', 0.4)]);
    approx(both.y, moveAt('bob', 0.4).y, 1e-9);
    approx(both.rotate, moveAt('sway', 0.4).rotate, 1e-9);
  });

  t('drawing: the lines are redrawn eight times a second, a still has the first wobble', () => {
    assert.strictEqual(boilSeed(null), 1);
    assert.strictEqual(boilSeed(0), 1);
    const seeds = Array.from({ length: 30 }, (_, n) => boilSeed(n / 30));
    assert.strictEqual(new Set(seeds).size, 5, 'five wobbles in turn');
    assert.strictEqual(seeds.filter((s, i) => i > 0 && s !== seeds[i - 1]).length, 7, 'seven changes in a second of thirty frames');
    assert.ok(seeds.every((s) => Number.isInteger(s) && s >= 1));
  });

  t('drawing: pixels keep the drawing\'s shape, with even sides', () => {
    assert.deepStrictEqual(drawingPixels(1920, 1080), { w: 1920, h: 1080 });
    assert.deepStrictEqual(drawingPixels(1080, 1920), { w: 1080, h: 1920 });
    assert.deepStrictEqual(drawingPixels(192, 108), { w: 1920, h: 1080 });
    assert.deepStrictEqual(drawingPixels(1000, 333), { w: 1920, h: 640 });
    assert.strictEqual(drawingSlug('Sam stares at the router!'), 'sam-stares-at-the-router');
    assert.strictEqual(drawingSlug('  '), 'drawing');
  });

  await ta('drawing: the tool is listed, and wrong input is refused before anything is drawn', async () => {
    assert.ok(AGENT_TOOL_NAMES.includes('draw_images'));
    const call = (tool, args) => runAgentTool({ rid: 1, tool, args, client: 'test' }, () => undefined, new AbortController().signal);
    const none = await call('draw_images', {});
    assert.ok(!none.ok && /drawings is required/.test(none.text), none.text);
    const many = await call('draw_images', { drawings: Array(MAX_DRAWINGS + 1).fill({ svg: SVG }) });
    assert.ok(!many.ok && /At most 16/.test(many.text), many.text);
    const notSvg = await call('draw_images', { drawings: [{ svg: SVG }, { svg: '<p>a stick figure</p>' }] });
    assert.ok(!notSvg.ok && /Drawing 2: it has no <svg>/.test(notSvg.text), notSvg.text);
    const long = await call('draw_images', { drawings: [{ svg: SVG, seconds: 900 }] });
    assert.ok(!long.ok && /seconds is how long/.test(long.text), long.text);
    const inVideo = await call('build_longform', { title: 'A story', sections: [{ heading: 'One', text: 'A man walks in.', drawings: [{ svg: '<svg><!ENTITY x "y"></svg>', when: 'A man' }] }] });
    assert.ok(!inVideo.ok && /Section "One", drawing 1: it has a DOCTYPE or an ENTITY/.test(inVideo.text), inVideo.text);
  });
}
