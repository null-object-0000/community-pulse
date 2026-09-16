const assert = require('node:assert/strict');
const test = require('node:test');

const { topbarHtml, footerHtml } = require('../web/shared.js');
const render = require('../scripts/render-site.js');

// The dynamic product pages used to hand-copy the topbar and footer, which is how they ended up
// without the appearance/accent/language pickers (and crashed app.js on the missing #theme-picker).
// Both renderers must keep emitting the same chrome, so compare them byte for byte.
function chromeOf(html) {
  const topbar = html.match(/<header class="topbar">[\s\S]*?<\/header>/);
  const footer = html.match(/<footer class="footer">[\s\S]*?<\/footer>/);
  assert.ok(topbar && footer, 'page must render the global chrome');
  return { topbar: topbar[0], footer: footer[0] };
}

test('static and dynamic pages render identical global chrome', async () => {
  const { renderProductPage } = await import('../worker/project-page.mjs');
  for (const locale of ['zh-CN', 'en']) {
    const model = { catalogVersion: 'v1', product: {
      id: 'prd_0123456789abcdef01234567', title: 'Owner/Repo', githubRepo: 'owner/repo', route: '/projects/owner/repo/',
      canonicalUrl: 'https://github.com/owner/repo', firstSeenDate: '2026-09-01', lastSeenDate: '2026-09-15',
      item: { summary: 'A useful project with enough text to index.' },
      sources: [{ sourceId: 'showhn', sourceName: 'Show HN', firstSeenDate: '2026-09-01', lastSeenDate: '2026-09-15', observationCount: 2 }],
    } };
    const dynamic = chromeOf(renderProductPage(model, locale));
    // No catalogue report needed: shell() only interpolates the template slots it is given.
    const staticPage = chromeOf(render.shell({ locale, view: 'project', route: '/projects/owner/repo/', title: 't', description: 'd', content: '' }));
    assert.equal(dynamic.topbar, staticPage.topbar, `${locale} topbar drift`);
    assert.equal(dynamic.footer, staticPage.footer, `${locale} footer drift`);
    // Guard the actual regression: the pickers must be present, not merely equal to each other.
    assert.match(dynamic.topbar, /id="theme-picker"/);
    assert.match(dynamic.topbar, /data-theme-choice="light"/);
    assert.match(dynamic.topbar, /data-accent-choice="violet"/);
    assert.match(dynamic.topbar, /id="language-picker"/);
    assert.match(dynamic.topbar, /class="brand-logo"/);
  }
  assert.equal(topbarHtml({ locale: 'zh-CN', active: 'discover', homePath: '/' }).includes('aria-current="page"'), true);
  assert.equal(footerHtml({ locale: 'en', homePath: '/en' }).includes('↗'), true);
});

test('catalog cache normalizes source order and keeps different combinations apart', async () => {
  const { apiCacheKey } = await import('../worker/index.js');
  const a = apiCacheKey(new Request('https://devtrends.site/api/v1/trends?facet=useCases&sources=showhn,producthunt,showhn'));
  const b = apiCacheKey(new Request('https://devtrends.site/api/v1/trends?sources=producthunt,showhn&facet=useCases'));
  const c = apiCacheKey(new Request('https://devtrends.site/api/v1/trends?sources=showhn&facet=useCases'));
  assert.equal(a.url, b.url);
  assert.notEqual(a.url, c.url);
  assert.match(a.url, /_devtrends_api_cache\/v9/);
});

test('product routes normalize locales and reject paths outside the catalog contract', async () => {
  const { canonicalProductRoute } = await import('../worker/index.js');
  assert.equal(canonicalProductRoute('/en/projects/Owner/Repo/'), '/projects/owner/repo/');
  assert.equal(canonicalProductRoute('/products/prd_0123456789abcdef01234567'), '/products/prd_0123456789abcdef01234567/');
  assert.equal(canonicalProductRoute('/projects/owner/repo/issues/1'), '');
});

test('dynamic product HTML contains canonical bilingual SEO and stable discussion identity', async () => {
  const { renderProductPage } = await import('../worker/project-page.mjs');
  const model = { catalogVersion: 'v1', product: {
    id: 'prd_0123456789abcdef01234567', title: 'Owner/Repo', githubRepo: 'owner/repo', route: '/projects/owner/repo/',
    canonicalUrl: 'https://github.com/owner/repo', firstSeenDate: '2026-09-01', lastSeenDate: '2026-09-15',
    item: { summary: 'A useful project.', githubUrl: 'https://github.com/owner/repo', taxonomy: { useCases: ['software-development'] } },
    sources: [{ sourceId: 'showhn', sourceName: 'Show HN', firstSeenDate: '2026-09-01', lastSeenDate: '2026-09-15', observationCount: 2 }],
  } };
  const html = renderProductPage(model, 'en');
  assert.match(html, /<link rel="canonical" href="https:\/\/devtrends\.site\/en\/projects\/owner\/repo\/"/);
  assert.match(html, /"@type":"SoftwareSourceCode"/);
  assert.match(html, /data-giscus-term="project:owner\/repo"/);
  assert.match(html, /"catalogVersion":"v1"/);
  assert.match(html, /googletagmanager\.com\/gtag\/js\?id=G-1E9PXZ2EVK/);
  assert.match(html, /clarity\.ms\/tag/);
  const thin = renderProductPage({ ...model, product: { ...model.product, item: { title: 'Owner/Repo' } } }, 'en');
  assert.match(thin, /<meta name="robots" content="noindex, follow"\/>/);
  const media = renderProductPage({ ...model, product: { ...model.product, item: {
    ...model.product.item, logo: 'https://ph-files.imgix.net/logo.png',
    images: ['https://ph-files.imgix.net/screenshot.png', 'javascript:alert(1)', 'https://unknown.example/image.png'],
  } } }, 'en');
  assert.match(media, /data-gallery=/);
  assert.match(media, /ph-files\.imgix\.net\/screenshot\.png/);
  assert.doesNotMatch(media, /unknown\.example\/image\.png|javascript:alert/);
});

test('product detail hero keeps the mark, owner and title inside one identity row', async () => {
  const { renderProductPage } = await import('../worker/project-page.mjs');
  const model = { catalogVersion: 'v1', product: {
    id: 'prd_0123456789abcdef01234567', title: '微信读书', githubRepo: '', route: '/products/prd_0123456789abcdef01234567/',
    canonicalUrl: '', firstSeenDate: '2026-09-14', lastSeenDate: '2026-09-14',
    item: { title: '微信读书', summaryZh: '一个用来验证详情页版式的产品摘要，长度足够进入索引。' },
    sources: [{ sourceId: 'indie-dev', sourceName: '中国独立开发者', firstSeenDate: '2026-09-14', lastSeenDate: '2026-09-14', observationCount: 1 }],
  } };
  const html = renderProductPage(model, 'zh-CN');
  // Without the .project-identity flex row, .project-heading spans the hero and its
  // space-between pushes the owner label and the title to opposite edges.
  assert.match(html, /<div class="project-identity"><span class="project-mark(?: has-logo)?"/);
  assert.match(html, /<div class="project-heading"><div><p class="project-owner">产品<\/p><h1>微信读书<\/h1><\/div><\/div>/);
  // No platform logo and no site icon: the mark falls back to initials instead of disappearing.
  assert.match(html, /aria-hidden="true">微信<\/span>/);
  // One sighting collapses the range to a single date, and the row keeps its labelled meta line.
  assert.match(html, /<li><b>中国独立开发者<\/b><p class="source-history-meta">2026年9月14日 · 1 次收录<\/p><\/li>/);
  const ranged = renderProductPage({ ...model, product: { ...model.product,
    sources: [{ sourceId: 'producthunt', sourceName: 'Product Hunt', firstSeenDate: '2026-09-01', lastSeenDate: '2026-09-14', observationCount: 2 }] } }, 'zh-CN');
  assert.match(ranged, /<p class="source-history-meta">2026年9月1日 – 2026年9月14日 · 2 次收录<\/p>/);
  // A catalog row without a title must still render a mark instead of throwing in the Worker.
  const untitled = renderProductPage({ ...model, product: { ...model.product, title: undefined, item: {} } }, 'zh-CN');
  assert.match(untitled, /<span class="project-mark" aria-hidden="true">·<\/span>/);
});

test('product detail buttons separate the repository, the website and the source', async () => {
  const { renderProductPage } = await import('../worker/project-page.mjs');
  // The live hippoxOS page linked 官网 to the repository (its catalogue canonical URL) and 来源 to
  // the product's own site, so two of the three buttons went to GitHub.
  const item = {
    sourceId: 'chinese-indie-dev', title: 'hippoxOS', url: 'https://hippoxos.vercel.app/',
    githubUrl: 'https://github.com/HippoxHQ/hippoxOS', github: { homepage: 'https://hippoxos.vercel.app' },
    summaryZh: '一款真正意义上的 LLM 操作系统，内置 6 个子系统，统一由自然语言控制。',
  };
  const model = { catalogVersion: 'v1', product: {
    id: 'prd_0123456789abcdef01234567', title: 'hippoxOS', githubRepo: 'hippoxhq/hippoxos', route: '/projects/hippoxhq/hippoxos/',
    canonicalUrl: 'https://github.com/hippoxhq/hippoxos', firstSeenDate: '2026-09-15', lastSeenDate: '2026-09-15',
    item,
    sources: [{ sourceId: 'chinese-indie-dev', sourceName: '中国独立开发者', firstSeenDate: '2026-09-15', lastSeenDate: '2026-09-15', observationCount: 1 }],
  } };
  const buttons = html => {
    const block = html.match(/<div class="project-links">([\s\S]*?)<\/div>/);
    assert.ok(block, 'the hero must render a link row');
    return [...block[1].matchAll(/href="([^"]+)"[^>]*>([^<]+) ↗<\/a>/g)].map(match => [match[2], match[1]]);
  };
  assert.deepEqual(buttons(renderProductPage(model, 'zh-CN')), [
    ['GitHub', 'https://github.com/HippoxHQ/hippoxOS'],
    ['官网', 'https://hippoxos.vercel.app/'],
    ['来源', 'https://github.com/1c7/chinese-independent-developer'],
  ]);
  assert.deepEqual(buttons(renderProductPage(model, 'en')).map(([label]) => label), ['GitHub', 'Website', 'Source']);
});

test('catalog cache skips the database on a hit and never stores errors', async () => {
  const { cachedCatalogApi } = await import('../worker/index.js');
  const entries = new Map();
  const before = globalThis.caches;
  globalThis.caches = { default: {
    async match(key) { return entries.get(key.url)?.clone(); },
    async put(key, response) { entries.set(key.url, response.clone()); },
  } };
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  let calls = 0;
  const handler = async () => {
    calls++;
    return new Response(JSON.stringify({ calls }), {
      status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, s-maxage=300' },
    });
  };
  try {
    const first = await cachedCatalogApi(new Request('https://devtrends.site/api/v1/trends?sources=showhn,producthunt'), {}, ctx, handler);
    assert.equal(first.headers.get('x-devtrends-cache'), 'MISS');
    await Promise.all(pending);
    const second = await cachedCatalogApi(new Request('https://devtrends.site/api/v1/trends?sources=producthunt,showhn'), {}, ctx, handler);
    assert.equal(second.headers.get('x-devtrends-cache'), 'HIT');
    assert.deepEqual(await second.json(), { calls: 1 });
    assert.equal(calls, 1);

    const error = await cachedCatalogApi(new Request('https://devtrends.site/api/v1/products?term=unknown'), {}, ctx,
      async () => new Response('{}', { status: 400 }));
    assert.equal(error.status, 400);
    await Promise.all(pending);
    assert.equal(entries.size, 1);
  } finally {
    if (before === undefined) delete globalThis.caches;
    else globalThis.caches = before;
  }
});
