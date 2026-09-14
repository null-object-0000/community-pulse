#!/usr/bin/env node
/** Reapply the current report-level dedupe policy to historical raw/final artifacts. */
const fs = require('fs');
const path = require('path');
const { dedupe, renderMarkdown } = require('../.agents/skills/community-pulse/scripts/collect.js');

const ROOT = path.resolve(__dirname, '..');
const RAW_ROOT = path.join(ROOT, '知识', '大家都在做什么', 'raw');
const FINAL_ROOT = path.join(ROOT, '知识', '大家都在做什么', 'final');

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function sourceName(line) {
  return line.match(/^## (.+?)(?:（\d+\s*条）)?\s*$/)?.[1] || '';
}

function normalizedHeading(value) {
  return String(value || '')
    .replace(/^\[(.*)\]\(https?:\/\/[^)]+\)(?=\s*(?:👤|$))/, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
    .replace(/\s+/g, ' ');
}

function removalQueues(originalResults, removedSet) {
  const queues = new Map();
  for (const result of originalResults) {
    for (const item of result.items || []) {
      const heading = normalizedHeading(`${item.title}${item.author ? ` 👤 ${item.author}` : ''}`);
      const key = `${result.sourceName}\n${heading}`;
      if (!queues.has(key)) queues.set(key, []);
      queues.get(key).push(removedSet.has(item));
    }
  }
  return queues;
}

function rewriteFinalMarkdown(markdown, queues) {
  const lines = markdown.split('\n');
  const output = [];
  const removedBySection = new Map();
  let section = '';
  for (let index = 0; index < lines.length;) {
    const name = sourceName(lines[index]);
    if (name) section = name;
    if (!lines[index].startsWith('### ')) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !lines[end].startsWith('### ') && !lines[end].startsWith('## ')) end += 1;
    const block = lines.slice(index, end);
    const heading = normalizedHeading(lines[index].slice(4));
    const queue = queues.get(`${section}\n${heading}`);
    const remove = queue?.length ? queue.shift() : false;
    if (remove) removedBySection.set(section, (removedBySection.get(section) || 0) + 1);
    else output.push(...block);
    index = end;
  }
  return output.map(line => line.replace(/^## (.+?)（(\d+)\s*条）\s*$/, (whole, name, count) => {
    const removed = removedBySection.get(name) || 0;
    return removed ? `## ${name}（${Number(count) - removed} 条）` : whole;
  })).join('\n');
}

function writePreservingNewline(file, original, updated) {
  const text = original.endsWith('\n') && !updated.endsWith('\n') ? `${updated}\n` : updated;
  fs.writeFileSync(file, text);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const refreshMarkdown = args.includes('--refresh-markdown');
  const start = argValue(args, '--start');
  const end = argValue(args, '--end');
  const dates = fs.readdirSync(RAW_ROOT)
    .map(name => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter(date => date && (!start || date >= start) && (!end || date <= end))
    .sort();
  const changes = [];
  for (const date of dates) {
    const jsonFile = path.join(RAW_ROOT, `${date}.json`);
    const rawMarkdownFile = path.join(RAW_ROOT, `${date}.md`);
    const finalMarkdownFile = path.join(FINAL_ROOT, `${date}.md`);
    const originalJson = fs.readFileSync(jsonFile, 'utf8');
    const report = JSON.parse(originalJson);
    const originalResults = report.results || [];
    const originalItems = originalResults.flatMap(result => result.items || []);
    const originalConsoleError = console.error;
    let dedupedResults;
    try {
      console.error = () => {};
      dedupedResults = dedupe(originalResults);
    } finally {
      console.error = originalConsoleError;
    }
    const kept = new Set(dedupedResults.flatMap(result => result.items || []));
    const removedSet = new Set(originalItems.filter(item => !kept.has(item)));
    const removedCount = removedSet.size;
    if (!removedCount && !refreshMarkdown) continue;
    if (!fs.existsSync(rawMarkdownFile)) throw new Error(`${date}: raw Markdown is missing`);
    const originalRawMarkdown = fs.readFileSync(rawMarkdownFile, 'utf8');
    // Some early backfills populated items but retained an obsolete capture error.
    // JSON items are authoritative; do not let that stale error hide them in Markdown.
    const markdownResults = dedupedResults.map(result => result.items?.length && result.error
      ? { ...result, error: undefined }
      : result);
    const updatedRawMarkdown = renderMarkdown(markdownResults, date, report.trendingPolicy);
    let originalFinalMarkdown = '';
    let updatedFinalMarkdown = '';
    if (removedCount && fs.existsSync(finalMarkdownFile)) {
      originalFinalMarkdown = fs.readFileSync(finalMarkdownFile, 'utf8');
      updatedFinalMarkdown = rewriteFinalMarkdown(
        originalFinalMarkdown,
        removalQueues(originalResults, removedSet),
      );
    }
    changes.push({ date, removedCount, hasFinal: Boolean(originalFinalMarkdown) });
    if (dryRun) continue;
    if (removedCount) {
      report.results = dedupedResults;
      const updatedJson = JSON.stringify(report, null, 2);
      writePreservingNewline(jsonFile, originalJson, updatedJson);
    }
    writePreservingNewline(rawMarkdownFile, originalRawMarkdown, updatedRawMarkdown);
    if (originalFinalMarkdown) writePreservingNewline(finalMarkdownFile, originalFinalMarkdown, updatedFinalMarkdown);
  }
  const total = changes.reduce((sum, change) => sum + change.removedCount, 0);
  console.log(`${dryRun ? '[dry-run] ' : ''}${changes.length} days, ${total} duplicate rows${dryRun ? ' would be' : ''} removed`);
  for (const change of changes) console.log(`${change.date}\t${change.removedCount}\tfinal=${change.hasFinal ? 'yes' : 'no'}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`FATAL ${error.message}`); process.exit(1); }
}

module.exports = { removalQueues, rewriteFinalMarkdown };
