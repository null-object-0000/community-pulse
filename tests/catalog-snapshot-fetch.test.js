/**
 * 站点快照拉取（`build-site-snapshot.js` 的 `fetchJson`）的回归用例。
 *
 * 守的是**「暂时错误要重试，永久错误不重试」这条判据必须按状态码判，不能按 content-type 判**。
 *
 * 2026-09-24 实测踩到：Cloudflare 源站错误页是 `502, text/html`，而当时的判据里有一句
 * `/html/i.test(contentType)` → 直接把 502 标成 `permanent` → **不重试、整批快照丢弃**
 * → 那一步失败 → 「提交并推送」被 skipped → 当期日报整期没进仓库，07:30 无东西可发。
 *
 * HTML 这个信号本身不足以判永久：验证页（403）是 HTML，源站错误页（502/503/504）**也是 HTML**，
 * 而后者重试就好了。所以判据只能是状态码。
 *
 * 纯函数层，用注入的假 fetch / sleep，不碰真网络。
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchJson } = require('../scripts/catalog/build-site-snapshot.js');

function jsonResponse(body) {
  return {
    ok: true, status: 200,
    headers: new Map([['content-type', 'application/json']]),
    json: async () => body,
  };
}

/** 假响应：`headers.get` 用一个最小 Map 实现。 */
function response(status, contentType) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => (key === 'content-type' ? contentType : key === 'cf-ray' ? 'test-ray' : null) },
    json: async () => ({}),
  };
}

const noSleep = async () => {};

test('5xx 是暂时错误：必须重试，不能因为响应体是 HTML 就判永久', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    // 前两次是 Cloudflare 的 502 HTML 错误页，第三次成功。
    if (calls < 3) return response(502, 'text/html; charset=UTF-8');
    return jsonResponse({ products: [] });
  };
  const result = await fetchJson('https://example.test', '/api/v1/products', fetcher, noSleep);
  assert.deepEqual(result, { products: [] });
  assert.equal(calls, 3, `502 该被重试（实际只请求了 ${calls} 次）`);
});

test('502/503/504 都按暂时处理', async () => {
  for (const status of [502, 503, 504]) {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      if (calls < 2) return response(status, 'text/html');
      return jsonResponse({ ok: status });
    };
    await fetchJson('https://example.test', '/x', fetcher, noSleep);
    assert.equal(calls, 2, `${status} 该被重试`);
  }
});

test('403 是永久：验证页重试也解不开，立刻放弃', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return response(403, 'text/html'); };
  await assert.rejects(
    () => fetchJson('https://example.test', '/x', fetcher, noSleep),
    /403/,
  );
  assert.equal(calls, 1, '403 不该重试');
});

test('4xx（429 除外）是永久：请求本身有问题，重试无意义', async () => {
  for (const status of [400, 404, 422]) {
    let calls = 0;
    const fetcher = async () => { calls += 1; return response(status, 'application/json'); };
    await assert.rejects(() => fetchJson('https://example.test', '/x', fetcher, noSleep), /expected catalog JSON/);
    assert.equal(calls, 1, `${status} 不该重试`);
  }
});

test('429 是暂时（限流），要重试', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    if (calls < 2) return response(429, 'application/json');
    return jsonResponse({ ok: true });
  };
  await fetchJson('https://example.test', '/x', fetcher, noSleep);
  assert.equal(calls, 2, '429 该被重试');
});

test('重试到上限仍失败就抛出（不会静默返回空）', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return response(500, 'text/html'); };
  await assert.rejects(() => fetchJson('https://example.test', '/x', fetcher, noSleep), /500/);
  assert.equal(calls, 8, '应当重试到上限 8 次');
});

test('网络异常（fetch 直接抛）也会重试', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    if (calls < 3) throw new Error('socket hang up');
    return jsonResponse({ ok: true });
  };
  const result = await fetchJson('https://example.test', '/x', fetcher, noSleep);
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
});