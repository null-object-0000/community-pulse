/**
 * 临时 Worker 通道（`scripts/catalog/mysql-channel.js`）的回归用例。
 *
 * 守的是**「重连只发生在请求根本没到 Worker 的时候」**：Cloudflare 用 HTML 404 答（路由漂移 /
 * Worker 被删）时事务必然没提交，重试安全；而 Worker 自己答的 JSON 错误（`ok:false`，例如
 * SQL 报错）**绝不能重试** —— 那可能是事务已部分生效后的失败，重试会掩盖真问题、甚至重复写入。
 *
 * 为什么这条值得钉住：2026-09-23 实测，430 条语句的补跑写到 100/430 时通道失联，而 `ensure()`
 * 缓存了 endpoint 不会重部署，于是同一份 SQL 重派又在第 1 批就断 —— 修法就是这里。
 *
 * 纯函数层，用注入的 fetch / spawnSync 假实现，不碰真 Cloudflare。
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { createChannelDb } = require('../scripts/catalog/mysql-channel.js');

/** 假的 wrangler：报出一个固定地址。 */
function fakeSpawn(endpoint = 'https://fake-worker.workers.dev') {
  return () => ({ status: 0, stdout: `Deployed to ${endpoint}`, stderr: '' });
}

/** 假的 fetch：按脚本依次返回响应。 */
function scriptedFetch(script) {
  let index = 0;
  return async () => {
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    return {
      status: step.status,
      async text() { return step.body; },
    };
  };
}

const html404 = { status: 404, body: '<!DOCTYPE html><html>cloudflare</html>' };
const okJson = { status: 200, body: JSON.stringify({ ok: true, rows: [] }) };
const sqlError = { status: 500, body: JSON.stringify({ ok: false, error: 'Unknown column' }) };

test('通道失联（Cloudflare 的 HTML）→ 重部署后重试成功', async () => {
  // 第 1 次（waitForRoute 探测）成功；第 2 次（真请求）失联；第 3 次（重试）成功。
  const db = createChannelDb({
    spawnSync: fakeSpawn(),
    fetch: scriptedFetch([okJson, html404, okJson]),
    sleep: async () => {},
    log: () => {},
  });
  await db.batch(['UPDATE t SET a=1']);
  await db.close();
});

test('Worker 自己的 JSON 错误 → 不重试（可能已部分生效，重试会掩盖真问题）', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    // 第 1 次是 waitForRoute 的探测，之后是 SQL 报错。
    return calls === 1
      ? { status: 200, async text() { return JSON.stringify({ ok: true, rows: [] }); } }
      : { status: 500, async text() { return JSON.stringify({ ok: false, error: 'Unknown column' }); } };
  };
  const db = createChannelDb({ spawnSync: fakeSpawn(), fetch: fetchImpl, sleep: async () => {}, log: () => {} });
  await assert.rejects(() => db.batch(['UPDATE t SET a=1']), /Unknown column/);
  await db.close();
});

test('失联重试用尽后仍然抛错（不静默吞掉）', async () => {
  const db = createChannelDb({
    spawnSync: fakeSpawn(),
    fetch: scriptedFetch([okJson, html404, html404, html404, html404, html404, html404]),
    sleep: async () => {},
    log: () => {},
  });
  await assert.rejects(() => db.batch(['UPDATE t SET a=1']), /不是 JSON/);
  await db.close();
});
