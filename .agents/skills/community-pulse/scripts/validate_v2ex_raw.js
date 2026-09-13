#!/usr/bin/env node
/**
 * Validate V2EX observation snapshots without network access.
 *
 * Re-derives every row from the stored raw API payload and checks the day
 * assignment. `--require-file` is deliberately opt-in: the node shows its current
 * 10 topics, so a day on which the job did not run simply has no file — that is
 * a gap in observation, not a corrupt capture.
 *
 * Usage:
 *   node scripts/validate_v2ex_raw.js --date 2026-09-13
 *   node scripts/validate_v2ex_raw.js --start 2026-09-08 --end 2026-09-13
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TIMEZONE = 'Asia/Shanghai';
const SOURCE_ID = 'v2ex';
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
  if (data.capture?.mode !== 'observed-snapshot') errors.push(`${targetDate}: wrong capture mode`);
  if (data.capture?.historicalBackfillSupported !== false) errors.push(`${targetDate}: backfill flag must be false`);
  if (data.capture?.apiReturnsLatestOnly !== true) errors.push(`${targetDate}: apiReturnsLatestOnly flag missing`);
  if (data.capture?.httpStatus !== 200) errors.push(`${targetDate}: HTTP status is not 200`);
  if (!data.capture?.nodeName) errors.push(`${targetDate}: nodeName missing`);
  if (!Array.isArray(data.records)) { errors.push(`${targetDate}: records must be an array`); return 0; }

  let topics;
  try {
    if (data.response?.transferEncoding !== 'base64' || data.response?.contentEncoding !== 'gzip') {
      throw new Error('response encoding must be gzip then base64');
    }
    const raw = zlib.gunzipSync(decodeBase64(data.response?.body));
    if (data.contentSha256 !== sha256(raw)) errors.push(`${targetDate}: contentSha256 mismatch`);
    if (data.capture?.bodyByteLength !== raw.length) errors.push(`${targetDate}: bodyByteLength mismatch`);
    topics = JSON.parse(raw.toString('utf8'));
    if (!Array.isArray(topics)) throw new Error('stored payload is not an array of topics');
  } catch (error) {
    errors.push(`${targetDate}: ${error.message}`);
    return 0;
  }

  if (data.itemCount !== topics.length) errors.push(`${targetDate}: itemCount mismatch`);
  if (data.itemCount !== data.records.length) errors.push(`${targetDate}: records length mismatch`);
  if (data.status === 'empty' && topics.length) errors.push(`${targetDate}: status is empty but topics exist`);
  if (data.status === 'ok' && !topics.length) errors.push(`${targetDate}: status is ok but there are no topics`);

  const ids = [];
  topics.forEach((topic, index) => {
    ids.push(topic.id);
    const record = data.records[index];
    if (!record) return;
    if (String(record.topicId) !== String(topic.id)) errors.push(`${targetDate}: record ${index} topicId mismatch`);
    if (record.title !== (topic.title || '')) errors.push(`${targetDate}: record ${index} title mismatch`);
    if (record.replies !== (topic.replies || 0)) errors.push(`${targetDate}: record ${index} replies mismatch`);
    if (record.author !== ((topic.member && topic.member.username) || '')) errors.push(`${targetDate}: record ${index} author mismatch`);
  });
  if (new Set(ids).size !== ids.length) errors.push(`${targetDate}: duplicate topic ids`);
  if (JSON.stringify(data.capture?.topicIds) !== JSON.stringify(ids)) errors.push(`${targetDate}: topicIds evidence mismatch`);

  // How many rows really belong to the observed Beijing day. The public API is a
  // cache, so this may be lower than itemCount; it must never exceed it.
  const sameDay = (data.capture?.topicsCreatedOnObservedDay ?? 0);
  const counted = topics.filter((topic) => topic.created
    && beijingDateStr(new Date(topic.created * 1000)) === targetDate).length;
  if (sameDay !== counted) errors.push(`${targetDate}: topicsCreatedOnObservedDay mismatch (${sameDay} vs ${counted})`);
  return topics.length;
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
  let files = 0, topics = 0, missing = 0;
  for (const targetDate of dates) {
    const file = path.join(root, SOURCE_ID, `${targetDate}.json`);
    if (!fs.existsSync(file)) {
      missing += 1;
      if (requireFile) errors.push(`${targetDate}: missing ${file}`);
      continue;
    }
    try {
      topics += validateFile(file, targetDate, errors);
      files += 1;
    } catch (error) {
      errors.push(`${targetDate}: ${error.message}`);
    }
  }
  console.log(JSON.stringify({ sourceId: SOURCE_ID, days: dates.length, files, missing, topics, errorCount: errors.length }, null, 2));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
}

main();
