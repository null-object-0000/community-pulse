#!/usr/bin/env node
/**
 * vibecafe 回溯回填: 翻页抓 /api/products 全量, 按北京日期过滤, 回填 raw 里 vibecafe 缺失/为空的天
 * 用法: node scripts/backfill_vibecafe.js [START] [END]
 *   START/END 默认 2026-06-02 (平台上线) ~ 2026-09-07
 * 只回填: 文件存在但 results 里没有 vibecafe 源, 或 vibecafe items 为空且 error 的天
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROXY = process.env.COMMUNITY_PULSE_PROXY || 'http://127.0.0.1:7890';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const RAW = path.join(VAULT, '知识', '大家都在做什么', 'raw');
const START = process.argv[2] || '2026-06-02';
const END = process.argv[3] || '2026-09-07';

function fetchPage(cursor) {
  const url = cursor ? `https://vibecafe.ai/api/products?cursor=${encodeURIComponent(cursor)}` : 'https://vibecafe.ai/api/products';
  const args = ['-s', '--max-time', '30', '-H', 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0'];
  if (PROXY) args.push('-x', PROXY);
  args.push(url);
  const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, timeout: 35000 });
  return JSON.parse(out);
}

// 全量抓取
async function fetchAll() {
  let cursor = null, all = [];
  for (let i = 0; i < 200; i++) {
    const d = fetchPage(cursor);
    const prods = d.products || [];
    if (!prods.length) break;
    all = all.concat(prods);
    cursor = d.nextCursor;
    if (!cursor) break;
    await new Promise(r => setTimeout(r, 250));
  }
  return all;
}

// 北京时间日期
function bjDate(iso) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function main() {
  const all = await fetchAll();
  console.error(`全量抓取: ${all.length} 产品`);
  if (!all.length) { console.error('空, 退出'); process.exit(1); }
  const dates = all.map(p => bjDate(p.createdAt)).sort();
  console.error(`覆盖: ${dates[0]} ~ ${dates[dates.length-1]}`);

  // 按北京日期分组
  const byDay = {};
  for (const p of all) {
    const d = bjDate(p.createdAt);
    if (d >= START && d <= END) (byDay[d] = byDay[d] || []).push(p);
  }
  console.error(`日期分组: ${Object.keys(byDay).length} 天`);

  // 回填: 只补缺失/为空的
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
    const items = (byDay[date] || []).map(p => ({
      sourceId: 'vibecafe',
      title: p.name || '',
      url: p.websiteUrl || `https://vibecafe.ai/products/${p.id}`,
      author: (p.owner && (p.owner.name || p.owner.handle)) || '',
      authorUrl: p.owner && p.owner.handle ? `https://vibecafe.ai/u/${p.owner.handle}` : '',
      publishedAt: p.createdAt ? String(p.createdAt).replace(/^\$D/, '') : null,
      summary: p.tagline || '',
      content: p.tagline || '',
      metrics: {},
      tags: ['vibecafe', 'product'],
      externalId: p.id,
      image: (p.imageUrls && p.imageUrls[0]) || p.logoUrl || '',
    }));
    let found = false;
    for (const r of data.results) {
      if (r.sourceId === 'vibecafe') {
        const oldEmpty = !(r.items && r.items.length);
        if (oldEmpty && items.length) { r.items = items; filled++; }
        if (r.error) delete r.error;
        found = true; break;
      }
    }
    if (!found && items.length) {
      data.results.push({ sourceId: 'vibecafe', sourceName: 'VibeCafé 作品', items });
      filled++;
    }
    if (found || items.length) fs.writeFileSync(jf, JSON.stringify(data));
    d.setDate(d.getDate()+1);
  }
  console.error(`回填完成: 扫描 ${scanned} 天, 更新 ${filled} 天`);
}

main().catch(e => { console.error(e); process.exit(1); });
