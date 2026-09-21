#!/usr/bin/env node
/**
 * 产品库的传输选择：**直连优先，Hyperdrive 降级**。
 *
 * 为什么要分两条：直连（RDS 3306）不占 Cloudflare 的额度、也没有那层按 SQL 文本的查询缓存，
 * 是首选；临时 Worker 通道（Hyperdrive）是备选。
 *
 * **但这台机器上直连永远会降级**，原因在链路上不在配置里（2026-09-21 字节级实测）：
 * TCP 握手通、服务端会发出真正的 MySQL 握手包（`0a` + `8.4.7` + `caching_sha2_password`），
 * 而客户端一发握手响应就 `ECONNRESET`；SSL 变体是 `HANDSHAKE_SSL_ERROR`。也就是出口防火墙在
 * **协议层**拦 MySQL，与 `worker/catalog-read.mjs` 里 09-14 / 09-18 记的结论一致。
 * 所以这个「优先」是**给网络恢复时准备的**，不是当下能生效的优化 —— 当下真正要省的是查询条数。
 *
 * 凭据来源（按优先级）：
 *   ① `--mysql-url` / `CATALOG_MYSQL_URL`（显式给的 DSN）
 *   ② 仓库根 `.env` 里的 `ALIYUN_RDS_*`（写账号优先，没有写账号才退回读账号）
 * 两者都没有就只用通道。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** 直连配置：没有可用凭据时返回 null（调用方就只用通道）。 */
function directConnectionConfig(options = {}) {
  if (options.mysqlUrl) return { uri: options.mysqlUrl };
  const env = { ...loadDotEnv(options.envFile), ...process.env };
  const host = env.ALIYUN_RDS_HOST;
  if (!host) return null;
  const useWriter = Boolean(env.ALIYUN_RDS_WRITER_USER);
  const user = useWriter ? env.ALIYUN_RDS_WRITER_USER : env.ALIYUN_RDS_READER_USER;
  const password = useWriter ? env.ALIYUN_RDS_WRITER_PASSWORD : env.ALIYUN_RDS_READER_PASSWORD;
  if (!user) return null;
  const config = {
    host,
    port: Number(env.ALIYUN_RDS_PORT || 3306),
    user,
    password,
    database: env.ALIYUN_RDS_DATABASE,
    connectTimeout: 12000,
    dateStrings: true,
  };
  const caPath = env.ALIYUN_RDS_SSL_CA || '';
  if (env.ALIYUN_RDS_SSL && env.ALIYUN_RDS_SSL !== 'false') {
    config.ssl = fs.existsSync(caPath) ? { ca: fs.readFileSync(caPath) } : { rejectUnauthorized: false };
  }
  return config;
}

async function openDirect(config) {
  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection(config.uri || config);
  return {
    select: async (sql) => (await connection.query(sql))[0],
    execute: async (sql) => { await connection.query(sql); },
    batch: async (statements) => {
      if (!statements.length) return;
      await connection.beginTransaction();
      try {
        for (const statement of statements) await connection.query(statement);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
    },
    close: async () => { await connection.end(); },
  };
}

/**
 * 打开一个 `db`。返回 `{ db, transport }`，`transport` 是 `'direct'` 或 `'hyperdrive'`，
 * 调用方要把它写进运行记录 —— 「这次走的是哪条路」必须可观测，否则降级是静默的。
 */
async function openDb(options = {}) {
  const log = options.log || (() => {});
  const config = options.preferDirect === false ? null : directConnectionConfig(options);
  if (config) {
    try {
      const db = await openDirect(config);
      // 真的探一下：不要等第一个业务查询才失败，那时已经分不清是链路问题还是 SQL 问题。
      await db.select('SELECT 1');
      log(`[db] 直连可用（${config.uri ? 'DSN' : config.host}）`);
      return { db, transport: 'direct' };
    } catch (error) {
      const detail = `${error.code || ''} ${String(error.message).slice(0, 120)}`.trim();
      if (options.allowFallback === false) throw error;
      log(`[db] 直连不可用（${detail}）→ 降级到 Hyperdrive 临时 Worker 通道`);
    }
  }
  return { db: require('./mysql-channel.js').createChannelDb(options), transport: 'hyperdrive' };
}

module.exports = { loadDotEnv, directConnectionConfig, openDirect, openDb };
