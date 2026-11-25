// Web capture and window recording (src/editor/webCapture.ts): the steps an
// agent or the dialog gives, checked before anything is opened. Run from
// editor.test.mjs. The filming itself needs a real window: it is checked live.
import assert from 'node:assert';
import { cleanSteps, cleanWindowSteps, parsePointer, parseSteps, pointerJson, runAgentTool, webAddress, webSize } from './.editor.mjs';

export async function run({ t, ta }) {
  t('web: an agent\'s steps are checked and tidied', () => {
    assert.deepStrictEqual(cleanSteps(undefined), []);
    assert.deepStrictEqual(
      cleanSteps([
        { do: 'Click', target: ' Pricing ' },
        { do: 'click', x: 0.5, y: 0.25 },
        { do: 'type', text: 'hello', target: 'Search' },
        { do: 'press', key: 'Enter' },
        { do: 'scroll' },
        { do: 'scroll', target: 'Footer', by: 200 },
        { do: 'wait', seconds: 2, x: 0.1, y: 0.1 },
        { do: 'goto', url: 'https://example.com/a' },
      ]),
      [
        { do: 'click', target: 'Pricing' },
        { do: 'click', x: 0.5, y: 0.25 },
        { do: 'type', target: 'Search', text: 'hello' },
        { do: 'press', key: 'Enter' },
        { do: 'scroll', by: 600 },
        { do: 'scroll', target: 'Footer' },
        { do: 'wait', seconds: 2 },
        { do: 'goto', url: 'https://example.com/a' },
      ],
    );
  });

  t('web: a wrong step is named, with what it needs', () => {
    assert.throws(() => cleanSteps('click Pricing'), /steps is a list/);
    assert.throws(() => cleanSteps([{ do: 'click', target: 'A' }, { do: 'tap', target: 'B' }]), /steps\[1\]: do is one of click/);
    assert.throws(() => cleanSteps([{ do: 'click' }]), /steps\[0\]: click needs a target/);
    assert.throws(() => cleanSteps([{ do: 'click', x: 1.4, y: 0.2 }]), /0\.\.1/);
    assert.throws(() => cleanSteps([{ do: 'type', target: 'Search' }]), /type needs text/);
    assert.throws(() => cleanSteps([{ do: 'press' }]), /press needs a key/);
    assert.throws(() => cleanSteps([{ do: 'goto', url: 'file:///C:/secret.txt' }]), /http or https/);
    assert.throws(() => cleanSteps([{ do: 'goto', url: 'javascript:alert(1)' }]), /http or https/);
    assert.throws(() => cleanSteps(Array.from({ length: 61 }, () => ({ do: 'wait' }))), /At most 60/);
  });

  t('web: the dialog\'s lines become steps', () => {
    const { steps, errors } = parseSteps(
      ['# a comment', '', 'click Pricing', 'Click on "Choose Pro"', 'hover Features', 'type hello world into Search notes', 'type "just words"', 'press Enter', 'scroll', 'scroll up', 'scroll 250', 'scroll up 300', 'scroll to Footer', 'wait', 'wait 2.5', 'wait 3 seconds', 'wait for Results', 'go to https://example.com/x'].join('\r\n'),
    );
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(steps, [
      { do: 'click', target: 'Pricing' },
      { do: 'click', target: 'Choose Pro' },
      { do: 'hover', target: 'Features' },
      { do: 'type', text: 'hello world', target: 'Search notes' },
      { do: 'type', text: 'just words' },
      { do: 'press', key: 'Enter' },
      { do: 'scroll', by: 600 },
      { do: 'scroll', by: -600 },
      { do: 'scroll', by: 250 },
      { do: 'scroll', by: -300 },
      { do: 'scroll', target: 'Footer' },
      { do: 'wait', seconds: 1 },
      { do: 'wait', seconds: 2.5 },
      { do: 'wait', seconds: 3 },
      { do: 'wait', target: 'Results' },
      { do: 'goto', url: 'https://example.com/x' },
    ]);
    // What the dialog writes is what the tool accepts.
    assert.deepStrictEqual(cleanSteps(steps), steps);
  });

  t('web: a line that is not a step says which line and why', () => {
    const { steps, errors } = parseSteps('click Pricing\ntap Buy\nclick\nscroll sideways\nwait forever\ngo to example');
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(errors.length, 5);
    assert.match(errors[0], /^Line 2: "tap" is not a step/);
    assert.match(errors[1], /^Line 3: click what/);
    assert.match(errors[2], /^Line 4: scroll how far/);
    assert.match(errors[3], /^Line 5: wait how long/);
    assert.match(errors[4], /^Line 6: go to which address/);
  });

  t('web: an address as typed is made whole, and only web addresses pass', () => {
    assert.strictEqual(webAddress(' krypt.cc '), 'https://krypt.cc/');
    assert.strictEqual(webAddress('http://example.com/a?b=1'), 'http://example.com/a?b=1');
    assert.strictEqual(webAddress('localhost:5173'), 'http://localhost:5173/');
    assert.strictEqual(webAddress('127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x');
    for (const bad of ['', 'two words', 'nodots', 'file:///C:/Users/x/secret.txt', 'javascript:alert(1)', 'chrome://settings', 'ftp://example.com/a']) assert.strictEqual(webAddress(bad), null, bad);
  });

  t('web: the picture fits the canvas, and the page is a desktop or a phone', () => {
    assert.deepStrictEqual(webSize({ width: 1920, height: 1080 }), { width: 1920, height: 1080, pageWidth: 1280 });
    assert.deepStrictEqual(webSize({ width: 1080, height: 1920 }), { width: 1080, height: 1920, pageWidth: 430 });
    // 4K is filmed at 1080p; odd sizes are made even.
    assert.deepStrictEqual(webSize({ width: 3840, height: 2160 }), { width: 1920, height: 1080, pageWidth: 1280 });
    const odd = webSize({ width: 1001, height: 563 });
    assert.ok(odd.width % 2 === 0 && odd.height % 2 === 0);
    // Between one and three picture pixels per page pixel, whatever is asked.
    assert.strictEqual(webSize({ width: 1920, height: 1080 }, 5000).pageWidth, 1920);
    assert.strictEqual(webSize({ width: 1920, height: 1080 }, 100).pageWidth, 640);
    assert.strictEqual(webSize({ width: 1920, height: 1080 }, 1600).pageWidth, 1600);
  });

  t('web: the pointer file is one a product demo reads', () => {
    const track = parsePointer(JSON.parse(pointerJson({ duration: 4, moves: [[0, 0.5, 0.5], [1, 0.2, 0.3]], clicks: [[1.2, 0.2, 0.3, 0]], log: [] })));
    assert.ok(track);
    assert.strictEqual(track.clicks.length, 1);
    assert.strictEqual(track.duration, 4);
  });

  t('window: steps are places on the window, checked', () => {
    assert.deepStrictEqual(cleanWindowSteps(null), []);
    assert.deepStrictEqual(cleanWindowSteps([{ do: 'click', x: 0.5, y: 0.3, target: 'ignored' }, { do: 'move', x: 0, y: 1 }, { do: 'type', text: 'hi' }, { do: 'press', key: 'Tab' }, { do: 'scroll' }, { do: 'scroll', by: -200 }, { do: 'wait' }]), [
      { do: 'click', x: 0.5, y: 0.3 },
      { do: 'move', x: 0, y: 1 },
      { do: 'type', text: 'hi' },
      { do: 'press', key: 'Tab' },
      { do: 'scroll', by: 300 },
      { do: 'scroll', by: -200 },
      { do: 'wait', seconds: 1 },
    ]);
    assert.throws(() => cleanWindowSteps([{ do: 'click', target: 'OK' }]), /steps\[0\]: click needs x and y/);
    assert.throws(() => cleanWindowSteps([{ do: 'click', x: 2, y: 0.5 }]), /0\.\.1/);
    assert.throws(() => cleanWindowSteps([{ do: 'goto', url: 'https://example.com' }]), /do is one of click, move/);
    assert.throws(() => cleanWindowSteps([{ do: 'hover', x: 0.5, y: 0.5 }]), /do is one of/);
  });

  await ta('web and window tools refuse bad arguments before anything is opened', async () => {
    const call = (tool, args) => runAgentTool({ rid: 0, tool, args, client: 'test' }, () => undefined, new AbortController().signal);
    let r = await call('capture_web', { url: 'file:///C:/Users/x/secret.txt' });
    assert.strictEqual(r.ok, false);
    r = await call('capture_web', { url: 'example.com', steps: [{ do: 'tap' }] });
    assert.strictEqual(r.ok, false);
    assert.match(r.text, /steps\[0\]/);
    r = await call('record_window', {});
    assert.strictEqual(r.ok, false);
    assert.match(r.text, /window is the title/);
    r = await call('record_window', { window: 'Some App', steps: [{ do: 'click' }] });
    assert.strictEqual(r.ok, false);
    assert.match(r.text, /needs x and y/);
  });
}
