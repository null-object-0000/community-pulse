#!/usr/bin/env node
/**
 * 用 issues 存量回填 raw 的投稿源 (weekly-issues / hellogithub-issues)
 * 存量是"事后完整真值", 回填让 raw 每天 = 当天新增 issue, 与存量一致
 * 用法: node scripts/backfill_sub_from_store.js [START] [END]
 *   START/END 默认 2026-01-01 ~ 2026-09-07
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const RAW = path.join(VAULT, '知识', '大家都在做什么', 'raw');
const STORE = path.join(VAULT, '.agents', 'skills', 'community-pulse', 'data', 'issues');

const START = process.argv[2] || '2026-01-01';
const END = process.argv[3] || '2026-09-07';

// 加载存量, 按 源→北京日期→items 组织
function loadStore(name, sourceId, repo) {
  const d = JSON.parse(fs.readFileSync(path.join(STORE, `${name}.json`), 'utf8'));
  const byDay = {};
  for (const iss of d) {
    const bj = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iss.created_at));
    const date = `${bj.find(p=>p.type==='year').value}-${bj.find(p=>p.type==='month').value}-${bj.find(p=>p.type==='day').value}`;
    if (date < START || date > END) continue;
    const urlMatch = iss.body ? iss.body.match(/https?:\/\/[^\s)\]]+/g) : null;
    const url = urlMatch ? urlMatch[0] : `https://github.com/${repo}/issues/${iss.number}`;
    const clean = (iss.body || '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[*_`>#-]/g, '')
      .replace(/https?:\/\/[^\s)\]]+/g, '')
      .replace(/\s+/g, ' ').trim();
    const segs = clean.split(/\n+/).map(s => s.trim()).filter(s => s.length > 15);
    const item = {
      sourceId,
      title: iss.title || '',
      url,
      author: iss.user ? iss.user.login : '',
      authorUrl: iss.user ? `https://github.com/${iss.user.login}` : '',
      publishedAt: iss.created_at || null,
      summary: segs.length ? segs[0] : clean,
      content: iss.body || '',
      metrics: { comments: iss.comments || 0 },
      tags: sourceId === 'weekly-issues' ? ['ruanyf-weekly', 'submission'] : ['hellogithub', 'submission'],
      externalId: String(iss.number),
      issueUrl: `https://github.com/${repo}/issues/${iss.number}`,
    };
    (byDay[date] = byDay[date] || []).push(item);
  }
  return byDay;
}

const ruanByDay = loadStore('ruanyf', 'weekly-issues', 'ruanyf/weekly');
const hgByDay = loadStore('hellogithub', 'hellogithub-issues', '521xueweihan/HelloGitHub');

// 逐日回填
let filled = 0, files = 0;
const d = new Date(`${START}T00:00:00+08:00`);
const endD = new Date(`${END}T23:59:59+08:00`);
while (d <= endD) {
  const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const jf = path.join(RAW, `${date}.json`);
  if (!fs.existsSync(jf)) { d.setDate(d.getDate()+1); continue; }
  let data;
  try { data = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch(e) { d.setDate(d.getDate()+1); continue; }
  const subs = {
    'weekly-issues': { name: '阮一峰周刊·用户投稿', items: ruanByDay[date] || [] },
    'hellogithub-issues': { name: 'HelloGitHub·用户投稿', items: hgByDay[date] || [] },
  };
  let changed = false;
  for (const r of data.results) {
    if (subs[r.sourceId]) {
      if (JSON.stringify(r.items) !== JSON.stringify(subs[r.sourceId].items)) { r.items = subs[r.sourceId].items; changed = true; }
      delete subs[r.sourceId];
    }
  }
  // 源不存在则追加
  for (const [sid, v] of Object.entries(subs)) {
    data.results.push({ sourceId: sid, sourceName: v.name, items: v.items });
    changed = true;
  }
  if (changed) { fs.writeFileSync(jf, JSON.stringify(data)); filled++; }
  files++;
  d.setDate(d.getDate()+1);
}
console.error(`回填完成: 扫描 ${files} 天, 更新 ${filled} 天`);
