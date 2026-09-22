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
 * `--apply` 直接把生成的那份 SQL 发给产品库（走 `db-transport.openDb`：直连优先，连不上就
 * 降级到临时 Worker 通道）。本机出口在协议层拦 MySQL，所以本地只会走通道、且需要 Cloudflare
 * 凭据；CI 里由 `catalog-refresh.yml` 的 `revoke_ids` 输入调用 —— 撤销必须排在**导入之后、
 * 快照之前**，顺序错了会把刚删掉的行又写进快照。
 *
 * `--inspect` 撤销前后各读一次产品库现状（`products` / `product_routes` /
 * `product_source_first_seen` 的来源数），把「单来源闸到底挡下了几行」写进报告。**别只看
 * 「SQL 没报错」**：`@shared <= 1` 是在 SQL 里生效的，多来源的行一行都不会删，而 `applied.products`
 * 只是「我发了几条 DELETE」，照样报「成功」—— 2026-09-22 那次报告写「已撤销 13 个产品」，
 * 脚本其实无从知道有几条 DELETE 真的匹配到了行。现在有存活目标时退出码 1。
 *
 * 用法：
 *   node scripts/catalog/revoke-products.js --plan .scratch/issue-entity-plan.json \
 *     --range 2026-01-03..2026-09-03 --verify --out .scratch/revoke-entity [--dry-run] [--inspect] [--apply]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_ORIGIN = 'https://community-pulse.nichangen.workers.dev';

// 布尔开关不取下一个 argv（见 backfill_issue_entity.js 里同一条注释）。
const BOOLEAN_FLAGS = new Set(['--verify', '--dry-run', '--apply', '--inspect']);

function parseArgs(argv) {
  const options = { out: path.join(ROOT, '.scratch', 'revoke-products'), plan: null, products: [], range: null, verify: false, dryRun: false, apply: false, inspect: false, origin: process.env.CATALOG_API_ORIGIN || DEFAULT_ORIGIN };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    if (BOOLEAN_FLAGS.has(name)) {
      if (name === '--verify') options.verify = true;
      else if (name === '--apply') options.apply = true;
      else if (name === '--inspect') options.inspect = true;
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

/**
 * 线上真的有这个产品页吗 —— **只作参考，别拿它当判据**。
 *
 * 产品页有两层缓存：Worker 的 Cache API（键含 CATALOG_VERSION + 渲染版本 + pathname）与
 * Cloudflare 的边缘缓存，`s-maxage` 是 24 小时。撤销之后规范地址仍可能返回 200 —— 那是旧渲染，
 * 2026-09-22 复核时就被它骗过一次（11 个页面看着还活着，其实产品库里的行早就删了）。
 * 反过来，一次 5xx 或网络抖动也不是「不存在」的证据。所以这里只在**明确 404** 时才把目标摘掉，
 * 其余（含探测失败）记进 `unknown` 并保留；真正的存在性判断看 `inspectTargets` 的产品库读数。
 * （真不存在的话 DELETE 本来就是空操作，摘不摘都无所谓。）
 */
async function liveProductIds(origin, ids, fetcher = fetch) {
  const live = new Set();
  const missing = [];
  const unknown = [];
  for (const id of ids) {
    try {
      const response = await fetcher(`${origin}/products/${id}/`, { method: 'GET', redirect: 'manual' });
      if (response.status === 200) live.add(id);
      else if (response.status === 404) missing.push(id);
      else unknown.push(`${id} (HTTP ${response.status})`);
    } catch (error) {
      unknown.push(`${id} (${error?.message || 'fetch failed'})`);
    }
  }
  return { live, missing, unknown };
}

/**
 * 这些 id 现在在产品库里长什么样（只读）。
 *
 * 关键是 `sources`：撤销 SQL 的 `@shared <= 1` 闸就是拿它判断的，多来源的行**一行都不会删**，
 * 而脚本从返回值上看不出这个区别 —— `applied.products` 只是「我发了几条 DELETE」。2026-09-22
 * 那次撤销的报告写「已撤销 13 个产品」，脚本其实无从知道每条 DELETE 有没有匹配到行。结论：
 * 撤销必须能核对结果，不能只看「SQL 没报错」。
 *
 * 通道的 `select` 不接受绑定参数（Worker 直接 `connection.query(text)`），所以 id 是内联的 ——
 * 因此先按 `prd_<24 位十六进制>` 校验，形状不对直接拒绝，不拼进 SQL。
 */
async function inspectTargets(db, ids) {
  const wanted = ids.filter((id) => /^prd_[a-f0-9]{24}$/.test(id));
  if (wanted.length !== ids.length) throw new Error(`product_id 形状不对，拒绝内联进 SQL：${ids.filter((id) => !wanted.includes(id)).join(' ')}`);
  if (!wanted.length) return [];
  const list = wanted.map((id) => `'${id}'`).join(',');
  const rows = await db.select(`SELECT p.id AS id,
      (SELECT COUNT(*) FROM product_routes r WHERE r.product_id = p.id) AS routes,
      (SELECT COUNT(*) FROM product_source_first_seen f WHERE f.product_id = p.id) AS sources,
      (SELECT GROUP_CONCAT(f.source_id ORDER BY f.source_id) FROM product_source_first_seen f WHERE f.product_id = p.id) AS sourceIds
    FROM products p WHERE p.id IN (${list})`);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return wanted.map((id) => {
    const row = byId.get(id);
    return row
      ? { productId: id, exists: true, routes: Number(row.routes || 0), sources: Number(row.sources || 0), sourceIds: String(row.sourceIds || '') }
      : { productId: id, exists: false, routes: 0, sources: 0, sourceIds: '' };
  });
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
  let probeUnknown = [];
  if (options.verify) {
    const { live, missing, unknown } = await liveProductIds(options.origin, kept.map((target) => target.productId));
    // 只摘掉**明确 404** 的：一次网络抖动不该让撤销空跑（2026-09-22 的教训）。
    verified = kept.filter((target) => !missing.includes(target.productId));
    notLive = missing;
    probeUnknown = unknown;
  }
  const sql = sqlFor(verified);
  const report = {
    version: 'revoke-products-v1', generatedAt: new Date().toISOString(), dryRun: options.dryRun,
    origin: options.origin, verified: options.verify, range: options.range, apply: options.apply, inspect: options.inspect,
    candidates: candidates.length, targets: verified.length,
    skippedSurviving: skippedSurviving.map((target) => ({ productId: target.productId, detail: target.detail })),
    notLive, probeUnknown,
    entries: verified.map((target) => ({ productId: target.productId, reason: target.reason, detail: target.detail })),
  };
  // SQL 先落盘再执行：执行失败时那份 SQL 还得留着排查（它是这次撤销唯一的记录）。
  if (!options.dryRun) {
    fs.mkdirSync(options.out, { recursive: true });
    fs.writeFileSync(path.join(options.out, 'revoke.sql'), sql);
  }
  if (options.apply && options.dryRun) throw new Error('--apply 不能和 --dry-run 一起用：dry-run 承诺不碰生产库');
  if ((options.apply || options.inspect) && verified.length) {
    const { openDb } = require('./db-transport.js');
    const opened = await openDb({ log: (message) => console.log(message) });
    try {
      // 撤销前先看清现状：`@shared <= 1` 的单来源闸是在 **SQL 里**生效的，脚本只看得到「发了 N 条
      // DELETE」。2026-09-22 那次就是这样被骗过一次 —— 报告写「已撤销 13 个产品」，线上却有 11 个
      // 产品页仍然 200（多来源的行被闸挡下，一行没删）。所以撤销必须能核对结果。
      report.before = await inspectTargets(opened.db, verified.map((target) => target.productId));
      if (options.apply) {
        await opened.db.execute(sql);
        report.after = await inspectTargets(opened.db, verified.map((target) => target.productId));
        const remaining = report.after.filter((row) => row.exists).map((row) => row.productId);
        report.applied = { transport: opened.transport, products: verified.length, removed: verified.length - remaining.length, remaining };
      }
    } finally {
      await opened.db.close();
    }
  }
  if (!options.dryRun) {
    fs.writeFileSync(path.join(options.out, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  const remaining = report.applied?.remaining?.length ?? 0;
  const label = options.dryRun ? '[dry-run] 待撤销' : (report.applied ? '已撤销' : '待撤销');
  console.log(`${label} ${report.applied ? report.applied.removed : verified.length} 个产品`
    + `（候选 ${candidates.length}，重建闸挡下 ${skippedSurviving.length}，线上不存在 ${notLive.length}`
    + `${report.applied ? `，单来源闸挡下 ${remaining}${remaining ? `：${report.applied.remaining.join(' ')}` : ''}` : ''}）`);
  if (remaining) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
module.exports = { parseArgs, targets, survivingProductIds, sqlFor, liveProductIds, inspectTargets };
