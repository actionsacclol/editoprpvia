// The video guides and the "Make a video with AI" chooser (src/utils/guides.ts):
// the list the Guides page shows must match the files that ship in
// resources/guides. Run from editor.test.mjs.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDES, GUIDE_FILE, MAKE_WAYS, chapterAt, findGuide, guideClock, guideUrl } from './.editor.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'guides');

export async function run({ t }) {
  t('guides: every guide has a video and a poster that ship with the app', () => {
    assert.ok(GUIDES.length >= 1);
    assert.strictEqual(new Set(GUIDES.map((g) => g.id)).size, GUIDES.length, 'ids are unique');
    for (const g of GUIDES) {
      assert.match(g.file, GUIDE_FILE, g.id);
      assert.match(g.poster, GUIDE_FILE, g.id);
      assert.strictEqual(g.file, `${g.id}.mp4`);
      assert.strictEqual(g.poster, `${g.id}.jpg`);
      for (const name of [g.file, g.poster]) {
        const st = fs.statSync(path.join(DIR, name));
        assert.ok(st.isFile() && st.size > 1000, `${name} is in resources/guides`);
      }
      // Small enough to ship in the installer.
      assert.ok(fs.statSync(path.join(DIR, g.file)).size < 12 * 1024 * 1024, `${g.file} is under 12 MB`);
      assert.ok(g.title && g.summary && g.action.label);
    }
    // Nothing else is in the folder: a file the list does not name would ship unseen.
    const named = new Set(GUIDES.flatMap((g) => [g.file, g.poster]));
    for (const f of fs.readdirSync(DIR)) assert.ok(named.has(f), `${f} is named by a guide`);
  });

  t('guides: chapters are in order and inside the video', () => {
    for (const g of GUIDES) {
      assert.ok(g.seconds > 20 && g.seconds < 180, `${g.id} length`);
      assert.ok(g.chapters.length >= 2, `${g.id} has chapters`);
      assert.strictEqual(g.chapters[0].at, 0);
      g.chapters.forEach((c, i) => {
        assert.ok(c.label.length > 0);
        assert.ok(c.at < g.seconds, `${g.id}: ${c.label} starts inside the video`);
        if (i) assert.ok(c.at > g.chapters[i - 1].at, `${g.id}: ${c.label} comes after the one before`);
      });
    }
  });

  t('guides: the chapter playing, the clock and the address', () => {
    const g = GUIDES[0];
    assert.strictEqual(chapterAt(g, 0), 0);
    assert.strictEqual(chapterAt(g, g.chapters[1].at - 0.5), 0);
    assert.strictEqual(chapterAt(g, g.chapters[1].at), 1);
    assert.strictEqual(chapterAt(g, g.seconds), g.chapters.length - 1);
    assert.strictEqual(chapterAt({ ...g, chapters: [] }, 5), -1);
    assert.strictEqual(guideClock(75), '1:15');
    assert.strictEqual(guideClock(59.6), '1:00');
    assert.strictEqual(guideClock(-3), '0:00');
    assert.strictEqual(guideUrl('first-edit.mp4'), 'krypteditor://guides/first-edit.mp4');
    assert.strictEqual(findGuide(g.id), g);
    assert.strictEqual(findGuide('nope'), undefined);
    assert.strictEqual(findGuide(null), undefined);
    // Only plain names are served: no folders, no other kinds of file.
    for (const bad of ['../main.js', 'a/b.mp4', 'first-edit.MP4', 'x.exe', '.mp4', 'a b.mp4']) assert.ok(!GUIDE_FILE.test(bad), bad);
  });

  t('guides: each way to make a video opens something and has a guide', () => {
    assert.deepStrictEqual(MAKE_WAYS.map((w) => w.id), ['script', 'website', 'screen', 'agent']);
    for (const w of MAKE_WAYS) {
      assert.ok(findGuide(w.guide), `${w.id} points at a guide that exists`);
      assert.ok(w.title && w.text && w.needs && w.button);
      // A video of an app starts with recording it, which is what its guide shows; the way itself opens the dialog that goes on from there.
      const same = w.id === 'screen' ? ['record', 'app'] : [w.feature];
      assert.ok(same.includes(findGuide(w.guide).action.feature) && (w.id !== 'screen' || w.feature === 'app'), `${w.id} and its guide open the same thing`);
    }
  });
}
