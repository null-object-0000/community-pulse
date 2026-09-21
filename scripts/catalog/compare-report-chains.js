#!/usr/bin/env node
/**
 * 新旧两条链的**离线逐期比较**（第二批「发布层」的验收材料）。
 *
 * 旧链：`raw/<date>.json` → `admitReport`（渲染期重算准入）
 * 新链：`report_items`（冻结的发布行）→ `deriveReportFromRecord`
 * 之后两步（合并 `final/*.md`、图片本地化、渲染）两边共用，所以差异只可能来自这三处：
 *   ① 外键筛掉的行（product_id 不在产品库里的历史行）
 *   ② 准入从「渲染期重算」变成「写入时冻结」
 *   ③ 记录重建 `results[]` 时的分组与顺序
 *
 * 跑完给出「哪些期完全一致 / 差异属于哪一类」，差异必须能逐条解释才允许切链。
 *
 * 用法：node scripts/catalog/compare-report-chains.js [--dates 2026-09-20,...] [--out FILE]
 */
const fs = require('node:fs');
const path = require('node:path');
const D = require('../../web/shared.js');
const { collectRows } = require('./build-mysql-import.js');
const { buildReportRecord } = require('./build-report-record.js');
const { deriveReportFromRecord, diffReportObjects } = require('./derive-report.js');
const { admitReport } = require('../../.agents/skills/community-pulse/scripts/issue-admission.js');

const ROOT = path.resolve(__dirname, '..', '..');
const RAW_DIR = path.join(ROOT, '知识', '大家都在做什么', 'raw');
const RAW_ROOT = path.join(ROOT, '知识', '大家都在做什么', 'source-raw');

function parseArgs(argv) {
  const options = { dates: null, out: null, quiet: false };
  const booleans = new Set(['--quiet']);
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined && !booleans.has(name) ? argv[++index] : inline;
    if (name === '--dates') options.dates = value.split(',').filter(Boolean);
    else if (name === '--out') options.out = path.resolve(value);
    else if (name === '--quiet') options.quiet = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

function allDates() {
  return fs.readdirSync(RAW_DIR).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map(name => name.slice(0, 10)).sort();
}

function compareReportChains(options = {}) {
  const dates = options.dates || allDates();
  // 产品库的投影：记录写入时会按外键筛掉「不在 products 里」的行，这里用同一份投影模拟，
  // 否则比出来的差异里会混进「离线没有库」这个假象。
  const collected = collectRows({ start: '2025-01-01', taxonomy: false, sources: null, rawRoot: RAW_ROOT });
  const known = new Set(collected.tables.products.map(row => row[0]));

  const identical = [];
  const differing = [];
  for (const date of dates) {
    const raw = JSON.parse(fs.readFileSync(path.join(RAW_DIR, `${date}.json`), 'utf8'));
    const oldReport = admitReport(raw);
    const record = buildReportRecord(raw, date);
    const keptItems = record.items.filter(item => known.has(item.productId));
    const droppedItems = record.items.filter(item => !known.has(item.productId));
    const newReport = deriveReportFromRecord({ ...record, items: keptItems });
    const differences = diffReportObjects(oldReport, newReport);
    if (!differences.length) { identical.push(date); continue; }
    differing.push({
      date,
      droppedByForeignKey: droppedItems.length,
      droppedSamples: droppedItems.slice(0, 3).map(item => ({ productId: item.productId, title: item.snapshot?.title || null })),
      differences,
    });
  }
  return {
    dates: dates.length,
    identical: identical.length,
    identicalDates: identical,
    differing: differing.length,
    // 差异按「路径」归类：切链前每一类都要能解释
    byPath: differing.flatMap(entry => entry.differences.map(diff => diff.path))
      .reduce((counts, key) => ({ ...counts, [key]: (counts[key] || 0) + 1 }), {}),
    details: differing,
  };
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const result = compareReportChains(options);
  if (options.out) fs.writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
  const brief = {
    dates: result.dates, identical: result.identical, differing: result.differing,
    byPath: result.byPath,
    worst: result.details.slice().sort((a, b) => b.droppedByForeignKey - a.droppedByForeignKey).slice(0, 5)
      .map(entry => ({ date: entry.date, dropped: entry.droppedByForeignKey, paths: entry.differences.map(d => d.path) })),
  };
  console.log(JSON.stringify(brief, null, 2));
  if (!options.quiet && result.identicalDates.length) {
    console.error(`完全一致 ${result.identical} 期：${result.identicalDates.slice(-5).join(', ')} …`);
  }
}

module.exports = { parseArgs, allDates, compareReportChains };
