#!/usr/bin/env node
/**
 * 把 `migrations/mysql/*.sql` 按文件名顺序应用到产品库，并用 `schema_migrations` 记账。
 *
 * 为什么需要它：仓库里的迁移一直是「一次性 Worker 手工执行」落地的（`schema_migrations` 表存在
 * 但全仓没有任何写入方），所以**没有可重复的迁移入口** —— 每加一个迁移就得现造一次临时 Worker。
 * 0005 要上生产时踩到第二层问题：生产写入走 Cloudflare Hyperdrive，而它**不支持 MySQL 的 SQL 级
 * prepared statement**，于是「用 information_schema + PREPARE 守卫让 ALTER 幂等」这条路在本地
 * 直连能跑、在 Hyperdrive 上直接 500。幂等只能搬到应用器里，这个脚本就是那个应用器。
 *
 * 幂等的三层：
 *   ① 记账：`schema_migrations.version` 已存在的版本直接跳过（这是主路径）；
 *   ② 逐条执行：一个迁移里的语句一条一条发，不会因为中间一条失败而整批回滚；
 *   ③ 引导容错：「已存在」类错误（1060 重复列 / 1061 重复索引 / 1062 重复键）视为已应用 ——
 *      生产库是**先有 schema 再有记账表**的，第一次跑必然要把 0001..0004 也判成已应用。
 *      其它任何错误立刻中止并退出码 1，不会把半截 schema 记成成功。
 *
 * 传输有两条（与 `enrich-products.js` 一致）：`--mysql-url` 直连（本地验收用；公司出口会重置
 * 协议，所以生产只能用第二条）、`--channel` 走临时 Worker（`mysql-channel.js`）。
 *
 * 用法：
 *   node scripts/catalog/apply-mysql-migrations.js --channel
 *   node scripts/catalog/apply-mysql-migrations.js --mysql-url mysql://root:root@127.0.0.1:13306/devtrends
 *   node scripts/catalog/apply-mysql-migrations.js --channel --dry-run
 */
const fs = require('fs');
const path = require('path');
const { sqlValue } = require('./build-mysql-import.js');

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations', 'mysql');
// 「已经存在」类错误：生产库先有 schema、后有记账表，引导那一次必然撞上它们。
const ALREADY_APPLIED = [/Duplicate column name/i, /Duplicate key name/i, /Duplicate entry/i, /check that column\/key exists/i];

function parseArgs(argv) {
  const options = { mysqlUrl: process.env.CATALOG_MYSQL_URL || '', channel: false, dryRun: false, only: null };
  const booleans = new Set(['--channel', '--dry-run']);
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined && !booleans.has(name) ? argv[++index] : inline;
    if (name === '--mysql-url') options.mysqlUrl = value;
    else if (name === '--only') options.only = value;
    else if (name === '--channel') options.channel = true;
    else if (name === '--dry-run') options.dryRun = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!options.channel && !options.mysqlUrl) {
    throw new Error('需要 --mysql-url / CATALOG_MYSQL_URL，或 --channel（临时 Worker 通道）');
  }
  return options;
}

function migrationFiles(only) {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(name => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .filter(name => !only || name.startsWith(only));
}

/** 与 `worker/catalog-import.mjs` 同一份切分实现 —— 应用器与写入通道不能有两套切分语义。 */
function splitSql(sql) {
  const source = fs.readFileSync(path.join(ROOT, 'worker', 'catalog-import.mjs'), 'utf8');
  const start = source.indexOf('export function splitSql');
  const end = source.indexOf('\nexport default');
  const body = source.slice(start, end).replace('export function splitSql', 'function splitSql');
  return new Function(`${body}; return splitSql;`)()(sql);
}

async function openDb(options) {
  // 把部署出来的地址回显到日志：通道问题的第一现场就是「它到底请求了哪个 URL」。
  if (options.channel) return require('./mysql-channel.js').createChannelDb({ log: message => console.log(message) });
  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection({ uri: options.mysqlUrl, dateStrings: true });
  return {
    select: async (sql) => (await connection.query(sql))[0],
    execute: async (sql) => { await connection.query(sql); },
    close: async () => { await connection.end(); },
  };
}

async function appliedVersions(db) {
  try {
    const rows = await db.select('SELECT version FROM schema_migrations');
    return new Set(rows.map(row => row.version));
  } catch (error) {
    // 只有「表不存在」（1146）才是「0001 还没跑过」这个正常状态。其它错误（通道挂了、404、
    // 权限）必须抛出去 —— 否则读失败会被降级成「记账为空」，于是每个迁移都被重跑一遍，
    // 而真正的原因（读通道不通）在日志里只剩一句「已记账 0 个」。
    const message = String(error.message || error);
    if (!/doesn't exist|1146/i.test(message)) throw error;
    console.warn('[migration] schema_migrations 还不存在，按「全部未应用」处理');
    return new Set();
  }
}

/**
 * 应用一个迁移。返回 `{ applied, skipped }`（跳过的语句 = 撞上「已存在」）。
 * 一条语句一次 POST：Hyperdrive 下整批是一个事务，一条失败会连已成功的语句一起回滚 ——
 * 而引导路径恰恰依赖「重复的跳过、缺的补上」，所以不能整批发。
 */
async function applyMigration(db, name, { dryRun }) {
  const statements = splitSql(fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
  let applied = 0;
  let skipped = 0;
  for (const statement of statements) {
    if (dryRun) { console.log(`  [dry-run] ${statement.split('\n')[0].slice(0, 90)}`); applied += 1; continue; }
    try {
      await db.execute(statement);
      applied += 1;
    } catch (error) {
      const message = String(error.message || error);
      if (ALREADY_APPLIED.some(pattern => pattern.test(message))) {
        skipped += 1;
        continue;
      }
      throw new Error(`${name} 第 ${applied + skipped + 1} 条语句失败：${message}`);
    }
  }
  return { applied, skipped };
}

/** 应用所有尚未记账的迁移。返回可读的运行摘要（测试直接调它，不经过 CLI）。 */
async function applyAll(db, options = {}) {
  const done = await appliedVersions(db);
  const files = migrationFiles(options.only);
  const summary = [];
  for (const name of files) {
    // 历史命名兼容：生产里有一条 `0001_catalog`（没有 .sql 后缀），来自最初那次一次性 Worker
    // 执行的迁移。不认它的话，0001 每次都会被重新应用一遍（`IF NOT EXISTS` 无害但白跑）。
    if (done.has(name) || done.has(name.replace(/\.sql$/, ''))) {
      summary.push({ name, status: 'recorded' });
      continue;
    }
    const result = await applyMigration(db, name, options);
    if (!options.dryRun) {
      // 记账与 DDL 分开：DDL 在 MySQL 里隐式提交，包不进事务，所以先做完再记账。
      // **不用 INSERT IGNORE**：它会把所有错误一起吞掉（包括「表不存在」「权限不足」），
      // 于是记账悄悄没写进去、下次又把每个迁移重跑一遍 —— 2026-09-21 就是这样丢了一整轮记账。
      // 只把 1062（重复键，即已经记过）当作成功。
      try {
        await db.execute(`INSERT INTO schema_migrations (version) VALUES (${sqlValue(name)})`);
      } catch (error) {
        if (!/Duplicate entry/i.test(String(error.message || error))) throw error;
      }
    }
    summary.push({ name, status: 'applied', ...result });
    console.log(`[migration] ${name}: 执行 ${result.applied} 条，跳过（已存在）${result.skipped} 条`);
  }
  return {
    dryRun: Boolean(options.dryRun),
    files: files.length,
    alreadyRecorded: summary.filter(entry => entry.status === 'recorded').length,
    applied: summary.filter(entry => entry.status === 'applied').length,
    migrations: summary,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = await openDb(options);
  try {
    const done = await appliedVersions(db);
    // 版本号要打出来：只报个数的话，「记账没累积」和「读通道看到的是另一个库」分不出来。
    console.log(`迁移目录 ${migrationFiles(options.only).length} 个文件，已记账 ${done.size} 个`
      + `${done.size ? `：${[...done].sort().join(', ')}` : ''}${options.dryRun ? '（dry-run）' : ''}`);
    console.log(JSON.stringify(await applyAll(db, options), null, 2));
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = { parseArgs, migrationFiles, splitSql, appliedVersions, applyMigration, applyAll, openDb, ALREADY_APPLIED };
