const assert = require('node:assert/strict');
const test = require('node:test');

// 临时 DB Worker 的入口令牌校验。回归的是「未配置令牌 = 拒绝」这条线：
// 老写法 `header !== \`Bearer ${env.TOKEN}\`` 在令牌缺失时期望值会退化成
// 字面量 `Bearer undefined`，等于任何人带上这个头就能通过 —— 而这两个 Worker
// 分别挂着主库的写连接与读连接，配置又是提交进仓库的。
const request = (authorization) => ({ headers: { get: (name) => (name.toLowerCase() === 'authorization' ? authorization : null) } });
const TOKEN = 'a'.repeat(64);

test('bearer guard accepts only the exact configured token', async () => {
  const { authorized } = await import('../worker/bearer-auth.mjs');
  assert.equal(authorized(request(`Bearer ${TOKEN}`), TOKEN), true);
  assert.equal(authorized(request(`Bearer ${TOKEN}`), 'b'.repeat(64)), false);
  assert.equal(authorized(request(`Bearer ${TOKEN}x`), TOKEN), false);
  assert.equal(authorized(request(`bearer ${TOKEN}`), TOKEN), false);
  assert.equal(authorized(request(TOKEN), TOKEN), false);
  assert.equal(authorized(request(null), TOKEN), false);
});

test('bearer guard fails closed when the token is unset, empty, or too short', async () => {
  const { authorized } = await import('../worker/bearer-auth.mjs');
  for (const missing of [undefined, null, '', 'short']) {
    // 这条断言就是「Bearer undefined」漏洞的回归用例：令牌不可用时任何请求都必须被拒。
    assert.equal(authorized(request('Bearer undefined'), missing), false, String(missing));
    assert.equal(authorized(request(`Bearer ${TOKEN}`), missing), false, String(missing));
  }
});

test('catalog workers reject unauthenticated requests before touching the database', async () => {
  const importWorker = (await import('../worker/catalog-import.mjs')).default;
  const readWorker = (await import('../worker/catalog-read.mjs')).default;
  // env 里刻意没有 HYPERDRIVE_* 绑定：只要认证先跑，401 就会在连接之前返回，
  // 一旦认证被绕过，这里会抛绑定错误而不是返回 401，测试随之失败。
  const call = (worker, path, env, authorization) => worker.fetch(
    new Request(`https://example.test${path}`, { method: 'POST', body: 'SELECT 1', headers: authorization ? { authorization } : {} }),
    env,
  );
  const cases = [
    [importWorker, '/import', {}, null],
    [importWorker, '/import', { IMPORT_TOKEN: '' }, null],
    [importWorker, '/import', { IMPORT_TOKEN: TOKEN }, 'Bearer undefined'],
    [importWorker, '/import', { IMPORT_TOKEN: TOKEN }, `Bearer ${'b'.repeat(64)}`],
    [readWorker, '/query', {}, null],
    [readWorker, '/query', { READ_TOKEN: 'short' }, null],
    [readWorker, '/query', { READ_TOKEN: TOKEN }, 'Bearer undefined'],
    [readWorker, '/query', { READ_TOKEN: TOKEN }, `Bearer ${'b'.repeat(64)}`],
  ];
  for (const [worker, path, env, authorization] of cases) {
    assert.equal((await call(worker, path, env, authorization)).status, 401, `${path} ${JSON.stringify(env)} ${authorization}`);
  }
});
