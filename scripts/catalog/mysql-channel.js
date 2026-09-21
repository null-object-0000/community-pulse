#!/usr/bin/env node
/**
 * 生产产品库的**临时 Worker 通道**：本机连不上 RDS 的 3306（公司出口在协议层重置，2026-09-21
 * 复测：TCP 通、MySQL `ECONNRESET`、TLS `HANDSHAKE_SSL_ERROR`），所以读写都经 Cloudflare
 * Hyperdrive —— 与 `scripts/catalog/live-query.js`（只读）和 `scripts/catalog/upload-mysql.js`
 * （写入）同一个模式，区别是这里把两个临时 Worker 的生命周期收进一个对象，供一次加工运行复用。
 *
 * 两个入口各自**在构造上**受限：`worker/catalog-read.mjs` 只放行单条 SELECT，
 * `worker/catalog-import.mjs` 只接受写入 SQL。所以 `select` 与 `execute`/`batch` 必须打不同端点，
 * 令牌每次随机生成、Worker 用完立刻删除。
 *
 * 与 `upload-mysql.js` 的关系：那份是「一次性把整包 SQL 传上去」的批处理脚本，各自持有一份
 * deploy/destroy 逻辑；这里没有去改它（日更链在跑，不值得为复用动它），代价是 20 行重复。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CHANNELS = {
  read: { config: 'wrangler.mysql-read.toml', tokenVar: 'READ_TOKEN', endpoint: '/query', label: '只读' },
  write: { config: 'wrangler.mysql-import.toml', tokenVar: 'IMPORT_TOKEN', endpoint: '/import', label: '写入' },
};

function deployChannel(kind, options = {}) {
  const channel = CHANNELS[kind];
  const token = options.token || crypto.randomBytes(32).toString('hex');
  const run = options.spawnSync || spawnSync;
  const result = run('npx', ['wrangler', 'deploy', '--config', channel.config, '--var', `${channel.tokenVar}:${token}`], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`${channel.label} Worker 部署失败：\n${result.stdout || ''}\n${result.stderr || ''}`);
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  // 去掉结尾的 `/`：wrangler 的输出格式会随版本变（有时带尾斜杠），而 `endpoint + '/import'`
  // 一旦变成 `//import`，Worker 的 pathname 判等就不成立，返回的是它自己的 404 —— 症状是
  // 「部署成功、请求 404」，很难从日志看出来。地址必须回显，否则只能靠猜。
  const endpoint = output.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0]?.replace(/\/+$/, '');
  if (!endpoint) {
    throw new Error(`${channel.label} Worker 没有报出地址，wrangler 输出：\n${output}`);
  }
  if (options.log) options.log(`[channel] ${channel.label} Worker: ${endpoint}`);
  return { endpoint, token };
}

function destroyChannel(kind, options = {}) {
  const run = options.spawnSync || spawnSync;
  run('npx', ['wrangler', 'delete', '--config', CHANNELS[kind].config, '--force'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * 一个 `db` 接口，形状与 `enrich-products.js` 的 `openDatabase()` 一致：
 * `select` / `execute` / `batch` / `close`。
 *
 * 懒部署：只有真的用到读或写才部署那一个 Worker —— 干跑（只读队列、不写结果）因此不需要写入入口。
 */
function createChannelDb(options = {}) {
  const fetchImpl = options.fetch || fetch;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deployed = { read: null, write: null };
  const log = options.log || (() => {});

  async function post(kind, body, { expectRows }) {
    const { endpoint, token } = await ensure(kind);
    const url = `${endpoint}${CHANNELS[kind].endpoint}`;
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
      throw new Error(`${CHANNELS[kind].label}通道返回的不是 JSON（HTTP ${response.status}，${url}）：${text.slice(0, 200)}`);
    }
    if (!payload || payload.ok !== true) {
      throw new Error(`${CHANNELS[kind].label}通道失败（${url}）：${payload && payload.error ? payload.error : `HTTP ${response.status}`}`);
    }
    return expectRows ? payload.rows : payload;
  }

  /**
   * 刚 deploy 出来的 workers.dev 路由不是立刻生效的：2026-09-21 实测，deploy 完 1.5 秒就发请求
   * 会拿到 404（不是我们 Worker 的响应），隔 ~7 秒就没问题。所以部署后先探测一次 —— 探测语句
   * 用 `SELECT 1`，它对只读入口合法、对写入入口也是无害的（写入 Worker 会把它放进事务提交），
   * 顺便把「令牌不对」这种配置错误在第一次真请求之前就暴露出来。
   */
  async function waitForRoute(kind, attempts = 6, delayMs = 1500) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await post(kind, 'SELECT 1', { expectRows: false });
        return;
      } catch (error) {
        if (attempt === attempts) throw error;
        log(`[channel] ${CHANNELS[kind].label} Worker 还没就绪（第 ${attempt} 次）：${String(error.message).slice(0, 120)}`);
        await sleep(delayMs * attempt);
      }
    }
  }

  async function ensure(kind) {
    if (!deployed[kind]) {
      deployed[kind] = deployChannel(kind, { ...options, log });
      await waitForRoute(kind);
    }
    return deployed[kind];
  }

  return {
    async select(sql) {
      return post('read', sql, { expectRows: true });
    },
    async execute(sql) {
      await post('write', sql, { expectRows: false });
    },
    async batch(statements) {
      if (!statements.length) return;
      // 一个产品的结果是一批语句，写入 Worker 会把它们放进**同一个事务**，所以「状态」与
      // 「内容」要么一起进要么都不进 —— 与直连时 `openDatabase().batch()` 的语义一致。
      await post('write', statements.map(statement => `${statement};`).join('\n'), { expectRows: false });
    },
    async close() {
      for (const kind of ['write', 'read']) {
        if (!deployed[kind]) continue;
        try { destroyChannel(kind, options); } catch (error) { /* 删除失败不该盖住真正的错误 */ }
        deployed[kind] = null;
      }
    },
    get deployedKinds() { return Object.keys(deployed).filter(kind => deployed[kind]); },
  };
}

module.exports = { CHANNELS, deployChannel, destroyChannel, createChannelDb };
