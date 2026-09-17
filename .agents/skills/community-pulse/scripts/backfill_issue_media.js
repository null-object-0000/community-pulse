#!/usr/bin/env node
/**
 * 回填历史日报里「投稿正文的截图」：
 *
 *   ① 把正文里的插图补进 `images`（原始配图层）—— 与 `source_raw_items.js` 的 issueItems 同一套
 *      规则（`issue-media.js` 的 `issueImages`），离线读 `content` 现算，不重跑 collect、不联网。
 *   ② 从已写好的简介里删掉图片残骸（`<img … src=" />`、`!Image` 这类 alt 文字）。
 *      **不重算历史简介**：那是当时解析规则的结果，用今天的规则重算会顺带改写大量与图片无关的行。
 *
 * 同时清理已发布的 Markdown（raw/<date>.md 的 `>` 摘要行）与 final/<date>.md（可见摘要行 +
 * 隐藏的 devtrends-i18n 元数据里的 summaryZh）。
 *
 *   node scripts/backfill_issue_media.js --dry-run
 *   node scripts/backfill_issue_media.js --start 2026-01-01 --end 2026-09-16
 *
 * 只改这三处，其它字段逐字节不变；跑完 `npm run build` 重建站点数据。
 */
const fs = require('node:fs');
const path = require('node:path');
const { issueImages, stripImageResidue } = require('./issue-media');
const { descriptionFromIssue } = require('./issue-description');

const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const RAW_DIR = path.join(VAULT, '知识', '大家都在做什么', 'raw');
const FINAL_DIR = path.join(VAULT, '知识', '大家都在做什么', 'final');
// 只有这两个来源的行是「投稿正文 → item」，其它来源的 content 里没有作者贴的插图。
const ISSUE_SOURCES = new Set(['weekly-issues', 'hellogithub-issues']);

const args = process.argv.slice(2);
const getArg = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const dryRun = args.includes('--dry-run');
const start = getArg('--start') || '0000-00-00';
const end = getArg('--end') || '9999-99-99';
const inRange = (date) => date >= start && date <= end;

// Markdown 里只删残骸、不动换行与其它空白。
const MD_STRIP = /<img\b[^>]*\/?>|<img\b[^>]*?\bsrc\s*=\s*"[\s/]*|!\[[^\]]{0,30}\]\([^)]*\)|(^|\s)![^\s!，。：；、）】]{1,20}(?=\s|$|[\u4e00-\u9fff])/g;
const cleanMarkdown = (text) => text
  .split('\n')
  .map((line) => {
    const next = line.replace(MD_STRIP, ' ');
    // 只在真的删掉残骸的行上收敛空白，避免动到正文里本来就有的空格（代码块、对齐文本）。
    return next === line ? line : next.replace(/[ \t]{2,}/g, ' ').trimEnd();
  })
  .join('\n');

function patchReport(report) {
  let imageRows = 0, summaryRows = 0;
  for (const result of report.results || []) {
    if (!ISSUE_SOURCES.has(result.sourceId)) continue;
    for (const item of result.items || []) {
      const images = issueImages(item.content);
      const before = Array.isArray(item.images) ? item.images : [];
      if (JSON.stringify(before) !== JSON.stringify(images)) {
        imageRows += 1;
        if (images.length) { item.images = images; item.image = images[0]; }
        else { delete item.images; delete item.image; }
      }
      const summary = String(item.summary || '');
      if (!/<img\b|(^|\s)![^\s]/.test(summary)) continue;
      const cleaned = stripImageResidue(summary);
      // 残骸就是全部内容时（正文只有图），退回今天的解析结果，而不是留下空简介。
      const next = cleaned || descriptionFromIssue(item.content);
      if (next && next !== summary) { item.summary = next; summaryRows += 1; }
    }
  }
  return { imageRows, summaryRows };
}

// final/<date>.md 的隐藏元数据：<!-- devtrends-i18n:<base64> -->，里面也有 summaryZh。
function patchFinalMarkdown(text) {
  let cleaned = cleanMarkdown(text);
  cleaned = cleaned.replace(/<!--\s*devtrends-i18n:([A-Za-z0-9+/=]+)\s*-->/g, (whole, base64) => {
    let meta;
    try { meta = JSON.parse(Buffer.from(base64, 'base64').toString('utf8')); } catch { return whole; }
    let touched = false;
    for (const key of ['summaryZh', 'summary']) {
      if (typeof meta[key] !== 'string') continue;
      const next = stripImageResidue(meta[key]);
      if (next && next !== meta[key]) { meta[key] = next; touched = true; }
    }
    if (!touched) return whole;
    return `<!-- devtrends-i18n:${Buffer.from(JSON.stringify(meta), 'utf8').toString('base64')} -->`;
  });
  return cleaned;
}

function main() {
  const dates = fs.readdirSync(RAW_DIR).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, -5)).filter(inRange).sort();
  let reports = 0, imageRows = 0, summaryRows = 0, markdowns = 0, finals = 0;
  for (const date of dates) {
    const jsonPath = path.join(RAW_DIR, `${date}.json`);
    const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const patch = patchReport(report);
    if (patch.imageRows || patch.summaryRows) {
      reports += 1; imageRows += patch.imageRows; summaryRows += patch.summaryRows;
      if (!dryRun) fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    }
    const mdPath = path.join(RAW_DIR, `${date}.md`);
    if (fs.existsSync(mdPath)) {
      const text = fs.readFileSync(mdPath, 'utf8');
      const next = cleanMarkdown(text);
      if (next !== text) { markdowns += 1; if (!dryRun) fs.writeFileSync(mdPath, next); }
    }
    const finalPath = path.join(FINAL_DIR, `${date}.md`);
    if (fs.existsSync(finalPath)) {
      const text = fs.readFileSync(finalPath, 'utf8');
      const next = patchFinalMarkdown(text);
      if (next !== text) { finals += 1; if (!dryRun) fs.writeFileSync(finalPath, next); }
    }
  }
  console.log(`${dryRun ? '[dry-run] ' : ''}扫描 ${dates.length} 期日报：`
    + `${reports} 期 JSON 有改动（补插图 ${imageRows} 行 / 清简介残骸 ${summaryRows} 行）、`
    + `${markdowns} 个 raw .md、${finals} 个 final .md`);
}

main();