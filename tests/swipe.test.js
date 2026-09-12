const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');

const root = path.join(__dirname, '..');
const local = '/images/' + 'a'.repeat(64) + '.png';

test('card rendering has an image treatment and a complete typographic fallback', () => {
  const pictured = D.renderSwipeItem({ title: 'Picture tool', summary: 'Short copy', sourceId: 'producthunt', images: [local], url: 'https://example.com' }, 'en', { index: 3 });
  assert.match(pictured, /class="swipe-item" data-depth="0"/);
  assert.match(pictured, /class="swipe-visual has-image"/);
  assert.match(pictured, new RegExp(`src="${local}"`));
  assert.match(pictured, /class="swipe-open"/);
  assert.ok(!pictured.includes('inert'), 'the top card stays interactive');

  const plain = D.renderSwipeItem({ title: 'A very useful compiler', summary: 'Explains the project in enough detail to stand on its own.', sourceId: 'hellogithub-issue', github: { language: 'Rust', stars: 1234 } }, 'en', { index: 1 });
  assert.match(plain, /class="swipe-visual is-typographic"/);
  assert.match(plain, /class="swipe-mark avatar-1"/);
  assert.match(plain, /A very useful compiler/);
  assert.match(plain, /Rust/);
  assert.match(plain, /1\.2K/);

  // A card waiting behind the top one is scenery: it must not add links or buttons to the tab order.
  const stacked = D.renderSwipeItem({ title: 'Behind', summary: 'x', url: 'https://example.com' }, 'en', { depth: 1, interactive: false });
  assert.match(stacked, /class="swipe-item" data-depth="1" inert aria-hidden="true"/);
  assert.ok(!stacked.includes('<a '), 'a deferred card renders no links at all');
  assert.ok(!stacked.includes('swipe-open'));
});

test('the deck keeps a bounded stack and moves the candidates the maths says it should', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  // The deck starts at the current item and never wraps around the ends.
  assert.deepEqual(D.swipeDeck(items, 0).map(entry => [entry.item, entry.depth, entry.interactive]), [['a', 0, true], ['b', 1, false], ['c', 2, false]]);
  assert.deepEqual(D.swipeDeck(items, 3).map(entry => entry.item), ['d', 'e']);
  assert.deepEqual(D.swipeDeck(items, 4).map(entry => entry.item), ['e']);

  // Dragging shows two cards in motion: the top one tilts, the next one grows and rises into place.
  const width = 390;
  const commitAt = D.swipeCommitDistance(width);
  const rest = D.swipeStackGeometry(0, width);
  assert.equal(rest.progress, 0);
  assert.equal(rest.rotate, 0);
  assert.equal(rest.nextScale, 0.94);
  assert.equal(rest.nextOffset, 14);
  // At the release distance the card behind has already reached full size, so the hand-off reads as
  // one card moving instead of a swap. This is the property the "rough" version was missing.
  const atCommit = D.swipeStackGeometry(-commitAt, width);
  assert.equal(atCommit.nextScale, 1, 'promotion completes by the commit distance');
  assert.equal(atCommit.nextOffset, 0);
  assert.equal(atCommit.thirdScale, 0.94, 'the third card moves up into the second slot');
  assert.equal(atCommit.thirdOffset, 14, 'and takes the second slot offset, not the top card position');
  assert.equal(D.swipeStackGeometry(-width, width).progress, 1, 'progress still tracks the whole width');
  // The tilt is clamped, and a short drag still tilts proportionally.
  assert.equal(D.swipeStackGeometry(-9999, width).rotate, -14);
  assert.equal(D.swipeStackGeometry(70, width).rotate, 5);
  assert.equal(D.swipeStackGeometry(0, 0).progress, 0, 'a zero width never divides by zero');

  // The commit distance scales with the card but stays inside sane bounds.
  assert.equal(D.swipeCommitDistance(100), 36);
  assert.equal(D.swipeCommitDistance(1000), 96);
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

test('the dense feed is unchanged and the card page keeps its remaining paging inputs', () => {
  const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
  const cards = fs.readFileSync(path.join(root, 'web', 'cards.js'), 'utf8');
  assert.doesNotMatch(app, /renderSwipeItem|swipe-stage|swipeStep/);
  assert.match(app, /filtered\.map\(\(item, index\) => D\.renderItem/);
  assert.match(cards, /location\.replace/);
  // The arrow keys are now the only non-gesture paging input: the two buttons were removed, so a
  // keyboard user must not lose paging with them.
  assert.match(cards, /ArrowLeft/);
  assert.match(cards, /ArrowRight/);
  assert.doesNotMatch(cards, /swipe-previous|swipe-next|swipe-controls/);
  assert.match(cards, /event\.clientX < 24/);
  assert.doesNotMatch(cards, /ArrowUp|ArrowDown/);
});

test('a flick commits the card even when the drag falls short of the distance', () => {
  // Distance alone is what made every card a deliberate drag; the speed path is the fix.
  assert.equal(D.swipeFlicked(-1.2), true);
  assert.equal(D.swipeFlicked(0.8), true);
  assert.equal(D.swipeFlicked(-0.3), false, 'a slow nudge under the threshold snaps back');
  assert.equal(D.swipeFlicked(0), false);
  const cards = fs.readFileSync(path.join(root, 'web', 'cards.js'), 'utf8');
  // The release must consult both, and the velocity has to come from time-stamped samples.
  assert.match(cards, /swipeFlicked\(velocity\)/);
  assert.match(cards, /samples\.push\(\{ x: event\.clientX, t: performance\.now\(\) \}\)/);
  assert.match(cards, /now - sample\.t < 120/);
  // A threshold in the low end of the 25–50% band the platforms use.
  assert.equal(D.swipeCommitDistance(390), 70.2);
  assert.ok(D.swipeCommitDistance(390) / 390 < 0.25);
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
    // The card page mirrors whatever the latest report holds; the count is not pinned to one day.
    const latest = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'data', 'reports', `${index.latest}.json`), 'utf8'));
    assert.equal(D.reportItems(data.report).length, D.reportItems(latest).length);
    assert.ok(D.reportItems(data.report).length > 0);
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
  assert.match(css, /\.swipe-visual \{[^}]*flex: 0 0 clamp\(/, 'the picture keeps a fixed ratio');
  assert.doesNotMatch(css, /\.swipe-visual \{[^}]*flex: 1 1 auto/, 'the picture must not stretch into a square crop');
  // The card fills the stage (no unused band above or below it) and the leftover height stays inside
  // the card, collected above the meta row by `margin-top: auto`.
  assert.match(css, /\.swipe-item \{[^}]*position: absolute; inset: 0/);
  assert.doesNotMatch(css, /\.swipe-stage \{[^}]*align-content: center/);
  assert.match(css, /\.swipe-meta \{[^}]*margin-top: auto/);
  // The page height comes from flex, not a hard-coded topbar height: the old `calc(100svh - 69px)`
  // disagreed with the real 73px bar and left the page scrollable.
  assert.match(css, /html:has\(body\[data-view="cards"\]\) \{ height: 100%; overflow: hidden; \}/);
  assert.match(css, /body\[data-view="cards"\] \{ display: flex; flex-direction: column; height: 100%; overflow: hidden; \}/);
  assert.match(css, /body\[data-view="cards"\] \.workspace \{ flex: 1 1 auto; width: 100%; height: auto/);
  assert.doesNotMatch(css, /calc\(100svh - \d+px\)/, 'no guessed topbar height');
  assert.match(css, /\.swipe-copy \.summary \{[^}]*-webkit-line-clamp: 9/);
  assert.ok(css.lastIndexOf('@media (prefers-reduced-motion: reduce)') > css.indexOf('.swipe-stage { --swipe-offset'));
  assert.doesNotMatch(css, /card-view/);
  // The two paging buttons are gone; only the gesture and the arrow keys page the deck.
  assert.doesNotMatch(css, /swipe-controls|swipe-previous|swipe-next/);
});

test('mobile hides the feed and its filters on the report that has a card page', () => {
  const css = fs.readFileSync(path.join(root, 'web', 'styles.css'), 'utf8');
  const media = css.match(/@media \(max-width: 600px\) \{\n  \.cards-entry \{ display: grid[\s\S]*?\n\}/)[0];
  // The feed, its search box and the filter row are hidden only where a card page exists.
  assert.match(media, /body\[data-cards-available="1"\] \.header-search,\n  body\[data-cards-available="1"\] \.discovery-results \{ display: none; \}/);
  // An archived report has no card page, so it must keep the list on mobile.
  assert.doesNotMatch(media, /^\s*\.header-search, \.discovery-results \{ display: none/m);
  // Desktop keeps the list: the rule lives inside the narrow-screen media query only.
  assert.ok(css.indexOf('body[data-cards-available="1"] .header-search') > css.indexOf('@media (max-width: 600px) {\n  .cards-entry'));

  const template = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  assert.match(template, /<body data-view="\{\{view\}\}"\{\{bodyAttrs\}\}>/);
  const render = fs.readFileSync(path.join(root, 'scripts', 'render-site.js'), 'utf8');
  assert.match(render, /bodyAttrs: entry \? 'data-cards-available="1"' : ''/);
});
