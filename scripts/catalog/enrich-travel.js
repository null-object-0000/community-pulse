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
 *   # 增量任务：补正文的同时把模型判定的 travel 归属回写（默认关闭，需显式开关）
 *   node scripts/catalog/enrich-travel.js --sql --content-only --taxonomy-writeback \
 *     --in .scratch/travel-results.json --out .scratch/travel.sql
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
// 标签回写用**单独的加工版本**：正文是 `llm:travel-localize-v1`，回写行是
// `taxonomy-writeback-v1`。两者必须能分开回滚 —— 正文按 content_source 删，
// 标签按 processor_version 删，混在一个版本里就只能整批退。
const WRITEBACK_PROCESSOR_VERSION = 'taxonomy-writeback-v1';
const MODE = 'shadow';
const PAGE_SIZE = 300;

// 门禁与日报链同源：没有可读证据就不发请求（见 enhance.js 的 hasEvidence 口径）。
const DESCRIPTION_MIN_LENGTH = D.DETAIL_SUMMARY_MIN;

function parseArgs(argv) {
  const options = {
    pull: false, run: false, sql: false, contentOnly: false, taxonomyWriteback: false,
    writebackCsv: null, in: null, out: null, queue: null, limit: 0, concurrency: 5, flush: 25,
  };
  const booleans = new Set(['--pull', '--run', '--sql', '--content-only', '--taxonomy-writeback']);
  for (let i = 0; i < argv.length; i += 1) {
    const [name, inline] = argv[i].split('=', 2);
    const value = inline === undefined && !booleans.has(name) ? argv[++i] : inline;
    if (name === '--pull') options.pull = true;
    else if (name === '--run') options.run = true;
    else if (name === '--sql') options.sql = true;
    // 增量补中文时只写正文，不重算归属/标签：这次队列只按「缺中文」取，不是分类复核。
    else if (name === '--content-only') options.contentOnly = true;
    // 默认关闭：只有分类复核/增量任务显式开启时才回写标签。普通补中文队列（--gaps）不改归属，
    // 一条模型判断就删标签的风险不该默认承担。
    else if (name === '--taxonomy-writeback') options.taxonomyWriteback = true;
    else if (name === '--writeback-csv') options.writebackCsv = path.resolve(value);
    else if (name === '--in') options.in = path.resolve(value);
    else if (name === '--out') options.out = path.resolve(value);
    else if (name === '--queue') options.queue = path.resolve(value);
    else if (name === '--limit') options.limit = Number(value);
    else if (name === '--concurrency') options.concurrency = Number(value);
    // 落盘间隔。默认 25；长跑（超过单次 50 分钟上限）时用 50，让 `.scratch/travel-progress.json`
    // 既是进度条也是续跑输入 —— `run` 启动时按 productId 跳过文件里已有的结果。
    else if (name === '--flush') options.flush = Math.max(1, Number(value) || 25);
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
        let localized;
        let lastError;
        // localize 内部已对网络/限流重试 5 次；这里再补 2 次外层次数，只重试非条目级错误
        // （校验层拒绝重试不会变好，直接交给 failed）。
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            localized = await localize(
              {
                heading: entry.title,
                // 投稿标签（Show HN: / 【开源自荐】）不进译文；否则 titleZh 会变成
                // 「Show HN：…」，列表行再 strip 一次也回不到干净的品牌名。
                title: D.stripTitleLabel(entry.title),
                desc: entry.desc,
                // 源没有摘要时把正文带上；localize({ allowTitleOnly: true }) 会再退到标题。
                content: entry.content || '',
                section: entry.sourceName,
                productId: entry.productId,
              },
              { onRequest: () => { productRequests += 1; requests += 1; }, allowTitleOnly: true },
            );
            break;
          } catch (error) {
            lastError = error;
            if (error.itemLevel || attempt === 3) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          }
        }
        if (!localized) throw lastError || new Error('没有结果');
        results.results.push({
          productId: entry.productId,
          title: entry.title,
          desc: entry.desc,
          evidence: entry.evidence || (entry.desc ? 'summary' : 'title'),
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
      if (finished % options.flush === 0 || finished === pending.length) {
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

/** CSV 字段：标题里逗号、引号、换行都常见，按 RFC 4180 转义，别让一行变更被拆成两行。 */
function csvField(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * 分类回写：模型判「不是 travel」而原分类是 → 生成移出 SQL；反过来 → 生成补入 SQL。
 *
 * 为什么补入要 DELETE + INSERT 而不是单纯 INSERT：`(product_id, facet, term_id,
 * assignment_source, processor_version)` 有唯一键，重跑同一份结果会撞键；先删掉同
 * (product, facet, term) 的旧行（含规则行）才能保证「补入后只有一条 current」。
 * 移出同样按 (product, facet, term) 删，不按 assignment_source 删 —— 规则与 LLM 两套
 * 行都指向同一个分类，漏掉任何一套都会让产品继续留在 travel。
 *
 * `ruleTaxonomy` 是**拉队列时库里的归属**，不是标题猜的；没有这个字段就跳过（不能把
 * 「不知道原来是什么」当成「原来不是 travel」，否则增量队列里每条都会被补一遍）。
 */
function buildTaxonomyWriteback(results, { runId, term = TERM } = {}) {
  const statements = [];
  const changes = [];
  for (const result of results || []) {
    if (!result || !result.productId || !result.localized) continue;
    const modelTaxonomy = result.localized.taxonomy;
    // 模型没返回 useCases 数组 = 没有可用的分类判断，不动库（与「明确判空」区分开）。
    if (!modelTaxonomy || !Array.isArray(modelTaxonomy.useCases)) continue;
    if (!Array.isArray(result.ruleTaxonomy)) continue;
    const from = [...new Set(result.ruleTaxonomy)];
    const to = [...new Set(modelTaxonomy.useCases)];
    const wasTravel = from.includes(term);
    const isTravel = to.includes(term);
    if (wasTravel === isTravel) continue;
    const id = sqlValue(result.productId);
    statements.push(`DELETE FROM taxonomy_assignments WHERE product_id=${id} AND facet='useCases' AND term_id=${sqlValue(term)}`);
    if (isTravel) {
      // is_current=1：回写本身就是结论，不走 shadow→激活两跳。版本号独立（见顶部常量），
      // 回滚时按 `processor_version='taxonomy-writeback-v1'` 精确删除这一批。
      statements.push(`INSERT INTO taxonomy_assignments (product_id, facet, term_id, assignment_source, confidence, processor_version, enrichment_run_id, is_current) `
        + `VALUES (${id}, 'useCases', ${sqlValue(term)}, 'llm', NULL, ${sqlValue(WRITEBACK_PROCESSOR_VERSION)}, ${sqlValue(runId)}, 1)`);
    }
    changes.push({
      productId: result.productId,
      title: result.title || '',
      from,
      to,
      reason: isTravel ? 'model:travel' : 'model:non-travel',
    });
  }
  const lines = ['product_id,title,from,to,reason,run_id'];
  for (const change of changes) {
    lines.push([
      change.productId, change.title, change.from.join('|'), change.to.join('|'), change.reason, runId || '',
    ].map(csvField).join(','));
  }
  return { statements, changes, csv: `${lines.join('\n')}\n` };
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
  // 日期进哈希：同一加工版本在 11-02 已有一整轮 589 条的结果，增量轮若复用同一个 run id，
  // 会把那一行 enrichment_runs 的 target_date/计数覆盖成本轮的小数字。内容与标签仍共用
  // travel-localize-v1（激活按 processor_version 走，不能换版本，否则同分面双计数）。
  const runId = `enr_${require('crypto').createHash('sha256')
    .update([TERM, PROCESSOR_VERSION, PROMPT_VERSION, D.taxonomyVersion, TO].join('\u0000')).digest('hex').slice(0, 24)}`;
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
  // 有摘要的走完整两行；只有 titleZh 的也保留 —— 过去这里只认 summaryZh/summaryEn，
  // 把「标题补上了但摘要没生成」的结果整条丢掉，分类页标题依然是英文。
  const usable = succeeded.filter((r) => {
    const l = r.localized || {};
    return String(l.summaryZh || '').trim() || String(l.summaryEn || '').trim() || String(l.titleZh || '').trim();
  });
  const noContent = succeeded.length - usable.length;
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
  // 同一 (product, facet, term, source, processor_version) 在 taxonomy_assignments 上有唯一键，
  // 而 resultBatchSql 只删 shadow 行。增量轮会命中 11-02 那轮留下的 current 行（例如 9 条
  // title-only 的标签），不先清掉就会在 INSERT 时撞唯一键；product_content 的 current 行不删
  // 则会在激活时与新行同时 current。两处都只清本轮成功的 productId，失败条目保留旧数据。
  if (items.length) {
    const ids = items.map((item) => sqlValue(item.entry.row.product_id)).join(',');
    statements.push(`DELETE FROM product_content WHERE content_source=${sqlValue(`llm:${PROCESSOR_VERSION}`)} AND product_id IN (${ids})`);
    if (!options.contentOnly) statements.push(`DELETE FROM taxonomy_assignments WHERE assignment_source='llm' AND processor_version=${sqlValue(PROCESSOR_VERSION)} AND product_id IN (${ids})`);
  }
  // 规范实现按 writeBatch=25 切批（两条 DELETE 按 IN、content 与 assignments 多行 INSERT、
  // status 多行 upsert）—— 同样的批次形状在这里照搬，避免逐产品写把通道额度打满。
  for (let i = 0; i < items.length; i += runOptions.writeBatch) {
    const batch = resultBatchSql(runId, runOptions, items.slice(i, i + runOptions.writeBatch));
    // --content-only：resultBatchSql 会连带写 primaryCategory + 全部受控分面。本轮只补中文，
    // 不重算归属，所以把标签 INSERT 去掉；正文与状态行照旧。
    statements.push(...(options.contentOnly ? batch.filter((statement) => !/taxonomy_assignments/i.test(statement)) : batch));
  }

  // 分类回写是**独立的写入语义**：正文仍按 `llm:travel-localize-v1`，回写行按
  // `taxonomy-writeback-v1`。`--content-only` 只压掉 resultBatchSql 的全分面重算，
  // 不压这里 —— 增量任务的正文与归属本来就是两件事，回滚也要能分开做。
  let writeback = null;
  if (options.taxonomyWriteback) {
    writeback = buildTaxonomyWriteback(succeeded, { runId, term: TERM });
    statements.push(...writeback.statements);
    const csvPath = options.writebackCsv || path.resolve('.scratch', `taxonomy-writeback-${TO}.csv`);
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    fs.writeFileSync(csvPath, writeback.csv);
    const movedOut = writeback.changes.filter((change) => change.reason === 'model:non-travel').length;
    console.log(`[sql] taxonomy writeback：${writeback.changes.length} 条变更`
      + `（移出 ${movedOut} / 补入 ${writeback.changes.length - movedOut}）→ ${csvPath}`);
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
    contentOnly: Boolean(options.contentOnly),
    taxonomyWriteback: Boolean(options.taxonomyWriteback),
    taxonomyWritebackCount: writeback ? writeback.changes.length : 0,
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
  if (noContent) console.log(`[sql] 跳过 ${noContent} 个「无标题也无摘要」的结果（模型没给出可用译文）`);
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

module.exports = {
  parseArgs, pull, run, buildSql, buildTaxonomyWriteback,
  PROCESSOR_VERSION, WRITEBACK_PROCESSOR_VERSION, PROMPT_VERSION, TERM,
};
