const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');

const root = path.join(__dirname, '..');
const local = '/images/' + 'a'.repeat(64) + '.png';

test('card rendering has an image treatment and a complete typographic fallback', () => {
  const pictured = D.renderSwipeItem({ title: 'Picture tool', summary: 'Short copy', sourceId: 'producthunt', images: [local], url: 'https://example.com' }, 'en', { index: 3 });
  assert.match(pictured, /class="swipe-item has-image"/);
  assert.match(pictured, /class="swipe-visual has-image"/);
  assert.match(pictured, new RegExp(`src="${local}"`));
  assert.match(pictured, /class="swipe-open"/);

  const plain = D.renderSwipeItem({ title: 'A very useful compiler', summary: 'Explains the project in enough detail to stand on its own.', sourceId: 'hellogithub-issue', github: { language: 'Rust', stars: 1234 } }, 'en', { index: 1 });
  assert.match(plain, /class="swipe-item is-typographic"/);
  assert.match(plain, /class="swipe-visual is-typographic"/);
  assert.match(plain, /class="swipe-mark avatar-1"/);
  assert.match(plain, /A very useful compiler/);
  assert.match(plain, /Rust/);
  assert.match(plain, /1\.2K/);
});

test('card content escapes source text and rejects unsafe destinations', () => {
  const html = D.renderSwipeItem({ title: '<script>x</script>', summary: '<img src=x>', sourceName: '<svg>', url: 'javascript:alert(1)' }, 'en');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('class="swipe-open"'));
});

test('horizontal steps follow the required direction and stop at both ends', () => {
  assert.equal(D.swipeStep(-60, 4), 1);
  assert.equal(D.swipeStep(60, -4), -1);
  assert.equal(D.swipeStep(-40, 0), 0);
  assert.equal(D.swipeStep(-80, 75), 0);
  assert.equal(D.boundedIndex(0, -1, 67), 0);
  assert.equal(D.boundedIndex(22, 1, 67), 23);
  assert.equal(D.boundedIndex(66, 1, 67), 66);
});

test('progress stores only the report date and greatest reached index', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let progress = D.readCardsProgress(storage, '2026-09-10', 67);
  assert.deepEqual(progress, { date: '2026-09-10', maxIndex: 0, readCount: 0, complete: false });
  assert.deepEqual(JSON.parse(values.get(D.cardsProgressKey)), { date: '2026-09-10', maxIndex: 0 });
  progress = D.writeCardsProgress(storage, '2026-09-10', 12, 67);
  // readCount counts items reached, so it matches the card page's own "13 / 67" position for index 12.
  assert.equal(progress.readCount, 13);
  assert.equal(D.writeCardsProgress(storage, '2026-09-10', 3, 67).maxIndex, 12);
  assert.equal(D.readCardsProgress(storage, '2026-09-10', 67).readCount, 13);
  assert.equal(D.writeCardsProgress(storage, '2026-09-10', 66, 67).complete, true);
  assert.equal(D.readCardsProgress(storage, '2026-09-11', 70).readCount, 0);
  assert.deepEqual(JSON.parse(values.get(D.cardsProgressKey)), { date: '2026-09-11', maxIndex: 0 });
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.doesNotThrow(() => D.readCardsProgress(blocked, '2026-09-11', 70));
  assert.doesNotThrow(() => D.writeCardsProgress(blocked, '2026-09-11', 1, 70));
});

test('the dense feed is unchanged and the independent script exposes every paging input', () => {
  const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
  const cards = fs.readFileSync(path.join(root, 'web', 'cards.js'), 'utf8');
  assert.doesNotMatch(app, /renderSwipeItem|swipe-stage|swipeStep/);
  assert.match(app, /filtered\.map\(\(item, index\) => D\.renderItem/);
  assert.match(cards, /location\.replace/);
  assert.match(cards, /ArrowLeft/);
  assert.match(cards, /ArrowRight/);
  assert.match(cards, /\.swipe-previous/);
  assert.match(cards, /\.swipe-next/);
  assert.match(cards, /event\.clientX < 24/);
  assert.doesNotMatch(cards, /ArrowUp|ArrowDown/);
});

test('build emits only latest noindex card routes, mobile entries, and no sitemap URLs', () => {
  const index = JSON.parse(fs.readFileSync(path.join(root, 'dist/data/index.json')));
  const sitemap = fs.readFileSync(path.join(root, 'dist/sitemap.xml'), 'utf8');
  assert.ok(!sitemap.includes('/cards/'));
  for (const prefix of ['', 'en/']) {
    const html = fs.readFileSync(path.join(root, 'dist', prefix, 'cards/index.html'), 'utf8');
    assert.match(html, /<meta name="robots" content="noindex, follow"/);
    assert.match(html, /<body data-view="cards">/);
    assert.match(html, /<script src="\/cards\.js" defer><\/script>/);
    assert.ok(!html.includes('<script src="/app.js"'));
    const data = JSON.parse(html.match(/<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(data.date, index.latest);
    assert.equal(D.reportItems(data.report).length, 67);
  }
  for (const file of ['dist/index.html', `dist/reports/${index.latest}/index.html`]) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(html, /data-cards-entry/);
    assert.match(html, /data-cards-progress/);
  }
});

test('styles keep the entry mobile-only, preserve vertical scrolling, and remove motion when requested', () => {
  const css = fs.readFileSync(path.join(root, 'web', 'styles.css'), 'utf8');
  assert.match(css, /\.cards-entry \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*\.cards-entry \{ display: grid/);
  assert.match(css, /\.swipe-stage \{[^}]*touch-action: pan-y/);
  assert.doesNotMatch(css.match(/\.swipe-stage \{ --swipe-offset[^}]*\}/)[0], /outline:\s*none/);
  assert.match(css, /\.swipe-copy \.summary \{[^}]*-webkit-line-clamp: 4/);
  assert.ok(css.lastIndexOf('@media (prefers-reduced-motion: reduce)') > css.indexOf('.swipe-stage { --swipe-offset'));
  assert.doesNotMatch(css, /card-view/);
});
