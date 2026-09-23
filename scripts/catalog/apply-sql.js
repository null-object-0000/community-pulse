#!/usr/bin/env node
/**
 * 把一份 SQL 文件应用到产品库（离线增强的第二跳：本机跑模型 → 这里写库）。
 *
 * 为什么需要它：本机所在网络在协议层重置到 RDS 3306 的 TLS 握手（公司网络限制），直连不通；
 * 而模型网关是本机自建的，GitHub Actions 到不了。于是「跑模型」留在本机、「写库」交给有
 * Cloudflare 凭据的一方，两边通过一份 SQL 文件交接。
 *
 * **写入通道复用 `createChannelDb`**（与 `upload-mysql.js`、`enrich-products.js` 同一个）：
 * 那条路已经处理了临时 Worker 的部署/删除、workers.dev 路由生效前的等待、令牌校验。
 * 这里不手搓 fetch —— 手搓的第二条路会在「路由没生效返回 HTML 404」这类场景下给出假的
 * 失败信号。
 *
 * 用法：
 *   node scripts/catalog/apply-sql.js --file .scratch/travel.sql --channel
 *   node scripts/catalog/apply-sql.js --file .scratch/travel.sql --channel --dry-run
 *   node scripts/catalog/apply-sql.js --file .scratch/travel.sql --mysql-url "mysql://..."
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createChannelDb } = require('./mysql-channel.js');

/** 每批提交的语句数。整份文件一次性 batch 会变成单个超长事务与超大请求体。 */
const STATEMENTS_PER_BATCH = 100;

/**
 * 读 SQL 文件，支持 `.gz`。为什么值得支持：一批全量增强的 SQL 约 10 MB，而它要经一个分支
 * 交给 Actions（仓库是公开的，这个 blob 会永久留在对象里）。gzip 后约 1/7，代价只有这几行。
 */
function readSql(file) {
  const raw = fs.readFileSync(file);
  return /\.gz$/.test(file) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
}

function parseArgs(argv) {
  const options = { file: null, channel: false, mysqlUrl: process.env.CATALOG_MYSQL_URL || '', dryRun: false, batch: STATEMENTS_PER_BATCH, allowActivation: false };
  // 布尔开关必须在这里列出：否则 `--allow-activation` 会被当成「取值开关」，
  // 把下一个参数（这里是 `--dry-run`）吃掉当值 —— 与 enrich-travel.js 的 `--pull` 同一个坑。
  const booleans = new Set(['--channel', '--dry-run', '--allow-activation']);
  for (let i = 0; i < argv.length; i += 1) {
    const [name, inline] = argv[i].split('=', 2);
    const value = inline === undefined && !booleans.has(name) ? argv[++i] : inline;
    if (name === '--file') options.file = path.resolve(value);
    else if (name === '--channel') options.channel = true;
    else if (name === '--mysql-url') options.mysqlUrl = value;
    else if (name === '--dry-run') options.dryRun = true;
    else if (name === '--batch') options.batch = Number(value);
    else if (name === '--allow-activation') options.allowActivation = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!options.file) throw new Error('需要 --file <sql 文件>');
  return options;
}

/**
 * 与 `worker/catalog-import.mjs` 的 `splitSql` 逐字同源 —— 两边对「一条语句」的判断必须一致，
 * 否则语句计数就失去意义（引号里的分号是最常见的分歧点）。
 */
function splitSql(sql) {
  const result = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    if (sql[index] === "'") {
      if (quoted && sql[index + 1] === "'") index += 1;
      else quoted = !quoted;
    } else if (sql[index] === ';' && !quoted) {
      const statement = sql.slice(start, index).trim();
      if (statement) result.push(statement);
      start = index + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

/**
 * shadow 闸：默认只允许写 `is_current=0` 的行。激活（改 `is_current`）是单独的受审操作 ——
 * 曾经就是因为自动激活，线上短暂出现过半成品描述。
 *
 * `--allow-activation` 是那道受审入口：只有显式传它才放行含 `is_current=1` 的语句，且仍然要求
 * 每一条这样的语句都来自 `activate-enrichment.js` 的形状（`UPDATE taxonomy_assignments`），
 * 不允许任意写。默认（不传）保持拒绝。
 */
function assertShadowOnly(statements, { allowActivation = false } = {}) {
  const offenders = statements.filter((statement) => /is_current\s*=\s*1/.test(statement));
  if (!offenders.length) return;
  if (!allowActivation) {
    throw new Error(`拒绝应用：${offenders.length} 条语句含 is_current=1，激活需要显式 --allow-activation`);
  }
  const unexpected = offenders.filter((statement) => !/^\s*UPDATE\s+taxonomy_assignments/i.test(statement));
  if (unexpected.length) {
    throw new Error(`拒绝应用：${unexpected.length} 条激活语句不是 taxonomy_assignments 的激活形状`);
  }
  console.log(`[apply] --allow-activation：放行 ${offenders.length} 条激活语句（taxonomy_assignments）`);
}

function summarize(file, sql, statements) {
  return {
    file: path.basename(file),
    bytes: Buffer.byteLength(sql),
    statements: statements.length,
    kinds: {
      content: statements.filter((s) => /INSERT INTO product_content/i.test(s)).length,
      assignments: statements.filter((s) => /INSERT INTO taxonomy_assignments/i.test(s)).length,
      status: statements.filter((s) => /INSERT INTO enrichment_product_status/i.test(s)).length,
      terms: statements.filter((s) => /INSERT INTO taxonomy_terms/i.test(s)).length,
    },
  };
}

async function main(options) {
  const sql = readSql(options.file);
  const statements = splitSql(sql);
  assertShadowOnly(statements, { allowActivation: options.allowActivation });
  const summary = summarize(options.file, sql, statements);
  console.log(`[apply] ${summary.file}: ${summary.bytes} 字节 / ${statements.length} 条语句`);
  console.log(`[apply] ${JSON.stringify(summary.kinds)}`);

  if (options.dryRun) { console.log('[apply] --dry-run：只校验，未写库'); return summary; }
  if (!options.channel && !options.mysqlUrl) throw new Error('需要 --channel 或 --mysql-url（或设 CATALOG_MYSQL_URL）');

  let db;
  if (options.mysqlUrl && !options.channel) {
    const { openDb } = require('./db-transport.js');
    ({ db } = await openDb({ mysqlUrl: options.mysqlUrl, preferDirect: true }));
  } else {
    db = createChannelDb({ log: (message) => console.log(`[apply] ${message}`) });
  }

  let applied = 0;
  try {
    for (let i = 0; i < statements.length; i += options.batch) {
      const chunk = statements.slice(i, i + options.batch);
      await db.batch(chunk);
      applied += chunk.length;
      console.log(`[apply] ${applied}/${statements.length}`);
    }
  } finally {
    await db.close();
  }
  console.log(`[apply] 完成：${applied} 条语句已应用（shadow，未激活）`);
  return { ...summary, applied };
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  main(options).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = { parseArgs, splitSql, assertShadowOnly, summarize, main };
