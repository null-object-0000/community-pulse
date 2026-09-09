#!/usr/bin/env node
/**
 * ruanyf issues cursor 续拉: 从最新往回 (desc+cursor), 直到页内最早 < 2026-07-01 停止
 * 与已有 9900 条 (到 6/30) 合并去重
 * 用法: node scripts/sync_ruanyf_cursor.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const OUT = path.join(VAULT, '.agents', 'skills', 'community-pulse', 'data', 'issues', 'ruanyf.json');
const REPO = 'ruanyf/weekly';
const CUTOFF = '2026-07-01T00:00:00Z';

// 用 gh api -i 一次拿 headers + body
function fetchPage(url) {
  const out = execFileSync('gh', ['api', '-i', url], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, timeout: 60000 });
  const sep = out.indexOf('\r\n\r\n');
  const hdrBlock = out.slice(0, sep);
  const body = JSON.parse(out.slice(sep + 4));
  // Link: <...?after=XXX...>; rel="next"
  let next = null;
  const m = hdrBlock.match(/<([^>]+)>;\s*rel="next"/);
  if (m) next = m[1];
  return { body, next };
}

function main() {
  let all = [];
  try { all = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { all = []; }
  const existingIds = new Set(all.map(i => i.id));
  console.error(`已有 ${all.length} 条`);

  let url = `repos/${REPO}/issues?state=all&per_page=100&sort=created&direction=desc`;
  const newItems = [];
  let pages = 0;
  while (pages < 100) {
    let res;
    try { res = fetchPage(url); } catch (e) { console.error(`page 失败: ${e.message}`); break; }
    const batch = res.body;
    if (!batch.length) { console.error('空页, 结束'); break; }
    const earliest = batch[batch.length - 1].created_at;
    for (const it of batch) {
      if (!existingIds.has(it.id) && it.created_at >= CUTOFF) newItems.push(it);
    }
    pages++;
    console.error(`page ${pages}: ${batch.length} 条, 最早 ${earliest}, 新收集 ${newItems.length}`);
    if (earliest < CUTOFF || !res.next) { console.error('已到 cutoff 或没有下一页, 停'); break; }
    url = res.next.replace('https://api.github.com/', '');
  }

  const merged = all.concat(newItems);
  const byId = new Map(merged.map(i => [i.id, i]));
  const dedup = [...byId.values()].sort((a, b) => a.created_at < b.created_at ? -1 : 1);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dedup));
  const maxD = dedup.length ? dedup[dedup.length - 1].created_at : 'N/A';
  const minD = dedup.length ? dedup[0].created_at : 'N/A';
  console.error(`合并完成: ${dedup.length} 条 (${minD} ~ ${maxD}) → ${OUT}`);
}

main();
