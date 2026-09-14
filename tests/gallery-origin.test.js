const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SKILL = path.join(__dirname, '..', '.agents', 'skills', 'community-pulse', 'scripts');
const D = require('../web/shared.js');
const { parseOgImage } = require(path.join(SKILL, 'site_logo.js'));
const { loadScreenshots, attachScreenshots } = require(path.join(SKILL, 'source_raw_items.js'));

const mirror = (hex) => `https://img.devtrends.site/images/${hex.repeat(64)}.png`;
const A = mirror('a'), B = mirror('b'), C = mirror('c');

// ------------------------------------------------------------------ og:image 解析

test('the og:image is read from the head and resolved relative to the page', () => {
  assert.equal(parseOgImage(`<meta property="og:image" content="https://a.test/og.png">`, 'https://a.test/'), 'https://a.test/og.png');
  // A relative path resolves against the page, like the icon candidates do.
  assert.equal(parseOgImage(`<meta property="og:image" content="/og.png">`, 'https://a.test/page'), 'https://a.test/og.png');
  assert.equal(parseOgImage(`<meta name="twitter:image" content="https://a.test/tw.png">`, 'https://a.test/'), 'https://a.test/tw.png');
  assert.equal(parseOgImage(`<meta property="og:image:secure_url" content="https://a.test/s.png">`, 'https://a.test/'), 'https://a.test/s.png');
  // Entities decoded; a page with no social image yields an empty string rather than a crash.
  assert.equal(parseOgImage(`<meta property="og:image" content="https://a.test/a&amp;b.png">`, 'https://a.test/'), 'https://a.test/a&b.png');
  assert.equal(parseOgImage('<html><head></head></html>', 'https://a.test/'), '');
  assert.equal(parseOgImage('', 'https://a.test/'), '');
});

// ------------------------------------------------------------------ 三类来源与顺序

test('the gallery orders the source media, then our screenshot, then the site og:image', () => {
  const item = { images: [A], screenshots: [B], ogImage: { url: C } };
  assert.deepEqual(D.mediaEntries(item).map(entry => entry.origin), ['original', 'screenshot', 'og']);
});

test('an og:image that is literally the product logo is dropped from the gallery', () => {
  // This is the real shape measured in the source data: photobridge-app.vercel.app served its
  // icon.png as both the mark and the og:image, so the gallery would show the avatar twice.
  const sameFile = { markImage: { sha256: 'deadbeef' }, ogImage: { url: A, sha256: 'deadbeef' } };
  assert.deepEqual(D.mediaEntries(sameFile), []);
  // A different file is kept: only 1 of the 4 logo-like OG images was an actual duplicate.
  const different = { markImage: { sha256: 'deadbeef' }, ogImage: { url: B, sha256: 'cafebabe' } };
  assert.deepEqual(D.mediaEntries(different).map(entry => entry.origin), ['og']);
});

test('the same file reaching two origins keeps only its highest-priority origin', () => {
  const item = { images: [A], screenshots: [A], ogImage: { url: A } };
  assert.deepEqual(D.mediaEntries(item), [{ url: A, origin: 'original' }]);
});

test('anything outside the trusted origins is dropped from the gallery', () => {
  const hostile = { images: ['https://evil.test/x.png'], screenshots: ['https://evil.test/y.png'] };
  assert.deepEqual(D.mediaEntries(hostile), []);
});

// ------------------------------------------------------------------ 来源标签

test('every gallery thumbnail names where its image came from', () => {
  const html = D.galleryHtml([{ url: A, origin: 'original' }, { url: B, origin: 'screenshot' }, { url: C, origin: 'og' }], 'zh-CN');
  assert.equal([...html.matchAll(/gallery-origin">([^<]+)</g)].map(match => match[1]).join(','), '原始配图,官网截图,OG 图');
  // The English locale uses its own wording rather than the Chinese strings.
  assert.ok(D.galleryHtml([{ url: A, origin: 'screenshot' }], 'en').includes('Screenshot'));
});

test('data-gallery stays a plain URL array for the lightbox, origins travel beside it', () => {
  const html = D.galleryHtml([{ url: A, origin: 'og' }], 'en');
  assert.ok(html.includes(`data-gallery="[&quot;${A}&quot;]"`), 'the viewer parses this directly');
  assert.ok(html.includes('data-origins='), 'origin labels for the viewer');
});

test('a plain URL list still renders, defaulting to the source-original label', () => {
  // Older callers and existing tests pass bare strings; the signature must stay compatible.
  const html = D.galleryHtml([A, B], 'zh-CN');
  assert.ok(html.includes('原始配图'));
  assert.ok(!html.includes('gallery-more'));
});

// ------------------------------------------------------------------ 截图层挂载

test('our screenshot attaches to a row and never overwrites one already set', () => {
  const index = { byKey: new Map([['showhn\u00001', { source: 'screenshots-files/x.png' }]]) };
  const [filled] = attachScreenshots([{ sourceId: 'showhn', externalId: '1', title: 'T' }], index);
  assert.deepEqual(filled.screenshots, ['screenshots-files/x.png']);
  const existing = { sourceId: 'showhn', externalId: '1', screenshots: ['screenshots-files/y.png'] };
  assert.equal(attachScreenshots([existing], index)[0], existing);
  // A row with no captured screenshot is returned untouched, not given an empty list.
  const none = { sourceId: 'showhn', externalId: '9', title: 'T' };
  assert.equal(attachScreenshots([none], index)[0], none);
});

test('a missing screenshot layer is not an error', () => {
  assert.equal(loadScreenshots('2026-09-13', '/nonexistent-root'), null);
  const item = { sourceId: 'showhn', externalId: '1' };
  assert.equal(attachScreenshots([item], null)[0], item);
});

test('the screenshot capture validates the rendered DOM instead of trusting the file size', () => {
  // A real failure mode measured on this machine: Chrome rendered its own ERR_CONNECTION_CLOSED
  // page, which produced a perfectly sized PNG. Only the DOM check catches it.
  const source = require('node:fs').readFileSync(path.join(SKILL, 'capture_screenshots_raw.js'), 'utf8');
  assert.match(source, /ERR_/);
  assert.match(source, /rendered its own error page/);
  // Nothing may re-fetch the page: one response feeds the icons, the description and the og:image.
  assert.equal((source.match(/--screenshot=/g) || []).length, 1);
});
