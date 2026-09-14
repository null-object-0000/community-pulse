#!/usr/bin/env node
/**
 * Add the GitHub Trending layer to already-published reports, additively.
 *
 * Why this exists instead of an offline replay of collect.js: the published reports
 * for June–August 2026 were produced by older code and older source-raw content. Today's
 * pipeline does NOT reproduce them. Replaying 2026-07-15 changed far more than Trending:
 * Product Hunt rows dropped from the published 20 to the current max_items of 15, weekly
 * issue summaries were re-normalised, link lines gained a second link, and markdown table
 * conversion changed. A replay would therefore silently rewrite unrelated published
 * history — the opposite of a backfill.
 *
 * So this script is strictly additive. It:
 *   1. reads the published report and its Markdown, byte for byte;
 *   2. converts the archived Trending snapshots with the same converter the pipeline uses
 *      (`source_raw_items.loadItems`) and applies the same novelty/cooldown policy
 *      (`collect.applyTrendingPolicy`) against the same three previous reports;
 *   3. drops any Trending row whose identity already exists in the report, so no existing
 *      row is ever modified, merged or removed;
 *   4. splices the new result entries and Markdown sections in at the position the current
 *      layout uses (before Product Hunt), leaving every other byte untouched by
 *      construction: the new files are built from slices of the originals.
 *
 * Language: the repository-snapshot layer for these days was derived from the published
 * report, so it cannot know the newly added repositories. Trending's own HTML carries the
 * language of every row (`metrics.lang`), which is the same field GitHub renders, so the
 * row's `language` is materialised from there. Stars/forks are measurements, not identity,
 * and are deliberately NOT written as repository facts.
 *
 * Usage:
 *   node backfill_report_trending.js --start 2026-06-22 --end 2026-08-31 --dry-run
 *   node backfill_report_trending.js --report 2026-09-05
 */
const fs = require('fs');
const path = require('path');

const collect = require('./collect.js');
const config = require('../config/sources.json');
const { loadItems } = require('./source_raw_items.js');

const TIMEZONE = 'Asia/Shanghai';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_RAW_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'raw');
const DEFAULT_SOURCE_RAW_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');
const TRENDING_IDS = ['github-trending', 'github-trending-cn'];
const LANGUAGES = {
  typescript: 'typescript', javascript: 'javascript', python: 'python', go: 'go', golang: 'go', rust: 'rust',
  java: 'java-kotlin', kotlin: 'java-kotlin', swift: 'swift', c: 'c-cpp', 'c++': 'c-cpp', cpp: 'c-cpp',
  'c#': 'csharp', csharp: 'csharp', php: 'php', ruby: 'ruby', dart: 'dart',
};

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function has(argv, name) {
  return argv.includes(name);
}

function shiftDate(date, days) {
  return collect.shiftDate(date, days);
}

function targetDates(argv) {
  const single = value(argv, '--report');
  if (single) return [single];
  const start = value(argv, '--start');
  const end = value(argv, '--end');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
    throw new Error('either --report YYYY-MM-DD or both --start/--end YYYY-MM-DD are required');
  }
  const dates = [];
  for (let date = start; date <= end; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

function atomicWrite(file, content) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

// The published report already knows these repositories; adding them again would mean
// editing an existing row, which this script never does.
function publishedIdentities(report) {
  const keys = new Set();
  for (const result of report.results || []) {
    if (TRENDING_IDS.includes(result.sourceId)) continue;
    for (const item of result.items || []) keys.add(collect.itemIdentity(item));
  }
  return keys;
}

function trendingResults(reportDate, options) {
  const observedDate = shiftDate(reportDate, 1);
  const historyReports = collect.recentReports(options.rawRoot, reportDate);
  const published = publishedIdentities(reportOf(options.rawRoot, reportDate));
  const maxItemsBySource = new Map(config.sources.map((source) => [source.id, source.max_items || Infinity]));
  const results = [];
  const missing = [];
  for (const sourceId of TRENDING_IDS) {
    const source = config.sources.find((candidate) => candidate.id === sourceId);
    let loaded;
    try {
      loaded = loadItems(source, {
        date: reportDate,
        observedDate,
        rawRoot: options.sourceRawRoot,
        maxItems: Infinity,
      });
    } catch (error) {
      // The Chinese list is only archived on a minority of days, so a missing snapshot is
      // an expected, recorded absence rather than a failure of the whole day.
      if (!fs.existsSync(path.join(options.sourceRawRoot, sourceId, `${observedDate}.json`))) {
        missing.push(sourceId);
        console.error(`[absent] ${sourceId} ${observedDate}: no archived snapshot`);
        continue;
      }
      throw error;
    }
    const items = [];
    let droppedExisting = 0;
    for (const item of loaded.items) {
      const language = String(item.metrics?.lang || '').trim();
      const key = LANGUAGES[language.toLowerCase()];
      const shaped = key ? { ...item, language } : item;
      if (published.has(collect.itemIdentity(shaped))) { droppedExisting += 1; continue; }
      items.push(shaped);
    }
    results.push({
      sourceId,
      sourceName: source.name,
      sourceRaw: { ...loaded.sourceRaw, droppedAlreadyPublishedCount: droppedExisting },
      items,
    });
  }
  const policy = collect.applyTrendingPolicy(results, { historyReports, maxItemsBySource });
  return { results, policy, observedDate, missing };
}

function reportOf(rawRoot, date) {
  return JSON.parse(fs.readFileSync(path.join(rawRoot, `${date}.json`), 'utf8'));
}

// Insert immediately before Product Hunt, which is where the current layout puts the
// Trending sections. Returns a new array of slices so untouched parts stay byte-identical.
function spliceResults(existing, additions) {
  const index = existing.findIndex((result) => result.sourceId === 'producthunt');
  const at = index >= 0 ? index : existing.length;
  return { head: existing.slice(0, at), tail: existing.slice(at), at };
}

const MD_ANCHOR = /^## Product Hunt/m;

function renderTrendingMarkdown(results, reportDate, policy) {
  const rendered = collect.renderMarkdown(results, reportDate, policy);
  const lines = rendered.split('\n');
  // Drop the synthetic H1 the renderer emits; the published file already has one.
  const body = lines.slice(lines.findIndex((line) => line.startsWith('## ')));
  const continuationAt = body.findIndex((line) => line.startsWith('## GitHub Trending·持续热门'));
  if (continuationAt < 0) return { sections: body.join('\n'), continuation: '' };
  return {
    sections: body.slice(0, continuationAt).join('\n'),
    continuation: body.slice(continuationAt).join('\n'),
  };
}

function spliceMarkdown(original, sections, continuation) {
  const lines = original.split('\n');
  const anchorAt = lines.findIndex((line) => MD_ANCHOR.test(line));
  const sectionLines = sections.split('\n').filter((line, index, all) => !(index === all.length - 1 && line === ''));
  const continuationLines = continuation
    ? continuation.split('\n').filter((line, index, all) => !(index === all.length - 1 && line === ''))
    : [];
  const at = anchorAt >= 0 ? anchorAt : lines.length;
  const head = lines.slice(0, at);
  const tail = lines.slice(at);
  // The whole point of this script is that published prose is not rewritten. `split`/`join`
  // round-trips exactly, so any splice bug that touched head or tail shows up right here
  // instead of silently landing in 71 published files.
  if ([...head, ...tail].join('\n') !== original) {
    throw new Error('markdown splice would modify existing bytes');
  }
  const joined = [
    ...head,
    ...sectionLines,
    '',
    ...tail,
    ...(continuationLines.length ? ['', ...continuationLines] : []),
  ].join('\n');
  return `${joined.split('\n').map((line) => line.trimEnd()).join('\n').trimEnd()}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  const rawRoot = path.resolve(value(argv, '--raw-root') || DEFAULT_RAW_ROOT);
  const sourceRawRoot = path.resolve(value(argv, '--source-raw-root') || DEFAULT_SOURCE_RAW_ROOT);
  const dryRun = has(argv, '--dry-run');
  const summary = { dryRun, dates: 0, updated: 0, skipped: 0, failed: [], addedRows: 0, suppressed: 0, droppedAlreadyPublished: 0 };

  for (const reportDate of targetDates(argv)) {
    const reportFile = path.join(rawRoot, `${reportDate}.json`);
    const markdownFile = path.join(rawRoot, `${reportDate}.md`);
    summary.dates += 1;
    if (!fs.existsSync(reportFile) || !fs.existsSync(markdownFile)) {
      summary.skipped += 1;
      console.error(`[skip] ${reportDate}: report json/md missing`);
      continue;
    }
    const original = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    if ((original.results || []).some((result) => TRENDING_IDS.includes(result.sourceId))) {
      summary.skipped += 1;
      console.error(`[skip] ${reportDate}: already carries a trending layer`);
      continue;
    }
    try {
      const { results, policy, observedDate } = trendingResults(reportDate, { rawRoot, sourceRawRoot });
      const added = results.reduce((total, result) => total + result.items.length, 0);
      if (!added && !policy.continuedItems.length) {
        summary.skipped += 1;
        console.error(`[skip] ${reportDate}: no snapshot rows survived (observed ${observedDate})`);
        continue;
      }
      const { head, tail } = spliceResults(original.results || [], results);
      if (JSON.stringify([...head, ...tail]) !== JSON.stringify(original.results || [])) {
        throw new Error('result splice would modify existing entries');
      }
      const nextResults = [...head, ...results, ...tail];
      const nextReport = { ...original, results: nextResults, ...(policy ? { trendingPolicy: policy } : {}) };
      const originalMarkdown = fs.readFileSync(markdownFile, 'utf8');
      const rendered = renderTrendingMarkdown(results, reportDate, policy);
      const nextMarkdown = spliceMarkdown(originalMarkdown, rendered.sections, rendered.continuation);

      if (dryRun) {
        console.error(`[dry] ${reportDate} (observed ${observedDate}): +${added} rows `
          + `(${results.map((result) => `${result.sourceId}=${result.items.length}`).join(', ')}), `
          + `${policy.suppressedCount} in cooldown, ${policy.continuedItems.length} continuation, `
          + `md ${originalMarkdown.length}→${nextMarkdown.length} bytes`);
      } else {
        atomicWrite(reportFile, `${JSON.stringify(nextReport, null, 2)}\n`);
        atomicWrite(markdownFile, nextMarkdown);
        console.error(`[ok] ${reportDate} (observed ${observedDate}): +${added} rows, `
          + `${policy.suppressedCount} suppressed, ${policy.continuedItems.length} continuation`);
      }
      summary.updated += 1;
      summary.addedRows += added;
      summary.suppressed += policy.suppressedCount;
      summary.droppedAlreadyPublished += results
        .reduce((total, result) => total + (result.sourceRaw?.droppedAlreadyPublishedCount || 0), 0);
    } catch (error) {
      summary.failed.push(`${reportDate}: ${error.message}`);
      console.error(`[fail] ${reportDate}: ${error.message}`);
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed.length) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

module.exports = { spliceMarkdown, spliceResults, renderTrendingMarkdown };
