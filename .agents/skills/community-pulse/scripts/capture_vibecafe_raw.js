#!/usr/bin/env node
/**
 * Capture VibeCafe's source-native product records into immutable daily files.
 *
 * This is the source/bronze layer. It deliberately does not normalize, enrich,
 * deduplicate, truncate, or render products. Each record under `records` is the
 * object returned by https://vibecafe.ai/api/products.
 *
 * Usage:
 *   node scripts/capture_vibecafe_raw.js
 *   node scripts/capture_vibecafe_raw.js --start 2026-06-02 --end 2026-09-07
 *   node scripts/capture_vibecafe_raw.js --date 2026-09-07
 *   node scripts/capture_vibecafe_raw.js --resume --end 2026-09-07
 *   node scripts/capture_vibecafe_raw.js --replace
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const SOURCE_ID = 'vibecafe';
const SOURCE_NAME = 'VibeCafé 作品';
const ENDPOINT = 'https://vibecafe.ai/api/products';
const PRODUCT_URL = 'https://vibecafe.ai/products';
const TIMEZONE = 'Asia/Shanghai';
const DEFAULT_START = '2026-06-02';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_OUT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw', SOURCE_ID);
const PROXY = process.env.COMMUNITY_PULSE_PROXY === undefined
  ? 'http://127.0.0.1:7890'
  : process.env.COMMUNITY_PULSE_PROXY;

function parseArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const date = value('--date');
  return {
    start: date || value('--start') || DEFAULT_START,
    end: date || value('--end') || beijingDateStr(new Date(Date.now() - 86400000)),
    outRoot: path.resolve(value('--out-root') || DEFAULT_OUT_ROOT),
    replace: argv.includes('--replace'),
    resume: argv.includes('--resume'),
  };
}

function beijingDateStr(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function assertDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must be YYYY-MM-DD: ${value}`);
  const parsed = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime()) || beijingDateStr(parsed) !== value) {
    throw new Error(`${name} is not a valid calendar date: ${value}`);
  }
}

function eachDate(start, end) {
  const out = [];
  const cursor = new Date(`${start}T00:00:00+08:00`);
  const last = new Date(`${end}T00:00:00+08:00`);
  while (cursor <= last) {
    out.push(beijingDateStr(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function fetchPage(cursor) {
  const url = cursor ? `${ENDPOINT}?cursor=${encodeURIComponent(cursor)}` : ENDPOINT;
  const args = [
    '-sS', '--fail-with-body', '--max-time', '30',
    '-H', 'Accept: application/json',
    '-H', 'User-Agent: community-pulse-source-capture/1',
  ];
  if (PROXY) args.push('-x', PROXY);
  args.push(url);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const text = execFileSync('curl', args, {
        encoding: 'utf8',
        maxBuffer: 30 * 1024 * 1024,
        timeout: 35000,
      });
      const payload = JSON.parse(text);
      if (!Array.isArray(payload.products)) throw new Error('response.products is not an array');
      return { url, payload };
    } catch (error) {
      lastError = error;
      if (attempt < 3) execFileSync('sleep', [String(attempt)]);
    }
  }
  throw new Error(`VibeCafe page fetch failed after 3 attempts: ${lastError.message}`);
}

function fetchDetail(product) {
  const requestUrl = `${PRODUCT_URL}/${encodeURIComponent(product.id)}`;
  const args = [
    '-sS', '-L', '--compressed', '--fail-with-body', '--max-time', '30',
    '-H', 'RSC: 1',
    '-H', 'Accept: */*',
    '-H', 'User-Agent: community-pulse-source-capture/1',
  ];
  if (PROXY) args.push('-x', PROXY);
  args.push(requestUrl);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const body = execFileSync('curl', args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 35000,
      });
      const text = body.toString('utf8');
      if (!text.includes(product.id)) {
        throw new Error(`detail response does not contain product id ${product.id}`);
      }
      return {
        productId: product.id,
        requestUrl,
        fetchedAt: new Date().toISOString(),
        bodyByteLength: body.length,
        contentSha256: crypto.createHash('sha256').update(body).digest('hex'),
        response: {
          transferEncoding: 'base64',
          contentEncoding: 'gzip',
          body: zlib.gzipSync(body, { level: 9 }).toString('base64'),
        },
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) execFileSync('sleep', [String(attempt)]);
    }
  }
  throw new Error(`VibeCafe detail fetch failed for ${product.id}: ${lastError.message}`);
}

function validateProduct(product, pageNumber, index) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) {
    throw new Error(`page ${pageNumber} product ${index} is not an object`);
  }
  if (!product.id || typeof product.id !== 'string') {
    throw new Error(`page ${pageNumber} product ${index} has no string id`);
  }
  if (!product.createdAt || Number.isNaN(new Date(product.createdAt).getTime())) {
    throw new Error(`product ${product.id} has invalid createdAt: ${product.createdAt}`);
  }
}

function fetchRange(start) {
  const records = [];
  const pages = [];
  const ids = new Set();
  const cursors = new Set();
  let cursor = null;
  let previousTime = Infinity;
  let stoppedBecause = null;

  for (let pageNumber = 1; pageNumber <= 200; pageNumber += 1) {
    const { url, payload } = fetchPage(cursor);
    const products = payload.products;
    for (let i = 0; i < products.length; i += 1) {
      const product = products[i];
      validateProduct(product, pageNumber, i);
      if (ids.has(product.id)) throw new Error(`duplicate product id across pages: ${product.id}`);
      const time = new Date(product.createdAt).getTime();
      if (time > previousTime) throw new Error(`feed is not descending at product ${product.id}`);
      previousTime = time;
      ids.add(product.id);
      records.push(product);
    }

    pages.push({
      number: pageNumber,
      requestUrl: url,
      itemCount: products.length,
      firstCreatedAt: products[0]?.createdAt || null,
      lastCreatedAt: products.at(-1)?.createdAt || null,
      nextCursor: payload.nextCursor || null,
    });

    if (!payload.nextCursor) {
      stoppedBecause = 'end-of-feed';
      break;
    }
    if (!products.length) throw new Error('empty page returned a nextCursor');
    if (cursors.has(payload.nextCursor)) throw new Error(`pagination cursor loop: ${payload.nextCursor}`);
    cursors.add(payload.nextCursor);

    // The endpoint is strictly newest-first. Once the last record is older
    // than the requested start date, all requested days are fully covered.
    if (beijingDateStr(new Date(products.at(-1).createdAt)) < start) {
      stoppedBecause = 'crossed-start-boundary';
      break;
    }
    cursor = payload.nextCursor;
  }

  if (!stoppedBecause) throw new Error('pagination exceeded the 200-page safety limit');
  return { records, pages, stoppedBecause };
}

function digest(records) {
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function firstMissingDate(outRoot, start, end) {
  for (const targetDate of eachDate(start, end)) {
    if (!fs.existsSync(path.join(outRoot, `${targetDate}.json`))) return targetDate;
  }
  return null;
}

function detailDigest(details) {
  const evidence = details.map((detail) => ({
    productId: detail.productId,
    contentSha256: detail.contentSha256,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

function writeDailyFiles(options, capture, detailsById) {
  const fetchedAt = new Date().toISOString();
  const captureId = `vibecafe-${fetchedAt.replace(/[-:.]/g, '').replace('Z', 'Z')}`;
  const byDay = new Map();
  for (const record of capture.records) {
    const day = beijingDateStr(new Date(record.createdAt));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(record);
  }

  let written = 0;
  let unchanged = 0;
  let totalRecords = 0;
  for (const targetDate of eachDate(options.start, options.end)) {
    const records = byDay.get(targetDate) || [];
    const detailResponses = records.map((record) => detailsById.get(record.id));
    if (detailResponses.some((detail) => !detail)) {
      throw new Error(`${targetDate}: one or more product detail responses are missing`);
    }
    totalRecords += records.length;
    const sha256 = digest(records);
    const document = {
      schemaVersion: 1,
      sourceId: SOURCE_ID,
      sourceName: SOURCE_NAME,
      targetDate,
      timezone: TIMEZONE,
      status: records.length ? 'ok' : 'empty',
      complete: true,
      itemCount: records.length,
      contentSha256: sha256,
      detailCount: detailResponses.length,
      detailContentSha256: detailDigest(detailResponses),
      fetchedAt,
      capture: {
        id: captureId,
        mode: options.start === options.end ? 'daily-finalized-date' : 'historical-reconstruction',
        endpoint: ENDPOINT,
        pageCount: capture.pages.length,
        scannedItemCount: capture.records.length,
        stoppedBecause: capture.stoppedBecause,
        newestScannedCreatedAt: capture.records[0]?.createdAt || null,
        oldestScannedCreatedAt: capture.records.at(-1)?.createdAt || null,
      },
      records,
      detailResponses,
    };
    const file = path.join(options.outRoot, `${targetDate}.json`);
    if (fs.existsSync(file) && !options.replace) {
      const old = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (old.contentSha256 !== sha256) {
        throw new Error(`${file} already exists with different content; use --replace only after review`);
      }
      unchanged += 1;
      continue;
    }
    atomicWrite(file, `${JSON.stringify(document, null, 2)}\n`);
    written += 1;
  }
  return { written, unchanged, totalRecords, captureId };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  assertDate(options.start, '--start');
  assertDate(options.end, '--end');
  if (options.start > options.end) throw new Error('--start must not be after --end');

  if (options.resume) {
    const missingDate = firstMissingDate(options.outRoot, options.start, options.end);
    if (!missingDate) {
      console.log(JSON.stringify({
        sourceId: SOURCE_ID,
        start: options.start,
        end: options.end,
        outRoot: options.outRoot,
        resumed: true,
        noOp: true,
        reason: 'all daily files already exist',
      }, null, 2));
      return;
    }
    options.start = missingDate;
  }

  const capture = fetchRange(options.start);
  const requestedDays = new Set(eachDate(options.start, options.end));
  const requestedRecords = capture.records.filter((record) => requestedDays.has(beijingDateStr(new Date(record.createdAt))));
  const detailsById = new Map();
  for (const [index, record] of requestedRecords.entries()) {
    process.stderr.write(`[vibecafe detail ${index + 1}/${requestedRecords.length}] ${record.id}\n`);
    detailsById.set(record.id, fetchDetail(record));
  }
  const result = writeDailyFiles(options, capture, detailsById);
  console.log(JSON.stringify({
    sourceId: SOURCE_ID,
    start: options.start,
    end: options.end,
    outRoot: options.outRoot,
    pagesFetched: capture.pages.length,
    scannedItemCount: capture.records.length,
    stoppedBecause: capture.stoppedBecause,
    resumed: options.resume,
    ...result,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
