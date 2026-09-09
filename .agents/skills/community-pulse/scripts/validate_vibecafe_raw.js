#!/usr/bin/env node
/** Validate VibeCafe daily source/bronze files without network access. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TIMEZONE = 'Asia/Shanghai';
const DEFAULT_START = '2026-06-02';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw', 'vibecafe');

function value(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function beijingDateStr(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function eachDate(start, end) {
  const dates = [];
  const cursor = new Date(`${start}T00:00:00+08:00`);
  const last = new Date(`${end}T00:00:00+08:00`);
  while (cursor <= last) {
    dates.push(beijingDateStr(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function digest(records) {
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function detailDigest(details) {
  const evidence = details.map((detail) => ({
    productId: detail.productId,
    contentSha256: detail.contentSha256,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

function main() {
  const argv = process.argv.slice(2);
  const root = path.resolve(value(argv, '--root') || DEFAULT_ROOT);
  const start = value(argv, '--start') || DEFAULT_START;
  const end = value(argv, '--end') || beijingDateStr(new Date(Date.now() - 86400000));
  const errors = [];
  const globalIds = new Map();
  let totalRecords = 0;
  let emptyDays = 0;

  for (const targetDate of eachDate(start, end)) {
    const file = path.join(root, `${targetDate}.json`);
    if (!fs.existsSync(file)) {
      errors.push(`${targetDate}: missing file`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push(`${targetDate}: invalid JSON (${error.message})`);
      continue;
    }
    if (data.schemaVersion !== 1) errors.push(`${targetDate}: schemaVersion must be 1`);
    if (data.sourceId !== 'vibecafe') errors.push(`${targetDate}: wrong sourceId`);
    if (data.targetDate !== targetDate) errors.push(`${targetDate}: targetDate mismatch`);
    if (data.timezone !== TIMEZONE) errors.push(`${targetDate}: wrong timezone`);
    if (data.complete !== true) errors.push(`${targetDate}: capture is not complete`);
    if (!['ok', 'empty'].includes(data.status)) errors.push(`${targetDate}: invalid status ${data.status}`);
    if (!Array.isArray(data.records)) {
      errors.push(`${targetDate}: records is not an array`);
      continue;
    }
    if (data.itemCount !== data.records.length) errors.push(`${targetDate}: itemCount mismatch`);
    if (data.status === 'empty' && data.records.length !== 0) errors.push(`${targetDate}: empty status has records`);
    if (data.status === 'ok' && data.records.length === 0) errors.push(`${targetDate}: ok status has no records`);
    if (data.contentSha256 !== digest(data.records)) errors.push(`${targetDate}: contentSha256 mismatch`);
    // detailResponses was added after the initial historical capture. Legacy
    // files remain readable; every newly enriched file must be all-or-nothing.
    if (data.detailResponses !== undefined) {
      if (!Array.isArray(data.detailResponses)) {
        errors.push(`${targetDate}: detailResponses is not an array`);
      } else {
        if (data.detailCount !== data.detailResponses.length) errors.push(`${targetDate}: detailCount mismatch`);
        if (data.detailResponses.length !== data.records.length) errors.push(`${targetDate}: detail coverage is incomplete`);
        if (data.detailContentSha256 !== detailDigest(data.detailResponses)) errors.push(`${targetDate}: detailContentSha256 mismatch`);
        const recordIds = new Set(data.records.map((record) => record.id));
        const detailIds = new Set();
        for (const detail of data.detailResponses) {
          if (!recordIds.has(detail.productId)) errors.push(`${targetDate}: unexpected detail ${detail.productId}`);
          if (detailIds.has(detail.productId)) errors.push(`${targetDate}: duplicate detail ${detail.productId}`);
          detailIds.add(detail.productId);
          try {
            if (detail.response?.transferEncoding !== 'base64' || detail.response?.contentEncoding !== 'gzip') {
              throw new Error('response encoding must be gzip then base64');
            }
            const body = zlib.gunzipSync(Buffer.from(detail.response.body, 'base64'));
            if (body.length !== detail.bodyByteLength) throw new Error('bodyByteLength mismatch');
            if (sha256(body) !== detail.contentSha256) throw new Error('contentSha256 mismatch');
            if (!body.toString('utf8').includes(detail.productId)) throw new Error('body does not contain product id');
          } catch (error) {
            errors.push(`${targetDate}: detail ${detail.productId} ${error.message}`);
          }
        }
      }
    }
    if (!data.records.length) emptyDays += 1;

    const localIds = new Set();
    for (const record of data.records) {
      totalRecords += 1;
      if (!record || typeof record !== 'object' || !record.id) {
        errors.push(`${targetDate}: record without id`);
        continue;
      }
      if (localIds.has(record.id)) errors.push(`${targetDate}: duplicate id ${record.id}`);
      localIds.add(record.id);
      if (globalIds.has(record.id)) errors.push(`${targetDate}: id ${record.id} also appears on ${globalIds.get(record.id)}`);
      globalIds.set(record.id, targetDate);
      const created = new Date(record.createdAt);
      if (Number.isNaN(created.getTime())) errors.push(`${targetDate}: ${record.id} has invalid createdAt`);
      else if (beijingDateStr(created) !== targetDate) errors.push(`${targetDate}: ${record.id} belongs to ${beijingDateStr(created)}`);
    }
  }

  const summary = {
    sourceId: 'vibecafe', root, start, end,
    expectedDays: eachDate(start, end).length,
    emptyDays,
    totalRecords,
    uniqueIds: globalIds.size,
    errorCount: errors.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (errors.length) {
    for (const error of errors.slice(0, 100)) console.error(error);
    if (errors.length > 100) console.error(`... ${errors.length - 100} more errors`);
    process.exit(1);
  }
}

main();
