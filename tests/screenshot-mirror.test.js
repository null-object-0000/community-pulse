const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const store = require(path.join(ROOT, 'scripts', 'image-store.js'));

// The capture layer writes screenshot bytes beside its day file. They are local paths, not URLs to
// download, but they still have to become ordinary mirrors: only then does upload see them, only
// then does the markup get a path the CDN serves. Missing this step shipped 404 screenshots.
test('our screenshots are discovered from the report layer, not from the network', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-shots-'));
  const rawDir = path.join(dir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, '2026-09-13.json'), JSON.stringify({
    results: [{ items: [
      { title: 'A', screenshots: ['screenshots-files/aaa.png'] },
      { title: 'B', screenshots: [] },
      { title: 'C', screenshots: ['screenshots-files/bbb.webp', 'screenshots-files/ccc.png'] },
      // A hosted screenshot from an older report is not a local capture file.
      { title: 'D', screenshots: ['https://example.test/x.png'] },
    ] }],
  }));
  const found = store.screenshotUrls(['2026-09-13', '2026-09-14'], rawDir);
  assert.deepEqual([...found].sort(), ['screenshots-files/aaa.png', 'screenshots-files/bbb.webp', 'screenshots-files/ccc.png']);
  // A day with no report file contributes nothing rather than throwing.
  assert.equal(store.screenshotUrls(['2026-01-01'], rawDir).size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a captured screenshot becomes a normal mirror entry with the same content-addressed name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-shots2-'));
  const files = path.join(dir, 'screenshots-files');
  const storeDir = path.join(dir, 'store');
  fs.mkdirSync(files, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  const name = `${'a'.repeat(64)}.webp`;
  fs.writeFileSync(path.join(files, name), Buffer.from('webp-bytes'));

  const mirror = store.materializeScreenshot('screenshots-files/' + name, storeDir, files);
  assert.equal(mirror, `/images/${name}`, 'the CDN path keeps the content-addressed name');
  assert.ok(fs.existsSync(path.join(storeDir, name)), 'the bytes were copied into the mirror store');
  // Idempotent: a second call must not fail and must not need the capture file again.
  fs.rmSync(path.join(files, name));
  assert.equal(store.materializeScreenshot('screenshots-files/' + name, storeDir, files), `/images/${name}`);
  // A capture file that never landed yields no mirror rather than a broken entry.
  assert.equal(store.materializeScreenshot('screenshots-files/' + 'b'.repeat(64) + '.png', storeDir, files), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a screenshot that was never materialized fails the build instead of shipping a dead URL', () => {
  // The bug this guards: screenshots were local paths with no manifest entry, so the markup carried
  // `screenshots-files/<sha>.png` — a URL nobody serves — and the build passed silently.
  const local = 'screenshots-files/' + 'c'.repeat(64) + '.png';
  const manifest = {};
  assert.throws(() => store.localizeReport({ results: [{ items: [{ screenshots: [local] }] }] }, manifest), /images:sync|Missing screenshot/);
});
