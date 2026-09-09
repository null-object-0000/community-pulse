#!/usr/bin/env node
/**
 * issues 全量同步: 从最老往最新拉, 翻到底为止 (不设 cutoff)
 * 存到 data/issues/<repo>.json (结构化数组, 每页100)
 * 用法: node scripts/sync_issues_full.js [repo]  (repo 可选: ruanyf|hellogithub, 默认两个)
 * 断点续传: 已存在的结果文件会从当前长度续拉 (按页续)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROXY = process.env.COMMUNITY_PULSE_PROXY === undefined ? 'http://127.0.0.1:7890' : process.env.COMMUNITY_PULSE_PROXY;
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const OUT_DIR = path.join(VAULT, '.agents', 'skills', 'community-pulse', 'data', 'issues');
const REPOS = {
  ruanyf: 'ruanyf/weekly',
  hellogithub: '521xueweihan/HelloGitHub',
};
const PER_PAGE = 100;
const MAX_PAGES = 200; // 单 repo 最多 20000 条, 防失控

function ghJson(url) {
  const args = ['api', url];
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, timeout: 60000 });
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`gh api 失败: ${e.message}`);
  }
}

function sync(name, repo, outFile) {
  // 断点: 已有数据则续拉
  let all = [];
  if (fs.existsSync(outFile)) {
    try { all = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { all = []; }
  }
  const startPage = Math.floor(all.length / PER_PAGE) + 1;
  console.error(`[${name}] ${repo} 全量拉取 (已有 ${all.length} 条, 从第 ${startPage} 页续)...`);

  let page = startPage;
  let emptyStreak = 0;
  while (page <= MAX_PAGES) {
    const url = `repos/${repo}/issues?state=all&per_page=${PER_PAGE}&sort=created&direction=asc&page=${page}`;
    let batch;
    try {
      batch = ghJson(url);
    } catch (e) {
      console.error(`  page ${page} 失败: ${e.message}, 重试...`);
      // 简单重试 3 次
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        try { batch = ghJson(url); ok = true; } catch (e2) { console.error(`    重试${i+1}失败: ${e2.message}`); }
      }
      if (!ok) { console.error(`  放弃 page ${page}, 断点保存`); break; }
    }
    if (!batch.length) { emptyStreak++; if (emptyStreak >= 2) { console.error(`  连续空页, 到底了`); break; } continue; }
    emptyStreak = 0;
    all = all.concat(batch);
    if (page % 10 === 0) console.error(`  page ${page}, 累计 ${all.length} 条`);
    // 每 20 页存一次, 防中断丢进度
    if (page % 20 === 0) {
      fs.writeFileSync(outFile, JSON.stringify(all));
      console.error(`  检查点保存: ${all.length} 条`);
    }
    page++;
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(all));
  const dates = all.length ? all.map(i => i.created_at) : [];
  const minD = dates.length ? dates.reduce((a, b) => a < b ? a : b) : 'N/A';
  const maxD = dates.length ? dates.reduce((a, b) => a > b ? a : b) : 'N/A';
  console.error(`[${name}] 完成: ${all.length} 条 (${minD} ~ ${maxD}) → ${outFile}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const only = process.argv[2];
const targets = only ? [[only, REPOS[only]]].filter(x => x[1]) : Object.entries(REPOS);
if (!targets.length) { console.error(`未知 repo: ${only}, 可选 ${Object.keys(REPOS).join('|')}`); process.exit(1); }
for (const [name, repo] of targets) {
  try {
    sync(name, repo, path.join(OUT_DIR, `${name}.json`));
  } catch (e) {
    console.error(`[${name}] 同步异常: ${e.message}`);
  }
}
console.error('全部完成');
