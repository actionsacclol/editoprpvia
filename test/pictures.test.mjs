// Pictures from words (shared/imageGen.ts, src/editor/pictureMath.ts): what is
// asked of each picture service and how its answer is read, the settings, the
// per-beat pictures of a narration, and the arithmetic of the on-device models.
// Run from editor.test.mjs. Nothing here touches the network or a graphics
// card, and no key is involved: requests are built, never sent.
import assert from 'node:assert';
import {
  AGENT_TOOL_NAMES,
  CLIP_LENGTH,
  DEFAULT_PICTURE_SETTINGS,
  LCM_TIMESTEPS,
  LOCAL_PICTURE_MODELS,
  PICTURE_LOOKS,
  PICTURE_PROVIDERS,
  SDXS_SIGMA,
  alphasCumprod,
  aspectFor,
  clipTokenizer,
  customEndpoint,
  gaussian,
  lcmStep,
  LOCAL_SIZE,
  localCrop,
  noise,
  pickSource,
  pictureAnswer,
  pictureBeats,
  pictureBeatsWithin,
  pictureFailure,
  picturePrompt,
  pictureRequest,
  pictureSlug,
  planesToRgba,
  readPictureSettings,
  readyLocalModel,
  runAgentTool,
  sdxsInput,
  sdxsStep,
  sourceProblem,
  withoutKey,
} from './.editor.mjs';

export async function run({ t, ta, approx }) {
  const ask = (over = {}) => ({ prompt: 'A red kite over a hill.', aspect: '16:9', quality: 'low', model: '', ...over });

  t('pictures: the prompt puts the look first, then the subject, what stays the same, and asks for no lettering', () => {
    const p = picturePrompt('  a fox crossing   a frozen river. ', 'comic', 'the fox has a white tail tip.');
    assert.strictEqual(p, 'Comic book art, a fox crossing a frozen river. the fox has a white tail tip. bold black ink outlines, flat colours, halftone shading, full bleed. no text, no captions, no watermark.');
    assert.strictEqual(picturePrompt('a fox', 'plain'), 'a fox.');
    assert.ok(picturePrompt('a fox', 'no such look').startsWith('Comic book art,'), 'an unknown look falls back to the first');
    assert.throws(() => picturePrompt('   '), /what the picture should show/);
    assert.ok(picturePrompt('x'.repeat(5000), 'plain').length <= 601);
    assert.strictEqual(new Set(PICTURE_LOOKS.map((l) => l.id)).size, PICTURE_LOOKS.length);
    assert.strictEqual(pictureSlug('Él corrió — 3 km, FAST!'), 'el-corrio-3-km-fast');
    assert.strictEqual(pictureSlug('!!!'), 'picture');
    assert.strictEqual(aspectFor(1920, 1080), '16:9');
    assert.strictEqual(aspectFor(1080, 1920), '9:16');
    assert.strictEqual(aspectFor(1080, 1080), '1:1');
  });

  t('pictures: each service is asked in its own words, and the key is never part of the request that is built', () => {
    const o = pictureRequest('openai', ask());
    assert.strictEqual(o.url, 'https://api.openai.com/v1/images/generations');
    assert.deepStrictEqual(o.key, { header: 'Authorization', prefix: 'Bearer ' });
    assert.deepStrictEqual(o.body, { model: 'gpt-image-2', prompt: 'A red kite over a hill.', n: 1, size: '1536x1024', quality: 'low', output_format: 'jpeg' });
    assert.ok(!('response_format' in o.body), 'GPT image models refuse response_format');
    assert.strictEqual(pictureRequest('openai', ask({ aspect: '9:16', model: ' gpt-image-1-mini ' })).body.size, '1024x1536');
    assert.strictEqual(pictureRequest('openai', ask({ model: ' gpt-image-1-mini ' })).body.model, 'gpt-image-1-mini');

    const x = pictureRequest('xai', ask({ aspect: '1:1' }));
    assert.strictEqual(x.url, 'https://api.x.ai/v1/images/generations');
    assert.deepStrictEqual(x.body, { model: 'grok-imagine-image', prompt: 'A red kite over a hill.', n: 1, aspect_ratio: '1:1', response_format: 'b64_json' });

    const g = pictureRequest('google', ask({ quality: 'high' }));
    assert.strictEqual(g.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.deepStrictEqual(g.key, { header: 'x-goog-api-key', prefix: '' });
    assert.deepStrictEqual(g.body.input, [{ type: 'text', text: 'A red kite over a hill.' }]);
    assert.deepStrictEqual(g.body.response_format, { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '16:9', image_size: '2K' });

    for (const r of [o, x, g]) assert.ok(!JSON.stringify(r).toLowerCase().includes('sk-'), 'no key in a built request');
    assert.throws(() => pictureRequest('midjourney', ask()), /not a picture service/);
  });

  t('pictures: another service needs a full https address (http only on this computer) and a model name', () => {
    const c = pictureRequest('custom', ask({ endpoint: 'https://pictures.example.com/v1/images/generations', model: 'some/model' }));
    assert.strictEqual(c.url, 'https://pictures.example.com/v1/images/generations');
    assert.deepStrictEqual(c.body, { model: 'some/model', prompt: 'A red kite over a hill.', n: 1, size: '1344x768' });
    const tg = pictureRequest('custom', ask({ endpoint: 'https://api.together.ai/v1/images/generations', model: 'm', aspect: '9:16' }));
    assert.deepStrictEqual([tg.body.width, tg.body.height, tg.body.size], [768, 1344, undefined]);
    assert.strictEqual(customEndpoint('http://localhost:8080/v1/images/generations').port, '8080');
    assert.strictEqual(customEndpoint('http://127.0.0.1:8080/x').hostname, '127.0.0.1');
    assert.throws(() => customEndpoint('http://pictures.example.com/v1'), /https/);
    assert.throws(() => customEndpoint('https://me:secret@pictures.example.com/v1'), /name or password/);
    assert.throws(() => customEndpoint('pictures.example.com'), /full address/);
    assert.throws(() => customEndpoint('file:///c:/x'), /https/);
    assert.throws(() => pictureRequest('custom', ask({ endpoint: 'https://pictures.example.com/v1' })), /Name the model/);
  });

  t('pictures: the picture is found in every answer shape the services use, and nowhere else', () => {
    assert.deepStrictEqual(pictureAnswer({ created: 1, data: [{ b64_json: 'QUJD' }] }), { b64: 'QUJD' });
    assert.deepStrictEqual(pictureAnswer({ data: [{ url: 'https://cdn.example.com/a.png', b64_json: null }] }), { url: 'https://cdn.example.com/a.png' });
    assert.deepStrictEqual(pictureAnswer({ status: 'completed', steps: [{ type: 'thought', content: [{ type: 'text', text: 'hm' }] }, { type: 'model_output', content: [{ type: 'text', text: 'here' }, { type: 'image', data: 'R09PRw==', mime_type: 'image/png' }] }] }), { b64: 'R09PRw==' });
    assert.deepStrictEqual(pictureAnswer({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: 'T0xE' } }] } }] }), { b64: 'T0xE' });
    for (const none of [null, 'text', [], {}, { data: [] }, { data: [{ revised_prompt: 'x' }] }, { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot draw that' }] }] }]) assert.strictEqual(pictureAnswer(none), null);
  });

  t('pictures: a refusal is told as something to do, quotes the service, and never shows the key', () => {
    const body = { error: { message: 'Incorrect API key provided: sk-test-1234567890abcd.', type: 'invalid_request_error', code: 'invalid_api_key' } };
    const said = pictureFailure('OpenAI', 401, body);
    assert.ok(/did not accept the key/.test(said) && /It said: "Incorrect API key/.test(said), said);
    assert.strictEqual(withoutKey(said, 'sk-test-1234567890abcd').includes('sk-test-1234567890abcd'), false);
    assert.ok(withoutKey(said, 'sk-test-1234567890abcd').includes('[key]'));
    assert.strictEqual(withoutKey('nothing here', null), 'nothing here');
    assert.ok(/no credit left/.test(pictureFailure('xAI (Grok)', 402, {})));
    assert.ok(/does not know that model/.test(pictureFailure('Google Gemini', 404, { error: { code: 'model_not_found', message: 'no such model' } })));
    assert.ok(/asking for a pause/.test(pictureFailure('OpenAI', 429, null)));
    assert.ok(/refused the request\. It said: "Your request was rejected by the safety system\."/.test(pictureFailure('OpenAI', 400, { error: { message: 'Your request was rejected by the safety system.' } })));
    assert.ok(/against its rules/.test(pictureFailure('OpenAI', 400, null)));
    assert.ok(/having trouble/.test(pictureFailure('OpenAI', 503, '<html>')));
    assert.ok(pictureFailure('S', 400, { error: { message: 'x'.repeat(2000) } }).length < 320, 'a long message is cut');
  });

  t('pictures: settings survive junk, hold no key, and say plainly what is missing', () => {
    assert.deepStrictEqual(readPictureSettings(undefined), DEFAULT_PICTURE_SETTINGS);
    assert.deepStrictEqual(readPictureSettings('nonsense'), DEFAULT_PICTURE_SETTINGS);
    const s = readPictureSettings({ source: 'openai', quality: 'ultra', models: { openai: ' gpt-image-1-mini ', nope: 'x', xai: 5 }, endpoint: ' https://a.example.com/v1 ', dailyLimit: 1e9, key: 'sk-should-not-be-kept' });
    assert.deepStrictEqual(s, { source: 'openai', quality: 'low', models: { openai: 'gpt-image-1-mini' }, endpoint: 'https://a.example.com/v1', dailyLimit: 2000 });
    assert.ok(!('key' in s));
    assert.strictEqual(readPictureSettings({ dailyLimit: -3 }).dailyLimit, 100);
    assert.strictEqual(readPictureSettings({ source: 'dall-e' }).source, null);

    const setup = (over = {}, keys = []) => ({ settings: { ...DEFAULT_PICTURE_SETTINGS, ...over }, madeToday: 0, providers: PICTURE_PROVIDERS.map((p) => ({ id: p.id, hasKey: keys.includes(p.id), hint: null, model: p.model })) });
    assert.ok(/not downloaded yet/.test(sourceProblem(setup(), 'local', false)));
    assert.strictEqual(sourceProblem(setup(), 'local', true), null);
    assert.ok(/No key is kept for OpenAI/.test(sourceProblem(setup(), 'openai', true)));
    assert.strictEqual(sourceProblem(setup({}, ['openai']), 'openai', false), null);
    assert.ok(/address of the service/.test(sourceProblem(setup({}, ['custom']), 'custom', false)));
    assert.ok(/Name the model/.test(sourceProblem(setup({ endpoint: 'https://a.example.com/v1' }, ['custom']), 'custom', false)));
    // Nothing chosen: this computer when its model is there, else the first service with a key, else nothing.
    assert.strictEqual(pickSource(setup(), false), null);
    assert.strictEqual(pickSource(setup(), true), 'local');
    assert.strictEqual(pickSource(setup({}, ['xai']), false), 'xai');
    assert.strictEqual(pickSource(setup({ source: 'xai' }, ['xai']), true), 'xai', 'the choice wins when it works');
    assert.strictEqual(pickSource(setup({ source: 'openai' }, ['xai']), true), 'local', 'a choice that cannot work is passed over');
    assert.strictEqual(pickSource(setup({ source: 'openai' }, []), false, 'google'), 'google', 'what is asked for by name is tried as asked');

    const st = (id, installed) => ({ id, installed, downloadBytes: 0, totalBytes: 1, installing: false, progress: null });
    assert.strictEqual(readyLocalModel([st('lcm', false), st('sdxs', true)]), 'sdxs');
    assert.strictEqual(readyLocalModel([st('sdxs', true), st('lcm', true)]), 'lcm', 'the better one when both are there');
    assert.strictEqual(readyLocalModel([]), null);
    // The sizes the user is told are the sizes of the files that are pinned.
    assert.deepStrictEqual(LOCAL_PICTURE_MODELS.map((m) => [m.id, m.bytes]), [['lcm', 1970067028], ['sdxs', 882094377]]);
  });

  t('pictures: a narration is cut into beats of about four seconds, each starting on its own words', () => {
    const story = 'The alarm did not go off. Sam ran for the bus and missed it by a second. Then the rain started, slowly at first, and it did not stop for the rest of that long grey morning. He laughed.';
    const beats = pictureBeats(story);
    assert.deepStrictEqual(beats.map((b) => b.when), ['The alarm did not go off.', 'Then the rain started, slowly at']);
    assert.ok(beats[0].subject.endsWith('by a second.'), 'two short sentences share a picture');
    assert.ok(beats[1].subject.endsWith('He laughed.'), 'a short last sentence joins the beat before it');
    assert.strictEqual(pictureBeats('One. Two. Three.', 1).length, 3);
    assert.deepStrictEqual(pictureBeats('   '), []);
    assert.strictEqual(pictureBeats('Dr. Who arrived at 3.5 p.m. sharp and nobody at all was there to meet him at the door.').length, 1, 'a full stop inside a sentence does not always end it');
    const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i + 1} has exactly eight words in it.`).join(' ');
    const fit = pictureBeatsWithin([long, long], 40);
    assert.ok(fit[0].length + fit[1].length <= 40 && fit[0].length >= 15, `${fit[0].length} + ${fit[1].length}`);
    assert.strictEqual(pictureBeatsWithin([story], 80)[0].length, 2);
  });

  t('on-device pictures: the tokenizer joins letters by the merge rules, and always hands over 77 numbers', () => {
    const vocab = { '<|startoftext|>': 100, '<|endoftext|>': 101, 'c': 1, 'a': 2, 't</w>': 3, 'ca': 4, 'cat</w>': 5, 's</w>': 6, 'a</w>': 7, ',</w>': 8, 'r': 9, 'ed</w>': 10, '3</w>': 11, 'e': 12, 'd</w>': 13 };
    const merges = '#version: 0.2\nc a\nca t</w>\ne d</w>\n';
    const tok = clipTokenizer(vocab, merges);
    const ids = tok('A  CAT, a red cat');
    assert.strictEqual(ids.length, CLIP_LENGTH);
    assert.deepStrictEqual(ids.slice(0, 9), [100, 7, 5, 8, 7, 9, 10, 5, 101]);
    assert.ok(ids.slice(9).every((v) => v === 101), 'padded with the end mark');
    assert.strictEqual(tok.count('a cat'), 2);
    // A letter the word list lacks becomes the end mark rather than a hole; digits stand alone.
    assert.deepStrictEqual(tok('z 33').slice(0, 5), [100, 101, 11, 11, 101]);
    const many = tok(Array(200).fill('cat').join(' '));
    assert.strictEqual(many.length, CLIP_LENGTH);
    assert.strictEqual(many[CLIP_LENGTH - 1], 101, 'a long prompt is cut, and still ends');
    assert.strictEqual(tok.count(Array(200).fill('cat').join(' ')), 200);
    assert.throws(() => clipTokenizer({ a: 1 }, ''), /word list is damaged/);
  });

  t('on-device pictures: the noise is repeatable, and the schedule is Stable Diffusion\'s', () => {
    const a = noise(20000, gaussian(7));
    const b = noise(20000, gaussian(7));
    const c = noise(20000, gaussian(8));
    assert.deepStrictEqual(Array.from(a.slice(0, 50)), Array.from(b.slice(0, 50)));
    assert.notDeepStrictEqual(Array.from(a.slice(0, 50)), Array.from(c.slice(0, 50)));
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    const variance = a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length;
    approx(mean, 0, 0.03);
    approx(variance, 1, 0.05);
    const al = alphasCumprod();
    assert.strictEqual(al.length, 1000);
    approx(al[0], 0.99915, 1e-5);
    approx(al[999], 0.00466, 1e-4);
    for (let i = 1; i < 1000; i++) assert.ok(al[i] < al[i - 1]);
    // The one-step model's starting strength is that same schedule read at its last step.
    approx(Math.sqrt((1 - al[999]) / al[999]), SDXS_SIGMA, 1e-3);
    assert.deepStrictEqual([...LCM_TIMESTEPS], [999, 759, 499, 259]);
  });

  t('on-device pictures: given the true noise, a step hands back the picture that was under it', () => {
    const next = gaussian(3);
    const x0 = noise(64, next, 0.8);
    const eps = noise(64, next);
    const al = alphasCumprod();
    // LCM, last step: the cleaned picture itself.
    const t3 = 259;
    const noisy = x0.map((v, i) => Math.sqrt(al[t3]) * v + Math.sqrt(1 - al[t3]) * eps[i]);
    const clean = lcmStep(noisy, eps, t3, null, next);
    for (let i = 0; i < 64; i++) approx(clean[i], x0[i], 2e-3);
    // LCM, a middle step: the cleaned picture noised again to the next level, so its spread grows.
    const again = lcmStep(noisy, eps, 499, 259, gaussian(4));
    assert.ok(again.some((v, i) => Math.abs(v - clean[i]) > 0.05));
    // SDXS: one step from noise this strong.
    const start = x0.map((v, i) => v + SDXS_SIGMA * eps[i]);
    const one = sdxsStep(start, eps);
    for (let i = 0; i < 64; i++) approx(one[i], x0[i], 1e-4);
    approx(sdxsInput(Float32Array.from([SDXS_SIGMA]))[0], SDXS_SIGMA / Math.sqrt(SDXS_SIGMA ** 2 + 1), 1e-6);
  });

  t('on-device pictures: numbers become pixels, at the one size the networks take', () => {
    // 2 x 1 picture: planes R, G, B.
    const px = planesToRgba(Float32Array.from([-1, 1, 0, 3, -5, 0.5]), 2, 1);
    assert.deepStrictEqual(Array.from(px), [0, 128, 0, 255, 255, 255, 191, 255]);
    assert.strictEqual(LOCAL_SIZE, 512);
    assert.strictEqual(LOCAL_SIZE % 8, 0);
    // A wide cut keeps the upper part (where the faces are), a tall one the middle, a square all of it.
    assert.deepStrictEqual(localCrop('16:9'), { x: 0, y: 67, width: 512, height: 288 });
    assert.deepStrictEqual(localCrop('9:16'), { x: 112, y: 0, width: 288, height: 512 });
    assert.deepStrictEqual(localCrop('1:1'), { x: 0, y: 0, width: 512, height: 512 });
  });

  await ta('pictures: the tool is listed, and wrong input is refused before anything is ordered', async () => {
    assert.ok(AGENT_TOOL_NAMES.includes('generate_images'));
    const call = (tool, args) => runAgentTool({ rid: 1, tool, args, client: 'test' }, () => undefined, new AbortController().signal);
    const none = await call('generate_images', {});
    assert.ok(!none.ok && /prompts is required/.test(none.text), none.text);
    const many = await call('generate_images', { prompts: Array(25).fill('a fox') });
    assert.ok(!many.ok && /At most 24/.test(many.text), many.text);
    const look = await call('generate_images', { prompts: ['a fox'], look: 'oil' });
    assert.ok(!look.ok && /No look "oil"/.test(look.text), look.text);
    const source = await call('generate_images', { prompts: ['a fox'], source: 'midjourney' });
    assert.ok(!source.ok && /source is local/.test(source.text), source.text);
    const aspect = await call('generate_images', { prompts: ['a fox'], aspect: '4:3' });
    assert.ok(!aspect.ok && /aspect is 16:9, 9:16 or 1:1/.test(aspect.text), aspect.text);
    const both = await call('build_longform', { title: 'T', sections: [{ heading: 'H', text: 'Some words.' }], pictures: 'auto', visual_style: 'stickman' });
    assert.ok(!both.ok && /use one of them/.test(both.text), both.text);
    const mode = await call('build_longform', { title: 'T', sections: [{ heading: 'H', text: 'Some words.' }], pictures: 'yes' });
    assert.ok(!mode.ok && /pictures is "auto"/.test(mode.text), mode.text);
  });
}
