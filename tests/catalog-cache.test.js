const assert = require('node:assert/strict');
const test = require('node:test');

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
