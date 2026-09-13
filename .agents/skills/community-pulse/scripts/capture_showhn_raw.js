#!/usr/bin/env node
/**
 * Capture Hacker News "Show HN" rows as immutable per-day source files.
 *
 * Show HN is the English-speaking world's main "I built a thing" channel, so it
 * complements Product Hunt (product launches) and GitHub Trending (repositories)
 * with the maker's own announcement.
 *
 * Unlike GitHub Trending, HN is fully backfillable: the Algolia search API
 * indexes every story with `created_at_i`, so a Beijing calendar day is reproduced
 * exactly from its epoch range. `capture.mode` records which path was used —
 * 'historical-range' for a reconstructed day, 'observed-snapshot' for the live day.
 *
 * Usage:
 *   node scripts/capture_showhn_raw.js                      # today (Beijing)
 *   node scripts/capture_showhn_raw.js --date 2026-09-12
 *   node scripts/capture_showhn_raw.js --start 2026-01-01 --end 2026-09-12
 *   node scripts/capture_showhn_raw.js --date 2026-09-12 --replace
 *   node scripts/capture_showhn_raw.js --date 2026-09-12 --dry-run
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const TIMEZONE = 'Asia/Shanghai';
const SOURCE_ID = 'showhn';
const SOURCE_NAME = 'Hacker News · Show HN';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_OUT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');
const ENDPOINT = 'https://hn.algolia.com/api/v1/search';
// Algolia returns at most 1000 hits per page; a Show HN day is far below that,
// so one request per day is enough and pagination is only a safety net.
const HITS_PER_PAGE = 1000;
const MAX_REQUESTS = 5;
const PROXY = process.env.COMMUNITY_PULSE_PROXY === undefined
  ? 'http://127.0.0.1:7890'
  : process.env.COMMUNITY_PULSE_PROXY;

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

// Beijing midnight → UTC epoch seconds, and the exclusive end of that day.
function beijingDayRange(dateStr) {
  const start = Math.floor(new Date(`${dateStr}T00:00:00+08:00`).getTime() / 1000);
  if (Number.isNaN(start)) throw new Error(`invalid date ${dateStr}`);
  return { start, end: start + 86400 };
}

function eachDate(start, end) {
  const dates = [];
  for (let d = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
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

function curlJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return curlJsonOnce(url);
    } catch (error) {
      lastError = error;
      // A long backfill is one request per day, and a single transient TLS/network hiccup
      // (observed: `curl: (56) OpenSSL SSL_read: unexpected eof`) must not discard the whole
      // run. Back off briefly and retry; the daily workflow runs unattended, so this is what
      // keeps one flaky connection from failing the entire report build.
      if (attempt < attempts) execFileSync('sleep', [String(attempt * 2)]);
    }
  }
  throw lastError;
}

function curlJsonOnce(url) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'community-pulse-showhn-'));
  const bodyFile = path.join(temporary, 'body');
  const headerFile = path.join(temporary, 'headers');
  const marker = `__SHOWHN_${crypto.randomBytes(8).toString('hex')}__`;
  const args = [
    '-sS', '-L', '--compressed', '--max-time', '45',
    '-A', 'Mozilla/5.0 community-pulse-source-capture/1 (+https://devtrends.site)',
    '-D', headerFile, '-o', bodyFile,
    '-w', `${marker}%{http_code}\t%{url_effective}\t%{content_type}`,
  ];
  if (PROXY) args.push('-x', PROXY);
  args.push(url);
  try {
    const metadata = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 50000 });
    if (!metadata.startsWith(marker)) throw new Error('curl response is missing its metadata marker');
    const [statusText, effectiveUrl, contentType] = metadata.slice(marker.length).split('\t');
    const httpStatus = Number(statusText);
    const body = fs.readFileSync(bodyFile);
    const rawHeaders = fs.readFileSync(headerFile);
    if (httpStatus !== 200) throw new Error(`showhn: HTTP ${httpStatus} for ${url}`);
    if (!/json/i.test(contentType || '')) throw new Error(`showhn: unexpected content-type ${contentType}`);
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8')); } catch (error) { throw new Error(`showhn: response is not JSON (${error.message})`); }
    if (!Array.isArray(parsed.hits)) throw new Error('showhn: response has no hits array');
    return { body, rawHeaders, httpStatus, effectiveUrl, contentType, parsed };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// Algolia attaches a per-field highlight copy (`_highlightResult`) and the child comment
// ids. Both describe the response rather than the story and together are ~47% of the
// payload, so they are dropped: the file keeps the story facts and stays reloadable.
function stripHit(hit) {
  if (!hit || typeof hit !== 'object') return hit;
  const { _highlightResult, children, ...keep } = hit;
  return keep;
}
function stripPages(value) {
  if (Array.isArray(value)) return value.map((page) => stripPages(page));
  if (value && Array.isArray(value.hits)) return { ...value, hits: value.hits.map(stripHit) };
  return value;
}

// Fetch every Show HN story created inside the Beijing day, page by page.
function fetchDay(dateStr) {
  const { start, end } = beijingDayRange(dateStr);
  const numericFilters = `created_at_i>${start},created_at_i<${end}`;
  const pages = [];
  const hits = [];
  let nbHits = null;
  let effectiveUrl = '';
  let httpStatus = 0;
  let contentType = '';
  for (let page = 0; page < MAX_REQUESTS; page += 1) {
    const url = `${ENDPOINT}?tags=show_hn&numericFilters=${encodeURIComponent(numericFilters)}`
      + `&hitsPerPage=${HITS_PER_PAGE}&page=${page}`;
    const result = curlJson(url);
    pages.push(result.parsed);
    nbHits = result.parsed.nbHits;
    effectiveUrl = result.effectiveUrl;
    httpStatus = result.httpStatus;
    contentType = result.contentType;
    hits.push(...result.parsed.hits);
    if (hits.length >= (nbHits || 0) || result.parsed.hits.length === 0) break;
  }
  if (nbHits === null) throw new Error(`showhn: no response for ${dateStr}`);
  if (hits.length < nbHits) {
    throw new Error(`showhn: parsed ${hits.length}/${nbHits} hits for ${dateStr}; Algolia pagination limit reached`);
  }
  // A story must fall inside the requested Beijing day; a discrepancy means the
  // numeric filter and the parsed timestamps disagree, which must never be stored.
  for (const hit of hits) {
    const day = beijingDateStr(new Date(hit.created_at_i * 1000));
    if (day !== dateStr) throw new Error(`showhn: hit ${hit.objectID} is dated ${day}, not ${dateStr}`);
  }
  const ids = hits.map((hit) => hit.objectID);
  if (new Set(ids).size !== ids.length) throw new Error(`showhn: duplicate story ids for ${dateStr}`);
  return { hits: hits.map(stripHit), pages: stripPages(pages), nbHits, effectiveUrl, httpStatus, contentType, dayStartEpoch: start, dayEndEpoch: end };
}

// Normalized rows: what the offline converter consumes. The raw JSON pages are
// stored alongside so the validator can re-derive these without the network.
function toRecords(hits) {
  return hits.map((hit) => ({
    objectID: String(hit.objectID),
    title: hit.title || '',
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    author: hit.author || '',
    createdAt: hit.created_at || null,
    createdAtEpoch: hit.created_at_i,
    points: hit.points || 0,
    comments: hit.num_comments || 0,
    storyText: hit.story_text || '',
    hnUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
  }));
}

function main() {
  const argv = process.argv.slice(2);
  const observedAt = new Date();
  const today = beijingDateStr(observedAt);
  const outRoot = path.resolve(value(argv, '--out-root') || DEFAULT_OUT_ROOT);
  const replace = argv.includes('--replace');
  const dryRun = argv.includes('--dry-run');
  const single = value(argv, '--date');
  const start = value(argv, '--start');
  const end = value(argv, '--end');
  if (single && (start || end)) throw new Error('use either --date or --start/--end, not both');

  let dates;
  if (start || end) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
      throw new Error('--start and --end must both be YYYY-MM-DD');
    }
    dates = eachDate(start, end);
  } else {
    const targetDate = single || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('--date must be YYYY-MM-DD');
    dates = [targetDate];
  }
  if (dates.some((date) => date > today)) throw new Error(`cannot capture a future day (current Beijing date is ${today})`);
  // A day that has not ended yet is still missing whatever is posted later, and because the
  // file is then immutable the gap would never close: the next run sees "already exists" and
  // skips. Since Algolia can reproduce any past day exactly, an unfinished day is always
  // better captured tomorrow. The daily workflow passes yesterday's date, so this only fires
  // on a manual same-day run, where failing loudly beats freezing a partial day.
  if (dates.includes(today) && !argv.includes('--allow-partial-day')) {
    throw new Error(`refusing to capture the unfinished Beijing day ${today}: `
      + 'it is missing everything posted later today and would then be frozen. '
      + `Capture it after midnight instead, or pass --allow-partial-day to record a live observation.`);
  }

  let written = 0, skipped = 0;
  for (const targetDate of dates) {
    const file = path.join(outRoot, SOURCE_ID, `${targetDate}.json`);
    if (fs.existsSync(file) && !replace) { console.log(`[${SOURCE_ID}] ${targetDate}: already exists`); skipped += 1; continue; }
    const day = fetchDay(targetDate);
    // The live day is an observation; any earlier day is a reconstruction.
    const mode = targetDate === today ? 'observed-snapshot' : 'historical-range';
    const rawBody = Buffer.from(JSON.stringify(day.pages.length === 1 ? day.pages[0] : day.pages));
    const data = {
      schemaVersion: 1,
      sourceId: SOURCE_ID,
      sourceName: SOURCE_NAME,
      targetDate,
      timezone: TIMEZONE,
      status: day.hits.length ? 'ok' : 'empty',
      complete: true,
      fetchedAt: observedAt.toISOString(),
      itemCount: day.hits.length,
      contentSha256: sha256(rawBody),
      capture: {
        mode,
        historicalBackfillSupported: true,
        endpoint: ENDPOINT,
        requestUrl: `${ENDPOINT}?tags=show_hn&numericFilters=${encodeURIComponent(`created_at_i>${day.dayStartEpoch},created_at_i<${day.dayEndEpoch}`)}`,
        effectiveUrl: day.effectiveUrl,
        httpStatus: day.httpStatus,
        contentType: day.contentType,
        dayStartEpoch: day.dayStartEpoch,
        dayEndEpoch: day.dayEndEpoch,
        nbHits: day.nbHits,
        pagesFetched: day.pages.length,
        bodyByteLength: rawBody.length,
        storyIds: day.hits.map((hit) => String(hit.objectID)),
      },
      records: toRecords(day.hits),
      response: {
        transferEncoding: 'base64',
        contentEncoding: 'gzip',
        body: zlib.gzipSync(rawBody, { level: 9 }).toString('base64'),
      },
    };
    if (!dryRun) atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`[${SOURCE_ID}] ${targetDate}: ${dryRun ? 'would write' : 'wrote'} ${data.itemCount} stories (${mode}, ${data.capture.pagesFetched} page(s))`);
    written += 1;
  }
  console.log(`[${SOURCE_ID}] done: ${written} written, ${skipped} skipped${dryRun ? ' (dry-run)' : ''}`);
}

if (require.main === module) main();
