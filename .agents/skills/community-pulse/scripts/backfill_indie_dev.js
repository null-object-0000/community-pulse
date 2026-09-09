#!/usr/bin/env node
/**
 * chinese-indie-dev 全量重建: 一次读 README, 按日期回填 raw 里所有天的 chinese-indie-dev 字段
 * 该源所有日期都在同一个 README 里, 一次抓取即可覆盖全部历史天
 * 用法: node scripts/backfill_indie_dev.js [START] [END]
 *   START/END 默认 2026-01-01 ~ 2026-09-07
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const RAW = path.join(VAULT, '知识', '大家都在做什么', 'raw');
const START = process.argv[2] || '2026-01-01';
const END = process.argv[3] || '2026-09-07';

// 复用 chinese-indie-dev 模块的解析
const { fetchItems } = require('./sources/chinese-indie-dev');

async function main() {
  // 一次抓取全部 (不传 date), 返回所有日期的 items
  const src = { id: 'chinese-indie-dev', max_items: 100000 };
  let allItems;
  try {
    allItems = await fetchItems(src, {});  // 全部
  } catch (e) {
    console.error(`README 抓取失败: ${e.message}`);
    process.exit(1);
  }
  console.error(`README 解析出 ${allItems.length} 条项目`);

  // 按日期分组 (publishedAt 是 YYYY-MM-DD 前缀)
  const byDay = {};
  for (const it of allItems) {
    const d = it.publishedAt ? it.publishedAt.slice(0, 10) : '';
    if (d >= START && d <= END) (byDay[d] = byDay[d] || []).push(it);
  }
  console.error(`覆盖日期范围: ${Object.keys(byDay).length} 天 (${Math.min(...Object.keys(byDay).map(x=>Number(x.replace(/-/g,''))))} ~ ${Math.max(...Object.keys(byDay).map(x=>Number(x.replace(/-/g,''))))})`);

  // 逐日回填 raw
  let filled = 0;
  const d = new Date(`${START}T00:00:00+08:00`);
  const endD = new Date(`${END}T23:59:59+08:00`);
  while (d <= endD) {
    const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const jf = path.join(RAW, `${date}.json`);
    if (!fs.existsSync(jf)) { d.setDate(d.getDate()+1); continue; }
    let data;
    try { data = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch(e) { d.setDate(d.getDate()+1); continue; }
    const items = byDay[date] || [];
    let found = false;
    for (const r of data.results) {
      if (r.sourceId === 'chinese-indie-dev') {
        if (JSON.stringify(r.items) !== JSON.stringify(items)) { r.items = items; filled++; }
        if (r.error) delete r.error;
        found = true; break;
      }
    }
    if (!found) { data.results.push({ sourceId: 'chinese-indie-dev', sourceName: '中国独立开发者', items }); filled++; }
    fs.writeFileSync(jf, JSON.stringify(data));
    d.setDate(d.getDate()+1);
  }
  console.error(`回填完成: 更新 ${filled} 天`);
}

main().catch(e => { console.error(e); process.exit(1); });
