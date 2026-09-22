#!/usr/bin/env node
/**
 * 生产产品库的**临时 Worker 通道**：本机连不上 RDS 的 3306（本机网络出口在协议层重置，2026-09-21
 * 复测：TCP 通、MySQL `ECONNRESET`、TLS `HANDSHAKE_SSL_ERROR`），所以读写都经 Cloudflare
 * Hyperdrive —— 与 `scripts/catalog/live-query.js`（只读核对）和 `scripts/catalog/upload-mysql.js`
 * （批量导入）同一个模式。
 *
 * **只用写入 Worker 一个入口，读也走它。** 原因不是省事，是 Hyperdrive 的缓存语义：
 * `HYPERDRIVE_READ` 那条路**按 SQL 文本缓存查询结果**（2026-09-21 实测约十分钟）。加工流水线
 * 「读本 run 的既有状态」的 SQL 每轮文本完全相同，于是第一轮在空表时读出的空结果被缓存，之后
 * 每一轮续跑都读到「没有状态」→ 把整天的产品重新发一遍请求（实测白付 627 次）。主库连接不带
 * 这层缓存，所以**状态读必须走主库**；队列读（`item_json` 会变、直接影响输入哈希）同理。
 * `live-query.js` 那条只读通道保留给人工核对 —— 那里陈旧只影响观察，不影响写。
 *
 * 令牌每次随机生成、Worker 用完立刻删除。
 */
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CHANNEL = { config: 'wrangler.mysql-import.toml', tokenVar: 'IMPORT_TOKEN', endpoint: '/import', label: '主库' };

function deployChannel(options = {}) {
  const token = options.token || crypto.randomBytes(32).toString('hex');
  const run = options.spawnSync || spawnSync;
  const result = run('npx', ['wrangler', 'deploy', '--config', CHANNEL.config, '--var', `${CHANNEL.tokenVar}:${token}`], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`${CHANNEL.label} Worker 部署失败：\n${result.stdout || ''}\n${result.stderr || ''}`);
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  // 去掉结尾的 `/`：wrangler 的输出格式会随版本变（有时带尾斜杠），而 `endpoint + '/import'`
  // 一旦变成 `//import`，Worker 的 pathname 判等就不成立，返回的是它自己的 404 —— 症状是
  // 「部署成功、请求 404」，很难从日志看出来。地址必须回显，否则只能靠猜。
  const endpoint = output.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0]?.replace(/\/+$/, '');
  if (!endpoint) {
    throw new Error(`${CHANNEL.label} Worker 没有报出地址，wrangler 输出：\n${output}`);
  }
  if (options.log) options.log(`[channel] ${CHANNEL.label} Worker: ${endpoint}`);
  return { endpoint, token };
}

function destroyChannel(options = {}) {
  const run = options.spawnSync || spawnSync;
  run('npx', ['wrangler', 'delete', '--config', CHANNEL.config, '--force'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * 一个 `db` 接口，形状与 `enrich-products.js` 的 `openDatabase()` 一致：
 * `select` / `execute` / `batch` / `close`。懒部署：只有真的用到才部署 Worker。
 */
function createChannelDb(options = {}) {
  const fetchImpl = options.fetch || fetch;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const log = options.log || (() => {});
  let deployed = null;

  async function post(body, { expectRows }) {
    const { endpoint, token } = await ensure();
    const url = `${endpoint}${CHANNEL.endpoint}`;
    const response = await fetchImpl(url, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body,
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      // 把响应体带出来：404 到底是我们自己的 Worker 答的（`Not found`，说明路径/方法不对），
      // 还是 Cloudflare 答的（HTML，说明路由还没生效 / 地址不对）—— 只看状态码分不出来。
      throw new Error(`${CHANNEL.label}通道返回的不是 JSON（HTTP ${response.status}，${url}）：${text.slice(0, 200)}`);
    }
    if (!payload || payload.ok !== true) {
      throw new Error(`${CHANNEL.label}通道失败（${url}）：${payload && payload.error ? payload.error : `HTTP ${response.status}`}`);
    }
    return expectRows ? (payload.rows || []) : payload;
  }

  /**
   * 刚 deploy 出来的 workers.dev 路由不是立刻生效的：2026-09-21 实测，deploy 完 1.5 秒就发请求
   * 会拿到 Cloudflare 的 HTML 404（不是我们 Worker 的响应）；有时几秒就好，有时要等 20 秒以上
   * （同一个 Worker 反复 deploy/delete 之后更慢）。所以部署后先探测 —— 用 `SELECT 1`，顺便把
   * 「令牌不对」这种配置错误在第一次真请求之前暴露出来。预算给到约 60 秒，退避上限 8 秒。
   */
  async function waitForRoute(attempts = 10, delayMs = 2000, maxDelayMs = 8000) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await post('SELECT 1', { expectRows: false });
        return;
      } catch (error) {
        if (attempt === attempts) throw error;
        log(`[channel] ${CHANNEL.label} Worker 还没就绪（第 ${attempt} 次）：${String(error.message).slice(0, 120)}`);
        await sleep(Math.min(delayMs * attempt, maxDelayMs));
      }
    }
  }

  async function ensure() {
    if (!deployed) {
      deployed = deployChannel({ ...options, log });
      await waitForRoute();
    }
    return deployed;
  }

  return {
    async select(sql) {
      // 走主库连接：Hyperdrive 的读连接按 SQL 文本缓存，状态读不能吃那层缓存。
      return post(sql, { expectRows: true });
    },
    async execute(sql) {
      await post(sql, { expectRows: false });
    },
    async batch(statements) {
      if (!statements.length) return;
      // 一个产品的结果是一批语句，Worker 会把它们放进**同一个事务**，所以「状态」与
      // 「内容」要么一起进要么都不进 —— 与直连时 `openDatabase().batch()` 的语义一致。
      await post(statements.map(statement => `${statement};`).join('\n'), { expectRows: false });
    },
    async close() {
      if (!deployed) return;
      try { destroyChannel(options); } catch (error) { /* 删除失败不该盖住真正的错误 */ }
      deployed = null;
    },
    get deployedKinds() { return deployed ? [CHANNEL.config] : []; },
  };
}

module.exports = { CHANNEL, deployChannel, destroyChannel, createChannelDb };
