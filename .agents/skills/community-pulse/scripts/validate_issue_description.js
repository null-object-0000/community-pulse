#!/usr/bin/env node
/**
 * 用真实的 Issue 存量语料校验 issue-description 的解析质量。
 * 语料在 data/issues/*.json（由 sync_issues_full.js 同步的完整 issue 列表）。
 *
 *   node scripts/validate_issue_description.js [--samples 8]
 */
const fs = require('node:fs');
const path = require('node:path');
const { descriptionFromIssue } = require('./issue-description');

const STORE = path.resolve(__dirname, '../data/issues');
// 走查里用来判定「模板字段泄漏到页面」的同一组特征
const LEAK = /项目地址|项目标题|项目名称|项目描述|项目简介|作品网址|项目网址|类别\s*(?:JS|Rust|Python|TypeScript|Go|Java)|No response/i;

/** 改动前 source_raw_items.js 的做法：整段压平后当简介。 */
function legacySummary(body) {
  return String(body || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>#-]/g, '')
    .replace(/https?:\/\/[^\s)\]]+/g, '')
    .replace(/\s+/g, ' ').trim();
}

function main() {
  const sampleCount = Number(process.argv[process.argv.indexOf('--samples') + 1]) || 6;
  let total = 0, legacyLeak = 0, nextLeak = 0, nextEmpty = 0;
  const samples = [];
  for (const file of fs.readdirSync(STORE).filter(name => name.endsWith('.json'))) {
    const issues = JSON.parse(fs.readFileSync(path.join(STORE, file), 'utf8'));
    for (const issue of issues) {
      const body = issue.body || '';
      if (!body) continue;
      total++;
      const before = legacySummary(body);
      const after = descriptionFromIssue(body);
      if (LEAK.test(before)) {
        legacyLeak++;
        if (LEAK.test(after)) nextLeak++;
        if (!after) nextEmpty++;
        if (samples.length < sampleCount) samples.push({ file, title: issue.title, before: before.slice(0, 110), after: after.slice(0, 110) });
      }
    }
  }
  console.log(`语料: ${total} 条 issue 正文（data/issues/*.json）`);
  console.log(`模板字段泄漏 —— 改动前: ${legacyLeak} (${(100 * legacyLeak / total).toFixed(1)}%)  改动后: ${nextLeak} (${(100 * nextLeak / total).toFixed(2)}%)  解析为空: ${nextEmpty}`);
  console.log('\n样例（仅列改动前泄漏的条目）:');
  for (const s of samples) {
    console.log(`\n  [${s.file}] ${String(s.title).slice(0, 60)}`);
    console.log(`    前: ${s.before}`);
    console.log(`    后: ${s.after}`);
  }
}

main();
