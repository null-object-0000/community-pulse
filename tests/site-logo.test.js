const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const D = require('../web/shared.js');
const SKILL = path.join(__dirname, '..', '.agents', 'skills', 'community-pulse', 'scripts');
const {
  candidatePage, normalizePageUrl, parseIconCandidates, pickIcon, faviconUrl, iconSize, imageKind,
} = require(path.join(SKILL, 'site_logo.js'));
const {
  resolvePage, eachDate, buildDocument, ICON_ACCEPT_LIMIT,
} = require(path.join(SKILL, 'capture_site_logos_raw.js'));
const { attachSiteLogos } = require(path.join(SKILL, 'source_raw_items.js'));
const { indexRecords, recordFor, lookupDate } = require(path.join(SKILL, 'backfill_site_logos.js'));
const { validateDocument } = require(path.join(SKILL, 'validate_site_logos_raw.js'));
const { imageExtension } = require('../scripts/image-store.js');

const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const GONE = { status: 404, body: null, contentType: '', kind: '', error: 'HTTP 404' };

// ---------------------------------------------------------------- candidate page

test('the fallback reads the row official website, never a platform page', () => {
  // websiteUrl first, then the repository homepage, then the row's own primary URL.
  assert.equal(candidatePage({ websiteUrl: 'https://a.test/', github: { homepage: 'https://b.test/' }, url: 'https://c.test/' }), 'https://a.test/');
  assert.equal(candidatePage({ github: { homepage: 'https://b.test/' }, url: 'https://c.test/' }), 'https://b.test/');
  assert.equal(candidatePage({ url: 'https://c.test/product' }), 'https://c.test/product');
  // A platform URL is skipped so a later candidate still wins: a submission that links GitHub but
  // declares a homepage must use the homepage, not github.com's mark.
  assert.equal(candidatePage({ websiteUrl: 'https://github.com/owner/repo', github: { homepage: 'https://kiri.test/' } }), 'https://kiri.test/');
  // Platforms, stores, article hosts and search engines are not an official website.
  for (const url of [
    'https://github.com/owner/repo',
    'https://gist.github.com/x/y',
    'https://raw.githubusercontent.com/owner/repo/main/badge',
    'https://chromewebstore.google.com/detail/x',
    'https://apps.apple.com/cn/app/x/id1',
    'https://play.google.com/store/apps/details?id=x',
    'https://mp.weixin.qq.com/s/abc',
    'https://www.zhihu.com/question/1',
    'https://www.bilibili.com/video/BV1',
    'https://x.com/someone/status/1',
    'https://www.google.com/search?q=x',
  ]) assert.equal(candidatePage({ url }), '', url);
  // A GitHub Pages project site is the project's own site, not the platform's.
  assert.equal(candidatePage({ url: 'https://jaywcjlove.github.io/tool/' }), 'https://jaywcjlove.github.io/tool/');
  // A link to a file is not a website (README badges show up as submitted URLs).
  assert.equal(candidatePage({ url: 'https://img.test/badge.svg' }), '');
});

test('page URLs are normalized and tracking parameters dropped', () => {
  assert.equal(normalizePageUrl('https://Example.test/a/?utm_source=x&utm_medium=y#frag'), 'https://example.test/a/');
  assert.equal(normalizePageUrl('https://example.test/a/?page=2'), 'https://example.test/a/?page=2');
  for (const value of ['', null, undefined, 'not a url', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.test/']) {
    assert.equal(normalizePageUrl(value), '', String(value));
  }
});

// ---------------------------------------------------------------- icon parsing

test('the declared icon is ranked by how well it reads at 48px', () => {
  const html = `<html><head>
    <link rel="icon" href="/favicon-32.png" sizes="32x32">
    <link rel="apple-touch-icon" href="/apple-icon.png" sizes="180x180">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="icon" href="/icon-192.png" sizes="192x192">
    <link rel="mask-icon" href="/mask.svg" color="#000">
  </head></html>`;
  assert.deepEqual(parseIconCandidates(html, 'https://site.test/').map((icon) => [icon.kind, icon.url]), [
    ['apple-touch-icon', 'https://site.test/apple-icon.png'],
    ['icon', 'https://site.test/icon-192.png'],
    ['icon', 'https://site.test/favicon.svg'],
    ['icon', 'https://site.test/favicon-32.png'],
    ['mask-icon', 'https://site.test/mask.svg'],
  ]);
  assert.equal(iconSize('180x180'), 180);
  assert.equal(iconSize('16x16 32x32'), 32);
  assert.equal(iconSize('any'), 1024);
  assert.equal(faviconUrl('https://site.test/deep/page'), 'https://site.test/favicon.ico');
});

test('relative icons, <base> and schema.org logos are understood; unusable hrefs are not', () => {
  const based = `<base href="https://cdn.test/assets/"><link rel="icon" href="mark.png">`;
  assert.deepEqual(parseIconCandidates(based, 'https://site.test/').map((icon) => icon.url), ['https://cdn.test/assets/mark.png']);
  const relative = `<link rel="shortcut icon" href="favicon.ico">`;
  assert.deepEqual(parseIconCandidates(relative, 'https://site.test/deep/').map((icon) => icon.url), ['https://site.test/deep/favicon.ico']);
  // An inline data: icon can never be mirrored, so it is not a candidate at all.
  assert.deepEqual(parseIconCandidates('<link rel="icon" href="data:image/png;base64,AAA">', 'https://site.test/'), []);
  const jsonLd = `<script type="application/ld+json">{"@type":"Organization","logo":{"@type":"ImageObject","url":"/brand.png"}}</script>`;
  assert.deepEqual(parseIconCandidates(jsonLd, 'https://site.test/').map((icon) => [icon.kind, icon.url]), [['json-ld-logo', 'https://site.test/brand.png']]);
  // `image` on those nodes is routinely a screenshot; only the declared logo counts.
  assert.deepEqual(parseIconCandidates(`<script type="application/ld+json">{"@type":"Organization","image":"/shot.png"}</script>`, 'https://site.test/'), []);
  // A declared icon outranks a schema.org wordmark, and duplicates keep their best rank.
  const both = `<link rel="icon" href="/f.ico"><link rel="apple-touch-icon" href="/f.ico">` +
    `<script type="application/ld+json">{"@type":"WebSite","logo":"/wide.png"}</script>`;
  assert.deepEqual(parseIconCandidates(both, 'https://site.test/').map((icon) => [icon.kind, icon.url]), [
    ['apple-touch-icon', 'https://site.test/f.ico'],
    ['json-ld-logo', 'https://site.test/wide.png'],
  ]);
  assert.equal(pickIcon([]), null);
});

test('byte sniffing matches the image mirror, and HTML is never an icon', () => {
  const fixtures = {
    png: PNG,
    jpg: Buffer.from('ffd8ffe000104a464946', 'hex'),
    gif: Buffer.from('GIF89a....', 'ascii'),
    webp: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]),
    avif: Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif')]),
    ico: Buffer.from([0, 0, 1, 0, 1, 0]),
    svg: Buffer.from('\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  };
  for (const [kind, bytes] of Object.entries(fixtures)) {
    assert.equal(imageKind(bytes), kind, kind);
    // The mirror and the capture must agree, or a captured icon would fail to sync later.
    assert.equal(imageExtension(bytes), kind === 'jpg' ? 'jpg' : kind, kind);
  }
  for (const bytes of ['<!DOCTYPE html><html>404</html>', '<html>error</html>', 'missing']) {
    assert.throws(() => imageKind(Buffer.from(bytes)), /unsupported image/);
    assert.throws(() => imageExtension(Buffer.from(bytes)), /Unsupported or invalid/);
  }
});

// ---------------------------------------------------------------- capture decisions

function workingDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'site-logo-test-'));
}

function pageIo(html, bytesByUrl, { pageStatus = 200, pageError = '' } = {}) {
  const calls = [];
  return {
    calls,
    io: {
      fetchPageHtml: async () => ({ status: pageStatus, body: Buffer.from(html), contentType: 'text/html', text: pageStatus === 200 ? html : '', error: pageError }),
      fetchIconBytes: async (url) => {
        calls.push(url);
        const entry = bytesByUrl[url];
        if (!entry) return { ...GONE };
        return { status: 200, body: entry, kind: imageKind(entry), contentType: 'image/png', error: '' };
      },
    },
  };
}

test('a page resolves to the declared icon and records every attempt', async () => {
  const html = `<link rel="icon" href="/favicon-32.png"><link rel="apple-touch-icon" href="/apple.png">`;
  const { io, calls } = pageIo(html, {
    'https://site.test/apple.png': PNG,
    'https://site.test/favicon-32.png': PNG,
  });
  const result = await resolvePage('https://site.test/', workingDir(), new Map(), io);
  assert.equal(result.status, 'ok');
  assert.equal(result.iconUrl, 'https://site.test/apple.png');
  assert.equal(result.iconKind, 'apple-touch-icon');
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.byteLength, PNG.length);
  assert.equal(result.contentSha256, crypto.createHash('sha256').update(PNG).digest('hex'));
  assert.deepEqual(calls, ['https://site.test/apple.png']);
  assert.deepEqual(result.attempts, [{ url: 'https://site.test/apple.png', kind: 'png', status: 'ok', cached: false, error: '' }]);
});

test('a broken declared icon falls through to the next candidate and then to /favicon.ico', async () => {
  const html = `<link rel="apple-touch-icon" href="/apple.png"><link rel="icon" href="/favicon-32.png">`;
  const { io, calls } = pageIo(html, { 'https://site.test/favicon.ico': PNG });
  const result = await resolvePage('https://site.test/', workingDir(), new Map(), io);
  assert.equal(result.iconUrl, 'https://site.test/favicon.ico');
  assert.equal(result.iconKind, 'default-favicon');
  assert.deepEqual(calls, ['https://site.test/apple.png', 'https://site.test/favicon-32.png', 'https://site.test/favicon.ico']);
  assert.deepEqual(result.attempts.map((attempt) => attempt.status), ['failed', 'failed', 'ok']);
});

test('an oversized brand poster is skipped in favour of the small favicon', async () => {
  const poster = Buffer.concat([PNG, Buffer.alloc(ICON_ACCEPT_LIMIT)]);
  const html = `<link rel="icon" href="/poster.png"><link rel="icon" href="/small.png">`;
  const { io } = pageIo(html, { 'https://site.test/poster.png': poster, 'https://site.test/small.png': PNG });
  const result = await resolvePage('https://site.test/', workingDir(), new Map(), io);
  assert.equal(result.iconUrl, 'https://site.test/small.png');
  assert.equal(result.attempts[0].status, 'failed');
  assert.match(result.attempts[0].error, /over the 256 KiB mirror budget/);
});

test('a page with no usable icon is a soft miss, a broken page is a failure', async () => {
  const { io } = pageIo('', {}, { pageStatus: 404, pageError: 'HTTP 404' });
  const failed = await resolvePage('https://site.test/', workingDir(), new Map(), io);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'HTTP 404');
  assert.equal(failed.iconUrl, '');

  const poster = Buffer.concat([PNG, Buffer.alloc(ICON_ACCEPT_LIMIT)]);
  const oversized = pageIo(`<link rel="icon" href="/poster.png">`, { 'https://site.test/poster.png': poster });
  const missing = await resolvePage('https://site.test/', workingDir(), new Map(), oversized.io);
  assert.equal(missing.status, 'missing');
  assert.match(missing.error, /every declared icon exceeds the 256 KiB mirror budget/);
});

test('pages that share an icon are downloaded once per run', async () => {
  const cache = new Map();
  const first = pageIo(`<link rel="icon" href="https://shared.test/shared.png">`, { 'https://shared.test/shared.png': PNG });
  await resolvePage('https://a.test/', workingDir(), cache, first.io);
  const second = pageIo(`<link rel="icon" href="https://shared.test/shared.png">`, { 'https://shared.test/shared.png': PNG });
  const result = await resolvePage('https://b.test/', workingDir(), cache, second.io);
  assert.deepEqual(second.calls, []);
  assert.equal(result.status, 'ok');
  assert.equal(result.attempts[0].cached, true);
});

// ---------------------------------------------------------------- offline layers

test('the day file counts and hash describe exactly the stored records', () => {
  const records = [
    { sourceId: 'weekly-issues', externalId: '1', pageUrl: 'https://a.test/', status: 'ok', iconUrl: 'https://a.test/i.png' },
    { sourceId: 'weekly-issues', externalId: '2', pageUrl: 'https://b.test/', status: 'missing', iconUrl: '', error: 'no usable icon' },
    { sourceId: 'weekly-issues', externalId: '3', pageUrl: 'https://c.test/', status: 'failed', iconUrl: '', error: 'HTTP 500' },
    { sourceId: 'github-trending', externalId: '1', pageUrl: 'https://a.test/', status: 'ok', iconUrl: 'https://a.test/i.png' },
  ];
  const document = buildDocument('2026-09-10', records, { complete: true, skippedSources: [], refreshed: false, concurrency: 6 });
  assert.equal(document.itemCount, 2);
  assert.equal(document.candidateCount, 4);
  assert.equal(document.pageCount, 3);
  assert.equal(document.missingCount, 1);
  assert.equal(document.failureCount, 1);
  assert.equal(document.contentSha256, crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex'));
  assert.equal(document.status, 'ok');
  assert.equal(buildDocument('2026-09-10', [], { complete: true, skippedSources: [], refreshed: false, concurrency: 6 }).status, 'empty');
});

test('site logos are attached offline to rows that have no product mark', () => {
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'site-logo-raw-'));
  fs.mkdirSync(path.join(rawRoot, 'site-logos'), { recursive: true });
  const record = (sourceId, externalId, pageUrl, iconUrl) => ({ sourceId, externalId, pageUrl, status: 'ok', iconUrl });
  fs.writeFileSync(path.join(rawRoot, 'site-logos', '2026-09-10.json'), JSON.stringify({
    schemaVersion: 1,
    sourceId: 'site-logos',
    targetDate: '2026-09-10',
    complete: true,
    records: [
      record('weekly-issues', '1', 'https://kiri.test/', 'https://kiri.test/icon.png'),
      // A renamed row loses its external id but still matches the website it points at.
      record('weekly-issues', 'renamed', 'https://omni.test/', 'https://omni.test/icon.png'),
      record('weekly-issues', '3', 'https://gone.test/', null),
    ].map((entry) => (entry.iconUrl ? entry : { sourceId: 'weekly-issues', externalId: '3', pageUrl: 'https://gone.test/', status: 'missing', iconUrl: '', error: 'no usable icon' })),
  }));
  const items = [
    { sourceId: 'weekly-issues', externalId: '1', title: 'by id', url: 'https://kiri.test/' },
    { sourceId: 'weekly-issues', externalId: 'renamed', title: 'by page', url: 'https://omni.test/x' },
    { sourceId: 'weekly-issues', externalId: '3', title: 'no icon', url: 'https://gone.test/' },
    { sourceId: 'weekly-issues', externalId: '4', title: 'unknown', url: 'https://other.test/' },
    { sourceId: 'weekly-issues', externalId: '1', title: 'has a real mark', url: 'https://kiri.test/', logo: 'https://cdn.test/logo.png' },
  ];
  const attached = attachSiteLogos(items, 'weekly-issues', '2026-09-10', rawRoot);
  assert.equal(attached[0].siteLogo, 'https://kiri.test/icon.png');
  assert.equal(attached[1].siteLogo, 'https://omni.test/icon.png');
  assert.equal(attached[2].siteLogo, undefined);
  assert.equal(attached[3].siteLogo, undefined);
  assert.equal(attached[4].siteLogo, undefined);
  // A day without a captured file simply changes nothing.
  assert.deepEqual(attachSiteLogos(items, 'weekly-issues', '2026-09-11', rawRoot), items);
  assert.deepEqual(attachSiteLogos(items, 'weekly-issues', '2026-09-10', path.join(rawRoot, 'missing')), items);
});

test('the backfill writes the captured icon onto mark-less rows only', () => {
  const index = indexRecords([
    { sourceId: 'weekly-issues', externalId: '1', pageUrl: 'https://a.test/', status: 'ok', iconUrl: 'https://a.test/i.png' },
    { sourceId: 'weekly-issues', externalId: '2', pageUrl: 'https://b.test/x', status: 'ok', iconUrl: 'https://b.test/i.png' },
    { sourceId: 'weekly-issues', externalId: '3', pageUrl: 'https://c.test/', status: 'missing', iconUrl: '', error: 'no usable icon' },
  ]);
  assert.equal(recordFor({ externalId: '1', url: 'https://a.test/' }, 'weekly-issues', index).iconUrl, 'https://a.test/i.png');
  assert.equal(recordFor({ externalId: 'drifted', url: 'https://b.test/x' }, 'weekly-issues', index).iconUrl, 'https://b.test/i.png');
  assert.equal(recordFor({ externalId: '3', url: 'https://c.test/' }, 'weekly-issues', index), null);
  assert.equal(recordFor({ externalId: '4', url: 'https://github.com/o/r' }, 'weekly-issues', index), null);
  // Trending rows are loaded from the day file of their observation day, not the report day.
  assert.equal(lookupDate({ sourceId: 'github-trending', sourceRaw: { path: '知识/大家都在做什么/source-raw/github-trending/2026-09-11.json' } }, '2026-09-10'), '2026-09-11');
  assert.equal(lookupDate({ sourceId: 'weekly-issues', sourceRaw: { path: '知识/大家都在做什么/source-raw/weekly-issues/2026-09-10.json' } }, '2026-09-10'), '2026-09-10');
  assert.equal(lookupDate({ sourceId: 'github-trending' }, '2026-09-10'), '2026-09-10');
  assert.deepEqual(eachDate('2026-09-09', '2026-09-11'), ['2026-09-09', '2026-09-10', '2026-09-11']);
});

// ---------------------------------------------------------------- site rendering

test('the avatar falls back from the product mark to the website logo, then to initials', () => {
  const local = (char) => `/images/${char.repeat(64)}.png`;
  const [logo, icon, site] = [local('a'), local('b'), local('c')];
  const avatar = (item) => D.renderItem(item, 'en').match(/<span class="item-avatar[^>]*>(.*?)<\/span>/s)[1];
  assert.match(D.renderItem({ title: 'Logo', logo }, 'en'), /class="item-avatar avatar-0 has-logo"/);
  assert.doesNotMatch(D.renderItem({ title: 'Fallback' }, 'en'), /class="item-avatar avatar-0 has-logo"/);
  assert.equal(avatar({ title: 'Both', logo, siteLogo: site }), `<img src="${logo}" class="is-logo" alt="" loading="lazy" />`);
  assert.equal(avatar({ title: 'Icon', icon, siteLogo: site }), `<img src="${icon}" class="is-logo" alt="" loading="lazy" />`);
  assert.equal(avatar({ title: 'Site', siteLogo: site }), `<img src="${site}" class="is-logo" alt="" loading="lazy" />`);
  // A screenshot is not a mark: it belongs to the gallery, so the row shows its initials instead.
  assert.equal(avatar({ title: 'Kiri', url: 'https://kiri.test/', image: local('d') }), 'Ki');
  // An unsynced website logo is dropped rather than hotlinked from an untrusted host.
  assert.equal(avatar({ title: 'Remote', siteLogo: 'https://site.test/icon.png' }), 'Re');
});

test('the validator rejects a layer whose evidence or coverage does not hold up', () => {
  const key = (sourceId, externalId) => `${sourceId}\u0000${externalId}`;
  const record = { sourceId: 'weekly-issues', externalId: '1', title: 't', reportDate: '2026-09-10', pageUrl: 'https://a.test/', status: 'ok', iconUrl: 'https://a.test/i.png', iconKind: 'apple-touch-icon', contentType: 'image/png', byteLength: 12, contentSha256: 'a'.repeat(64), declaredIconCount: 1, attempts: [{ url: 'https://a.test/i.png', kind: 'png', status: 'ok', cached: false, error: '' }], error: '' };
  const document = () => ({
    schemaVersion: 1,
    sourceId: 'site-logos',
    sourceName: '官网 Logo 兜底',
    targetDate: '2026-09-10',
    timezone: 'Asia/Shanghai',
    status: 'ok',
    complete: true,
    fetchedAt: '2026-09-11T00:00:00.000Z',
    itemCount: 1,
    candidateCount: 1,
    pageCount: 1,
    missingCount: 0,
    failureCount: 0,
    contentSha256: crypto.createHash('sha256').update(JSON.stringify([record])).digest('hex'),
    capture: { mode: 'website-logo-fallback' },
    records: [record],
  });
  const expected = new Map([[key('weekly-issues', '1'), record]]);

  const clean = [];
  const warnings = [];
  validateDocument(document(), 'file.json', '2026-09-10', expected, clean, warnings);
  assert.deepEqual([clean, warnings], [[], []]);

  // A hash that no longer describes the records stops the build from trusting the day file.
  const tampered = document();
  tampered.records = [{ ...record, byteLength: 999 }];
  const hashErrors = [];
  validateDocument(tampered, 'file.json', '2026-09-10', expected, hashErrors, []);
  assert.ok(hashErrors.some((error) => /contentSha256 does not match/.test(error)), hashErrors.join('; '));

  // An `ok` row without a successful attempt is not evidence.
  const unbacked = document();
  unbacked.records = [{ ...record, attempts: [{ url: 'https://a.test/i.png', kind: 'png', status: 'failed', cached: false, error: 'HTTP 500' }] }];
  unbacked.contentSha256 = crypto.createHash('sha256').update(JSON.stringify(unbacked.records)).digest('hex');
  const unbackedErrors = [];
  validateDocument(unbacked, 'file.json', '2026-09-10', expected, unbackedErrors, []);
  assert.ok(unbackedErrors.some((error) => /no successful attempt/.test(error)), unbackedErrors.join('; '));

  // A platform page is never an official website, and an unnormalized URL is a bug.
  const platform = document();
  platform.records = [{ ...record, pageUrl: 'https://github.com/owner/repo', status: 'missing', iconUrl: '', iconKind: '', contentType: '', byteLength: 0, contentSha256: '', attempts: [], error: 'HTTP 404' }];
  platform.contentSha256 = crypto.createHash('sha256').update(JSON.stringify(platform.records)).digest('hex');
  const platformErrors = [];
  validateDocument(platform, 'file.json', '2026-09-10', expected, platformErrors, []);
  assert.ok(platformErrors.some((error) => /platform page/.test(error)), platformErrors.join('; '));

  // A candidate with no record is a gap the build must not swallow; an explicitly partial file warns.
  const gapErrors = [];
  const gapWarnings = [];
  validateDocument(document(), 'file.json', '2026-09-10', new Map([...expected, [key('weekly-issues', '2'), { ...record, externalId: '2' }]]), gapErrors, gapWarnings);
  assert.ok(gapErrors.some((error) => /1 candidate row\(s\) have no record/.test(error)), gapErrors.join('; '));
  const partial = document();
  partial.complete = false;
  const partialErrors = [];
  const partialWarnings = [];
  validateDocument(partial, 'file.json', '2026-09-10', new Map([...expected, [key('weekly-issues', '2'), { ...record, externalId: '2' }]]), partialErrors, partialWarnings);
  assert.deepEqual(partialErrors.filter((error) => /have no record/.test(error)), []);
  assert.ok(partialWarnings.some((warning) => /have no record/.test(warning)));
});
