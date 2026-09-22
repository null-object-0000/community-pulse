#!/usr/bin/env node
/**
 * 只读核对产品库（借 Actions 的 Cloudflare 凭据）。
 *
 * 为什么不用 `live-query.js`：它部署临时只读 Worker 后**直接发请求**，而刚 deploy 出来的
 * `workers.dev` 路由不是立刻生效的（2026-09-21 实测：deploy 完 1.5 秒就发请求会拿到
 * Cloudflare 的 HTML 404，不是 Worker 的响应）。`createChannelDb` 里有 `waitForRoute`
 * 处理这件事，所以这里复用它 —— 本机没有 CF 凭据，这条只读路径也只能在 Actions 里跑。
 *
 * 用法：node scripts/catalog/read-check.js --sql "SELECT 1"
 */
const { createChannelDb } = require('./mysql-channel.js');

function parseArgs(argv) {
  const options = { sql: null };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined ? argv[++index] : inline;
    if (name === '--sql') options.sql = value;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!options.sql) throw new Error('需要 --sql');
  return options;
}

/** 只读闸：这条流水线是诊断用的，不该能改数据。 */
function assertSelectOnly(sql) {
  const head = sql.trim().replace(/\s+/g, ' ').toUpperCase();
  if (!head.startsWith('SELECT')) throw new Error(`拒绝：只允许 SELECT（收到 ${head.slice(0, 40)}）`);
  // 多语句也要拦 —— 单条 SELECT 是这条路的契约。
  if (head.includes(';') && head.indexOf(';') !== head.length - 1) {
    throw new Error('拒绝：只允许单条 SELECT（出现多个语句）');
  }
}

async function main(options) {
  assertSelectOnly(options.sql);
  const db = createChannelDb({ log: (m) => console.log(`[read] ${m}`) });
  try {
    const rows = await db.select(options.sql);
    console.log(`[read] ${rows.length} 行`);
    console.log(JSON.stringify(rows, null, 1));
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main(parseArgs(process.argv.slice(2))).catch((e) => { console.error(e.message); process.exitCode = 1; });
}

module.exports = { parseArgs, assertSelectOnly };
