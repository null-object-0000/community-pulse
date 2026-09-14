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
  // The live pipeline always captures both lists, so a missing file is a failure there.
  // Backfilled days are different: the Chinese list is archived on a minority of days,
  // so a caller may declare a source optional and accept a partial day.
  const optionalMissing = new Set((value(argv, '--optional-missing') || '')
    .split(',').map((item) => item.trim()).filter(Boolean));
  const skipped = [];
  const errors = [];
  let totalRows = 0;
  let totalBytes = 0;

  for (const [sourceId, expected] of Object.entries(SOURCES)) {
    const file = path.join(root, sourceId, `${targetDate}.json`);
    if (!fs.existsSync(file)) {
      if (optionalMissing.has(sourceId)) {
        skipped.push(sourceId);
        continue;
      }
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
    // Two legitimate provenances share this schema. `observed-snapshot` is the live
    // fetcher, which may only ever label today. `archived-observation` is a Wayback
    // capture of the page as it actually read on an earlier day: there the observation
    // date is evidence carried by the archive, not an assertion, so it may describe the
    // past. Both keep `historicalBackfillSupported: false` — the live fetcher still may
    // not relabel a current page as a past day.
    const mode = data.capture?.mode;
    if (mode !== 'observed-snapshot' && mode !== 'archived-observation') {
      errors.push(`${sourceId}: unknown capture mode ${JSON.stringify(mode)}`);
    }
    if (data.capture?.historicalBackfillSupported !== false) errors.push(`${sourceId}: historical backfill flag must be false`);
    if (data.capture?.since !== 'daily') errors.push(`${sourceId}: since must be daily`);
    if (data.capture?.spokenLanguageCode !== expected.spokenLanguageCode) errors.push(`${sourceId}: spoken language mismatch`);
    if (data.capture?.httpStatus !== 200) errors.push(`${sourceId}: HTTP status is not 200`);
    if (mode === 'archived-observation') {
      const archive = data.capture?.archive;
      if (!archive || typeof archive !== 'object') {
        errors.push(`${sourceId}: archived capture is missing its archive evidence`);
      } else {
        if (archive.provider !== 'web.archive.org') errors.push(`${sourceId}: unexpected archive provider`);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(archive.capturedAtUtc || '')) {
          errors.push(`${sourceId}: archive capturedAtUtc must be an ISO UTC instant`);
        }
        if (!/^[a-z0-9]{20,}$/i.test(archive.cdxDigest || '')) errors.push(`${sourceId}: archive CDX digest is missing`);
        if (archive.observedDate !== targetDate) errors.push(`${sourceId}: archive observedDate must equal targetDate`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(archive.reportDate || '')) errors.push(`${sourceId}: archive reportDate is missing`);
        if (typeof archive.offsetFromLiveObservationSeconds !== 'number') {
          errors.push(`${sourceId}: archive offset from the live observation hour is missing`);
        }
        // The Chinese list is only archived without `since=daily`, so the recorded URL is
        // the one actually fetched; assert the spoken-language filter survived, since that
        // is what makes the archived page the Chinese list rather than the global one.
        const archivedUrl = String(archive.originalUrl || '');
        if (expected.spokenLanguageCode && !archivedUrl.includes(`spoken_language_code=${expected.spokenLanguageCode}`)) {
          errors.push(`${sourceId}: archived URL is missing the spoken language filter`);
        }
        if (!expected.spokenLanguageCode && /spoken_language_code=/.test(archivedUrl)) {
          errors.push(`${sourceId}: global list must not carry a spoken language filter`);
        }
        // The archive instant recorded in capturedAtUtc must appear in the fetch URL, so
        // the evidence and the bytes cannot describe two different captures.
        const stamp = String(archive.capturedAtUtc || '').replace(/[-:TZ]/g, '');
        if (!stamp || !String(archive.fetchUrl || '').includes(stamp)) {
          errors.push(`${sourceId}: fetch URL does not match the archived timestamp`);
        }
      }
    }

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

  console.log(JSON.stringify({
    targetDate,
    sourceCount: Object.keys(SOURCES).length - skipped.length,
    skippedSources: skipped,
    totalRows,
    totalBytes,
    errorCount: errors.length,
  }, null, 2));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
}

main();
