const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../web/shared.js');
const { submissionUrls, submitIndexNow, submitBaidu } = require('../scripts/search-submit.js');

test('search submissions include changed bilingual pages and only valid repository details', () => {
  const report = { results: [{ items: [
    { title: 'Repo', githubUrl: 'https://github.com/Owner/Repo' },
    { title: 'Duplicate', url: 'https://github.com/owner/repo/' },
    { title: 'Issue', url: 'https://github.com/owner/repo/issues/1' },
    { title: 'Product', url: 'https://example.com/product' },
  ] }] };
  const targets = submissionUrls(report, '2026-09-13');
  assert.deepEqual(targets.chinese, [
    `${D.origin}/`, `${D.origin}/reports/`, `${D.origin}/reports/2026-09-13/`, `${D.origin}/projects/owner/repo/`,
  ]);
  assert.equal(targets.indexNow.length, 8);
  assert.ok(targets.indexNow.includes(`${D.origin}/en/projects/owner/repo/`));
  assert.ok(!targets.indexNow.some(url => url.includes('/issues/')));
});

test('IndexNow sends the public root key and the complete URL batch', async () => {
  let request;
  const result = await submitIndexNow([`${D.origin}/`, `${D.origin}/en/`], async (url, options) => {
    request = { url, options };
    return { status: 202 };
  });
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://api.indexnow.org/indexnow');
  assert.equal(body.host, 'devtrends.site');
  assert.match(body.key, /^[a-f0-9]{32}$/);
  assert.equal(body.keyLocation, `${D.origin}/${body.key}.txt`);
  assert.deepEqual(body.urlList, [`${D.origin}/`, `${D.origin}/en/`]);
  assert.deepEqual(result, { status: 202, submitted: 2 });
});

test('Baidu is optional and receives Chinese canonical URLs only', async () => {
  const previous = process.env.BAIDU_SITE_TOKEN;
  delete process.env.BAIDU_SITE_TOKEN;
  assert.equal((await submitBaidu([`${D.origin}/`])).skipped, true);
  process.env.BAIDU_SITE_TOKEN = 'secret-token';
  let request;
  const result = await submitBaidu([`${D.origin}/`, `${D.origin}/reports/2026-09-13/`], async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, status: 200, text: async () => '{"remain":98,"success":2}' };
  });
  if (previous === undefined) delete process.env.BAIDU_SITE_TOKEN; else process.env.BAIDU_SITE_TOKEN = previous;
  assert.match(request.url, /^http:\/\/data\.zz\.baidu\.com\/urls\?/);
  assert.ok(!request.url.includes('https%3A'));
  assert.equal(request.options.body, `${D.origin}/\n${D.origin}/reports/2026-09-13/`);
  assert.deepEqual(result, { status: 200, submitted: 2, remaining: 98 });
});
