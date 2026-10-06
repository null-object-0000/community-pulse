const assert = require('node:assert/strict');
const test = require('node:test');

const D = require('../web/shared.js');
const { buildProjects, projectPage } = require('../scripts/projects.js');

// 真实 Product Hunt 2026-07-12 记录里的 Titan Codes 描述（产品详情页曝光最高的那条）。
const DESCRIPTION = 'Titan Codes is a software development company helping businesses build SEO-ready websites, SaaS platforms, mobile apps, custom software, AI automation systems, AI agents, and cloud-ready digital products. We focus on clean code, scalable architecture, performance, and full ownership so businesses can launch faster and grow with confidence.';
const TITAN = {
  sourceId: 'producthunt', sourceName: 'Product Hunt 新品', externalId: '1193625',
  title: 'Titan Codes', summary: DESCRIPTION,
  tags: ['producthunt', 'new', 'vertical-agent', 'web', 'mobile-app', 'web-app', 'business-growth'],
  taxonomy: { useCases: ['business-growth'], agentRoles: ['vertical-agent'], productForms: ['web-app', 'mobile-app'], platforms: ['web'] },
};
const product = {
  id: 'prd_531820e4b098be9a12e061ee', title: 'Titan Codes', githubRepo: '',
  route: '/products/prd_531820e4b098be9a12e061ee/', canonicalUrl: '',
  firstSeenDate: '2026-07-12', lastSeenDate: '2026-07-12', item: TITAN,
  sources: [{ sourceId: 'producthunt', sourceName: 'Product Hunt 新品', firstSeenDate: '2026-07-12', lastSeenDate: '2026-07-12', observationCount: 1 }],
};
const model = { catalogVersion: 'test', product };

// 可见正文：去掉 <script>（JSON-LD / page-data）与标签本身，只看读者实际读到的文字。
const strip = value => value.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;
const tagsHtml = html => html.match(/<div class="project-tags">([\s\S]*?)<\/div>/)?.[1] || '';
const chipLabels = html => [...tagsHtml(html).matchAll(/data-tag-label="([^"]+)"/g)]
  .map(match => match[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'));

test('product detail page renders the description exactly once in both locales', async () => {
  const { renderProductPage } = await import('../worker/project-page.mjs');
  for (const locale of ['zh-CN', 'en']) {
    const html = renderProductPage(model, locale);
    const body = strip(html.match(/<main[\s\S]*?<\/main>/)[0]);
    // 长描述：页首只放截断导语（不是全文），About 是全文唯一落点。
    assert.equal(occurrences(body, DESCRIPTION), 1, `${locale} 描述必须恰好出现一次`);
    const lead = html.match(/<p class="project-summary">([^<]*)<\/p>/)?.[1] || '';
    assert.ok(lead && lead.length < DESCRIPTION.length, `${locale} 页首应当是截断导语`);
    assert.ok(DESCRIPTION.startsWith(lead.replace(/…$/, '')), `${locale} 导语应当是描述前缀`);
    assert.match(html, new RegExp(`<h2>${locale === 'en' ? 'About' : '关于'}</h2><p>${DESCRIPTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</p>`));
  }
});

test('short and empty descriptions never duplicate and never empty the About panel', async () => {
  const { renderProductPage } = await import('../worker/project-page.mjs');
  const short = { ...model, product: { ...model.product, route: '/products/prd_short/', item: { sourceId: 'indie-dev', title: '短描述', summaryZh: '一个很短的描述。', tags: [] } } };
  const empty = { ...model, product: { ...model.product, route: '/products/prd_empty/', item: { sourceId: 'producthunt', title: '空描述', tags: [] } } };
  for (const locale of ['zh-CN', 'en']) {
    const shortHtml = renderProductPage(short, locale);
    const shortBody = strip(shortHtml.match(/<main[\s\S]*?<\/main>/)[0]);
    assert.equal(occurrences(shortBody, '一个很短的描述。'), 1);
    assert.ok(shortHtml.includes(`<h2>${locale === 'en' ? 'About' : '关于'}</h2>`), 'About 标题必须保留');
    assert.ok(!shortHtml.includes('class="project-summary"'), '短描述不再在页首重复');
    const fallback = locale === 'en' ? 'A product discovered by DevTrends.' : 'DevTrends 收录的开发者产品。';
    const emptyBody = strip(renderProductPage(empty, locale).match(/<main[\s\S]*?<\/main>/)[0]);
    assert.equal(occurrences(emptyBody, fallback), 1, `${locale} 回退文案只能出现一次`);
  }
});

test('product detail tag row drops collection scaffolding and keeps real topics', async () => {
  const { renderProductPage } = await import('../worker/project-page.mjs');
  const expected = {
    'zh-CN': ['商业与增长', '垂直 Agent', 'Web 应用', '移动应用', 'Web'],
    en: ['Business & growth', 'Vertical agent', 'Web app', 'Mobile app', 'Web'],
  };
  for (const locale of ['zh-CN', 'en']) {
    const html = renderProductPage(model, locale);
    assert.doesNotMatch(tagsHtml(html), /producthunt/);
    assert.doesNotMatch(tagsHtml(html), /data-tag-label="new"/);
    assert.deepEqual(chipLabels(html), expected[locale]);
    assert.match(tagsHtml(html), /data-tag-origin="devtrends"/);
  }
});

test('visibleTagEntries keeps the list contract at limit 3 while a detail limit exposes more facets', () => {
  assert.equal(D.visibleTagEntries(TITAN, 'en', 3).length, 3);
  const detail = D.visibleTagEntries(TITAN, 'en', 12).map(entry => entry.label);
  assert.deepEqual(detail, ['Business & growth', 'Vertical agent', 'Web app', 'Mobile app', 'Web']);
});

test('GitHub project page shares the same summary and tag contract', () => {
  const item = {
    title: 'acme/tool', summary: DESCRIPTION, githubUrl: 'https://github.com/acme/tool',
    tags: ['producthunt', 'new', 'typescript', 'vertical-agent'],
    github: { language: 'TypeScript', topics: ['producthunt', 'new', 'typescript', 'web-app', 'mobile-app', 'vertical-agent'], description: DESCRIPTION, license: 'MIT' },
    taxonomy: { useCases: ['business-growth'], agentRoles: ['vertical-agent'], productForms: ['web-app', 'mobile-app'], platforms: ['web'] },
  };
  const project = buildProjects([{ date: '2026-07-12', results: [{ sourceId: 'producthunt', sourceName: 'Product Hunt', items: [item] }] }])[0];
  for (const locale of ['zh-CN', 'en']) {
    const html = projectPage(project, locale);
    const hero = html.match(/<article class="project-hero">[\s\S]*?<\/article>/)[0];
    const about = html.match(/<section class="panel" id="about">[\s\S]*?<\/section>/)[0];
    assert.equal(occurrences(strip(hero + about), DESCRIPTION), 1, `${locale} GitHub 项目页描述必须一次`);
    // 收录记录按设计逐条列历史摘要，所以这里只比较 hero 与 About 的正文落点。
    assert.doesNotMatch(tagsHtml(html), /producthunt|data-tag-label="new"/);
    assert.ok(chipLabels(html).includes('TypeScript'), `${locale} 语言 chip 应保留`);
    assert.ok(chipLabels(html).includes(locale === 'en' ? 'Vertical agent' : '垂直 Agent'));
  }
});
