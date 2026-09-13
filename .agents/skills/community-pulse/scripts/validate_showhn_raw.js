#!/usr/bin/env node
/**
 * Validate Show HN source files without network access.
 *
 * Re-derives every row from the stored raw Algolia pages, so the records[] array,
 * the day assignment and the story ids are all checked against the bytes that were
 * actually captured rather than against a re-fetch.
 *
 * Usage:
 *   node scripts/validate_showhn_raw.js --date 2026-09-12
 *   node scripts/validate_showhn_raw.js --start 2026-01-01 --end 2026-09-12
 *   node scripts/validate_showhn_raw.js --date 2026-09-12 --require-file
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TIMEZONE = 'Asia/Shanghai';
const SOURCE_ID = 'showhn';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function beijingDateStr(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function decodeBase64(input) {
  if (typeof input !== 'string' || !input.length) throw new Error('missing base64 value');
  const buffer = Buffer.from(input, 'base64');
  if (buffer.toString('base64').replace(/=+$/, '') !== input.replace(/\s+/g, '').replace(/=+$/, '')) {
    throw new Error('invalid base64 value');
  }
  return buffer;
}

function eachDate(start, end) {
  const dates = [];
  for (let d = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function validateFile(file, targetDate, errors) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.schemaVersion !== 1) errors.push(`${targetDate}: schemaVersion must be 1`);
  if (data.sourceId !== SOURCE_ID) errors.push(`${targetDate}: sourceId mismatch`);
  if (data.targetDate !== targetDate) errors.push(`${targetDate}: targetDate mismatch`);
  if (data.timezone !== TIMEZONE) errors.push(`${targetDate}: timezone mismatch`);
  if (!['ok', 'empty'].includes(data.status)) errors.push(`${targetDate}: invalid status ${data.status}`);
  if (data.complete !== true) errors.push(`${targetDate}: capture is not complete`);
  if (!['observed-snapshot', 'historical-range'].includes(data.capture?.mode)) errors.push(`${targetDate}: wrong capture mode`);
  if (data.capture?.historicalBackfillSupported !== true) errors.push(`${targetDate}: backfill flag must be true`);
  if (data.capture?.httpStatus !== 200) errors.push(`${targetDate}: HTTP status is not 200`);
  if (!Array.isArray(data.records)) { errors.push(`${targetDate}: records must be an array`); return 0; }

  let pages;
  try {
    if (data.response?.transferEncoding !== 'base64' || data.response?.contentEncoding !== 'gzip') {
      throw new Error('response encoding must be gzip then base64');
    }
    const raw = zlib.gunzipSync(decodeBase64(data.response?.body));
    if (data.contentSha256 !== sha256(raw)) errors.push(`${targetDate}: contentSha256 mismatch`);
    if (data.capture?.bodyByteLength !== raw.length) errors.push(`${targetDate}: bodyByteLength mismatch`);
    pages = JSON.parse(raw.toString('utf8'));
    if (!Array.isArray(pages)) pages = [pages];
    if (!pages.length || !pages.every((page) => Array.isArray(page.hits))) throw new Error('stored pages have no hits arrays');
  } catch (error) {
    errors.push(`${targetDate}: ${error.message}`);
    return 0;
  }

  const hits = pages.flatMap((page) => page.hits);
  if (data.capture?.pagesFetched !== pages.length) errors.push(`${targetDate}: pagesFetched mismatch`);
  if (data.capture?.nbHits !== hits.length) errors.push(`${targetDate}: nbHits mismatch (${data.capture?.nbHits} vs ${hits.length})`);
  if (data.itemCount !== hits.length) errors.push(`${targetDate}: itemCount mismatch`);
  if (data.itemCount !== data.records.length) errors.push(`${targetDate}: records length mismatch`);
  if (data.status === 'empty' && hits.length) errors.push(`${targetDate}: status is empty but hits exist`);
  if (data.status === 'ok' && !hits.length) errors.push(`${targetDate}: status is ok but there are no hits`);

  const { start, end } = { start: data.capture?.dayStartEpoch, end: data.capture?.dayEndEpoch };
  if (!Number.isInteger(start) || !Number.isInteger(end) || end - start !== 86400) {
    errors.push(`${targetDate}: day epoch range must span exactly 86400 seconds`);
  }
  const ids = [];
  hits.forEach((hit, index) => {
    ids.push(String(hit.objectID));
    if (hit.created_at_i < start || hit.created_at_i >= end) {
      errors.push(`${targetDate}: hit ${hit.objectID} falls outside the stored day range`);
    }
    if (beijingDateStr(new Date(hit.created_at_i * 1000)) !== targetDate) {
      errors.push(`${targetDate}: hit ${hit.objectID} is not on the target Beijing day`);
    }
    const record = data.records[index];
    if (!record) return;
    if (record.objectID !== String(hit.objectID)) errors.push(`${targetDate}: record ${index} objectID mismatch`);
    if (record.points !== (hit.points || 0)) errors.push(`${targetDate}: record ${index} points mismatch`);
    if (record.comments !== (hit.num_comments || 0)) errors.push(`${targetDate}: record ${index} comments mismatch`);
    if (record.author !== (hit.author || '')) errors.push(`${targetDate}: record ${index} author mismatch`);
    if (record.url !== (hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`)) {
      errors.push(`${targetDate}: record ${index} url mismatch`);
    }
  });
  if (new Set(ids).size !== ids.length) errors.push(`${targetDate}: duplicate story ids`);
  if (JSON.stringify(data.capture?.storyIds) !== JSON.stringify(ids)) errors.push(`${targetDate}: storyIds evidence mismatch`);
  return hits.length;
}

function main() {
  const argv = process.argv.slice(2);
  const root = path.resolve(value(argv, '--root') || DEFAULT_ROOT);
  const single = value(argv, '--date');
  const start = value(argv, '--start');
  const end = value(argv, '--end');
  const requireFile = argv.includes('--require-file');
  let dates;
  if (single) dates = [single];
  else if (start && end) dates = eachDate(start, end);
  else throw new Error('provide --date YYYY-MM-DD or --start/--end');
  if (dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new Error('dates must be YYYY-MM-DD');

  const errors = [];
  let files = 0, stories = 0, missing = 0;
  for (const targetDate of dates) {
    const file = path.join(root, SOURCE_ID, `${targetDate}.json`);
    if (!fs.existsSync(file)) {
      missing += 1;
      if (requireFile) errors.push(`${targetDate}: missing ${file}`);
      continue;
    }
    try {
      stories += validateFile(file, targetDate, errors);
      files += 1;
    } catch (error) {
      errors.push(`${targetDate}: ${error.message}`);
    }
  }
  console.log(JSON.stringify({ sourceId: SOURCE_ID, days: dates.length, files, missing, stories, errorCount: errors.length }, null, 2));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
}

main();
