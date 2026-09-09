#!/usr/bin/env node
/**
 * issues 存量同步: 从最新往回拉, 直到 created_at < CUTOFF (默认 2026-01-01) 停止
 * 存到 data/issues/ruanyf.json + hellogithub.json (结构化, 每页100)
 * 用法: node sync_issues.js [CUTOFF_DATE]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CUTOFF = process.argv[2] || '2026-01-01';
const PROXY = process.env.COMMUNITY_PULSE_PROXY === undefined ? 'http://127.0.0.1:7890' : process.env.COMMUNITY_PULSE_PROXY;
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const OUT_DIR = path.join(VAULT, '.agents', 'skills', 'community-pulse', 'data', 'issues');
const REPOS = {
  ruanyf: 'ruanyf/weekly',
  hellogithub: '521xueweihan/HelloGitHub',
};

function ghJson(url) {
  const args = ['api', url, '--paginate'];
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, timeout: 120000 });
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`gh api 失败: ${e.message}`);
  }
}

function sync(repo, outFile) {
  console.error(`[${repo}] 拉取中 (截止 ${CUTOFF})...`);
  // 从最新往回翻页, 直到页内最老 issue 早于 cutoff
  let all = [];
  let page = 1;
  let done = false;
  while (!done && page < 200) {
    const url = `repos/${repo}/issues?state=all&per_page=100&sort=created&direction=desc&page=${page}`;
    let batch;
    try { batch = ghJson(url); } catch (e) { console.error(`  page ${page} 失败: ${e.message}`); break; }
    if (!batch.length) break;
    // 该页最老的 (最后一个) issue
    const oldest = batch[batch.length - 1];
    all = all.concat(batch);
    if (oldest.created_at < `${CUTOFF}T00:00:00Z`) {
      // 过滤掉 cutoff 之前的
      all = all.filter(it => it.created_at >= `${CUTOFF}T00:00:00Z`);
      done = true;
      console.error(`  到达 ${oldest.created_at} (早于 ${CUTOFF}), 停止`);
    }
    page++;
    if (page % 5 === 0) console.error(`  ${page} 页, ${all.length} issues`);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(all));
  console.error(`[${repo}] 完成: ${all.length} issues → ${outFile}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, repo] of Object.entries(REPOS)) {
  sync(repo, path.join(OUT_DIR, `${name}.json`));
}
console.error('全部完成');
