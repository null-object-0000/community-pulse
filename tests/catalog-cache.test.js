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
