#!/usr/bin/env node
/**
 * vibecafe 缺失源补空: 把 raw 里 results 没有 vibecafe 源的天, 补成显式空数组
 * 目的: 数据自洽 — 无产品的天应显示 items: [] 而非"源缺失"(避免被当成抓漏)
 * 用法: node scripts/fill_vibecafe_empty.js
 */
const fs = require('fs');
const path = require('path');

const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const RAW = path.join(VAULT, '知识', '大家都在做什么', 'raw');
const START = '2026-06-02';
const END = '2026-09-07';

let filled = 0, scanned = 0;
const d = new Date(`${START}T00:00:00+08:00`);
const endD = new Date(`${END}T23:59:59+08:00`);
while (d <= endD) {
  const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const jf = path.join(RAW, `${date}.json`);
  if (!fs.existsSync(jf)) { d.setDate(d.getDate()+1); continue; }
  let data;
  try { data = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch(e) { d.setDate(d.getDate()+1); continue; }
  scanned++;
  let hasVibe = data.results.some(r => r.sourceId === 'vibecafe');
  if (!hasVibe) {
    data.results.push({ sourceId: 'vibecafe', sourceName: 'VibeCafé 作品', items: [] });
    fs.writeFileSync(jf, JSON.stringify(data));
    filled++;
  }
  d.setDate(d.getDate()+1);
}
console.error(`补空完成: 扫描 ${scanned} 天, 补 ${filled} 天 (显式空 vibecafe 源)`);
