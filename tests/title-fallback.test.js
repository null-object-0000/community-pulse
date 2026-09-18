const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const D = require('../web/shared');
const { prepare } = require('../scripts/enhance-report');
test('real CanvasCode label uses explicit fields without changing title or descriptions', () => {
  const raw = JSON.parse(fs.readFileSync('知识/大家都在做什么/raw/2026-09-15.json'));
  const item = raw.results.flatMap(s => s.items).find(i => i.externalId === '3710');
  const copy = D.withTitleFallback(item);
  assert.equal(D.displayTitle(copy), 'CanvasCode');
  assert.equal(copy.title, '[开源推荐]');
  assert.deepEqual(D.summary(copy), D.summary(item));
  assert.equal(copy.content, item.content);
  assert.equal(copy.titleFallbackSource, 'issue-body:项目名称');
});
test('dynamic detail uses projected fallback even if old MySQL product title wins the length upsert', async () => {
  const { renderProductPage } = await import('../worker/project-page.mjs');
  const item = D.withTitleFallback({ title: '[开源推荐]', content: '项目名称：CanvasCode', summary: 'Original description remains unchanged.' });
  const model = { catalogVersion: 'v1', product: { id: 'prd_0123456789abcdef01234567', title: '[开源推荐]', githubRepo: '', route: '/products/prd_0123456789abcdef01234567/', canonicalUrl: '', firstSeenDate: '2026-09-15', lastSeenDate: '2026-09-15', item, sources: [] } };
  const html = renderProductPage(model);
  assert.ok(html.includes('<title>CanvasCode | DevTrends</title>'));
  assert.ok(html.includes('<h1>CanvasCode</h1>'));
  assert.equal(model.product.title, '[开源推荐]');
});
test('the detail page drops a submission label that lost its opening bracket', async () => {
  const { renderProductPage } = await import('../worker/project-page.mjs');
  const title = '开源自荐】PiX: 把 AI Agent 会话变成一张图的桌面工作台';
  const item = { title, summary: '基于开源 Agent 框架 Pi 的图形化工作台。', summaryZh: '基于开源 Agent 框架 Pi 的图形化工作台。' };
  const model = { catalogVersion: 'v1', product: { id: 'prd_0123456789abcdef01234567', title, githubRepo: 'huang-sh/PiX', route: '/products/prd_0123456789abcdef01234567/', canonicalUrl: '', firstSeenDate: '2026-09-17', lastSeenDate: '2026-09-17', item, sources: [] } };
  const html = renderProductPage(model);
  // 目录里的原始投稿标题要剥掉标签，但产品名本身（含 `:` 后面的说明）保持原样。
  assert.ok(html.includes('<title>PiX: 把 AI Agent 会话变成一张图的桌面工作台 | DevTrends</title>'));
  assert.ok(!html.includes('开源自荐】'));
  assert.equal(model.product.title, title);
});
test('only explicit fields: no prose guessing; conflicts fall back to repository; normal titles untouched', () => {
  assert.equal(D.displayTitle({ title: '[开源推荐]', content: 'This amazing product is Foo' }), '[开源推荐]');
  assert.equal(D.displayTitle({ title: '[开源推荐]', content: '项目名称：A\n项目名称：B', url: 'https://github.com/a/b' }), 'a/b');
  assert.equal(D.displayTitle({ title: '【Tokenscope】', content: '项目名称：Other' }), '【Tokenscope】');
  assert.equal(D.displayTitle({ title: '【工具自荐】', content: '工具名称：mouse code generator' }), 'mouse code generator');
  assert.equal(D.displayTitle({ title: '[开源推荐]', content: '```md\n项目名称：Fake\n```\n### 项目标题\nReal' }), 'Real');
});
test("a release note never becomes a product name", () => {
  // #3440 的「项目标题」是版本更新说明，不是产品名 —— 应退到 owner/repo。
  const item = { title: '[开源自荐]', url: 'https://github.com/FB208/OpenBidKit_Yibiao', content: '### 项目标题\nv2.18.3发布：已有方案扩写、导出格式设置、多标段支持' };
  assert.equal(D.displayTitle(item), 'FB208/OpenBidKit_Yibiao');
  assert.equal(D.titleFallback(item).source, 'github-repository');
  // 无仓库且无可用字段时，仍退回原标题（既有兜底，不产生空标题）。
  assert.equal(D.displayTitle({ title: '[开源推荐]', content: '项目标题：v1.2.3 发布：修复若干问题' }), '[开源推荐]');
});
test('enhancement input preserves original match headings and removes only the ad', () => {
  const job = prepare('2026-09-15');
  assert.equal(job.report.results.flatMap(s => s.items).length, 90);
  assert.ok(job.markdown.includes('[开源推荐]'));
  assert.ok(job.markdown.includes('Recruit OS'));
  assert.ok(!job.markdown.includes('11707'));
});
