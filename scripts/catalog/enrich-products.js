#!/usr/bin/env node
/**
 * 产品级 LLM 加工流水线（MySQL 原生，shadow 模式）。
 *
 * 这是 09-14 那份 `enrich-products.js`（随 SQLite 一起删除）的重新落地。存储层从 SQLite/D1 换成
 * MySQL，但**入口门禁、状态机、输入哈希续跑**这三件事是照抄它验证过的设计的；下面每条注释里
 * 标了「为什么」而不是「做了什么」。
 *
 * 与日报增强链的关系：共用 `.agents/skills/community-pulse/scripts/enhance.js` 的
 * `localize()` / 提示词 / 受控词表校验 / `sourceHash`。**这里不写第二套 prompt，也不定第二套词表** ——
 * 分叉出第二套语义正是当初删掉它的原因。日报链在跑，所以对 `enhance.js` 零改动，只调用它导出的函数。
 *
 * 队列口径（2026-09-21 拍板，见 CHANGELOG）：
 *   新增桶   products.first_seen_date = target_date   —— 全局首次出现，互斥、恰好一次
 *   重入臂   终态是 skipped_no_input 且输入哈希已变    —— 「跳过必须可重入」的实现
 *   0 请求   终态且输入哈希未变                        —— 续跑不重发
 * 为什么不用 `product_source_first_seen.first_seen_date`（来源级首见）：输入取的是**全局唯一**的
 * `product_details` 行，边界必须和输入同源，否则「某个新来源又看到它了」会被选中而输入没变，
 * 那次选择只是空转，还污染成本口径。
 * 为什么不用 `last_seen_date` / `product_details.observed_date`：实测它们会被后来的数据改写
 * （2026-09-19 的桶在补进 09-21 数据后从 824→821、817→814），队列因此不可复现：前者重复付费，
 * 后者会让没加工的产品从队列里消失。`first_seen_date` 是 `LEAST` 累积，append-only。
 *
 * 状态与结果（全部 shadow）：
 *   enrichment_runs                每次运行一行，含成本列（0005 迁移）
 *   enrichment_product_status      逐产品状态：pending/running/complete/failed/skipped_no_input
 *   product_content                is_current=0 的双语结果
 *   taxonomy_assignments           assignment_source='llm' + is_current=0
 * **所有输出 `is_current=0`，没有任何「顺手激活 current」的参数** —— 激活是单独的受审操作。
 *
 * 用法：
 *   node scripts/catalog/enrich-products.js --date 2026-09-19 --dry-run
 *   node scripts/catalog/enrich-products.js --date 2026-09-19 --concurrency 20
 *   node scripts/catalog/enrich-products.js --date 2026-09-19 --limit 30 --product-id prd_xxx
 * 连接串取 `--mysql-url` 或环境变量 `CATALOG_MYSQL_URL`。
 *
 * 为什么这一层要跑在**本机**而不是日报 workflow 里：模型网关是 `127.0.0.1:18640`（见 enhance.js
 * 的 BASE），GitHub Actions 到不了；而本机连不上 RDS 的 3306（公司出口重置 TLS 握手），所以
 * 生产运行需要一个到产品库的通道 —— 与「生产写入」是同一件事的两面，属于单独的受审操作。
 * 这一批只到「工具就绪 + 干跑证据」：可复现的验收在 `tests/catalog-enrichment.test.js` 的集成层
 * （真 MySQL 上跑完整状态机，没有可达数据库时自动跳过），真实数据实跑的数字见 CHANGELOG 2026-09-21。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('../../web/shared.js');
const {
  localize: sharedLocalize,
  translationInput,
  sourceHash,
  PROMPT_VERSION,
} = require('../../.agents/skills/community-pulse/scripts/enhance.js');
const { sqlValue, taxonomyRows } = require('./build-mysql-import.js');

const PROCESSOR = 'enhance.localize';
const PROCESSOR_VERSION = 'catalog-localize-v1';
const MODE = 'shadow';
// 门禁判据用仓库既有口径：`enhance.js` 的 `translationInput(desc)` 为空即视为无证据。
// 它按仓库自己的 `plainDescription` 剥掉 markdown 链接/图片/裸 URL，所以「描述只有一条链接」
// 也算无证据 —— 这与日报链的判据是同一个函数，不是又一次口径分叉。
function hasEvidence(desc) {
  return translationInput(desc).length > 0;
}

function parseArgs(argv) {
  const options = {
    date: null,
    mysqlUrl: process.env.CATALOG_MYSQL_URL || '',
    concurrency: 5,
    mode: MODE,
    processorVersion: PROCESSOR_VERSION,
    dryRun: false,
    resume: true,
    reentry: true,
    retryFailed: false,
    limit: 0,
    productId: null,
    out: null,
    sqlOut: null,
    quiet: false,
    channel: false,
  };
  const booleans = new Set(['--dry-run', '--resume', '--no-resume', '--no-reentry', '--retry-failed', '--quiet', '--channel']);
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined && !booleans.has(name) ? argv[++index] : inline;
    if (name === '--date') options.date = value;
    else if (name === '--mysql-url') options.mysqlUrl = value;
    else if (name === '--concurrency') options.concurrency = Number(value);
    else if (name === '--mode') options.mode = value;
    else if (name === '--processor-version') options.processorVersion = value;
    else if (name === '--product-id') options.productId = value;
    else if (name === '--limit') options.limit = Number(value);
    else if (name === '--out') options.out = path.resolve(value);
    else if (name === '--sql-out') options.sqlOut = path.resolve(value);
    else if (name === '--dry-run') options.dryRun = true;
    else if (name === '--resume') options.resume = true;
    else if (name === '--no-resume') options.resume = false;
    else if (name === '--no-reentry') options.reentry = false;
    else if (name === '--retry-failed') options.retryFailed = true;
    else if (name === '--quiet') options.quiet = true;
    else if (name === '--channel') options.channel = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date || '')) throw new Error('--date YYYY-MM-DD is required');
  // 只接受 shadow：激活 current 是单独的受审操作，不留「顺手切换」的开关。
  if (options.mode !== MODE) throw new Error(`only --mode ${MODE} is supported; activation is a separate reviewed operation`);
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 50) {
    throw new Error('--concurrency must be an integer between 1 and 50');
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) throw new Error('--limit must be a non-negative integer');
  if (!options.processorVersion) throw new Error('--processor-version must not be empty');
  // 两条到产品库的路：本机直连（`--mysql-url`，公司出口会重置协议，通常只用于本地 MySQL 验收）
  // 或临时 Worker 通道（`--channel`，生产唯一可用的路）。
  if (!options.channel && !options.mysqlUrl) {
    throw new Error('需要 --mysql-url / CATALOG_MYSQL_URL，或 --channel（临时 Worker 通道）');
  }
  return options;
}

/**
 * 运行 id 稳定可复现：同一天 + 同加工版本 + 同提示词版本 + 同词表版本 = 同一个 run。
 * 这样重复执行同一天是**续跑**（找到既有状态行、按哈希跳过），而不是每次新建一批状态。
 * 版本变化会得到新 run，于是该日重付一次 —— 这是刻意的：改了 prompt 就该重跑。
 */
function stableRunId(options) {
  const key = [options.date, options.mode, options.processorVersion, PROMPT_VERSION, D.taxonomyVersion].join('\u0000');
  return `enr_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

/**
 * 输入哈希覆盖「描述文本 + prompt 版本 + 受控词表版本」。描述文本用 `enhance.js` 自己的
 * `sourceHash`（标题/描述/分区），所以口径与日报链一致；后两维是这一层新增的，因为加工版本
 * 变了就该重跑，而 `sourceHash` 本身看不见版本。
 */
function inputHashFor(input) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([sourceHash(input), PROMPT_VERSION, D.taxonomyVersion]))
    .digest('hex');
}

/**
 * 队列条目的模型输入。**取自 `product_details.item_json`**，不是 `observations` / `source_items`
 * —— 那两张表在 MySQL 里从未被写入过（tests/backfill-issue-entity.test.js 有断言），旧的
 * `loadProducts()` 查询照抄过来只会拿到空集。`product_details` 每个产品恰好一行（320,227 = 320,227），
 * 正是「全局唯一那一行」。
 *
 * `section` 传 **sourceName** 而不是 sourceId：`localize()` 用 `/^Product Hunt\b/i` 判 Product Hunt
 * 并换一段提示词，传 `'producthunt'` 命不中，占日增 85% 的 PH 行会丢掉那段说明。
 */
function localizationInput(row) {
  const item = typeof row.item_json === 'string' ? JSON.parse(row.item_json) : (row.item_json || {});
  const title = String(item.title || row.product_title || '').trim();
  return {
    heading: title,
    title,
    desc: String(item.summary || '').trim(),
    section: String(item.sourceName || ''),
    productId: row.product_id,
  };
}

// ---- SQL 构造 -------------------------------------------------------------------------------
// 队列与状态都是**单条 SELECT**：生产只读通道（worker/catalog-read.mjs）只放行单条 SELECT，
// 而这一层的读取正好只需要三条。

function newBucketSql(date) {
  return `SELECT p.id AS product_id, p.first_seen_date, p.title AS product_title,
       d.observed_date, d.content_score, d.item_json
  FROM products p
  JOIN product_details d ON d.product_id = p.id
  WHERE p.first_seen_date = ${sqlValue(date)}
  ORDER BY p.id`;
}

function runStatusSql(runId) {
  return `SELECT product_id, status, input_hash, attempt_count, model_request_count
  FROM enrichment_product_status
  WHERE enrichment_run_id = ${sqlValue(runId)}`;
}

/**
 * 重入臂：**跨 run** 找 skipped_no_input 的终态行。
 * 为什么跨 run：一个 09-19 因无描述被跳过的产品，等描述在 09-25 补齐时它的 `first_seen_date`
 * 还是 09-19，只有「按输入哈希重新比对」才能让它自己回到队列，不需要人工干预。
 * 为什么只查 skipped：这类行每天只有 30~60 条，全历史累积也小；把 complete 一起拉进来会让
 * 扫描量随天数线性增长，而「描述变好了要不要重跑」是拿到成本曲线之后再定的事。
 */
function reentrySql(options) {
  const statuses = options.retryFailed ? `'skipped_no_input','failed'` : `'skipped_no_input'`;
  return `SELECT s.product_id, s.status AS previous_status, s.input_hash AS previous_input_hash,
       p.first_seen_date, p.title AS product_title, d.observed_date, d.content_score, d.item_json
  FROM enrichment_product_status s
  JOIN enrichment_runs r ON r.id = s.enrichment_run_id
  JOIN products p ON p.id = s.product_id
  JOIN product_details d ON d.product_id = s.product_id
  WHERE s.status IN (${statuses})
    AND r.processor = ${sqlValue(PROCESSOR)}
    AND r.processor_version = ${sqlValue(options.processorVersion)}
    AND r.prompt_version = ${sqlValue(PROMPT_VERSION)}
    AND s.product_id NOT IN (SELECT fresh.id FROM products fresh WHERE fresh.first_seen_date = ${sqlValue(options.date)})
  ORDER BY s.product_id`;
}

function seedSql() {
  const statements = [];
  // 受控词表必须先落库：taxonomy_assignments 有外键指向 taxonomy_terms(facet,id)，
  // 词表没种子的话第一批 LLM 标签会整批插入失败。幂等（ON DUPLICATE KEY UPDATE）。
  const terms = taxonomyRows();
  const primary = D.categories.map((category, index) => ['primaryCategory', category.id, null, category.labelZh, category.labelEn, index, 1]);
  const rows = [...primary, ...terms];
  const columns = '(facet,id,parent_id,label_zh,label_en,sort_order,active)';
  const upsert = `ON DUPLICATE KEY UPDATE parent_id=VALUES(parent_id), label_zh=VALUES(label_zh),
    label_en=VALUES(label_en), sort_order=VALUES(sort_order), active=VALUES(active)`;
  for (let index = 0; index < rows.length; index += 200) {
    const chunk = rows.slice(index, index + 200)
      .map(row => `(${row.map(sqlValue).join(',')})`).join(',');
    statements.push(`INSERT INTO taxonomy_terms ${columns} VALUES ${chunk} ${upsert}`);
  }
  return statements;
}

function startRunSql(options, runId) {
  return `INSERT INTO enrichment_runs
    (id, kind, processor, processor_version, prompt_version, target_date, mode, status, started_at)
  VALUES (${sqlValue(runId)}, 'catalog-product', ${sqlValue(PROCESSOR)}, ${sqlValue(options.processorVersion)},
    ${sqlValue(PROMPT_VERSION)}, ${sqlValue(options.date)}, ${sqlValue(options.mode)}, 'running', CURRENT_TIMESTAMP(3))
  ON DUPLICATE KEY UPDATE status='running', started_at=COALESCE(started_at, CURRENT_TIMESTAMP(3)),
    completed_at=NULL, error=NULL, prompt_version=VALUES(prompt_version), target_date=VALUES(target_date),
    mode=VALUES(mode)`;
}

/** 入队：状态行先落 'pending'，并且**重置 attempt/request 之外的终态痕迹**。 */
function queueStatusSql(runId, entries) {
  const columns = '(enrichment_run_id, product_id, status, input_hash, error, completed_at)';
  const upsert = `ON DUPLICATE KEY UPDATE status='pending', input_hash=VALUES(input_hash),
    error=NULL, completed_at=NULL, updated_at=CURRENT_TIMESTAMP(3)`;
  const statements = [];
  for (let index = 0; index < entries.length; index += 200) {
    const chunk = entries.slice(index, index + 200)
      .map(entry => `(${sqlValue(runId)}, ${sqlValue(entry.row.product_id)}, 'pending', ${sqlValue(entry.inputHash)}, NULL, NULL)`)
      .join(',');
    statements.push(`INSERT INTO enrichment_product_status ${columns} VALUES ${chunk} ${upsert}`);
  }
  return statements;
}

/**
 * 门禁跳过：写成**独立终态** `skipped_no_input`，不是 failed —— 失败要重试、要计入失败率，
 * 跳过不要。attempt_count / model_request_count 显式留 0，所以「无描述产品零模型请求」是按
 * 状态计数读出来的，不是读代码分支推断的。
 */
function skipStatusSql(runId, entries) {
  const columns = '(enrichment_run_id, product_id, status, input_hash, error, completed_at)';
  const upsert = `ON DUPLICATE KEY UPDATE status='skipped_no_input', input_hash=VALUES(input_hash),
    error=NULL, completed_at=CURRENT_TIMESTAMP(3), updated_at=CURRENT_TIMESTAMP(3)`;
  const statements = [];
  for (let index = 0; index < entries.length; index += 200) {
    const chunk = entries.slice(index, index + 200)
      .map(entry => `(${sqlValue(runId)}, ${sqlValue(entry.row.product_id)}, 'skipped_no_input', ${sqlValue(entry.inputHash)}, NULL, CURRENT_TIMESTAMP(3))`)
      .join(',');
    statements.push(`INSERT INTO enrichment_product_status ${columns} VALUES ${chunk} ${upsert}`);
  }
  return statements;
}

function markRunningSql(runId, productId) {
  return `UPDATE enrichment_product_status SET status='running', attempt_count=attempt_count+1,
    started_at=CURRENT_TIMESTAMP(3), completed_at=NULL, error=NULL, updated_at=CURRENT_TIMESTAMP(3)
  WHERE enrichment_run_id=${sqlValue(runId)} AND product_id=${sqlValue(productId)}`;
}

function contentSource(options) {
  return `llm:${options.processorVersion}`;
}

/**
 * 一个产品的成功结果。三条纪律：
 * ① `product_content.created_at` **不写值**，用列默认的 `CURRENT_TIMESTAMP(3)` —— 旧实现写的是
 *    `new Date().toISOString()`（带 T/Z 的字面量），MySQL 的 DATETIME(3) 收不了。
 * ② 先 DELETE 自己的旧 shadow 行再 INSERT：`product_content` 的主键含 created_at，
 *    `taxonomy_assignments` 有 (product_id,facet,term_id,source,processor_version) 唯一键，
 *    不删就会在重跑时撞键。
 * ③ 每一行都显式 `is_current=0`：这是 shadow 模式的唯一保证，读路径只认 is_current=1。
 */
function resultSql(runId, options, entry, localized, requestCount) {
  const row = entry.row;
  const source = contentSource(options);
  // zh-CN 的标题是**原标题**，不是译文：`localize()` 产出的是 `summaryZh`（中文摘要）与
  // `titleEn`（英文标题），中文标题本来就有，没有 `titleZh` 这个字段。
  const titleZh = localized.titleZh || entry.input.title || '';
  const titleEn = localized.titleEn || entry.input.title || '';
  const statements = [
    `DELETE FROM product_content WHERE product_id=${sqlValue(row.product_id)}
      AND content_source=${sqlValue(source)} AND is_current=0`,
    `INSERT INTO product_content (product_id, locale, title, summary, content_source, enrichment_run_id, is_current)
      VALUES (${sqlValue(row.product_id)}, 'zh-CN', ${sqlValue(titleZh)},
        ${sqlValue(localized.summaryZh || '')}, ${sqlValue(source)}, ${sqlValue(runId)}, 0)`,
    `INSERT INTO product_content (product_id, locale, title, summary, content_source, enrichment_run_id, is_current)
      VALUES (${sqlValue(row.product_id)}, 'en', ${sqlValue(titleEn)},
        ${sqlValue(localized.summaryEn || '')}, ${sqlValue(source)}, ${sqlValue(runId)}, 0)`,
    `DELETE FROM taxonomy_assignments WHERE product_id=${sqlValue(row.product_id)}
      AND assignment_source='llm' AND processor_version=${sqlValue(options.processorVersion)} AND is_current=0`,
  ];
  const assignment = (facet, termId) => `INSERT INTO taxonomy_assignments
    (product_id, facet, term_id, assignment_source, confidence, processor_version, enrichment_run_id, is_current)
    VALUES (${sqlValue(row.product_id)}, ${sqlValue(facet)}, ${sqlValue(termId)}, 'llm', NULL,
      ${sqlValue(options.processorVersion)}, ${sqlValue(runId)}, 0)`;
  // confidence 明确留空：模型没有给出可比的置信度，编一个数字比留空更糟。
  statements.push(assignment('primaryCategory', localized.primaryCategory));
  for (const [facet, termIds] of Object.entries(localized.taxonomy || {})) {
    if (!D.taxonomyFacets[facet] || !Array.isArray(termIds)) continue;
    for (const termId of termIds) statements.push(assignment(facet, termId));
  }
  statements.push(`UPDATE enrichment_product_status SET status='complete',
    model_request_count=model_request_count+${Number(requestCount) || 0}, error=NULL,
    completed_at=CURRENT_TIMESTAMP(3), updated_at=CURRENT_TIMESTAMP(3)
    WHERE enrichment_run_id=${sqlValue(runId)} AND product_id=${sqlValue(row.product_id)}`);
  return statements;
}

function failureSql(runId, row, error, requestCount) {
  const message = String(error && (error.stack || error.message) || error).slice(0, 4000);
  return `UPDATE enrichment_product_status SET status='failed', attempt_count=attempt_count+1,
    model_request_count=model_request_count+${Number(requestCount) || 0}, error=${sqlValue(message)},
    completed_at=CURRENT_TIMESTAMP(3), updated_at=CURRENT_TIMESTAMP(3)
    WHERE enrichment_run_id=${sqlValue(runId)} AND product_id=${sqlValue(row.product_id)}`;
}

/**
 * 结束这次运行并把成本落成可读数字。
 *
 * **成本列累加，状态列取最新** —— 这不是随手选的，是「续跑」这个语义逼出来的：
 * 一个 run id 对应「某一天 + 某加工版本」，同一天重跑（续跑、补跑、--retry-failed）都落在同一行。
 * 若成本列也取最新，第二次续跑的 0 请求就会把第一次真实花掉的 630 次请求覆盖成 0 ——
 * 成本曲线会把所有重跑过的日期记成免费（2026-09-21 实测踩到）。
 *   - 累加（成本/工作量）：model_request_count / wall_clock_ms / requested_count / resumed_count
 *     → 派生指标「每条平均耗时 = wall_clock_ms / requested_count」两边都是累计量，自洽
 *   - 最新（结果状态）：product_count / new_product_count / reentry_count /
 *     completed_count / failed_count / skipped_no_input_count
 * summary_json 存**这一次**的完整摘要，所以逐次明细也留得住。
 */
function finishRunSql(runId, summary) {
  const terminal = (summary.failedCount || summary.states.pending || summary.states.running) ? 'failed' : 'complete';
  const error = terminal === 'failed'
    ? `${summary.failedCount} failed, ${summary.states.pending} pending, ${summary.states.running} running`
    : null;
  // runState 是「这个 run 现在是什么状态」（从 enrichment_product_status 数出来的，跨执行稳定）；
  // 没有它的话，一次 0 请求的续跑会把 completed_count 写成 0，而那一列的含义是「这一天有多少条
  // 加工完成」—— 成本记录里「处理了多少产品 / 跳过多少 / 失败几条」正是 brief 要求可读的数字。
  const state = summary.runState || {
    productCount: summary.productCount, completedCount: summary.completedCount,
    failedCount: summary.failedCount, skippedNoInputCount: summary.skippedNoInputCount,
  };
  return `UPDATE enrichment_runs SET status=${sqlValue(terminal)}, completed_at=CURRENT_TIMESTAMP(3),
    error=${sqlValue(error)}, product_count=${state.productCount}, new_product_count=${summary.newProductCount},
    reentry_count=reentry_count+${summary.reentryCount}, requested_count=requested_count+${summary.requestedCount},
    completed_count=${state.completedCount}, failed_count=${state.failedCount},
    skipped_no_input_count=${state.skippedNoInputCount}, resumed_count=resumed_count+${summary.resumedCount},
    model_request_count=model_request_count+${summary.modelRequests},
    wall_clock_ms=wall_clock_ms+${summary.wallClockMs},
    summary_json=${sqlValue(JSON.stringify(summary))}
  WHERE id=${sqlValue(runId)}`;
}

// ---- 数据库 ---------------------------------------------------------------------------------

async function openDatabase(options) {
  if (options.channel) {
    return require('./mysql-channel.js').createChannelDb({ log: message => console.error(message) });
  }
  const mysql = require('mysql2/promise');
  // dateStrings：DATE 列回来的是 'YYYY-MM-DD' 字符串，不是本地时区午夜的 JS Date。
  // 这层只在 SQL 里比日期，但把日期当成字符串读掉了一个「拿 Date 对象和字符串比」的隐患。
  const connection = await mysql.createConnection({ uri: options.mysqlUrl, dateStrings: true });
  return {
    async select(sql) {
      const [rows] = await connection.query(sql);
      return rows;
    },
    async execute(sql) {
      await connection.query(sql);
    },
    // 一个产品的结果是一个整体：拆成 N 次自动提交的话，中途失败会留下「状态 complete 但只有
    // 中文行」这种半成品。打包成一个事务，让「状态」与「内容」要么一起进要么都不进。
    async batch(statements) {
      if (!statements.length) return;
      await connection.beginTransaction();
      try {
        for (const statement of statements) await connection.query(statement);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    },
    async close() { await connection.end(); },
  };
}

/**
 * 开工前的 schema 前置检查。0005 迁移没应用时，`skipped_no_input` 会以
 * 「Data truncated for column 'status'」这种看不懂的形式炸在第一条跳过语句上；这里提前把
 * 该做什么说清楚。成本列同理 —— 缺了它们，运行记录会静默丢掉这一批的主要产出。
 */
async function assertSchema(db) {
  const rows = await db.select(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND ((TABLE_NAME='enrichment_product_status' AND COLUMN_NAME='status')
        OR (TABLE_NAME='enrichment_runs' AND COLUMN_NAME IN
          ('target_date','mode','product_count','new_product_count','reentry_count','requested_count',
           'completed_count','failed_count','skipped_no_input_count','resumed_count','model_request_count',
           'wall_clock_ms','summary_json')))`);
  const byKey = new Map(rows.map(row => [`${row.TABLE_NAME}.${row.COLUMN_NAME}`, row.COLUMN_TYPE]));
  if (!String(byKey.get('enrichment_product_status.status') || '').includes('skipped_no_input')) {
    throw new Error('enrichment_product_status.status 缺 skipped_no_input：先应用 migrations/mysql/0005_enrichment_run_cost.sql');
  }
  const missing = ['target_date', 'mode', 'product_count', 'new_product_count', 'reentry_count', 'requested_count',
    'completed_count', 'failed_count', 'skipped_no_input_count', 'resumed_count', 'model_request_count',
    'wall_clock_ms', 'summary_json'].filter(name => !byKey.has(`enrichment_runs.${name}`));
  if (missing.length) {
    throw new Error(`enrichment_runs 缺成本列 ${missing.join(', ')}：先应用 migrations/mysql/0005_enrichment_run_cost.sql`);
  }
}

/**
 * 组装队列。返回的每一条都已经带好输入与哈希，后面的执行阶段不再读库。
 * 这里的顺序（先算哈希、再比状态、最后过门禁）就是「0 请求」的因果：门禁在有证据判定之前
 * 不会调用模型，续跑在模型被调用之前就已经返回。
 */
function planQueue(options, newRows, statusRows, reentryRows) {
  const previous = new Map(statusRows.map(row => [row.product_id, row]));
  const seen = new Set();
  const pending = [];
  const skipped = [];
  const reentry = [];
  let resumedCount = 0;
  let skippedFailedCount = 0;

  const consider = (row, fromReentry) => {
    const productId = row.product_id;
    if (seen.has(productId)) return;
    if (options.productId && productId !== options.productId) return;
    seen.add(productId);
    const input = localizationInput(row);
    const inputHash = inputHashFor(input);
    // 状态行是**按 run** 存的，而重入臂要跨 run：一个 09-18 被跳过的产品，它那条状态行在
    // 09-18 的 run 里，今天这次运行的 run id 查不到它。所以重入臂必须带上自己那行的
    // previous_status / previous_input_hash，否则每天都会把历史上所有被跳过的产品重新判一遍 ——
    // 结果虽然还是「跳过」（零请求），但会天天重复写状态行，还让每天的门禁计数虚高。
    const before = previous.get(productId) || (fromReentry
      ? { status: row.previous_status, input_hash: row.previous_input_hash }
      : null);
    // 终态且输入未变 → 0 请求续跑。这条必须在门禁之前判：门禁会写状态行，续跑不该写。
    // `--no-resume` 是唯一的例外，而且它**明确会重新付费** —— 只用于「模型换了但 prompt 版本没
    // 动」这种想在同一版本内重跑的场合。默认永远续跑，因为默认重跑等于悄悄把成本翻倍。
    if (options.resume && before && before.input_hash === inputHash
      && (before.status === 'complete' || before.status === 'skipped_no_input')) {
      resumedCount += 1;
      return;
    }
    if (before && before.status === 'failed' && !options.retryFailed) {
      skippedFailedCount += 1;
      return;
    }
    const entry = { row, input, inputHash, fromReentry };
    if (!hasEvidence(input.desc)) {
      skipped.push(entry);
      return;
    }
    if (fromReentry) reentry.push(entry);
    pending.push(entry);
  };

  for (const row of newRows) consider(row, false);
  for (const row of reentryRows) consider(row, true);

  const limited = options.limit > 0 ? pending.slice(0, options.limit) : pending;
  return {
    pending: limited,
    // 门禁统计覆盖**全部候选**，不受 --limit 影响：被跳过的产品本来就不发请求，
    // 让它们全量落成终态才能按状态计数证明「无描述 = 零模型请求」。
    skipped,
    skippedFailedCount,
    resumedCount,
    newProductCount: options.productId ? newRows.filter(row => row.product_id === options.productId).length : newRows.length,
    reentryCount: reentry.length,
  };
}

async function runEnrichment(options, dependencies = {}) {
  const localize = dependencies.localize || sharedLocalize;
  const now = dependencies.now || (() => Date.now());
  const log = options.quiet ? () => {} : (message) => console.error(message);
  const db = dependencies.db || await openDatabase(options);
  const ownsDb = !dependencies.db;
  const startedAt = now();
  const runId = stableRunId(options);
  const executedSql = [];

  const run = async (statement) => {
    if (options.dryRun) { executedSql.push(statement); return; }
    await db.execute(statement);
  };
  const runBatch = async (statements) => {
    if (!statements.length) return;
    if (options.dryRun) { executedSql.push(...statements); return; }
    if (db.batch) await db.batch(statements);
    else for (const statement of statements) await db.execute(statement);
  };

  try {
    await assertSchema(db);
    await run(startRunSql(options, runId));
    await runBatch(seedSql());

    const newRows = await db.select(newBucketSql(options.date));
    const statusRows = await db.select(runStatusSql(runId));
    const reentryRows = options.reentry ? await db.select(reentrySql(options)) : [];
    const plan = planQueue(options, newRows, statusRows, reentryRows);
    log(`[enrich] run=${runId} 新增桶 ${plan.newProductCount} + 重入臂 ${plan.reentryCount} → 待加工 ${plan.pending.length}，`
      + `0 请求续跑 ${plan.resumedCount}，门禁跳过 ${plan.skipped.length}，失败未重试 ${plan.skippedFailedCount}`);

    await runBatch(queueStatusSql(runId, plan.pending));
    await runBatch(skipStatusSql(runId, plan.skipped));

    let cursor = 0;
    let modelRequests = 0;
    let completedCount = 0;
    let failedCount = 0;
    let processed = 0;
    const worker = async () => {
      while (cursor < plan.pending.length) {
        const entry = plan.pending[cursor++];
        let productRequests = 0;
        try {
          const localized = await localize(entry.input, {
            onRequest: () => { productRequests += 1; modelRequests += 1; },
          });
          // markRunning 与结果放同一批：批在写入通道里是一个事务，所以「状态 + 内容」原子落地，
          // 而且通道下每个产品只发一次 POST（分开发是两次）。中断的产品因此停在 `pending` 而不是
          // `running` —— 两者都不是终态，重跑都会重新排队，语义没有区别。
          await runBatch([markRunningSql(runId, entry.row.product_id),
            ...resultSql(runId, options, entry, localized, productRequests)]);
          completedCount += 1;
        } catch (error) {
          await run(failureSql(runId, entry.row, error, productRequests));
          failedCount += 1;
          log(`[enrich] 失败 ${entry.row.product_id}: ${error.message}`);
        }
        processed += 1;
        if (processed % 25 === 0 || processed === plan.pending.length) log(`[enrich] ${processed}/${plan.pending.length}`);
        if (dependencies.onProgress) await dependencies.onProgress({ processed, total: plan.pending.length, modelRequests });
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, plan.pending.length) }, worker));

    const states = {};
    if (options.dryRun) {
      // 干跑不落库，所以状态只能从计划里算；这条要在摘要里显式标出来，别让人误以为续跑也验过了。
      states.pending = 0; states.running = 0;
      states.complete = completedCount; states.failed = failedCount;
      states.skipped_no_input = plan.skipped.length;
    } else {
      for (const row of await db.select(`SELECT status, COUNT(*) AS count FROM enrichment_product_status
        WHERE enrichment_run_id=${sqlValue(runId)} GROUP BY status`)) {
        states[row.status] = Number(row.count);
      }
    }
    const wallClockMs = Math.max(0, Math.round(now() - startedAt));
    // run 的状态（跨执行稳定）：状态表里这个 run 现在有多少条终态。干跑没落库，退回本次计划的数字。
    const runState = options.dryRun ? {
      productCount: plan.pending.length + plan.skipped.length,
      completedCount, failedCount, skippedNoInputCount: plan.skipped.length,
    } : {
      productCount: (states.pending || 0) + (states.running || 0) + (states.complete || 0) + (states.failed || 0) + (states.skipped_no_input || 0),
      completedCount: states.complete || 0,
      failedCount: states.failed || 0,
      skippedNoInputCount: states.skipped_no_input || 0,
    };
    const summary = {
      runId,
      date: options.date,
      mode: options.mode,
      processorVersion: options.processorVersion,
      promptVersion: PROMPT_VERSION,
      taxonomyVersion: D.taxonomyVersion,
      dryRun: options.dryRun,
      statePersisted: !options.dryRun,
      // 口径与成本 —— 这就是这一批的主要产出。
      newProductCount: plan.newProductCount,
      reentryCount: plan.reentryCount,
      // productCount 是这次真正「过了一遍」的产品数（进模型 + 门禁跳过）；
      // skippedFailedCount（失败且没开 --retry-failed）不在里面，它这次没有被处理。
      productCount: plan.pending.length + plan.skipped.length,
      requestedCount: plan.pending.length,
      completedCount,
      failedCount,
      skippedNoInputCount: plan.skipped.length,
      skippedFailedCount: plan.skippedFailedCount,
      resumedCount: plan.resumedCount,
      modelRequests,
      wallClockMs,
      avgMsPerProduct: plan.pending.length ? Math.round(wallClockMs / plan.pending.length) : 0,
      concurrency: options.concurrency,
      states: {
        pending: states.pending || 0, running: states.running || 0,
        complete: states.complete || 0, failed: states.failed || 0,
        skipped_no_input: states.skipped_no_input || 0,
      },
      // 这个 run 的状态（写进 enrichment_runs 的那几个结果列）；上面那些是**本次执行**的数字。
      runState,
    };
    await run(finishRunSql(runId, summary));

    if (options.sqlOut) {
      fs.writeFileSync(options.sqlOut, `${executedSql.join(';\n')};\n`);
      summary.sqlStatements = executedSql.length;
    }
    if (options.out) fs.writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  } finally {
    if (ownsDb) await db.close();
  }
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  runEnrichment(options).then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    if (summary.failedCount || summary.states.pending || summary.states.running) process.exitCode = 1;
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  PROCESSOR,
  PROCESSOR_VERSION,
  parseArgs,
  stableRunId,
  inputHashFor,
  localizationInput,
  hasEvidence,
  planQueue,
  newBucketSql,
  reentrySql,
  runStatusSql,
  seedSql,
  resultSql,
  skipStatusSql,
  finishRunSql,
  runEnrichment,
};
