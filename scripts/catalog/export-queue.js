#!/usr/bin/env node
/**
 * 把「某一天的新增产品」导出成**离线队列文件**，供本机跑模型（`enrich-queue.js`）。
 *
 * **为什么需要这一步**：`enrich-products.js` 自己取队列（`newBucketSql`）也自己写库，而
 * 这两件事的可用环境是**互斥**的 —— 队列在 RDS 里，本机网络在协议层重置到 3306 的 TLS
 * 握手（只能借 Actions 的 Cloudflare 凭据经临时 Worker 通道读）；模型网关
 * `127.0.0.1:18640` 是本机自建，Actions 到不了。所以把「读队列」单独拆出来跑在 Actions 侧，
 * 正文落成产物，本机只负责跑模型，写库再回 Actions（`apply-catalog-sql.yml`）。
 *
 * **导出的是 `enrich-products.js` 的 `queueSql` 原始行**（新增桶 ∪ 当天初次打标 travel-mobility
 * 的旅行臂），不是加工过的条目：`enrich-queue.js` 会把这份行喂给
 * 一个假 db，让 `runEnrichment()` 走**与日更链逐字相同**的代码路径（`localizationInput` →
 * `inputHashFor` → `planQueue`）。若在这里就把行压成 `{title, desc, …}`，那条路径上任何
 * 未来改动（例如 `localizationInput` 换了取值字段）都不会反映到离线补跑，哈希就分叉了 ——
 * 后果是同一批产品被反复重付，且 `--resume` 永远认为输入变了。
 *
 * 用法：
 *   # Actions（生产，见 daily-report.yml 与 .github/workflows/catalog-queue-export.yml）
 *   node scripts/catalog/export-queue.js --date 2026-09-22 --out queue-2026-09-22.json \
 *     --status-out status-2026-09-22.json
 *   # 本地验收（直连一个可达的 MySQL）
 *   node scripts/catalog/export-queue.js --date 2026-09-22 --mysql-url "mysql://..." --out q.json
 */
const fs = require('fs');
const path = require('path');
const { createChannelDb } = require('./mysql-channel.js');
const { openDb } = require('./db-transport.js');
const {
  queueSql, travelBucketSql, newBucketSql, runStatusSql, stableRunId, PROCESSOR_VERSION, MODE,
} = require('./enrich-products.js');

function parseArgs(argv) {
  const options = { date: null, out: null, statusOut: null, mysqlUrl: process.env.CATALOG_MYSQL_URL || '', channel: false };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined ? argv[++index] : inline;
    if (name === '--date') options.date = value;
    else if (name === '--out') options.out = path.resolve(value);
    else if (name === '--status-out') options.statusOut = path.resolve(value);
    else if (name === '--mysql-url') options.mysqlUrl = value;
    else if (name === '--channel') options.channel = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date || '')) throw new Error('--date YYYY-MM-DD is required');
  if (!options.out) throw new Error('--out is required');
  return options;
}

/** 只保留 `localizationInput` 真正会读的键，避免把 item_json 里的配图数组（几百 KB）搬进产物。 */
function slimRow(row) {
  let item = row.item_json;
  if (typeof item === 'string') {
    try { item = JSON.parse(item); } catch { item = {}; }
  }
  return {
    product_id: row.product_id,
    product_title: row.product_title,
    observed_date: row.observed_date,
    content_score: row.content_score,
    // 这三个键就是 `localizationInput` 的全部输入（heading/title 取 title，desc 取 summary，
    // section 取 sourceName）。多带一个键不会改哈希，少带一个就会。
    item_json: {
      title: item.title,
      summary: item.summary,
      sourceName: item.sourceName,
    },
  };
}

async function main(options) {
  const db = options.channel || !options.mysqlUrl
    ? createChannelDb({ log: (m) => console.error(`[export] ${m}`) })
    : (await openDb({ mysqlUrl: options.mysqlUrl, preferDirect: true })).db;
  try {
    // 队列与旅行臂**共用 `queueSql`**：旅行臂在 `export-queue.js` 里单独再查一次不是另取一套，
    // 而是为了把「这一批里有几条是当天初次打上 travel-mobility」落成可观测的数字，并**硬校验**
    // 它们确实都在队列里。将来若有人把 `queueSql` 的旅行臂删掉，这里会先炸，而不是静默少跑。
    const rows = await db.select(queueSql(options));
    const slim = rows.map(slimRow);
    const queueIds = new Set(slim.map(row => row.product_id));
    const travelRows = await db.select(travelBucketSql(options));
    const missingTravel = travelRows.filter(row => !queueIds.has(row.product_id));
    if (missingTravel.length) {
      throw new Error(`队列漏了 ${missingTravel.length} 个当天初次打标为 travel-mobility 的产品`
        + `（例：${missingTravel.slice(0, 3).map(row => row.product_id).join(', ')}）—— queueSql 的旅行臂被改坏了`);
    }
    const newIds = new Set((await db.select(newBucketSql(options.date))).map(row => row.product_id));
    const travelAdded = travelRows.filter(row => !newIds.has(row.product_id)).length;
    const queue = {
      schemaVersion: 1,
      date: options.date,
      pulledAt: new Date().toISOString(),
      source: 'queueSql',
      fetched: slim.length,
      travelFetched: travelRows.length,
      travelAdded,
      rows: slim,
    };
    fs.writeFileSync(options.out, `${JSON.stringify(queue)}\n`);
    const bytes = fs.statSync(options.out).size;
    console.log(`[export] ${options.date} 队列 ${slim.length} 个产品`
      + `（其中当天初次打标 travel-mobility ${travelRows.length} 个，新增桶之外 ${travelAdded} 个）`
      + ` → ${options.out}（${Math.round(bytes / 1024)} KB）`);

    // 该 run 的既有状态：决定「0 请求续跑」。**必须一并导出** —— 本机查不到库，
    // 若离线跑批假装没有状态行，每个产品都会被当成新的重新付费。
    if (options.statusOut) {
      const runId = stableRunId({ date: options.date, mode: MODE, processorVersion: PROCESSOR_VERSION });
      const statusRows = await db.select(runStatusSql(runId));
      fs.writeFileSync(options.statusOut, `${JSON.stringify({
        schemaVersion: 1, date: options.date, runId, fetched: statusRows.length, rows: statusRows,
      })}\n`);
      console.log(`[export] run ${runId} 既有状态 ${statusRows.length} 行 → ${options.statusOut}`);
    }
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, slimRow };
