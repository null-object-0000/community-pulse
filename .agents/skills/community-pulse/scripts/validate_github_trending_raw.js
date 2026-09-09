#!/usr/bin/env node
/** Validate GitHub Trending observation snapshots without network access. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TIMEZONE = 'Asia/Shanghai';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');
const SOURCES = {
  'github-trending': { spokenLanguageCode: null },
  'github-trending-cn': { spokenLanguageCode: 'zh' },
};

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function inspectHtml(buffer) {
  const html = buffer.toString('utf8');
  const rows = html.split('class="Box-row"').slice(1);
  const repositoryPaths = rows.map((row) => {
    const match = row.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"?#]+)"/i);
    return match ? match[1].trim() : null;
  });
  return { html, rows, repositoryPaths };
}

function decodeBase64(input) {
  if (typeof input !== 'string' || !input.length) throw new Error('missing base64 value');
  const buffer = Buffer.from(input, 'base64');
  if (buffer.toString('base64').replace(/=+$/, '') !== input.replace(/\s+/g, '').replace(/=+$/, '')) {
    throw new Error('invalid base64 value');
  }
  return buffer;
}

function main() {
  const argv = process.argv.slice(2);
  const root = path.resolve(value(argv, '--root') || DEFAULT_ROOT);
  const targetDate = value(argv, '--date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate || '')) throw new Error('--date YYYY-MM-DD is required');
  const errors = [];
  let totalRows = 0;
  let totalBytes = 0;

  for (const [sourceId, expected] of Object.entries(SOURCES)) {
    const file = path.join(root, sourceId, `${targetDate}.json`);
    if (!fs.existsSync(file)) {
      errors.push(`${sourceId}: missing ${file}`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push(`${sourceId}: invalid JSON (${error.message})`);
      continue;
    }
    if (data.schemaVersion !== 1) errors.push(`${sourceId}: schemaVersion must be 1`);
    if (data.sourceId !== sourceId) errors.push(`${sourceId}: sourceId mismatch`);
    if (data.targetDate !== targetDate) errors.push(`${sourceId}: targetDate mismatch`);
    if (data.timezone !== TIMEZONE) errors.push(`${sourceId}: timezone mismatch`);
    if (data.status !== 'ok' || data.complete !== true) errors.push(`${sourceId}: capture is not complete and ok`);
    if (data.capture?.mode !== 'observed-snapshot') errors.push(`${sourceId}: wrong capture mode`);
    if (data.capture?.historicalBackfillSupported !== false) errors.push(`${sourceId}: historical backfill flag must be false`);
    if (data.capture?.since !== 'daily') errors.push(`${sourceId}: since must be daily`);
    if (data.capture?.spokenLanguageCode !== expected.spokenLanguageCode) errors.push(`${sourceId}: spoken language mismatch`);
    if (data.capture?.httpStatus !== 200) errors.push(`${sourceId}: HTTP status is not 200`);

    let body;
    try {
      if (data.response?.transferEncoding !== 'base64' || data.response?.contentEncoding !== 'gzip') {
        throw new Error('response encoding must be gzip then base64');
      }
      body = zlib.gunzipSync(decodeBase64(data.response?.body));
      decodeBase64(data.response?.rawHeaders);
    } catch (error) {
      errors.push(`${sourceId}: ${error.message}`);
      continue;
    }
    totalBytes += body.length;
    const evidence = inspectHtml(body);
    if (!/<html[\s>]/i.test(evidence.html)) errors.push(`${sourceId}: body is not HTML`);
    if (!evidence.rows.length) errors.push(`${sourceId}: no Box-row entries`);
    if (evidence.repositoryPaths.some((item) => !item)) errors.push(`${sourceId}: a row has no repository path`);
    if (new Set(evidence.repositoryPaths).size !== evidence.repositoryPaths.length) errors.push(`${sourceId}: duplicate repository path`);
    if (data.itemCount !== evidence.rows.length) errors.push(`${sourceId}: itemCount mismatch`);
    if (data.capture?.bodyByteLength !== body.length) errors.push(`${sourceId}: bodyByteLength mismatch`);
    if (data.contentSha256 !== sha256(body)) errors.push(`${sourceId}: contentSha256 mismatch`);
    if (JSON.stringify(data.capture?.repositoryPaths) !== JSON.stringify(evidence.repositoryPaths)) {
      errors.push(`${sourceId}: repositoryPaths evidence mismatch`);
    }
    totalRows += evidence.rows.length;
  }

  console.log(JSON.stringify({ targetDate, sourceCount: Object.keys(SOURCES).length, totalRows, totalBytes, errorCount: errors.length }, null, 2));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
}

main();
