#!/usr/bin/env node
/**
 * 本机侧的**离线补跑**：拿 `export-queue.js` 导出的队列，在本机跑模型网关，出回放 SQL。
 *
 * **为什么不能直接用 `enrich-products.js`**：它自己取队列也自己写库，而队列在 RDS（本机连不上）、
 * 模型网关在本机（Actions 到不了）。所以拆成三跳：Actions 导队列 → 本机跑模型出 SQL →
 * Actions 写库（`apply-catalog-sql.yml`）。
 *
 * **这一层不复制任何 SQL 拼装**：它把导出的行喂给一个假 db，然后调用
 * `enrich-products.js` 的 `runEnrichment()` —— 走的是**与日更链逐字相同**的代码路径
 * （`localizationInput` → `inputHashFor` → `planQueue` → `resultBatchSql` → `finishRunSql`）。
 * 配 `--dry-run`，该函数会把本该执行的语句**收集**进 `sqlOut` 而不是执行。所以离线补跑与
 * 日更链的输入哈希、批次形状、`content_source` 命名天然同源，将来改那条链这里自动跟上。
 *
 * 假 db 只回答两个查询：`newBucketSql`（喂离线行）与 `runStatusSql`（该 run 的既有状态）。
 * **状态必须来自离线文件**：本机查不到库，而状态决定「0 请求续跑」—— 若假装没有状态行，
 * 每个产品都会被当成新的重新付费。所以 `--status <file>` 是必需的（由导出器一并产出，
 * 见 `export-queue.js` 的 `--status-out`）。
 *
 * 用法：
 *   node scripts/catalog/enrich-queue.js --in queue-2026-09-22.json --status status-2026-09-22.json \
 *     --date 2026-09-22 --out sql-2026-09-22.sql --summary summary-2026-09-22.json
 */
const fs = require('fs');
const path = require('path');
const {
  runEnrichment, newBucketSql, runStatusSql, stableRunId, PROCESSOR_VERSION, MODE,
} = require('./enrich-products.js');

function parseArgs(argv) {
  const options = {
    in: null, status: null, date: null, out: null, summary: null, concurrency: 6, limit: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined ? argv[++index] : inline;
    if (name === '--in') options.in = path.resolve(value);
    else if (name === '--status') options.status = path.resolve(value);
    else if (name === '--date') options.date = value;
    else if (name === '--out') options.out = path.resolve(value);
    else if (name === '--summary') options.summary = path.resolve(value);
    else if (name === '--concurrency') options.concurrency = Number(value);
    else if (name === '--limit') options.limit = Number(value);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!options.in) throw new Error('--in is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date || '')) throw new Error('--date YYYY-MM-DD is required');
  if (!options.out) throw new Error('--out is required');
  return options;
}

/**
 * 假 db：只认两个查询，其余一律抛错 —— 静默返回空数组会让「状态查不到」伪装成「全新一批」，
 * 那是**真金白银**的差别（整批重付），必须炸得响亮。
 */
function fakeDb({ rows, statusRows, log }) {
  const executed = [];
  const normalize = (sql) => String(sql).replace(/\s+/g, ' ').trim();
  return {
    async select(sql) {
      const q = normalize(sql);
      if (q === normalize(newBucketSql('__probe__')) || /FROM products p JOIN product_details d/.test(q)) {
        log(`[db] 喂离线队列 ${rows.length} 行`);
        return rows;
      }
      if (/FROM enrichment_product_status/.test(q) && /enrichment_run_id/.test(q) && /SELECT product_id/.test(q)) {
        log(`[db] 喂既有状态 ${statusRows.length} 行`);
        return statusRows;
      }
      if (/FROM enrichment_product_status s/.test(q) && /previous_input_hash/.test(q)) {
        // 重入臂：跨 run 找历史上被跳过的产品。离线补跑**不重放它** —— 那些产品的状态行属于
        // 别的 run（本机查不到库），而把整段历史拉进来会让这次补跑的规模失控（并且它们本来就
        // 是「无描述」的，重判一遍仍然是零请求的跳过）。返回空集是**如实**的：这次补跑的重入
        // 臂为空，不是「假装没有」。将来若要支持，得让导出器把 reentrySql 的结果也一并导出。
        log('[db] 重入臂：离线补跑不重放（返回空集）');
        return [];
      }
      if (/FROM information_schema\.COLUMNS/.test(q)) {
        // schema 前置检查：离线补跑不写库，但 `assertSchema` 会先问一次。这里如实回答
        // 「迁移已应用」的形状（0005 的列都在），否则会被自己的前置检查挡在门外。
        return [
          { TABLE_NAME: 'enrichment_product_status', COLUMN_NAME: 'status', COLUMN_TYPE: "enum('pending','running','complete','failed','skipped_no_input')" },
          ...['target_date', 'mode', 'product_count', 'new_product_count', 'reentry_count', 'requested_count',
            'completed_count', 'failed_count', 'skipped_no_input_count', 'resumed_count', 'model_request_count',
            'wall_clock_ms', 'summary_json'].map((COLUMN_NAME) => ({
            TABLE_NAME: 'enrichment_runs', COLUMN_NAME, COLUMN_TYPE: 'bigint',
          })),
        ];
      }
      if (/SELECT status, COUNT\(\*\) AS count FROM enrichment_product_status/.test(q)) {
        // 干跑不落库，`runEnrichment` 只在这条上问「这个 run 现在有多少条终态」。
        return [];
      }
      throw new Error(`离线补跑的假 db 不认识这个查询（不静默返回空，避免把「查不到」伪装成「全新」）：\n${q.slice(0, 200)}`);
    },
    async execute(sql) { executed.push(String(sql)); },
    async batch(statements) { for (const s of statements) executed.push(String(s)); },
    async close() {},
    executed,
  };
}

async function main(options) {
  const queue = JSON.parse(fs.readFileSync(options.in, 'utf8'));
  const status = options.status && fs.existsSync(options.status)
    ? JSON.parse(fs.readFileSync(options.status, 'utf8'))
    : null;
  if (!status) {
    throw new Error('缺 --status（该 run 的既有状态）：没有它，续跑判定会把已加工的产品当成新的重新付费');
  }
  const db = fakeDb({
    rows: queue.rows || [],
    statusRows: status.rows || [],
    log: (m) => console.error(m),
  });
  // 状态文件里的 runId 是导出器按日更链口径算的；这里必须一致，否则续跑判定读的是另一个 run
  // 的状态行 —— 症状是「明明跑过却整批重付」，而钱已经花掉了才看得出来。先炸在这里。
  const runId = stableRunId({ date: options.date, mode: MODE, processorVersion: PROCESSOR_VERSION });
  if (status.runId && status.runId !== runId) {
    throw new Error(`run id 与导出器不一致：导出器 ${status.runId} vs 本地 ${runId}`
      + '（版本或 mode 不同源，续跑判定会失效 → 整批重付）');
  }
  const runOptions = {
    date: options.date,
    mode: MODE,
    processorVersion: PROCESSOR_VERSION,
    concurrency: options.concurrency,
    limit: options.limit,
    writeBatch: 25,
    // 关键：dry-run 让 runEnrichment 把语句收进 sqlOut 而不执行；离线补跑不碰库。
    dryRun: true,
    sqlOut: options.out,
    out: options.summary,
    quiet: false,
    resume: true,
    reentry: true,
    retryFailed: false,
    productId: null,
  };
  console.error(`[queue] run id: ${stableRunId(runOptions)}（与日更链同源：date+mode+版本）`);
  const summary = await runEnrichment(runOptions, { db });
  const statements = db.executed.length;
  console.error(`[queue] 待加工 ${summary.requestedCount}，跳过 ${summary.skippedNoInputCount}，续跑 ${summary.resumedCount}，失败 ${summary.failedCount}`);
  console.error(`[queue] ${statements} 条语句 → ${options.out}`);
  return summary;
}

if (require.main === module) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, fakeDb };
