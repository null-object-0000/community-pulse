#!/usr/bin/env node
/**
 * 旅行方向存量产品的 LLM 增强（两跳：Actions 读库 → 本机跑模型 → 回放 SQL 写库）。
 *
 * 为什么是两跳：模型网关是本机自建的（enhance.js 的 BASE，127.0.0.1:18640），
 * GitHub Actions 到不了；而本机所在的公司网络在协议层重置到 RDS 3306 的 TLS 握手，
 * 直连不通。所以读与写走 Cloudflare（生产 Worker 的只读 API + 临时通道 Worker），
 * 只有「跑模型」这一步在本机。
 *
 * 用法：
 *   # 1) 拉取队列（走生产只读 API，本机可达）
 *   node scripts/catalog/enrich-travel.js --pull --out .scratch/travel-queue.json
 *   # 2) 本机跑模型（产出结果 JSON）
 *   node scripts/catalog/enrich-travel.js --run --in .scratch/travel-queue.json --out .scratch/travel-results.json
 *   # 3) 生成回放 SQL（由 Actions 或任何有凭据的通道应用）
 *   node scripts/catalog/enrich-travel.js --sql --in .scratch/travel-results.json --out .scratch/travel.sql
 *
 * 只有第 2 步需要模型；第 1、3 步不联网到模型，可在任何环境跑。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const D = require('../../web/shared.js');
const {
  localize, sourceHash, PROMPT_VERSION,
} = require('../../.agents/skills/community-pulse/scripts/enhance.js');
const { sqlValue, taxonomyRows } = require('./build-mysql-import.js');
// 写库形状直接复用规范实现，避免分叉第二套 SQL（见 buildSql 的注释）。
// `inputHashFor` / `localizationInput` 同理：状态行的输入哈希必须由规范函数算出，
// 自己拼一个「长得差不多」的哈希会让续跑与重入判定与日更链不可比。
const {
  startRunSql, seedSql, resultBatchSql, finishRunSql, inputHashFor, localizationInput,
} = require('./enrich-products.js');

const API = process.env.CATALOG_API_ORIGIN || 'https://community-pulse.nichangen.workers.dev';
const FACET = 'useCases';
const TERM = process.env.TRAVEL_TERM || 'travel-mobility';
const FROM = process.env.TRAVEL_FROM || '2025-01-01';
const TO = process.env.TRAVEL_TO || new Date().toISOString().slice(0, 10);
const PROCESSOR = 'enhance.travel';
// 独立的加工版本（不是 `catalog-localize-v1`）：这批的队列口径完全不同（按标签全历史，
// 而不是「某个 first_seen_date 的当天新增」），而 `product_content` 的删除边界是
// `content_source='llm:<版本>'` —— 用同一个版本号会让这批的 DELETE 顺手删掉日更链写下的
// shadow 行（那一行的输入可能比这里拉到的更新）。版本分开，两批互不覆盖。
const PROCESSOR_VERSION = 'travel-localize-v1';
const MODE = 'shadow';
const PAGE_SIZE = 300;

// 门禁与日报链同源：没有可读证据就不发请求（见 enhance.js 的 hasEvidence 口径）。
const DESCRIPTION_MIN_LENGTH = D.DETAIL_SUMMARY_MIN;

function parseArgs(argv) {
  const options = { pull: false, run: false, sql: false, in: null, out: null, queue: null, limit: 0, concurrency: 5 };
  const booleans = new Set(['--pull', '--run', '--sql']);
  for (let i = 0; i < argv.length; i += 1) {
    const [name, inline] = argv[i].split('=', 2);
    const value = inline === undefined && !booleans.has(name) ? argv[++i] : inline;
    if (name === '--pull') options.pull = true;
    else if (name === '--run') options.run = true;
    else if (name === '--sql') options.sql = true;
    else if (name === '--in') options.in = path.resolve(value);
    else if (name === '--out') options.out = path.resolve(value);
    else if (name === '--queue') options.queue = path.resolve(value);
    else if (name === '--limit') options.limit = Number(value);
    else if (name === '--concurrency') options.concurrency = Number(value);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

/** 用 curl 而不是 fetch：这台机器上 Node 不走系统代理，curl 会读 HTTPS_PROXY。 */
function curlJson(url) {
  const out = execFileSync('curl', ['-s', '--max-time', '60', url], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return JSON.parse(out);
}

/** 第 1 步：按受控标签拉全历史队列。 */
async function pull(options) {
  const products = [];
  let cursor = null;
  for (let page = 0; page < 200; page += 1) {
    const url = new URL(`${API}/api/v1/products`);
    url.searchParams.set('term', TERM);
    url.searchParams.set('from', FROM);
    url.searchParams.set('to', TO);
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    if (cursor) url.searchParams.set('cursor', cursor);
    else url.searchParams.set('page', String(page + 1));
    const data = curlJson(url.toString());
    products.push(...(data.products || []));
    if (!data.hasMore || !data.nextCursor) break;
    cursor = data.nextCursor;
  }
  const entries = products.map((p) => {
    const desc = String(p.summary || '').trim();
    return {
      productId: p.productId,
      title: String(p.title || ''),
      desc,
      sourceName: String(p.sourceName || ''),
      sourceId: String(p.sourceId || ''),
      url: String(p.url || ''),
      trendDate: String(p.trendDate || ''),
      ruleTaxonomy: (p.taxonomy || {})[FACET] || [],
      gate: desc.length >= DESCRIPTION_MIN_LENGTH ? 'pass' : 'skipped_no_input',
    };
  });
  const queue = {
    schemaVersion: 1,
    term: TERM,
    from: FROM,
    to: TO,
    pulledAt: new Date().toISOString(),
    fetched: products.length,
    gatePass: entries.filter((e) => e.gate === 'pass').length,
    entries,
  };
  fs.writeFileSync(options.out, `${JSON.stringify(queue, null, 2)}\n`);
  console.log(`[pull] 拉取 ${products.length} 条（标签 ${TERM} ${FROM}..${TO}），过门禁 ${queue.gatePass} 条 → ${options.out}`);
  return queue;
}

/**
 * 输入哈希：走规范实现（`localizationInput` → `inputHashFor`），不自己拼一个「长得差不多」的。
 * 这里唯一的差别是数据来源 —— 日更链从 `product_details.item_json` 取，本脚本从只读 API 的
 * `summary` / `sourceName` 取，但喂给规范的形状完全一样，所以哈希可比。
 */
function inputHashOf({ productId, title, desc, sourceName }) {
  return inputHashFor(localizationInput({
    product_id: productId,
    product_title: title,
    item_json: { title, summary: desc, sourceName },
  }));
}

/** 第 2 步：本机跑模型。可续跑（结果文件里已有的 productId 不再请求）。 */
async function run(options) {
  const queue = JSON.parse(fs.readFileSync(options.in, 'utf8'));
  const results = fs.existsSync(options.out) ? JSON.parse(fs.readFileSync(options.out, 'utf8')) : { schemaVersion: 1, results: [], failed: [] };
  const done = new Set(results.results.map((r) => r.productId));
  let pending = queue.entries.filter((e) => e.gate === 'pass' && !done.has(e.productId));
  if (options.limit > 0) pending = pending.slice(0, options.limit);
  console.log(`[run] 队列 ${queue.entries.length}，已跑 ${done.size}，本次待跑 ${pending.length}`);

  let cursor = 0;
  let requests = 0;
  let finished = 0;
  const startedAt = Date.now();
  const flush = () => fs.writeFileSync(options.out, `${JSON.stringify(results, null, 2)}\n`);
  const worker = async () => {
    while (cursor < pending.length) {
      const entry = pending[cursor++];
      let productRequests = 0;
      try {
        const localized = await localize(
          { heading: entry.title, title: entry.title, desc: entry.desc, section: entry.sourceName, productId: entry.productId },
          { onRequest: () => { productRequests += 1; requests += 1; } },
        );
        results.results.push({
          productId: entry.productId,
          title: entry.title,
          desc: entry.desc,
          sourceName: entry.sourceName,
          ruleTaxonomy: entry.ruleTaxonomy,
          inputHash: inputHashOf(entry),
          // 整个 localized 原样留档：回放 SQL 由规范构造函数消费它，少一次「拆字段再拼回去」。
          localized,
          requestCount: productRequests,
        });
      } catch (error) {
        results.failed.push({ productId: entry.productId, error: String(error.message || error).slice(0, 300), requestCount: productRequests });
      }
      finished += 1;
      if (finished % 25 === 0 || finished === pending.length) {
        flush();
        const rate = (Date.now() - startedAt) / finished;
        console.log(`[run] ${finished}/${pending.length}  请求 ${requests}  均 ${Math.round(rate)}ms/条  预计剩余 ${Math.round(rate * (pending.length - finished) / 60000)} 分钟`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, pending.length) }, worker));
  flush();
  console.log(`[run] 完成 ${results.results.length} 条，失败 ${results.failed.length} 条，模型请求 ${requests} → ${options.out}`);
  return results;
}

/**
 * 第 3 步：把结果翻成回放 SQL（shadow：is_current=0，激活是单独的受审操作）。
 *
 * **不分叉第二套 SQL**：这里直接调用 `enrich-products.js` 导出的 `resultBatchSql` /
 * `startRunSql` / `finishRunSql` / `seedSql`。理由与那一层「不写第二套 prompt」相同 ——
 * 曾经分叉出第二套语义正是删掉旧实现的原因。两跳只是把「读队列 + 跑模型」挪到本机，
 * 写库的形状必须逐字一致（含 zh-CN / en 两行、`content_source=llm:<版本>`、
 * 先删自己的旧 shadow 行、`confidence` 留空）。
 */
function buildSql(options) {
  const data = JSON.parse(fs.readFileSync(options.in, 'utf8'));
  // 输入哈希一律重算：结果文件可能来自改动之前的运行（那时哈希是另一套算法），而状态行的
  // `input_hash` 决定「输入变了没有」，必须与规范实现同源。队列文件里有重算所需的 `desc`。
  const byId = new Map();
  if (options.queue && fs.existsSync(options.queue)) {
    const queue = JSON.parse(fs.readFileSync(options.queue, 'utf8'));
    for (const entry of queue.entries || []) byId.set(entry.productId, entry);
  } else {
    console.warn('[sql] 未提供 --queue：沿用结果文件里存的 inputHash（可能与规范实现不同源）');
  }
  const hashFor = (r) => {
    const entry = byId.get(r.productId);
    if (entry) return inputHashOf(entry);
    if (r.desc !== undefined) return inputHashOf(r);
    return r.inputHash || '';
  };
  const runId = `enr_${require('crypto').createHash('sha256')
    .update([TERM, PROCESSOR_VERSION, PROMPT_VERSION, D.taxonomyVersion].join('\u0000')).digest('hex').slice(0, 24)}`;
  const runOptions = { date: TO, mode: MODE, processorVersion: PROCESSOR_VERSION, writeBatch: 25 };
  const statements = [];
  statements.push(startRunSql(runOptions, runId));
  statements.push(...seedSql());

  // 归一化：续跑一轮里失败过的产品会在下一轮成功，但 `failed` 里的陈旧条目不会自己消失。
  // 以「历史上是否成功过」为准 —— 成功过的产品从失败集合里剔除，这样摘要与 failedCount
  // 反映的是**最终**状态，而不是重试过程的累计。（进程崩溃留下的重复项也一并去重。）
  const seen = new Set();
  const succeeded = [];
  for (const r of data.results) {
    if (!r || !r.productId || seen.has(r.productId)) continue;
    seen.add(r.productId);
    succeeded.push(r);
  }
  const stillFailed = [];
  const failedSeen = new Set();
  for (const f of data.failed || []) {
    if (!f || !f.productId || seen.has(f.productId) || failedSeen.has(f.productId)) continue;
    failedSeen.add(f.productId);
    stillFailed.push(f);
  }

  // 逐条包成规范构造函数要求的 entry 形状：row.product_id 是唯一被读的字段，
  // entry.input 提供中文标题兜底（与 enrich-products.js 的 resultBatchSql 一致）。
  const usable = succeeded.filter((r) => {
    const l = r.localized || {};
    return String(l.summaryZh || '').trim() || String(l.summaryEn || '').trim();
  });
  const noSummary = succeeded.length - usable.length;
  const items = usable.map((r) => {
    const entry = byId.get(r.productId);
    const input = localizationInput({
      product_id: r.productId,
      product_title: r.title || '',
      item_json: {
        title: r.title || '',
        summary: (entry && entry.desc) || r.desc || '',
        sourceName: (entry && entry.sourceName) || r.sourceName || '',
      },
    });
    return { entry: { row: { product_id: r.productId }, input, inputHash: hashFor(r) }, localized: r.localized, requestCount: r.requestCount || 0 };
  });
  // 规范实现按 writeBatch=25 切批（两条 DELETE 按 IN、content 与 assignments 多行 INSERT、
  // status 多行 upsert）—— 同样的批次形状在这里照搬，避免逐产品写把通道额度打满。
  for (let i = 0; i < items.length; i += runOptions.writeBatch) {
    statements.push(...resultBatchSql(runId, runOptions, items.slice(i, i + runOptions.writeBatch)));
  }

  const summary = {
    runId,
    date: TO,
    mode: MODE,
    processorVersion: PROCESSOR_VERSION,
    promptVersion: PROMPT_VERSION,
    taxonomyVersion: D.taxonomyVersion,
    dryRun: false,
    statePersisted: true,
    transport: 'offline-replay',
    scope: { term: TERM, from: FROM, to: TO },
    newProductCount: 0,
    reentryCount: usable.length,
    productCount: usable.length + stillFailed.length,
    requestedCount: usable.length + stillFailed.length,
    completedCount: usable.length,
    failedCount: stillFailed.length,
    skippedNoInputCount: 0,
    skippedFailedCount: 0,
    resumedCount: 0,
    modelRequests: succeeded.reduce((n, r) => n + (r.requestCount || 0), 0),
    wallClockMs: data.wallClockMs || 0,
    concurrency: data.concurrency || 20,
    states: { pending: 0, running: 0, complete: usable.length, failed: stillFailed.length, skipped_no_input: 0 },
    runState: { productCount: usable.length + stillFailed.length, completedCount: usable.length, failedCount: stillFailed.length, skippedNoInputCount: 0 },
  };
  statements.push(finishRunSql(runId, summary));

  fs.writeFileSync(options.out, `${statements.join(';\n')};\n`);
  console.log(`[sql] ${statements.length} 条语句（${usable.length} 个产品 → ${usable.length * 2} 行 content + 标签）→ ${options.out}`);
  if (noSummary) console.log(`[sql] 跳过 ${noSummary} 个「无中英摘要」的结果（模型没给出可用译文）`);
  if (stillFailed.length) console.log(`[sql] ${stillFailed.length} 个产品最终仍失败，写进 run 的 failed_count`);
  console.log(`[sql] run id: ${runId}`);
  return { runId, statements: statements.length, products: usable.length, failed: stillFailed.length };
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const action = options.pull ? pull : options.run ? run : options.sql ? buildSql : null;
  if (!action) { console.error('需要 --pull / --run / --sql 之一'); process.exit(1); }
  if (!options.out) { console.error('需要 --out'); process.exit(1); }
  if ((options.run || options.sql) && !options.in) { console.error('--run / --sql 需要 --in'); process.exit(1); }
  Promise.resolve(action(options)).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = { parseArgs, pull, run, buildSql, PROCESSOR_VERSION, PROMPT_VERSION, TERM };
