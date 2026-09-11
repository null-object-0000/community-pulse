#!/usr/bin/env node
/**
 * Offline backfill of `siteLogo` into older 日报 files.
 *
 * The website-logo fallback layer (`source-raw/site-logos/<date>.json`) is captured on its own
 * schedule; this script only copies the already-proven icon URL onto the rows of the mixed 日报
 * layer, exactly like backfill_vibecafe_media.js / backfill_producthunt_media.js do for other media.
 * It touches one field per item and never re-runs collect, so no other source is rewritten.
 *
 * Rows keep their own product mark when they have one; a row whose site yielded nothing keeps the
 * plain text avatar. `--refresh` also rewrites rows that already carry a siteLogo (use it after
 * re-capturing a day).
 *
 * Usage:
 *   node scripts/backfill_site_logos.js --start 2026-01-01 --end 2026-09-10 [--dry-run]
 *   node scripts/backfill_site_logos.js --date 2026-09-10 --refresh
 *
 * Follow up with `npm run images:sync` so the new icons are mirrored, then `npm run check`.
 */
const fs = require('fs');
const path = require('path');
const { OBSERVED_SOURCES } = require('./source_raw_items');
const { candidatePage } = require('./site_logo');

const SOURCE_ID = 'site-logos';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const RAW_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'raw');
const SOURCE_RAW_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function eachDate(start, end) {
  const dates = [];
  const cursor = new Date(`${start}T00:00:00+08:00`);
  const last = new Date(`${end}T00:00:00+08:00`);
  while (cursor <= last) {
    dates.push(new Date(cursor).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

// Site logos of a day file, indexed per source by external id and by page URL.
function indexRecords(records) {
  const byExternalId = new Map();
  const byPage = new Map();
  for (const record of records || []) {
    if (record.status !== 'ok' || !record.iconUrl) continue;
    byExternalId.set(`${record.sourceId}\u0000${record.externalId}`, record);
    byPage.set(`${record.sourceId}\u0000${record.pageUrl}`, record);
  }
  return { byExternalId, byPage };
}

function recordFor(item, sourceId, index) {
  const byId = index.byExternalId.get(`${sourceId}\u0000${item.externalId}`);
  if (byId) return byId;
  const page = candidatePage(item);
  return page ? index.byPage.get(`${sourceId}\u0000${page}`) || null : null;
}

// A 日报 states which source-raw day file it consumed, which is how a Trending row finds the day
// file that was captured for its observation day.
function lookupDate(source, reportDate) {
  const observed = String(source.sourceRaw?.path || '').match(/(\d{4}-\d{2}-\d{2})\.json$/)?.[1];
  return OBSERVED_SOURCES.has(source.sourceId) && observed ? observed : reportDate;
}

function backfillDate(date, options, stats) {
  const rawFile = path.join(options.rawRoot, `${date}.json`);
  if (!fs.existsSync(rawFile)) { stats.missingReports.push(date); return; }
  const report = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  const indexes = new Map();
  let changed = 0;
  for (const source of report.results || []) {
    const day = lookupDate(source, date);
    if (!indexes.has(day)) {
      const file = path.join(options.sourceRawRoot, SOURCE_ID, `${day}.json`);
      indexes.set(day, fs.existsSync(file) ? indexRecords(JSON.parse(fs.readFileSync(file, 'utf8')).records) : indexRecords([]));
    }
    const index = indexes.get(day);
    for (const item of source.items || []) {
      // A row with its own product mark never borrows the website's; the fallback is a fallback.
      if (item.logo || item.icon) continue;
      const record = recordFor(item, source.sourceId, index);
      const wanted = record ? record.iconUrl : '';
      const current = item.siteLogo || '';
      if (current === wanted) { stats.unchanged += 1; continue; }
      if (current && !options.refresh) { stats.kept += 1; continue; }
      if (options.dryRun) {
        if (wanted) stats.wouldFill += 1; else stats.wouldClear += 1;
        if (stats.sample.length < 8) stats.sample.push({ date, sourceId: source.sourceId, title: item.title, page: candidatePage(item), siteLogo: wanted, previous: current });
        continue;
      }
      if (wanted) { item.siteLogo = wanted; stats.filled += 1; changed += 1; }
      else { delete item.siteLogo; stats.cleared += 1; changed += 1; }
    }
  }
  if (changed && !options.dryRun) atomicWrite(rawFile, JSON.stringify(report, null, 2));
  if (changed) console.log(`${date}: ${changed} row(s) updated`);
}

function main() {
  const argv = process.argv.slice(2);
  const date = value(argv, '--date');
  const options = {
    start: date || value(argv, '--start'),
    end: date || value(argv, '--end'),
    rawRoot: path.resolve(value(argv, '--raw-root') || RAW_ROOT),
    sourceRawRoot: path.resolve(value(argv, '--source-raw-root') || SOURCE_RAW_ROOT),
    dryRun: argv.includes('--dry-run'),
    refresh: argv.includes('--refresh'),
  };
  if (!options.start || !options.end) throw new Error('--date or --start/--end is required');
  const stats = { filled: 0, cleared: 0, unchanged: 0, kept: 0, wouldFill: 0, wouldClear: 0, missingReports: [], sample: [] };
  for (const day of eachDate(options.start, options.end)) backfillDate(day, options, stats);
  console.log(JSON.stringify({
    mode: options.dryRun ? 'dry-run' : 'write',
    start: options.start,
    end: options.end,
    filled: stats.filled,
    cleared: stats.cleared,
    unchanged: stats.unchanged,
    keptExisting: stats.kept,
    wouldFill: stats.wouldFill,
    wouldClear: stats.wouldClear,
    reportsWithoutRaw: stats.missingReports.length,
    sample: stats.sample,
  }, null, 2));
  if (stats.missingReports.length) console.warn(`no 日报 for ${stats.missingReports.length} day(s): ${stats.missingReports.slice(0, 5).join(', ')}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

module.exports = { indexRecords, recordFor, lookupDate, eachDate };
