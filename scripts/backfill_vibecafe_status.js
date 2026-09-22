#!/usr/bin/env node
/**
 * 把 VibeCafé 的「作品状态」回填进 raw 日报行（`vibecafeStatus`）。
 *
 * 为什么需要：状态只存在于作品详情页的 RSC payload 里（「作品状态」卡片：策划中 / 开发中 / 已发布），
 * `vibecafeItems` 从 2026-09-22 起才把它挂到行上。而发布准入规则（`issue-admission.js` 的
 * `vibecafe_planning`）是**构建期**读这个字段决定发不发的 —— 历史行不补就挡不住已经收进来的
 * 「策划中」作品（实测 19 行）。raw 是发布层的唯一输入，所以补在 raw 上，source-raw 一个字不动。
 *
 * 边界：只**新增** `vibecafeStatus` 一个字段，其余字节不动；只处理 `vibecafe` 源、且 source-raw
 * 里真的拿得到状态的行（2026-09-03…09-06 的采集没有详情页，拿不到就不写，准入按「未知」放行）。
 *
 * 用法：
 *   node scripts/backfill_vibecafe_status.js --dry-run
 *   node scripts/backfill_vibecafe_status.js --start 2026-09-07 --end 2026-09-21
 */
const fs = require('node:fs');
const path = require('node:path');
const { vibecafeItems } = require('../.agents/skills/community-pulse/scripts/source_raw_items.js');

const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, '知识', '大家都在做什么');
const RAW_DIR = path.join(BASE, 'raw');
const SOURCE_RAW = path.join(BASE, 'source-raw', 'vibecafe');
const SOURCE = { id: 'vibecafe', sourceName: 'VibeCafé' };

function parseArgs(argv) {
  const options = { dryRun: false, start: null, end: null };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--start=')) options.start = arg.slice(8);
    else if (arg.startsWith('--end=')) options.end = arg.slice(6);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** 当天的 source-raw 详情页 → `externalId → 作品状态`。 */
function statusesFor(date) {
  const file = path.join(SOURCE_RAW, `${date}.json`);
  if (!fs.existsSync(file)) return new Map();
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = new Map();
  for (const item of vibecafeItems(document, SOURCE)) {
    if (item.vibecafeStatus) map.set(String(item.externalId), item.vibecafeStatus);
  }
  return map;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dates = fs.readdirSync(RAW_DIR).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, 10)).sort()
    .filter((date) => (!options.start || date >= options.start) && (!options.end || date <= options.end));
  const report = { dryRun: options.dryRun, dates: [], changed: [], skippedNoStatus: 0 };
  for (const date of dates) {
    const statuses = statusesFor(date);
    if (!statuses.size) continue;
    const jsonPath = path.join(RAW_DIR, `${date}.json`);
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    let touched = false;
    for (const result of raw.results || []) {
      if (result.sourceId !== 'vibecafe') continue;
      for (const item of result.items || []) {
        const status = statuses.get(String(item.externalId));
        if (!status) { report.skippedNoStatus += 1; continue; }
        if (item.vibecafeStatus === status) continue;
        item.vibecafeStatus = status;
        touched = true;
        report.changed.push({ date, externalId: item.externalId, status, title: item.title });
      }
    }
    if (!touched) continue;
    report.dates.push(date);
    // 与 collect.js 完全一致的序列化：2 空格缩进、结尾没有换行。
    if (!options.dryRun) fs.writeFileSync(jsonPath, JSON.stringify(raw, null, 2));
  }
  const byStatus = {};
  for (const row of report.changed) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  console.log(JSON.stringify({ ...report, changed: report.changed.length, byStatus }, null, 2));
  console.log(`${options.dryRun ? '[dry-run] ' : ''}补了 ${report.changed.length} 行的 vibecafeStatus，涉及 ${report.dates.length} 个日报日`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = { parseArgs, statusesFor };
