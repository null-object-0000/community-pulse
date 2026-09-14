const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SKILL = path.join(__dirname, '..', '.agents', 'skills', 'community-pulse', 'scripts');
const { parsePageDescription } = require(path.join(SKILL, 'site_logo.js'));
const {
  attachDescriptionFallback, loadSiteDescriptions, sourceDescriptionLength,
  meetsDescriptionFloor, DESCRIPTION_MIN_LENGTH,
} = require(path.join(SKILL, 'source_raw_items.js'));
const { resolvePage } = require(path.join(SKILL, 'capture_site_logos_raw.js'));

const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const LONG = 'A tool that does something long enough to clear the forty character floor.';
const LONG2 = 'Repository copy that is also long enough to clear the floor.';
const LONG3 = 'Website copy that is long enough to clear the forty character floor.';
const SHORT = '短描述';

// ------------------------------------------------------------ 官网描述的解析

test('the page description prefers <meta name=description> and falls back to og:description', () => {
  assert.equal(parsePageDescription(`<meta name="description" content="Primary text here">`), 'Primary text here');
  assert.equal(parsePageDescription(`<meta property="og:description" content="Social card text">`), 'Social card text');
  // name=description wins when both are present.
  assert.equal(
    parsePageDescription(`<meta property="og:description" content="Social"><meta name="description" content="Primary">`),
    'Primary');
  // Attributes in either order, entities decoded, whitespace collapsed.
  assert.equal(parsePageDescription(`<meta content="A &amp; B\n  wrapped" name="description">`), 'A & B wrapped');
  // No description declared is an empty string, not a crash.
  assert.equal(parsePageDescription('<html><head></head></html>'), '');
  assert.equal(parsePageDescription(''), '');
});

test('the capture reads the description out of the same response as the icon', async () => {
  const html = `<meta name="description" content="${LONG}"><link rel="apple-touch-icon" href="/apple.png">`;
  const io = {
    fetchPageHtml: async () => ({ status: 200, body: Buffer.from(html), contentType: 'text/html', kind: '', error: '', text: html }),
    fetchIconBytes: async () => ({ status: 200, body: PNG, contentType: 'image/png', kind: 'png', error: '' }),
  };
  const result = await resolvePage('https://site.test/', os.tmpdir(), new Map(), io);
  assert.equal(result.status, 'ok');
  assert.equal(result.description, LONG);
});

// ------------------------------------------------------------ 三级兜底

test('the description floor is the same forty characters the dedupe uses', () => {
  assert.equal(DESCRIPTION_MIN_LENGTH, 40);
  assert.equal(meetsDescriptionFloor(LONG), true);
  assert.equal(meetsDescriptionFloor(SHORT), false);
  assert.equal(meetsDescriptionFloor(''), false);
  assert.equal(meetsDescriptionFloor(null), false);
});

test('the source description is the longest field the row already carries', () => {
  // summary is short but content is long: the row does have a description, it must not be "backfilled".
  assert.equal(sourceDescriptionLength({ summary: SHORT, content: LONG }), LONG.length);
  // Product Hunt keeps its copy in the launch block.
  assert.equal(sourceDescriptionLength({ summary: SHORT, launch: { tagline: LONG } }), LONG.length);
  assert.equal(sourceDescriptionLength({ summary: SHORT }), SHORT.length);
  assert.equal(sourceDescriptionLength({}), 0);
});

test('a row that already has a description is never overwritten', () => {
  const item = { summary: LONG, content: LONG };
  const filled = attachDescriptionFallback([item], {
    repositories: new Map(),
    descriptions: { byExternalId: new Map(), byPage: new Map([['https://site.test/', LONG3]]) },
  });
  assert.equal(filled[0], item);
});

test('the repository description fills a row before the website description does', () => {
  const item = { sourceId: 'showhn', externalId: '1', title: 'T', url: 'https://site.test/', summary: '', content: '' };
  const repositories = new Map([['owner/repo', { description: LONG2 }]]);
  const descriptions = {
    byExternalId: new Map([['showhn' + String.fromCharCode(0) + '1', LONG3]]),
    byPage: new Map(),
  };
  const filled = attachDescriptionFallback([{ ...item, githubUrl: 'https://github.com/owner/repo' }],
    { repositories, descriptions });
  assert.equal(filled[0].summary, LONG2);
  assert.equal(filled[0].descriptionSource, 'repository');
});

test('the website description is the third tier, and only writes summary', () => {
  const item = { sourceId: 'showhn', externalId: '1', title: 'T', url: 'https://site.test/', summary: '', content: '' };
  const descriptions = {
    byExternalId: new Map([['showhn' + String.fromCharCode(0) + '1', LONG3]]),
    byPage: new Map(),
  };
  const filled = attachDescriptionFallback([item], { repositories: new Map(), descriptions });
  assert.equal(filled[0].summary, LONG3);
  assert.equal(filled[0].descriptionSource, 'website');
  // content keeps its "source archive" meaning; the fallback must not touch it.
  assert.equal(filled[0].content, '');
});

test('a row no tier can fill is returned untouched', () => {
  const item = { sourceId: 'showhn', externalId: '1', title: 'T', url: 'https://site.test/', summary: SHORT, content: '' };
  const filled = attachDescriptionFallback([item], {
    repositories: new Map([['owner/repo', { description: SHORT }]]),
    descriptions: { byExternalId: new Map(), byPage: new Map([['https://site.test/', SHORT]]) },
  });
  assert.equal(filled[0], item);
  assert.equal(filled[0].descriptionSource, undefined);
});

test('a matched page falls back to the row URL when the id drifted', () => {
  // externalId can move between runs; the page URL is the stable second key, like the icon lookup.
  const item = { sourceId: 'showhn', externalId: 'moved', title: 'T', url: 'https://site.test/', summary: '', content: '' };
  const descriptions = { byExternalId: new Map(), byPage: new Map([['showhn' + String.fromCharCode(0) + 'https://site.test/', LONG]]) };
  const filled = attachDescriptionFallback([item], { repositories: null, descriptions });
  assert.equal(filled[0].summary, LONG);
});

test('the site-logos day file is read offline and only offers usable descriptions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-desc-'));
  const dir = path.join(root, 'site-logos');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-09-13.json'), JSON.stringify({
    schemaVersion: 1,
    sourceId: 'site-logos',
    records: [
      { sourceId: 'showhn', externalId: '1', pageUrl: 'https://a.test/', status: 'ok', description: LONG },
      { sourceId: 'showhn', externalId: '2', pageUrl: 'https://b.test/', status: 'ok', description: SHORT },
      { sourceId: 'showhn', externalId: '3', pageUrl: 'https://c.test/', status: 'failed', description: '' },
    ],
  }));
  const index = loadSiteDescriptions('2026-09-13', root);
  assert.equal(index.byExternalId.get('showhn' + String.fromCharCode(0) + '1'), LONG);
  assert.equal(index.byExternalId.has('showhn' + String.fromCharCode(0) + '2'), false);   // below the floor
  assert.equal(index.byExternalId.has('showhn' + String.fromCharCode(0) + '3'), false);   // no description captured
  // A missing day file is not an error: those rows simply stop at the repository tier.
  assert.equal(loadSiteDescriptions('2026-09-14', root), null);
  fs.rmSync(root, { recursive: true, force: true });
});
