const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');
const { submissionUrls, submitIndexNow, submitBaidu, detailRoute } = require('../scripts/search-submit.js');

test('Baidu gets only the day\'s new URLs while IndexNow also covers refreshed hubs', () => {
  const report = { results: [{ sourceId: 'showhn', items: [
    { title: 'Repo', url: 'https://github.com/Owner/Repo', summary: 'A'.repeat(30) },
    { title: 'Thin product', url: 'https://example.com/thin', summary: 'short' },
    { title: 'Product', url: 'https://example.com/product', summary: 'B'.repeat(30) },
    { title: 'Issue', url: 'https://github.com/owner/repo/issues/1', summary: 'C'.repeat(30) },
  ] }] };
  const targets = submissionUrls(report, '2026-09-13', new Map());
  assert.deepEqual(targets.baidu.slice(0, 1), [`${D.origin}/reports/2026-09-13/`]);
  assert.equal(targets.baidu.length, 4, 'the report page plus three indexable detail pages');
  // 官方的重复提交会浪费配额、可能下调额度，所以首页/趋势页/归档页不进百度那份。
  assert.ok(!targets.baidu.includes(`${D.origin}/`));
  assert.ok(!targets.baidu.includes(`${D.origin}/trends/`));
  assert.ok(!targets.baidu.includes(`${D.origin}/reports/`));
  assert.ok(targets.indexNow.includes(`${D.origin}/`), 'IndexNow accepts updated pages and has no quota');
  assert.ok(targets.indexNow.includes(`${D.origin}/trends/`));
  assert.ok(targets.indexNow.includes(`${D.origin}/en/reports/`));
  assert.ok(targets.baidu.includes(`${D.origin}/projects/owner/repo/`));
  assert.ok(!targets.baidu.some(url => url.includes('/issues/')), 'issue pages are not repositories');
  assert.ok(!targets.baidu.some(url => url.includes('/thin')), 'a noindex detail page must not consume the quota');
});

test('the site snapshot overrides the summary length when it knows the route', () => {
  const item = { title: 'Known thin', url: 'https://example.com/known', summary: 'D'.repeat(200) };
  const report = { results: [{ sourceId: 'showhn', items: [item] }] };
  const route = detailRoute(item, 'showhn');
  assert.match(route, /^\/products\/prd_[a-f0-9]{24}\/$/);
  const known = submissionUrls(report, '2026-09-13', new Map([[route, false]]));
  assert.equal(known.baidu.length, 1, 'an explicitly noindex route stays out even with a long summary');
  const unknown = submissionUrls(report, '2026-09-13', new Map());
  assert.equal(unknown.baidu.length, 2, 'unknown routes fall back to the report summary length');
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
  const batches = [];
  const result = await submitBaidu([`${D.origin}/`, `${D.origin}/reports/2026-09-13/`], async (url, options) => {
    batches.push({ url: String(url), body: options.body });
    return { ok: true, status: 200, text: async () => '{"remain":1,"success":1}' };
  });
  if (previous === undefined) delete process.env.BAIDU_SITE_TOKEN; else process.env.BAIDU_SITE_TOKEN = previous;
  assert.match(batches[0].url, /^http:\/\/data\.zz\.baidu\.com\/urls\?/);
  assert.ok(!batches[0].url.includes('https%3A'));
  assert.deepEqual(batches.map(batch => batch.body), [`${D.origin}/`, `${D.origin}/reports/2026-09-13/`]);
  assert.deepEqual(result, { status: 200, submitted: 2, remaining: 1 });
});

// 百度超额时整批作废，所以必须按条推、配额用完即停，并把未推的记成 deferred 而不是报错。
test('Baidu stops at the daily quota instead of failing the whole submission', async () => {
  const previous = process.env.BAIDU_SITE_TOKEN;
  process.env.BAIDU_SITE_TOKEN = 'secret-token';
  const urls = [`${D.origin}/`, `${D.origin}/reports/`, `${D.origin}/reports/2026-09-13/`];
  // (1) 上一条响应直接告知配额见底：停在那里，剩下的记成 deferred。
  let calls = 0;
  const drained = await submitBaidu(urls, async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => '{"remain":0,"success":1}' };
  });
  assert.deepEqual(drained, { status: 200, submitted: 1, remaining: 0, quotaExhausted: true, deferred: 2 });
  assert.equal(calls, 1, 'the loop stops as soon as the quota is drained');
  // (2) 百度直接回 over quota（实测行为：整批作废，一条不收）也不算失败。
  let rejected = 0;
  const overshoot = await submitBaidu(urls, async () => {
    rejected += 1;
    return { ok: false, status: 400, text: async () => '{"error":400,"message":"over quota"}' };
  });
  assert.deepEqual(overshoot, { status: 400, submitted: 0, remaining: 0, quotaExhausted: true, deferred: 3 });
  assert.equal(rejected, 1);
  // (3) A real configuration error must still fail loudly.
  await assert.rejects(submitBaidu([`${D.origin}/`], async () => ({
    ok: false, status: 400, text: async () => '{"error":400,"message":"site error"}',
  })), /HTTP 400: site error/);
  if (previous === undefined) delete process.env.BAIDU_SITE_TOKEN; else process.env.BAIDU_SITE_TOKEN = previous;
});

test('the deploy check polls the Worker entry point before the public zone', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'search-index.yml'), 'utf8');
  assert.match(workflow, /- name: 等待 Cloudflare 部署包含该日报/);
  assert.match(workflow, /CHECK_ORIGINS: https:\/\/community-pulse\.nichangen\.workers\.dev https:\/\/devtrends\.site/);
  assert.match(workflow, /\$origin\/data\/index\.json\?deploy-check=/);
});
