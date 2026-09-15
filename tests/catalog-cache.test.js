const assert = require('node:assert/strict');
const test = require('node:test');

test('catalog cache normalizes source order and keeps different combinations apart', async () => {
  const { apiCacheKey } = await import('../worker/index.js');
  const a = apiCacheKey(new Request('https://devtrends.site/api/v1/trends?facet=useCases&sources=showhn,producthunt,showhn'));
  const b = apiCacheKey(new Request('https://devtrends.site/api/v1/trends?sources=producthunt,showhn&facet=useCases'));
  const c = apiCacheKey(new Request('https://devtrends.site/api/v1/trends?sources=showhn&facet=useCases'));
  assert.equal(a.url, b.url);
  assert.notEqual(a.url, c.url);
  assert.match(a.url, /_devtrends_api_cache\/v1/);
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
