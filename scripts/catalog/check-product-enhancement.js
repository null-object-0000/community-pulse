#!/usr/bin/env node
/**
 * 产品级增强覆盖率巡检（可观测性）。只读。
 *
 * **为什么需要它**：产品级增强曾经从 2026-09-23 断到 10-06 **没人发现** —— 那十几天里
 * `enrichment_runs` 里根本没有对应日期的运行行，而「某天没跑」这件事不发任何信号。日报级增强
 * 早就有 `enhancement-watchdog.yml`（`scripts/check-enhancement.js`），产品级这条链没有，
 * 所以照它的形状补一个：**某天的运行缺失，或覆盖率低于阈值，就报警（退出码 1 → GitHub 通知）**。
 *
 * 判据只读 `enrichment_runs`：run id 由 `stableRunId({date, mode, processorVersion})` 稳定算出，
 * 所以「这一天该有的 run 在不在」是一次按主键的点查。覆盖率的分子分母取运行行自己的成本列
 * （`completed_count / product_count`），与 `finishRunSql` 写进去的口径同源，不另算一套。
 *
 * 用法：
 *   node scripts/catalog/check-product-enhancement.js --channel
 *   node scripts/catalog/check-product-enhancement.js --date 2026-10-05 --mysql-url "mysql://..."
 * 阈值：环境变量 `CP_ENRICHMENT_COVERAGE_MIN`（默认 0.8）。跳过（无描述）计入分母，
 * 因为「覆盖率」问的是「这一天该加工的产品里有多少真拿到了中文」。
 */
const path = require('path');
const { createChannelDb } = require('./mysql-channel.js');
const { openDb } = require('./db-transport.js');
const {
  stableRunId, PROCESSOR_VERSION, MODE,
} = require('./enrich-products.js');
// `sqlValue` 从规范实现取，不从 `enrich-products.js` 取 —— 后者只是**引入**它（第 58 行
// `require('./build-mysql-import.js')`），并没有 re-export。写 `sqlValue` 在那一行的解构里
// 会得到 `undefined`，然后第一次拼 SQL 就抛 `sqlValue is not a function`：
// 一个「本该在整批没跑时报警」的巡检脚本自己崩掉，等于把静默失效又搬到了巡检层。
const { sqlValue } = require('./build-mysql-import.js');

const DEFAULT_THRESHOLD = Number(process.env.CP_ENRICHMENT_COVERAGE_MIN || 0.8);
const DEFAULT_LOOKBACK_DAYS = 3;

function parseArgs(argv) {
  const options = {
    date: null, lookback: DEFAULT_LOOKBACK_DAYS, threshold: DEFAULT_THRESHOLD,
    mysqlUrl: process.env.CATALOG_MYSQL_URL || '', channel: false,
  };
  const booleans = new Set(['--channel']);
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined && !booleans.has(name) ? argv[++index] : inline;
    if (name === '--date') options.date = value;
    else if (name === '--lookback') options.lookback = Number(value);
    else if (name === '--threshold') options.threshold = Number(value);
    else if (name === '--mysql-url') options.mysqlUrl = value;
    else if (name === '--channel') options.channel = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1) {
    throw new Error('--threshold 必须在 0..1');
  }
  if (!Number.isInteger(options.lookback) || options.lookback < 0) throw new Error('--lookback 必须是非负整数');
  return options;
}

/**
 * 与 `scripts/check-enhancement.js` 同一个「宽限期」口径：北京日 D 的产物在北京时间 D+1 中午
 * （D+1 04:00 UTC）之前应当落库。同理 `lookback` 只回看最近几天，避免把远古缺口当成新告警。
 */
function enhancementDue(date, now, lookback = DEFAULT_LOOKBACK_DAYS) {
  const deadline = Date.parse(`${date}T04:00:00Z`) + 86400000;
  return deadline <= now.getTime() && deadline >= now.getTime() - lookback * 86400000;
}

/** 最近 `lookback + 2` 个自然日里，已经过了宽限期的那几天。 */
function dueDates(now = new Date(), lookback = DEFAULT_LOOKBACK_DAYS) {
  const dates = [];
  for (let offset = 0; offset <= lookback + 2; offset += 1) {
    const day = new Date(now.getTime() - offset * 86400000).toISOString().slice(0, 10);
    if (enhancementDue(day, now, lookback)) dates.push(day);
  }
  return dates.sort();
}

/**
 * 纯函数：给运行行的成本列判「是否告警」。缺行 = 整批没跑（09-23..10-06 就是这形状）。
 * 行存在但 `product_count=0`（当天真的没有新增）不算告警 —— 没有东西要加工不是故障。
 */
function evaluateCoverage(run, threshold = DEFAULT_THRESHOLD) {
  if (!run) return { alert: true, reason: '缺运行（该日产品级增强没跑）', covered: 0, total: 0, ratio: null };
  const total = Number(run.product_count || 0);
  const covered = Number(run.completed_count || 0);
  // 进程在 `finishRunSql` 之前死掉时状态停在 running（`finishRunSql` 只在跑完/有残留时才收尾）。
  // 到了宽限期还 running，说明这一批没有正常收尾 —— 与「缺运行」同一种静默失效。
  if (run.status === 'running') {
    return { alert: true, covered, total, ratio: total ? covered / total : null, reason: '运行未收尾（status=running）' };
  }
  if (!total) return { alert: false, reason: '当天没有待加工产品', covered, total, ratio: 1 };
  const ratio = covered / total;
  if (ratio < threshold) {
    return {
      alert: true, covered, total, ratio,
      reason: `覆盖率 ${(ratio * 100).toFixed(1)}% < 阈值 ${(threshold * 100).toFixed(0)}%`
        + `（完成 ${covered} / 共 ${total}，失败 ${run.failed_count || 0}，无描述跳过 ${run.skipped_no_input_count || 0}）`,
    };
  }
  return { alert: false, covered, total, ratio, reason: `覆盖率 ${(ratio * 100).toFixed(1)}%` };
}

function coverageSql(runId) {
  return `SELECT id, status, product_count, completed_count, failed_count, skipped_no_input_count
  FROM enrichment_runs WHERE id = ${sqlValue(runId)}`;
}

async function check(options, db, { log = console.error, now = new Date() } = {}) {
  const dates = options.date ? [options.date] : dueDates(now, options.lookback);
  const results = [];
  for (const date of dates) {
    const runId = stableRunId({ date, mode: MODE, processorVersion: PROCESSOR_VERSION });
    const [row] = await db.select(coverageSql(runId));
    const verdict = evaluateCoverage(row, options.threshold);
    results.push({ date, runId, ...verdict });
    const mark = verdict.alert ? '告警' : '正常';
    log(`[watchdog] ${date} run=${runId} ${mark}：${verdict.reason}`);
  }
  return results;
}

async function main(options) {
  const db = options.channel || !options.mysqlUrl
    ? createChannelDb({ log: (m) => console.error(`[watchdog] ${m}`) })
    : (await openDb({ mysqlUrl: options.mysqlUrl, preferDirect: true })).db;
  try {
    const results = await check(options, db);
    const alerts = results.filter(result => result.alert);
    if (alerts.length) {
      console.error(`[watchdog] ${alerts.length}/${results.length} 天告警：${alerts.map(r => r.date).join(', ')}`);
      process.exitCode = 1;
    }
    return results;
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  main(options).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = {
  parseArgs, enhancementDue, dueDates, evaluateCoverage, coverageSql, check, DEFAULT_THRESHOLD,
};
