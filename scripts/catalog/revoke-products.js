#!/usr/bin/env node
/**
 * 按 **product_id** 定向撤销产品行（招聘广告、身份被修正的历史行）。
 *
 * 为什么不是 `revoke-admissions.js`：那个脚本按 `source_items` / `observations` 反查产品，
 * 而这两张表**从来没有被写入过** —— 09-14 的初次迁移和之后的日更导入包只写 7 张表
 * （sources / products / product_routes / product_details / product_source_first_seen /
 * taxonomy_terms / taxonomy_assignments，见 `build-mysql-import.js` 的 TABLES），线上读路径
 * （`worker/catalog-api.mjs`）也只读这 7 张。所以那份 SQL 里的 `@item_id` 恒为 NULL，
 * 每条 DELETE 都匹配不到行 —— 2026-09-16 生成的招聘广告撤销 SQL 从来没生效过，
 * 7 条广告至今仍返回 200（2026-09-18 实测）。
 *
 * 这个脚本只认 product_id，直接删读路径上的 5 张表，并带两道闸：
 *   1. **单来源闸**：`product_source_first_seen` 里这个产品只有一个来源时才删 ——
 *      跨来源观察过的产品整条删掉会丢掉别的来源的合法收录；
 *   2. **重建闸**：本次要导入的（`--range` 范围内的）产品 id 一律不删 —— 否则会把
 *      刚导入的正确行删掉（身份没变、只是地址形态被修的行就属于这种）。
 *
 * `--verify` 会逐个请求线上产品页，只保留真的返回 200 的 id：算出来的 id 必须能在线上
 * 兑现，否则宁可不删（历史 raw 与当初那次导入的输入未必逐字节一致）。
 *
 * 用法：
 *   node scripts/catalog/revoke-products.js --plan .scratch/issue-entity-plan.json \
 *     --range 2026-01-03..2026-09-03 --verify --out .scratch/revoke-entity [--dry-run]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_ORIGIN = 'https://community-pulse.nichangen.workers.dev';

// 布尔开关不取下一个 argv（见 backfill_issue_entity.js 里同一条注释）。
const BOOLEAN_FLAGS = new Set(['--verify', '--dry-run']);

function parseArgs(argv) {
  const options = { out: path.join(ROOT, '.scratch', 'revoke-products'), plan: null, products: [], range: null, verify: false, dryRun: false, origin: process.env.CATALOG_API_ORIGIN || DEFAULT_ORIGIN };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    if (BOOLEAN_FLAGS.has(name)) {
      if (name === '--verify') options.verify = true;
      else options.dryRun = true;
      continue;
    }
    const value = inline === undefined ? argv[++index] : inline;
    if (name === '--out') options.out = path.resolve(value);
    else if (name === '--plan') options.plan = path.resolve(value);
    else if (name === '--product') options.products.push(value);
    else if (name === '--range') options.range = value;
    else if (name === '--origin') options.origin = value;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!options.plan && !options.products.length) throw new Error('需要 --plan 或至少一个 --product');
  return options;
}

/** 计划文件 / 命令行 → 去重后的待撤销产品 id（保留原因，便于复核）。 */
function targets(options) {
  const targets = new Map();
  if (options.plan) {
    const plan = JSON.parse(fs.readFileSync(options.plan, 'utf8'));
    for (const entry of plan.entries || []) {
      if (!entry.oldProductId) continue;
      targets.set(entry.oldProductId, {
        productId: entry.oldProductId,
        reason: entry.reason || 'identity-repair',
        detail: `${entry.date || ''} ${entry.sourceId || ''} #${entry.externalId || ''} ${entry.title || ''}`.trim(),
        before: entry.before || null,
        after: entry.after || null,
      });
    }
  }
  for (const productId of options.products) {
    if (!targets.has(productId)) targets.set(productId, { productId, reason: 'manual', detail: '', before: null, after: null });
  }
  return [...targets.values()];
}

/** 本次导入会（重新）创建的产品 id：这些绝不能删。 */
function survivingProductIds(range) {
  if (!range) return new Set();
  const [start, end] = range.split('..');
  const { collectRows } = require('./build-mysql-import.js');
  const rawRoot = path.join(ROOT, '知识', '大家都在做什么', 'source-raw');
  const collected = collectRows({ start, end, taxonomy: true, rawRoot });
  return new Set((collected.tables.products || []).map((row) => row[0]));
}

/** 线上真的有这个产品页吗（只保留 200）。 */
async function liveProductIds(origin, ids) {
  const live = new Set();
  const missing = [];
  for (const id of ids) {
    let ok = false;
    try {
      const response = await fetch(`${origin}/products/${id}/`, { method: 'GET', redirect: 'manual' });
      ok = response.status === 200;
    } catch { ok = false; }
    if (ok) live.add(id); else missing.push(id);
  }
  return { live, missing };
}

function sqlFor(targets) {
  const lines = [
    '-- 按 product_id 定向撤销（revoke-products.js 生成）',
    '-- 只删线上读路径的 5 张表；单来源闸 @shared <= 1 保证跨来源产品不会被整条删掉。',
    // 列是 utf8mb4_0900_ai_ci，而导入 Worker 的会话默认排序规则是 utf8mb4_general_ci：
    // 拿字面量/用户变量跟这些列比会报 `Illegal mix of collations`（第一次真跑就撞上了，
    // 事务整体回滚、没删掉任何行）。先把会话排序规则对齐到列的那一份。
    'SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci;',
    'START TRANSACTION;',
  ];
  for (const target of targets) {
    lines.push(`-- ${target.reason}: ${target.detail}`);
    if (target.before) lines.push(`--   旧地址 ${target.before.url || '(none)'}${target.before.githubUrl ? ` / ${target.before.githubUrl}` : ''}`);
    if (target.after) lines.push(`--   新地址 ${target.after.url || '(none)'}${target.after.githubUrl ? ` / ${target.after.githubUrl}` : ''}`);
    lines.push(`SET @pid = '${String(target.productId).replace(/'/g, "''")}';`);
    lines.push('SET @shared = (SELECT COUNT(*) FROM product_source_first_seen WHERE product_id = @pid);');
    for (const table of ['product_routes', 'product_details', 'taxonomy_assignments', 'product_source_first_seen']) {
      lines.push(`DELETE FROM ${table} WHERE product_id = @pid AND @shared <= 1;`);
    }
    lines.push('DELETE FROM products WHERE id = @pid AND @shared <= 1;');
  }
  lines.push('COMMIT;');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const candidates = targets(options);
  const surviving = survivingProductIds(options.range);
  const kept = candidates.filter((target) => !surviving.has(target.productId));
  const skippedSurviving = candidates.filter((target) => surviving.has(target.productId));
  let verified = kept;
  let notLive = [];
  if (options.verify) {
    const { live, missing } = await liveProductIds(options.origin, kept.map((target) => target.productId));
    verified = kept.filter((target) => live.has(target.productId));
    notLive = missing;
  }
  const sql = sqlFor(verified);
  const report = {
    version: 'revoke-products-v1', generatedAt: new Date().toISOString(), dryRun: options.dryRun,
    origin: options.origin, verified: options.verify, range: options.range,
    candidates: candidates.length, targets: verified.length,
    skippedSurviving: skippedSurviving.map((target) => ({ productId: target.productId, detail: target.detail })),
    notLive,
    entries: verified.map((target) => ({ productId: target.productId, reason: target.reason, detail: target.detail })),
  };
  if (!options.dryRun) {
    fs.mkdirSync(options.out, { recursive: true });
    fs.writeFileSync(path.join(options.out, 'revoke.sql'), sql);
    fs.writeFileSync(path.join(options.out, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  console.log(`${options.dryRun ? '[dry-run] ' : ''}待撤销 ${verified.length} 个产品（候选 ${candidates.length}，重建闸挡下 ${skippedSurviving.length}，线上不存在 ${notLive.length}）`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
module.exports = { parseArgs, targets, survivingProductIds, sqlFor, liveProductIds };
