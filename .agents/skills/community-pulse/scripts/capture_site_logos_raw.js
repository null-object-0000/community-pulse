#!/usr/bin/env node
/**
 * Website-logo fallback capture.
 *
 * Rows that carry no product mark (VibeCafé `logo`, Product Hunt `thumbnail`) fall back to the
 * logo their official website declares. This script resolves the candidate pages of a report day
 * from the immutable source-raw layer, reads each page's declared icon, downloads the winning icon
 * to prove it really is an image, and stores the evidence as a source layer of its own:
 *
 *   知识/大家都在做什么/source-raw/site-logos/<date>.json
 *
 * The date is the source-raw date the consuming row is loaded from: the report day for regular
 * sources, the observed day for GitHub Trending (same rule as source_raw_items.js). Downstream,
 * `source_raw_items.js` attaches `siteLogo` to those rows offline and the site build mirrors the
 * icon through `npm run images:sync` like any other product mark. A row whose site yields nothing
 * keeps the plain text avatar.
 *
 * Only declared icons are trusted first (apple-touch-icon, rel=icon, schema.org logo) because they
 * are the site's own brand mark; /favicon.ico is the browser default and is tried last. Screenshots
 * and social cards are never used: a shrunk banner is not a logo.
 *
 * Resumable: a day file that already exists is left alone unless `--replace` is given, and
 * `--refresh-failures` only retries the rows that previously failed or found nothing.
 *
 * Usage:
 *   node scripts/capture_site_logos_raw.js --date 2026-09-10 --observed-date 2026-09-11
 *   node scripts/capture_site_logos_raw.js --start 2026-08-01 --end 2026-09-10
 *   node scripts/capture_site_logos_raw.js --date 2026-09-10 --dry-run
 *   node scripts/capture_site_logos_raw.js --date 2026-09-10 --limit 5 --out-root /tmp/logos
 *   node scripts/capture_site_logos_raw.js --start 2026-09-01 --end 2026-09-10 --strict
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { loadItems, loadGithubRepositories, attachRepositoryFacts, OBSERVED_SOURCES, sourceDescriptionLength, meetsDescriptionFloor, DESCRIPTION_MIN_LENGTH } = require('./source_raw_items');
const { candidatePage, parseIconCandidates, parsePageDescription, parseOgImage, pickIcon, faviconUrl, imageKind } = require('./site_logo');

const run = promisify(execFile);
const SOURCE_ID = 'site-logos';
const SOURCE_NAME = '官网 Logo 兜底';
const TIMEZONE = 'Asia/Shanghai';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const CONFIG = path.join(__dirname, '..', 'config', 'sources.json');
const DEFAULT_SOURCE_RAW_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');
const DEFAULT_RAW_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'raw');
const DEFAULT_OUT_ROOT = path.join(DEFAULT_SOURCE_RAW_ROOT, SOURCE_ID);
const PROXY = process.env.COMMUNITY_PULSE_PROXY === undefined
  ? 'http://127.0.0.1:7890'
  : process.env.COMMUNITY_PULSE_PROXY;
// Identify honestly but look like a browser: many small product sites answer 403 to unknown agents.
const USER_AGENT = 'Mozilla/5.0 (compatible; community-pulse-source-capture/1; +https://devtrends.site)';
const PAGE_TIMEOUT = 15;
const ICON_TIMEOUT = 15;
const PAGE_LIMIT = 3 * 1024 * 1024;
const ICON_LIMIT = 2 * 1024 * 1024;
// Mirrored icons live in git forever, so a declared "brand mark" that is really a poster (1 MB PNG
// favicons exist) is rejected and the next candidate — usually the small favicon — is tried.
// SITE_LOGO_MAX_KB loosens or tightens the budget without touching this file.
const ICON_ACCEPT_LIMIT = (Number(process.env.SITE_LOGO_MAX_KB) || 256) * 1024;
const MAX_DECLARED_ATTEMPTS = 3;

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function beijingDateStr(date) {
  return new Date(date).toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
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

function parseArgs(argv) {
  const date = value(argv, '--date');
  const yesterday = beijingDateStr(new Date(Date.now() - 86400000));
  return {
    start: date || value(argv, '--start') || yesterday,
    end: date || value(argv, '--end') || yesterday,
    observedDate: value(argv, '--observed-date'),
    sourceRawRoot: path.resolve(value(argv, '--source-raw-root') || DEFAULT_SOURCE_RAW_ROOT),
    rawRoot: path.resolve(value(argv, '--raw-root') || DEFAULT_RAW_ROOT),
    outRoot: path.resolve(value(argv, '--out-root') || DEFAULT_OUT_ROOT),
    concurrency: Number(value(argv, '--concurrency')) || 6,
    limit: Number(value(argv, '--limit')) || 0,
    replace: argv.includes('--replace'),
    refreshFailures: argv.includes('--refresh-failures'),
    dryRun: argv.includes('--dry-run'),
    strict: argv.includes('--strict'),
  };
}

function digest(valueToHash) {
  return crypto.createHash('sha256').update(JSON.stringify(valueToHash)).digest('hex');
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function shorten(message, limit = 300) {
  return String(message || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// A 日报 records the source-raw file it consumed, which is how a Trending day file is matched to
// the report that used it even when the observation day differs from the report day.
function observedDateByReport(dates, rawRoot) {
  const byReport = new Map();
  for (const date of dates) {
    const file = path.join(rawRoot, `${date}.json`);
    if (!fs.existsSync(file)) continue;
    let report;
    try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
    for (const source of report.results || []) {
      if (!OBSERVED_SOURCES.has(source.sourceId)) continue;
      const observed = String(source.sourceRaw?.path || '').match(/(\d{4}-\d{2}-\d{2})\.json$/)?.[1];
      if (observed) { byReport.set(date, observed); break; }
    }
  }
  return byReport;
}

// candidate: { sourceId, externalId, title, reportDate, pageUrl } keyed per source-raw day file.
function collectCandidates(args, sources) {
  const dates = eachDate(args.start, args.end);
  const observedByReport = args.observedDate ? null : observedDateByReport(dates, args.rawRoot);
  const byFileDate = new Map();
  const skippedSources = [];
  for (const date of dates) {
    const observedDate = args.observedDate || observedByReport?.get(date) || null;
    // A row's official website often only exists as the repository `homepage` in the GitHub
    // snapshot layer, so the snapshot is merged in exactly like collect.js does. Early history has
    // no snapshot at all; the capture then still works from `websiteUrl` / `url`.
    let repositories = null;
    try {
      repositories = loadGithubRepositories(args.sourceRawRoot, date).repositories;
    } catch (error) {
      skippedSources.push(`github-repositories@${date}: ${shorten(error.message, 120)}`);
    }
    for (const source of sources) {
      const observedSource = OBSERVED_SOURCES.has(source.id);
      if (observedSource && !observedDate) {
        skippedSources.push(`${source.id}@${date}: no observation day`);
        continue;
      }
      let loaded;
      try {
        loaded = loadItems(source, { date, observedDate: observedDate || date, rawRoot: args.sourceRawRoot });
      } catch (error) {
        if (args.strict) throw error;
        skippedSources.push(`${source.id}@${date}: ${shorten(error.message, 120)}`);
        continue;
      }
      const fileDate = observedSource ? observedDate : date;
      for (const item of attachRepositoryFacts(loaded.items, repositories)) {
        // 一行有两种理由需要抓官网 HTML：缺产品标志（拿图标）、缺产品描述（拿 <meta description>）。
        // 已有 logo 但描述过短的行不能整行跳过，否则第三级描述永远拿不到。
        const needsIcon = !(item.logo || item.icon);
        const needsDescription = sourceDescriptionLength(item) < DESCRIPTION_MIN_LENGTH
          && !meetsDescriptionFloor(item.github && item.github.description);
        if (!needsIcon && !needsDescription) continue;
        const pageUrl = candidatePage(item);
        if (!pageUrl) continue;
        const key = `${source.id}\u0000${item.externalId || pageUrl}`;
        if (!byFileDate.has(fileDate)) byFileDate.set(fileDate, new Map());
        const bucket = byFileDate.get(fileDate);
        if (bucket.has(key)) continue;
        bucket.set(key, {
          sourceId: source.id,
          externalId: String(item.externalId || ''),
          title: String(item.title || ''),
          reportDate: date,
          pageUrl,
          needsIcon,
          needsDescription,
        });
      }
    }
  }
  return { byFileDate, skippedSources };
}

async function mapWithConcurrency(entries, concurrency, worker) {
  const results = new Array(entries.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, entries.length)) }, async () => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(entries[index], index);
    }
  }));
  return results;
}

function lastResponseHeaders(headerFile) {
  const blocks = fs.readFileSync(headerFile, 'utf8').split(/\r?\n\r?\n/).filter((block) => /^HTTP\//m.test(block));
  return blocks.at(-1) || '';
}

function contentTypeOf(headerBlock) {
  return headerBlock.match(/^content-type:\s*([^;\r\n]+)/im)?.[1]?.trim().toLowerCase() || '';
}

// curl because it honours COMMUNITY_PULSE_PROXY exactly like every other capture script; the body
// goes to a temp file so a redirect chain and the status code stay inspectable.
async function curlToFile(url, { accept, timeout, workingDir, bodyLimit }) {
  const id = crypto.randomUUID();
  const headerFile = path.join(workingDir, `${id}.headers`);
  const bodyFile = path.join(workingDir, `${id}.body`);
  const args = [
    '-sS', '-L', '--compressed', '--max-time', String(timeout), '--connect-timeout', '8',
    '--retry', '1', '--retry-delay', '1', '--retry-connrefused',
    '-A', USER_AGENT, '-H', `Accept: ${accept}`,
    '-D', headerFile, '-o', bodyFile, '-w', '%{http_code}',
  ];
  if (PROXY) args.push('-x', PROXY);
  args.push(url);
  try {
    const { stdout } = await run('curl', args, { timeout: (timeout + 10) * 1000, maxBuffer: 1024 * 1024 });
    const status = Number(String(stdout).trim()) || 0;
    const headerBlock = fs.existsSync(headerFile) ? lastResponseHeaders(headerFile) : '';
    const size = fs.existsSync(bodyFile) ? fs.statSync(bodyFile).size : 0;
    if (status !== 200) return { status, body: null, contentType: contentTypeOf(headerBlock), error: `HTTP ${status || 'failed'}` };
    if (size > bodyLimit) return { status, body: null, contentType: contentTypeOf(headerBlock), error: `response exceeds ${Math.round(bodyLimit / 1024)} KiB` };
    return { status, body: fs.readFileSync(bodyFile), contentType: contentTypeOf(headerBlock), error: '' };
  } catch (error) {
    // curl explains the reason on stderr (DNS failure, TLS, timeout); the wrapper message does not.
    return { status: 0, body: null, contentType: '', error: shorten(error.stderr || error.message) };
  } finally {
    fs.rmSync(headerFile, { force: true });
    fs.rmSync(bodyFile, { force: true });
  }
}

async function fetchPageHtml(pageUrl, workingDir) {
  const response = await curlToFile(pageUrl, {
    accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    timeout: PAGE_TIMEOUT,
    workingDir,
    bodyLimit: PAGE_LIMIT,
  });
  return { ...response, text: response.body ? response.body.toString('utf8') : '' };
}

// The og:image is downloaded only to hash it: the byte size decides nothing, but the dHash is what
// lets the browser drop an og:image that is literally the product's own logo. A failure here is not
// fatal — the gallery simply shows the source's own media and our screenshot.
async function fetchMarkHashes(ogUrl, workingDir, io) {
  if (!ogUrl) return null;
  try {
    const download = await io.fetchIconBytes(ogUrl, workingDir);
    if (!download.body || !download.kind) return null;
    return { url: ogUrl, sha256: crypto.createHash('sha256').update(download.body).digest('hex'), bytes: download.body };
  } catch (_) {
    return null;
  }
}

async function fetchIconBytes(iconUrl, workingDir) {
  const response = await curlToFile(iconUrl, {
    accept: 'image/avif,image/webp,image/svg+xml,image/*,*/*;q=0.8',
    timeout: ICON_TIMEOUT,
    workingDir,
    bodyLimit: ICON_LIMIT,
  });
  if (!response.body) return { ...response, kind: '' };
  try {
    return { ...response, kind: imageKind(response.body) };
  } catch (error) {
    return { status: response.status, body: null, contentType: response.contentType, kind: '', error: `not an image (${shorten(error.message, 60)})` };
  }
}

// One page resolves to one icon. Declared candidates are tried best-first, then the browser
// default; the first downloadable image wins and every attempt is recorded as evidence.
// `io` is injectable so the fall-through rules can be tested without the network.
async function resolvePage(pageUrl, workingDir, iconCache, io = { fetchPageHtml, fetchIconBytes }) {
  const html = await io.fetchPageHtml(pageUrl, workingDir);
  const description = html.text ? parsePageDescription(html.text) : '';
  const declared = html.text ? parseIconCandidates(html.text, pageUrl) : [];
  // The og:image comes out of the SAME response the icons do — one page request per URL, as before.
  // Only its hash is needed (to drop an og:image that is really the product logo), but the bytes
  // have to be downloaded once to compute it.
  const ogImageUrl = html.text ? parseOgImage(html.text, pageUrl) : '';
  let ogImage = null;
  if (ogImageUrl) {
    const hashes = await fetchMarkHashes(ogImageUrl, workingDir, io);
    if (hashes) ogImage = { url: hashes.url, sha256: hashes.sha256 };
  }
  const order = declared.slice(0, MAX_DECLARED_ATTEMPTS);
  const fallback = faviconUrl(pageUrl);
  if (fallback && !order.some((candidate) => candidate.url === fallback)) {
    order.push({ url: fallback, kind: 'default-favicon', priority: 7, sizes: '', size: 0, type: '' });
  }
  if (!order.length) {
    const error = html.error || 'no icon declared and no favicon URL could be derived';
    return { pageUrl, description, ogImage, status: 'failed', declaredIconCount: declared.length, attempts: [], iconUrl: '', iconKind: '', contentType: '', byteLength: 0, contentSha256: '', error };
  }
  const attempts = [];
  let oversized = 0;
  for (const candidate of order) {
    if (iconCache.has(candidate.url)) {
      const cached = iconCache.get(candidate.url);
      attempts.push({ url: candidate.url, kind: cached.kind, status: cached.kind ? 'ok' : 'failed', cached: true, error: cached.error || '' });
      if (cached.kind) {
        return { pageUrl, status: 'ok', declaredIconCount: declared.length, attempts, iconUrl: candidate.url, iconKind: candidate.kind, contentType: cached.contentType, byteLength: cached.byteLength, contentSha256: cached.contentSha256, error: '' };
      }
      continue;
    }
    const download = await io.fetchIconBytes(candidate.url, workingDir);
    const bytes = download.body;
    // A mirrored icon is kept in git forever, so an oversized "brand mark" PNG is skipped in favour
    // of the next declared candidate (usually the small favicon) instead of bloating every future clone.
    const overBudget = Boolean(bytes) && bytes.length > ICON_ACCEPT_LIMIT;
    const error = overBudget
      ? `icon is ${Math.round(bytes.length / 1024)} KiB, over the ${Math.round(ICON_ACCEPT_LIMIT / 1024)} KiB mirror budget`
      : download.error || '';
    if (overBudget) oversized += 1;
    iconCache.set(candidate.url, {
      kind: overBudget ? '' : download.kind,
      contentType: download.contentType,
      byteLength: bytes ? bytes.length : 0,
      contentSha256: bytes && !overBudget ? crypto.createHash('sha256').update(bytes).digest('hex') : '',
      error,
    });
    attempts.push({ url: candidate.url, kind: download.kind, status: download.kind && !overBudget ? 'ok' : 'failed', cached: false, error });
    if (download.kind && !overBudget) {
      return {
        pageUrl,
        description,
        ogImage,
        status: 'ok',
        declaredIconCount: declared.length,
        attempts,
        iconUrl: candidate.url,
        iconKind: candidate.kind,
        contentType: download.contentType,
        byteLength: bytes.length,
        contentSha256: iconCache.get(candidate.url).contentSha256,
        error: '',
      };
    }
  }
  // The page itself loaded but no candidate yielded a usable image: a soft miss, not a failure.
  const status = html.status === 200 ? 'missing' : 'failed';
  const reason = oversized && oversized >= Math.min(declared.length, MAX_DECLARED_ATTEMPTS)
    ? `every declared icon exceeds the ${Math.round(ICON_ACCEPT_LIMIT / 1024)} KiB mirror budget`
    : `no usable icon among ${order.length} candidate(s)`;
  return {
    pageUrl,
    description,
    ogImage,
    status,
    declaredIconCount: declared.length,
    attempts,
    iconUrl: '',
    iconKind: '',
    contentType: '',
    byteLength: 0,
    contentSha256: '',
    error: html.error || reason,
  };
}

// A row is identified by its source and external id; a row whose id drifted still matches by page.
function candidateKey(candidate) {
  return `${candidate.sourceId}\u0000${candidate.externalId || candidate.pageUrl}`;
}

function recordKey(record) {
  return `${record.sourceId}\u0000${record.externalId || record.pageUrl}`;
}

function buildDocument(fileDate, records, context) {
  const okCount = records.filter((record) => record.status === 'ok').length;
  const missingCount = records.filter((record) => record.status === 'missing').length;
  const failureCount = records.filter((record) => record.status === 'failed').length;
  return {
    schemaVersion: 1,
    sourceId: SOURCE_ID,
    sourceName: SOURCE_NAME,
    targetDate: fileDate,
    timezone: TIMEZONE,
    status: records.length ? 'ok' : 'empty',
    complete: context.complete,
    fetchedAt: new Date().toISOString(),
    itemCount: okCount,
    candidateCount: records.length,
    pageCount: new Set(records.map((record) => record.pageUrl)).size,
    missingCount,
    failureCount,
    contentSha256: digest(records),
    capture: {
      mode: 'website-logo-fallback',
      userAgent: USER_AGENT,
      reportDates: [...new Set(records.map((record) => record.reportDate))].sort(),
      skippedSources: context.skippedSources,
      refreshed: context.refreshed,
      limits: {
        pageBytes: PAGE_LIMIT,
        iconBytes: ICON_LIMIT,
        iconAcceptBytes: ICON_ACCEPT_LIMIT,
        pageTimeoutSeconds: PAGE_TIMEOUT,
        iconTimeoutSeconds: ICON_TIMEOUT,
        concurrency: context.concurrency,
        maxDeclaredAttempts: MAX_DECLARED_ATTEMPTS,
      },
    },
    records,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const sources = config.sources.filter((source) => source.enabled);
  const { byFileDate, skippedSources } = collectCandidates(args, sources);
  const fileDates = [...byFileDate.keys()].sort();
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-logo-'));
  const pageCache = new Map();
  const iconCache = new Map();
  const summary = [];

  try {
    for (const fileDate of fileDates) {
      const file = path.join(args.outRoot, `${fileDate}.json`);
      const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      let candidates = [...byFileDate.get(fileDate).values()].sort((a, b) => a.pageUrl.localeCompare(b.pageUrl));
      if (args.limit) candidates = candidates.slice(0, args.limit);
      // One day file is fed by two runs: the report of the previous day files its Trending rows
      // under this observation day, and this day's own report files its regular rows here. Records
      // are stamped with the report that consumed them, so a run only owns and rewrites its own
      // report date and always keeps what the other run established.
      const ownedDates = new Set(candidates.map((candidate) => candidate.reportDate));
      const foreign = (existing?.records || []).filter((record) => !ownedDates.has(record.reportDate));
      const known = new Map();
      if (existing && !args.replace) {
        for (const record of existing.records || []) {
          if (!ownedDates.has(record.reportDate)) continue;
          // Resumable: keep the logos an earlier pass already proved, only redo the rest.
          if (record.status === 'ok' || !args.refreshFailures) known.set(recordKey(record), record);
        }
      }
      const pending = candidates.filter((candidate) => !known.has(candidateKey(candidate)));
      if (args.dryRun) {
        console.log(`[site-logos] ${fileDate}: ${candidates.length} candidates for report ${[...ownedDates].sort().join(', ') || '-'} (${pending.length} to fetch, ${known.size} already known, ${foreign.length} from another run) -> ${file}`);
        for (const candidate of candidates) console.log(`  ${candidate.reportDate} ${candidate.sourceId} ${candidate.externalId} ${candidate.pageUrl}`);
        summary.push({ targetDate: fileDate, dryRun: true, candidateCount: candidates.length, pendingCount: pending.length, keptFromOtherRuns: foreign.length, file });
        continue;
      }
      // Pages repeat across rows and across days; resolve each one once per run.
      const pages = [...new Set(pending.map((candidate) => candidate.pageUrl))];
      const missingPages = pages.filter((page) => !pageCache.has(page));
      console.log(`[site-logos] ${fileDate}: ${candidates.length} rows for report ${[...ownedDates].sort().join(', ') || '-'}, ${pages.length} pages (${pages.length - missingPages.length} reused), ${known.size} kept, ${foreign.length} from another run`);
      let done = 0;
      const resolved = await mapWithConcurrency(missingPages, args.concurrency, async (page) => {
        const result = await resolvePage(page, workingDir, iconCache);
        done += 1;
        if (done % 25 === 0) process.stderr.write(`[site-logos ${fileDate}] ${done}/${missingPages.length} pages resolved\n`);
        return result;
      });
      missingPages.forEach((page, index) => pageCache.set(page, resolved[index]));
      const records = [...foreign];
      for (const candidate of candidates) {
        const kept = known.get(candidateKey(candidate));
        if (kept) { records.push(kept); continue; }
        const page = pageCache.get(candidate.pageUrl);
        records.push({
          sourceId: candidate.sourceId,
          externalId: candidate.externalId,
          title: candidate.title,
          reportDate: candidate.reportDate,
          pageUrl: candidate.pageUrl,
          description: page.description || '',
          ogImage: page.ogImage || null,
          status: page.status,
          iconUrl: page.iconUrl,
          iconKind: page.iconKind,
          contentType: page.contentType,
          byteLength: page.byteLength,
          contentSha256: page.contentSha256,
          declaredIconCount: page.declaredIconCount,
          attempts: page.attempts,
          error: page.error,
        });
      }
      records.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.externalId.localeCompare(b.externalId) || a.pageUrl.localeCompare(b.pageUrl));
      const document = buildDocument(fileDate, records, {
        complete: !args.limit,
        skippedSources,
        refreshed: Boolean(existing && (args.replace || args.refreshFailures)),
        concurrency: args.concurrency,
      });
      atomicWrite(file, `${JSON.stringify(document, null, 2)}\n`);
      console.log(`[site-logos] ${fileDate}: ${document.itemCount} logos, ${document.missingCount} without an icon, ${document.failureCount} failed -> ${file}`);
      summary.push({
        targetDate: fileDate,
        candidateCount: document.candidateCount,
        itemCount: document.itemCount,
        missingCount: document.missingCount,
        failureCount: document.failureCount,
        file,
      });
    }
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
  if (skippedSources.length) console.warn(`[site-logos] skipped: ${skippedSources.join('; ')}`);
  console.log(JSON.stringify({ sourceId: SOURCE_ID, dates: fileDates, summary }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  resolvePage, collectCandidates, observedDateByReport, parseArgs, eachDate, buildDocument,
  ICON_ACCEPT_LIMIT, ICON_LIMIT, PAGE_LIMIT,
};
