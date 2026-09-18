#!/usr/bin/env node
/**
 * 经 Hyperdrive 只读查询生产产品库（临时部署 `worker/catalog-read.mjs`，用完立刻删除）。
 *
 * 为什么需要它：本机连不上 RDS 的 3306（公司出口重置 TLS 握手），而核对「旧地址对应哪个
 * product_id」「source_items 到底有没有数据」只能查库。只读通道也是撤销名单的唯一可靠来源 ——
 * `raw/*.json` 与产品库是两份不同的投影，从 raw 反推的旧 id 209 个里只有 5 个真在线上。
 *
 * 用法：
 *   node scripts/catalog/live-query.js --sql "SELECT 1"
 *   node scripts/catalog/live-query.js --file .scratch/queries.json   # ["SELECT …", …]
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG = path.join(ROOT, 'wrangler.mysql-read.toml');

function parseArgs(argv) {
  const options = { sql: null, file: null, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    if (name === '--keep') { options.keep = true; continue; }
    const value = inline === undefined ? argv[++index] : inline;
    if (name === '--sql') options.sql = value;
    else if (name === '--file') options.file = path.resolve(value);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!options.sql && !options.file) throw new Error('需要 --sql 或 --file');
  return options;
}

function deploy(token) {
  const result = spawnSync('npx', ['wrangler', 'deploy', '--config', CONFIG, '--var', `READ_TOKEN:${token}`], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`wrangler deploy failed:\n${result.stdout || ''}\n${result.stderr || ''}`);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const endpoint = output.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
  if (!endpoint) throw new Error('temporary read Worker URL was not reported');
  return endpoint;
}

function destroy() {
  spawnSync('npx', ['wrangler', 'delete', '--config', CONFIG, '--force'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const statements = options.file ? JSON.parse(fs.readFileSync(options.file, 'utf8')) : [options.sql];
  const token = crypto.randomBytes(32).toString('hex');
  const endpoint = deploy(token);
  const results = [];
  try {
    for (const sql of statements) {
      const response = await fetch(`${endpoint}/query`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: sql });
      const payload = await response.json();
      if (!payload.ok) throw new Error(`${sql.slice(0, 80)}… → ${payload.error}`);
      results.push({ sql, rows: payload.rows });
    }
  } finally {
    if (!options.keep) destroy();
  }
  console.log(JSON.stringify(results, null, 2));
  console.error(`queried ${results.length} statement(s); temporary Worker ${options.keep ? 'kept' : 'deleted'}`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
module.exports = { parseArgs, deploy, destroy };
