#!/usr/bin/env node
/**
 * Offline validation of the website-logo fallback layer
 * (`知识/大家都在做什么/source-raw/site-logos/<date>.json`).
 *
 * It re-derives the candidate rows from the immutable source-raw layer — never the network — and
 * checks that the day file accounts for every one of them, that hashes and counters still match the
 * stored records, and that only real image evidence is marked `ok`. Exit code 1 means the layer
 * cannot be trusted by the site build.
 *
 * A day file is fed by two runs, so its expectations come from two reports: the report of this very
 * day (its regular rows) and the report of the previous day (its Trending rows, which are filed
 * under the observation day). Both are recomputed here, which is why the check window is two days.
 *
 * Two things are deliberately lenient: a day with no candidate rows needs no file at all (several
 * calendar days have no 日报), and a server that answers an icon without an `image/*` content-type
 * is only a warning — the icon was accepted because its bytes sniff as an image.
 *
 * Usage:
 *   node scripts/validate_site_logos_raw.js --date 2026-09-10
 *   node scripts/validate_site_logos_raw.js --start 2026-09-01 --end 2026-09-10
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { collectCandidates, eachDate } = require('./capture_site_logos_raw');
const { PLATFORM_HOSTS, normalizePageUrl } = require('./site_logo');

const SOURCE_ID = 'site-logos';
const TIMEZONE = 'Asia/Shanghai';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const CONFIG = path.join(__dirname, '..', 'config', 'sources.json');
const DEFAULT_SOURCE_RAW_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');
const DEFAULT_RAW_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'raw');
const STATUSES = ['ok', 'missing', 'failed'];
const ICON_KINDS = ['apple-touch-icon', 'icon', 'json-ld-logo', 'mask-icon', 'default-favicon'];

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function digest(valueToHash) {
  return crypto.createHash('sha256').update(JSON.stringify(valueToHash)).digest('hex');
}

function shiftDate(date, days) {
  const cursor = new Date(`${date}T00:00:00+08:00`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try { return /^https?:$/.test(new URL(value).protocol); } catch (_) { return false; }
}

function isPlatformHost(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return PLATFORM_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
  } catch (_) { return false; }
}

function validateRecord(record, index, errors, warnings = []) {
  const where = `records[${index}]`;
  for (const field of ['sourceId', 'pageUrl', 'status']) {
    if (typeof record[field] !== 'string' || !record[field]) errors.push(`${where}.${field} is missing`);
  }
  if (!STATUSES.includes(record.status)) errors.push(`${where}.status is invalid: ${record.status}`);
  if (!isHttpUrl(record.pageUrl)) errors.push(`${where}.pageUrl is not an http(s) URL: ${record.pageUrl}`);
  if (isPlatformHost(record.pageUrl)) errors.push(`${where}.pageUrl is a platform page, not an official website: ${record.pageUrl}`);
  if (normalizePageUrl(record.pageUrl) && normalizePageUrl(record.pageUrl) !== record.pageUrl) {
    errors.push(`${where}.pageUrl is not normalized: ${record.pageUrl}`);
  }
  if (!Array.isArray(record.attempts)) errors.push(`${where}.attempts must be an array`);
  for (const [attemptIndex, attempt] of (record.attempts || []).entries()) {
    if (!isHttpUrl(attempt.url)) errors.push(`${where}.attempts[${attemptIndex}].url is not an http(s) URL`);
    if (!['ok', 'failed'].includes(attempt.status)) errors.push(`${where}.attempts[${attemptIndex}].status is invalid`);
  }
  if (record.status === 'ok') {
    if (!isHttpUrl(record.iconUrl)) errors.push(`${where}.iconUrl is not an http(s) URL`);
    if (!ICON_KINDS.includes(record.iconKind)) errors.push(`${where}.iconKind is invalid: ${record.iconKind}`);
    // The server header is only a hint: the icon was accepted because its bytes sniff as an image
    // (`iconKind`), and some hosts answer an apple-touch-icon with octet-stream or no header at all.
    if (!String(record.contentType || '').startsWith('image/')) warnings.push(`${where}.contentType is not an image: ${record.contentType}`);
    if (!Number.isInteger(record.byteLength) || record.byteLength <= 0) errors.push(`${where}.byteLength must be a positive integer`);
    if (!/^[a-f0-9]{64}$/.test(String(record.contentSha256 || ''))) errors.push(`${where}.contentSha256 is not a sha256`);
    if (!(record.attempts || []).some((attempt) => attempt.url === record.iconUrl && attempt.status === 'ok')) {
      errors.push(`${where}.iconUrl has no successful attempt backing it`);
    }
  } else {
    if (record.iconUrl || record.contentSha256) errors.push(`${where} claims an icon while status is ${record.status}`);
    if (!String(record.error || '')) errors.push(`${where}.error is empty for status ${record.status}`);
  }
}

function validateDocument(document, file, date, expected, errors, warnings) {
  if (document.schemaVersion !== 1) errors.push(`${file}: unsupported schemaVersion ${document.schemaVersion}`);
  if (document.sourceId !== SOURCE_ID) errors.push(`${file}: sourceId mismatch (${document.sourceId})`);
  if (document.targetDate !== date) errors.push(`${file}: targetDate mismatch (${document.targetDate})`);
  if (document.timezone !== TIMEZONE) errors.push(`${file}: timezone mismatch (${document.timezone})`);
  if (!['ok', 'empty'].includes(document.status)) errors.push(`${file}: invalid status ${document.status}`);
  if (!Array.isArray(document.records)) { errors.push(`${file}: records must be an array`); return; }
  if (document.complete !== true) errors.push(`${file}: source capture is incomplete (complete=${document.complete})`);
  if (document.contentSha256 !== digest(document.records)) errors.push(`${file}: contentSha256 does not match records`);
  const okCount = document.records.filter((record) => record.status === 'ok').length;
  const missingCount = document.records.filter((record) => record.status === 'missing').length;
  const failureCount = document.records.filter((record) => record.status === 'failed').length;
  const pageCount = new Set(document.records.map((record) => record.pageUrl)).size;
  if (document.itemCount !== okCount) errors.push(`${file}: itemCount ${document.itemCount} != ${okCount} logos`);
  if (document.candidateCount !== document.records.length) errors.push(`${file}: candidateCount ${document.candidateCount} != ${document.records.length} records`);
  if (document.missingCount !== missingCount) errors.push(`${file}: missingCount ${document.missingCount} != ${missingCount}`);
  if (document.failureCount !== failureCount) errors.push(`${file}: failureCount ${document.failureCount} != ${failureCount}`);
  if (document.pageCount !== pageCount) errors.push(`${file}: pageCount ${document.pageCount} != ${pageCount}`);
  if (!document.capture || document.capture.mode !== 'website-logo-fallback') errors.push(`${file}: capture.mode is missing`);
  document.records.forEach((record, index) => validateRecord(record, index, errors, warnings));

  const covered = new Set(document.records.map((record) => `${record.sourceId}\u0000${record.externalId || record.pageUrl}`));
  const uncovered = [...expected.keys()].filter((key) => !covered.has(key));
  if (uncovered.length) {
    const sample = uncovered.slice(0, 5).map((key) => key.split('\u0000').join(':')).join(', ');
    const message = `${file}: ${uncovered.length} candidate row(s) have no record (${sample})`;
    // A day file written with --limit is explicitly partial; anything else is a real gap.
    if (document.complete === true) errors.push(message); else warnings.push(message);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const date = value(argv, '--date');
  const start = date || value(argv, '--start');
  const end = date || value(argv, '--end');
  if (!start || !end) throw new Error('--date or --start/--end is required');
  const sourceRawRoot = path.resolve(value(argv, '--source-raw-root') || DEFAULT_SOURCE_RAW_ROOT);
  const rawRoot = path.resolve(value(argv, '--raw-root') || DEFAULT_RAW_ROOT);
  const outRoot = path.resolve(value(argv, '--out-root') || path.join(sourceRawRoot, SOURCE_ID));
  const dates = eachDate(start, end);
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const sources = config.sources.filter((source) => source.enabled);
  const errors = [];
  const warnings = [];
  let records = 0;
  let logos = 0;
  for (const day of dates) {
    const file = path.join(outRoot, `${day}.json`);
    // A day without a single candidate row needs no file: the 日报 itself is missing for those days
    // (no report was generated then), so there is nothing to fall back for.
    const { byFileDate } = collectCandidates({ start: shiftDate(day, -1), end: day, sourceRawRoot, rawRoot, strict: false }, sources);
    const expected = byFileDate.get(day) || new Map();
    if (!fs.existsSync(file)) {
      if (expected.size) errors.push(`${file}: missing (${expected.size} candidate row(s) expect it)`);
      continue;
    }
    let document;
    try { document = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { errors.push(`${file}: ${error.message}`); continue; }
    validateDocument(document, file, day, expected, errors, warnings);
    records += (document.records || []).length;
    logos += document.records?.filter((record) => record.status === 'ok').length || 0;
    console.log(`${file}: ${document.itemCount}/${document.candidateCount} logos (${document.missingCount} without an icon, ${document.failureCount} failed)`);
  }
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (errors.length) {
    console.error(`site-logos validation failed with ${errors.length} problem(s):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`site-logos layer OK: ${dates.length} day file(s), ${records} candidate rows, ${logos} logos, ${warnings.length} warning(s).`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

module.exports = { validateDocument, validateRecord };
