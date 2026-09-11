const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');

const local = '/images/' + 'a'.repeat(64) + '.png';

test('mobile swipe rendering has an image treatment and a complete typographic fallback', () => {
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
  assert.match(plain, /source-hellogithub\.svg/);
});

test('swipe card content escapes source text and rejects unsafe destinations', () => {
  const html = D.renderSwipeItem({ title: '<script>x</script>', summary: '<img src=x>', sourceName: '<svg>', url: 'javascript:alert(1)' }, 'en');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('class="swipe-open"'));
});

test('swipe steps use vertical intent and stop at both ends', () => {
  assert.equal(D.swipeStep(-60, 4), 1);
  assert.equal(D.swipeStep(60, -4), -1);
  assert.equal(D.swipeStep(-40, 0), 0);
  assert.equal(D.swipeStep(-80, 75), 0);
  assert.equal(D.boundedIndex(0, -1, 67), 0);
  assert.equal(D.boundedIndex(22, 1, 67), 23);
  assert.equal(D.boundedIndex(66, 1, 67), 66);
});

test('mobile implementation keeps one swipe item and exposes alternate inputs', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  assert.match(app, /matchMedia\('\(max-width: 600px\)'\)/);
  assert.match(app, /swipeStage\.innerHTML = D\.renderSwipeItem\(swipeItems\[swipeIndex\]/);
  assert.doesNotMatch(app, /swipeItems\.map\([^\n]*renderSwipeItem/);
  assert.match(app, /addEventListener\('pointerdown'/);
  assert.match(app, /addEventListener\('pointermove'/);
  assert.match(app, /ArrowUp/);
  assert.match(app, /ArrowDown/);
  assert.match(app, /class="swipe-previous"/);
  assert.match(app, /class="swipe-next"/);
  assert.match(app, /textContent = `\$\{swipeIndex \+ 1\} \/ \$\{swipeItems\.length\}`/);
});

test('swipe styles reserve vertical gestures and remove motion when requested', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');
  assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*\.swipe-stage \{[^}]*touch-action: pan-x/);
  assert.doesNotMatch(css.match(/\.swipe-stage \{ --swipe-offset[^}]*\}/)[0], /outline:\s*none/);
  assert.match(css, /\.swipe-copy \.summary \{[^}]*-webkit-line-clamp: 5/);
  assert.ok(css.lastIndexOf('@media (prefers-reduced-motion: reduce) { .swipe-stage { transition: none; }') > css.indexOf('.swipe-stage { --swipe-offset'));
  assert.doesNotMatch(css, /card-view/);
});
