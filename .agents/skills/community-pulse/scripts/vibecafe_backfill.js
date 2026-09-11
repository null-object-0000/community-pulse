#!/usr/bin/env node
/**
 * VibeCafé 回溯: 用 /api/products 分页 API 拉全部历史产品, 按天合并进 raw/*.json
 * 用法: node vibecafe_backfill.js            # 拉全量(6/2至今)
 *       node vibecafe_backfill.js --dry-run  # 只统计不写
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROXY = process.env.COMMUNITY_PULSE_PROXY === undefined ? 'http://127.0.0.1:7890' : process.env.COMMUNITY_PULSE_PROXY;
const API = 'https://vibecafe.ai/api/products';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const RAW = path.join(VAULT, '知识', '大家都在做什么', 'raw');

function apiGet(url) {
  const args = ['-s', '--max-time', '25', '-H', 'Accept: application/json', '-H', 'User-Agent: Mozilla/5.0'];
  if (PROXY) args.push('-x', PROXY);
  args.push(url);
  return JSON.parse(execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 30000 }));
}

// 北京时间日期
function bjDate(iso) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function main() {
  const dry = process.argv.includes('--dry-run');
  const all = [];
  let cursor = null;
  let pages = 0;
  // 翻页拉全部
  while (pages < 200) {
    const url = API + (cursor ? `?cursor=${cursor}` : '');
    const d = apiGet(url);
    const prods = d.products || [];
    if (!prods.length) break;
    all.push(...prods);
    cursor = d.nextCursor;
    pages++;
    if (!cursor) break;
    if (pages % 10 === 0) console.error(`[进度] ${pages} 页, ${all.length} 产品`);
  }
  console.error(`[完成] ${pages} 页, ${all.length} 产品`);

  // 按天分组
  const byDate = {};
  for (const p of all) {
    if (!p.createdAt) continue;
    const d = bjDate(p.createdAt);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push({
      sourceId: 'vibecafe',
      title: p.name || '',
      url: p.websiteUrl || `https://vibecafe.ai/products/${p.id}`,
      author: (p.owner && (p.owner.name || p.owner.handle)) || '',
      authorUrl: p.owner && p.owner.handle ? `https://vibecafe.ai/u/${p.owner.handle}` : '',
      publishedAt: new Date(p.createdAt).toISOString(),
      summary: p.tagline || '',
      content: p.tagline || '',
      metrics: {},
      tags: ['vibecafe', 'product'],
      externalId: p.id,
      image: (p.imageUrls && p.imageUrls[0]) || p.logoUrl || '',
      logo: p.logoUrl || '',
      images: (p.imageUrls || []).filter(Boolean),
    });
  }
  console.error(`[分组] ${Object.keys(byDate).length} 天 (${Object.keys(byDate).sort()[0]} ~ ${Object.keys(byDate).sort().pop()})`);

  if (dry) return;

  // 合并进 raw/*.json (VibeCafé 源插入/替换)
  let merged = 0;
  for (const [date, items] of Object.entries(byDate)) {
    const jf = path.join(RAW, `${date}.json`);
    if (!fs.existsSync(jf)) continue; // 该天没有 raw (如 6/1 前) — 跳过, 不新建
    const data = JSON.parse(fs.readFileSync(jf, 'utf8'));
    // 找 VibeCafé 源, 替换 items (保留其他源)
    let found = false;
    for (const r of data.results) {
      if (r.sourceId === 'vibecafe') { r.items = items; found = true; break; }
    }
    if (!found) data.results.push({ sourceId: 'vibecafe', sourceName: 'VibeCafé 作品', items });
    fs.writeFileSync(jf, JSON.stringify(data));
    merged++;
  }
  console.error(`[合并] ${merged} 天写入 VibeCafé 数据`);
}

main();
