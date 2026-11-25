// AI cursors: which cursor a tool call belongs to, where it goes, and how
// the crew shares a call that touches many clips.
import assert from 'node:assert';
import { AGENT_TOOL_NAMES, CREW, TOOL_SPECS, beginAgentStage, deal, diffClips, planStage, toolSpec } from './.editor.mjs';

export async function run({ t, ta }) {
  console.log('ai cursors');

  const clips = [
    { id: 'a', trackId: 'v1', start: 0, duration: 10 },
    { id: 'b', trackId: 'v1', start: 10, duration: 10 },
    { id: 'c', trackId: 'a1', start: 0, duration: 20 },
  ];
  const media = [{ id: 'm1', name: 'take one.mp4' }];

  t('every tool has a cursor, and every spec names a real tool and crew member', () => {
    const roles = new Set(CREW.map((c) => c.role));
    assert.strictEqual(new Set(CREW.map((c) => c.color)).size, CREW.length);
    for (const name of AGENT_TOOL_NAMES) assert.ok(TOOL_SPECS[name], `no cursor spec for ${name}`);
    for (const [name, s] of Object.entries(TOOL_SPECS)) {
      assert.ok(AGENT_TOOL_NAMES.includes(name), `${name} is not a tool`);
      assert.ok(roles.has(s.role) && s.label.length > 0);
    }
    // A tool added later still gets a cursor.
    assert.strictEqual(toolSpec('brand_new_tool').label, 'Brand new tool');
  });

  t('plan: an add goes to its button and drags the file out of the bin', () => {
    const p = planStage('add_clip', { media_id: 'm1', track_id: 'v1', start: 20 }, clips, media);
    assert.strictEqual(p.role, 'lead');
    assert.strictEqual(p.after, 'reveal');
    assert.deepStrictEqual(p.lead, [{ kind: 'media', id: 'm1' }]);
    assert.strictEqual(p.carry, 'take one.mp4');
    // The track it lands on is not something to visit: nothing on it changes.
    assert.deepStrictEqual(p.others, []);
    assert.deepStrictEqual(planStage('add_text', { text: 'hi' }, clips, media).lead, [{ kind: 'anchor', name: 'tool-text' }]);
    // A media id that is not in the bin is ignored.
    assert.deepStrictEqual(planStage('add_clip', { media_id: 'nope' }, clips, media).lead, []);
  });

  t('plan: cuts land on the clip under each cut point, the first one for the tool’s own cursor', () => {
    const p = planStage('cut_ranges', { ranges: [[2, 3], [12, 14], [40, 41]] }, clips, media);
    assert.strictEqual(p.role, 'cuts');
    assert.deepStrictEqual(p.lead, [{ kind: 'clip', id: 'a', t: 2 }]);
    assert.deepStrictEqual(p.others, [{ kind: 'clip', id: 'b', t: 12 }, { kind: 'time', t: 40 }]);
    const s = planStage('split_clips', { clip_ids: ['c'], at: 5 }, clips, media);
    assert.deepStrictEqual(s.lead, [{ kind: 'clip', id: 'c', t: 5 }]);
  });

  t('plan: an edit visits the clips it names, a track means every clip on it', () => {
    const p = planStage('update_clip', { track_id: 'v1', effect: 'vhs' }, clips, media);
    assert.strictEqual(p.role, 'look');
    assert.deepStrictEqual(p.lead, [{ kind: 'clip', id: 'a' }]);
    assert.deepStrictEqual(p.others, [{ kind: 'clip', id: 'b' }]);
    assert.deepStrictEqual(p.focus, ['a', 'b']);
    const d = planStage('delete_clips', { clip_ids: ['b', 'gone'] }, clips, media);
    assert.deepStrictEqual(d.lead, [{ kind: 'clip', id: 'b' }]);
    const e = planStage('auto_edit', { scope: { clip_ids: ['a'] } }, clips, media);
    assert.deepStrictEqual(e.lead, [{ kind: 'anchor', name: 'tool-auto-edit' }, { kind: 'clip', id: 'a' }]);
    // Bad arguments never throw: the tool itself reports them.
    assert.deepStrictEqual(planStage('update_clip', null, clips, media).lead, []);
    assert.strictEqual(planStage('get_project', undefined, clips, media).lead.length, 2);
  });

  t('diff: added, removed and changed clips', () => {
    const b2 = { ...clips[1], start: 8 };
    const d = diffClips(clips, [clips[0], b2, { id: 'n', trackId: 'v1', start: 30, duration: 2 }]);
    assert.deepStrictEqual(d, { added: ['n'], removed: ['c'], changed: ['b'] });
    assert.deepStrictEqual(diffClips(clips, clips), { added: [], removed: [], changed: [] });
  });

  t('deal: every item goes to exactly one stop, in order, and hands keep to their own stretch', () => {
    const items = Array.from({ length: 23 }, (_, i) => i);
    const dealt = deal(items, 5, 4);
    assert.strictEqual(dealt.length, 5);
    assert.ok(dealt.every((groups) => groups.length <= 4 && groups.every((g) => g.length > 0)));
    assert.deepStrictEqual(dealt.flat(2), items);
    // Fewer items than hands: one each, nobody empty-handed.
    assert.deepStrictEqual(deal(['x', 'y'], 5, 4), [[['x']], [['y']]]);
    assert.deepStrictEqual(deal([], 5, 4), []);
    assert.deepStrictEqual(deal(['x'], 0, 0), [[['x']]]);
  });

  await ta('with no window (tests, a hidden app) a call is not held up and nothing is drawn', async () => {
    const stage = await beginAgentStage({ tool: 'add_text', args: {}, client: 'test' });
    stage.progress(0.5, 'working');
    stage.end(true);
  });
}
