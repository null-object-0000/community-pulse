#!/usr/bin/env node
/**
 * Backfill GitHub Trending observation snapshots from the Internet Archive.
 *
 * Why this is not the thing `capture_github_trending_raw.js` refuses to do:
 * that script refuses to label a *live* response with a past date, because a live
 * page is today's rolling window, not the past day's list. A Wayback capture is
 * the opposite: it is the page as it actually read on that day, so it carries the
 * observation date as evidence rather than asserting it. Every file written here
 * therefore records `capture.mode: 'archived-observation'` plus the archive
 * timestamp and CDX digest, and `historicalBackfillSupported` stays false so the
 * live capture path keeps its own rule.
 *
 * Which archived URL is used matters and is recorded verbatim:
 *   - global list: `https://github.com/trending` is archived many times per day.
 *     The `?since=daily` variant is NOT (sparse captures), so the bare URL is used.
 *   - Chinese list: only `https://github.com/trending?spoken_language_code=zh` is
 *     archived, and only on a minority of days. `since` defaults to `daily` on
 *     GitHub, so the archived page is the daily list either way.
 *
 * The capture closest to the hour the daily job actually runs (00:07 Asia/Shanghai,
 * i.e. 16:07 UTC on the report day) is chosen, and the offset is stored so a reader
 * can tell how far the observation drifted from the live pipeline's moment.
 *
 * Arguments are *report* dates, because that is the unit a reader cares about; the
 * script derives the observation (snapshot) date as report date + 1, matching the
 * live pipeline's mapping.
 *
 * Usage:
 *   node backfill_github_trending_wayback.js --start 2026-06-22 --end 2026-08-31 --dry-run
 *   node backfill_github_trending_wayback.js --start 2026-06-22 --end 2026-08-31
 *   node backfill_github_trending_wayback.js --report 2026-09-05
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const TIMEZONE = 'Asia/Shanghai';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_OUT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');
const DEFAULT_REPORT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'raw');
const ARCHIVE = 'web.archive.org';
const CDX_ENDPOINT = `http://${ARCHIVE}/cdx/search/cdx`;
// The daily job starts at 00:07 Asia/Shanghai; the page it reads is the one live at
// that moment, which is 16:07 UTC on the *previous* (report) calendar day.
const LIVE_OBSERVATION_UTC_HOUR = 16;
const LIVE_OBSERVATION_UTC_MINUTE = 7;
const REQUEST_DELAY_MS = Number(process.env.WAYBACK_DELAY_MS || 1200);
const MAX_ATTEMPTS = Number(process.env.WAYBACK_ATTEMPTS || 6);

const SOURCES = [
  {
    id: 'github-trending',
    name: 'GitHub Trending 每日热榜',
    archivedUrl: 'https://github.com/trending',
    since: 'daily',
    spokenLanguageCode: null,
  },
  {
    id: 'github-trending-cn',
    name: 'GitHub Trending 中文圈',
    archivedUrl: 'https://github.com/trending?spoken_language_code=zh',
    since: 'daily',
    spokenLanguageCode: 'zh',
  },
];

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function has(argv, name) {
  return argv.includes(name);
}

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inspectHtml(buffer) {
  const html = buffer.toString('utf8');
  const rows = html.split('class="Box-row"').slice(1);
  const repositoryPaths = [];
  for (const row of rows) {
    const match = row.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"?#]+)"/i);
    if (match) repositoryPaths.push(match[1].trim());
  }
  const languages = rows
    .map((row) => row.match(/<span itemprop="programmingLanguage">([^<]+)<\/span>/i)?.[1]?.trim() || '')
    .filter(Boolean);
  return { html, rowCount: rows.length, repositoryPaths, languageCount: languages.length };
}

function curl(args, options = {}) {
  return execFileSync('curl', args, {
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    timeout: options.timeout || 90000,
  });
}

// CDX lists every capture of the exact URL inside the window, including repeats on
// the same day. `filter=statuscode:200` drops the archive's own error captures.
//
// An empty body is a normal answer meaning "nothing matched", but the archive also
// returns empty bodies, HTML 503 pages and 502s while it is briefly offline, so every
// attempt is retried and only a well-formed JSON array (possibly empty) is accepted.
async function listCaptures(source, from, to) {
  const url = `${CDX_ENDPOINT}?url=${encodeURIComponent(source.archivedUrl)}`
    + `&from=${from.replace(/-/g, '')}&to=${to.replace(/-/g, '')}`
    + '&output=json&fl=timestamp,original,mimetype,statuscode,digest&filter=statuscode:200';
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const text = curl(['-sS', '-L', '--max-time', '75', url], { timeout: 80000 }).trim();
      if (!text) {
        if (attempt < MAX_ATTEMPTS) {
          lastError = new Error('CDX returned an empty body');
          await sleep(REQUEST_DELAY_MS * attempt * 2);
          continue;
        }
        return [];
      }
      if (!text.startsWith('[')) throw new Error('CDX did not return JSON (archive offline?)');
      const rows = JSON.parse(text);
      if (!rows.length) return [];
      return rows.slice(1).map((row) => ({
        timestamp: row[0], original: row[1], mimetype: row[2], status: row[3], digest: row[4],
      })).filter((capture) => capture.mimetype === 'text/html');
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await sleep(REQUEST_DELAY_MS * attempt * 2);
    }
  }
  throw new Error(`${source.id}: CDX lookup failed (${lastError ? lastError.message : 'unknown'})`);
}

function timestampToUtcIso(timestamp) {
  return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T`
    + `${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}Z`;
}

// Snapshot files are named by the Beijing calendar day the page was observed, while
// CDX timestamps are UTC. A capture at 01:57 UTC on the 14th is Beijing 09:57 on the
// 14th, NOT an observation of the 15th — so every candidate is re-labelled by its
// Beijing date and captures from the wrong Beijing day are dropped.
function beijingDateOf(timestamp) {
  const utc = Date.parse(timestampToUtcIso(timestamp));
  return new Date(utc + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// The report day's live observation instant, as an epoch value: 00:07 Asia/Shanghai on
// the observation day, i.e. 16:07 UTC on the report day. The closest capture on the
// *correct Beijing day* wins; there is no requirement to land inside a tolerance, but
// the offset is recorded so a reader can see how far the archive drifted.
function liveObservationInstant(reportDate) {
  return Date.parse(`${reportDate}T${String(LIVE_OBSERVATION_UTC_HOUR).padStart(2, '0')}:`
    + `${String(LIVE_OBSERVATION_UTC_MINUTE).padStart(2, '0')}:00Z`);
}

function pickCapture(onDay, reportDate) {
  const target = liveObservationInstant(reportDate);
  let best = null;
  for (const capture of onDay) {
    const at = Date.parse(timestampToUtcIso(capture.timestamp));
    const delta = Math.abs(at - target);
    if (!best || delta < Math.abs(best.deltaSeconds * 1000)) best = { ...capture, deltaSeconds: Math.round((at - target) / 1000) };
  }
  return best;
}

// One CDX lookup per source for the whole window. Asking per day would mean ~150 queries,
// and the archive answers "no captures that day" with an empty body, which is indistinguishable
// from a transient failure without retries — so the cheap query is also the reliable one.
async function captureIndex(sources, from, to) {
  const index = new Map();
  for (const source of sources) {
    const captures = await listCaptures(source, from, to);
    const byDay = new Map();
    for (const capture of captures) {
      const day = beijingDateOf(capture.timestamp);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(capture);
    }
    index.set(source.id, { byDay, total: captures.length });
    console.error(`[cdx] ${source.id}: ${captures.length} captures in ${from}..${to}, `
      + `${byDay.size} distinct Beijing days`);
    await sleep(REQUEST_DELAY_MS);
  }
  return index;
}

async function fetchArchived(source, capture) {
  const url = `http://web.archive.org/web/${capture.timestamp}id_/${capture.original}`;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'trending-wayback-'));
    const bodyFile = path.join(temporary, 'body');
    try {
      // `id_` returns the archived bytes as stored, which may or may not be gzip, and the
      // transport header does not reliably agree with the body. curl is therefore not asked
      // to decode anything (--compressed makes it fail with "incorrect header check" on
      // exactly those captures); the bytes are demultiplexed by their own magic instead.
      // The Wayback banner is absent, so the body is the page's own bytes.
      const metadata = curl([
        '-sS', '-L', '--max-time', '80',
        '-D', path.join(temporary, 'headers'), '-o', bodyFile,
        '-w', '%{http_code}\t%{url_effective}\t%{content_type}',
        url,
      ], { timeout: 90000 }).trim();
      const [statusText, effectiveUrl, contentType] = metadata.split('\t');
      const httpStatus = Number(statusText);
      let body = fs.readFileSync(bodyFile);
      if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
      if (httpStatus !== 200) throw new Error(`HTTP ${httpStatus}`);
      if (body.length < 10000) throw new Error(`body too small (${body.length} bytes)`);
      return { body, httpStatus, effectiveUrl, contentType, rawHeaders: fs.readFileSync(path.join(temporary, 'headers')) };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await sleep(REQUEST_DELAY_MS * attempt * 2);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  throw new Error(`${source.id}: ${lastError ? lastError.message : 'unknown fetch failure'}`);
}

function reportHasTrending(reportRoot, date) {
  const file = path.join(reportRoot, `${date}.json`);
  if (!fs.existsSync(file)) return null;
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  let rows = 0;
  for (const result of report.results || []) {
    if (result.sourceId === 'github-trending' || result.sourceId === 'github-trending-cn') {
      rows += (result.items || []).length;
    }
  }
  return rows;
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

async function main() {
  const argv = process.argv.slice(2);
  const outRoot = path.resolve(value(argv, '--out-root') || DEFAULT_OUT_ROOT);
  const reportRoot = path.resolve(value(argv, '--report-root') || DEFAULT_REPORT_ROOT);
  const dryRun = has(argv, '--dry-run');
  const replace = has(argv, '--replace');
  const only = value(argv, '--source');
  const sources = only ? SOURCES.filter((source) => source.id === only) : SOURCES;
  if (!sources.length) throw new Error(`unknown --source ${only}`);
  const reportDates = targetDates(argv).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));

  const summary = { dryRun, reportDates: reportDates.length, written: 0, skipped: 0, failed: [], rows: {}, missingCn: [] };

  // A Beijing observation day spans UTC [report date 16:00, observation date 16:00], so the
  // CDX window opens one UTC day before the first report and closes on the last observation day.
  const index = await captureIndex(
    sources,
    shiftDate(reportDates[0], -1),
    shiftDate(reportDates[reportDates.length - 1], 1),
  );

  for (const reportDate of reportDates) {
    const existingRows = reportHasTrending(reportRoot, reportDate);
    if (existingRows === null) {
      summary.skipped += 1;
      console.error(`[skip] ${reportDate}: no published report`);
      continue;
    }
    if (existingRows > 0 && !replace) {
      summary.skipped += 1;
      console.error(`[skip] ${reportDate}: report already carries ${existingRows} trending rows (real live observation)`);
      continue;
    }
    const observedDate = shiftDate(reportDate, 1);
    for (const source of sources) {
      const file = path.join(outRoot, source.id, `${observedDate}.json`);
      if (fs.existsSync(file) && !replace) {
        summary.skipped += 1;
        console.error(`[skip] ${source.id} ${observedDate}: snapshot already exists`);
        continue;
      }
      try {
        const dayIndex = index.get(source.id) || { byDay: new Map(), total: 0 };
        const onDay = dayIndex.byDay.get(observedDate) || [];
        const capture = pickCapture(onDay, reportDate);
        if (!capture) {
          // A missing Chinese-list day is expected (only a minority of days are archived);
          // a missing global-list day would be a real gap in the window.
          if (source.id === 'github-trending') summary.failed.push(`${source.id} ${observedDate}: no archived capture`);
          else summary.missingCn.push(observedDate);
          console.error(`[none] ${source.id} ${observedDate}: no capture on that Beijing day `
            + `(${dayIndex.total} captures in the whole window, none on this day)`);
          continue;
        }
        const result = await fetchArchived(source, capture);
        const evidence = inspectHtml(result.body);
        if (!/<html[\s>]/i.test(evidence.html)) throw new Error('archived body is not HTML');
        if (!evidence.rowCount) throw new Error('archived page has no Box-row entries');
        if (evidence.repositoryPaths.length !== evidence.rowCount) {
          throw new Error(`parsed ${evidence.repositoryPaths.length}/${evidence.rowCount} repository paths`);
        }
        if (new Set(evidence.repositoryPaths).size !== evidence.repositoryPaths.length) {
          throw new Error('duplicate repository paths in archived page');
        }
        const data = {
          schemaVersion: 1,
          sourceId: source.id,
          sourceName: source.name,
          targetDate: observedDate,
          timezone: TIMEZONE,
          status: 'ok',
          complete: true,
          fetchedAt: new Date().toISOString(),
          itemCount: evidence.rowCount,
          contentSha256: sha256(result.body),
          capture: {
            mode: 'archived-observation',
            historicalBackfillSupported: false,
            requestUrl: capture.original,
            effectiveUrl: result.effectiveUrl,
            since: source.since,
            spokenLanguageCode: source.spokenLanguageCode,
            httpStatus: result.httpStatus,
            contentType: result.contentType,
            bodyByteLength: result.body.length,
            repositoryPaths: evidence.repositoryPaths,
            archive: {
              provider: ARCHIVE,
              // The archived page carries only `spoken_language_code` for the Chinese
              // list; GitHub's `since` default is `daily`, which `since` above records.
              originalUrl: capture.original,
              capturedAtUtc: timestampToUtcIso(capture.timestamp),
              capturedAtBeijing: new Date(Date.parse(timestampToUtcIso(capture.timestamp)) + 8 * 3600 * 1000)
                .toISOString().replace('T', ' ').slice(0, 19),
              observedDate,
              reportDate,
              cdxDigest: capture.digest,
              cdxCaptureCount: dayIndex.total,
              cdxCapturesOnObservationDay: onDay.length,
              fetchUrl: `http://web.archive.org/web/${capture.timestamp}id_/${capture.original}`,
              offsetFromLiveObservationSeconds: capture.deltaSeconds,
            },
            itemCount: evidence.rowCount,
            languageRowCount: evidence.languageCount,
          },
          response: {
            transferEncoding: 'base64',
            contentEncoding: 'gzip',
            body: zlib.gzipSync(result.body, { level: 9 }).toString('base64'),
            rawHeaders: result.rawHeaders.toString('base64'),
          },
        };
        summary.rows[source.id] = (summary.rows[source.id] || 0) + evidence.rowCount;
        if (dryRun) {
          console.error(`[dry] ${source.id} ${observedDate} (report ${reportDate}): ${evidence.rowCount} rows, `
            + `${evidence.languageCount} with language, archive ${capture.timestamp} `
            + `(${capture.deltaSeconds}s from live hour, ${onDay.length} captures on the observation day)`);
        } else {
          atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
          summary.written += 1;
          console.error(`[ok] ${source.id} ${observedDate} (report ${reportDate}): ${evidence.rowCount} rows, `
            + `${evidence.languageCount} with language, archive ${capture.timestamp}`);
        }
        await sleep(REQUEST_DELAY_MS);
      } catch (error) {
        summary.failed.push(`${source.id} ${observedDate}: ${error.message}`);
        console.error(`[fail] ${source.id} ${observedDate}: ${error.message}`);
        await sleep(REQUEST_DELAY_MS);
      }
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
