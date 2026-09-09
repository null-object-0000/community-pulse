#!/usr/bin/env node
/**
 * Capture GitHub Trending's current daily pages as immutable observation snapshots.
 *
 * GitHub Trending has no historical date parameter. A file therefore belongs to
 * the Beijing calendar day on which the page was observed; this script refuses
 * to label a live response as another day.
 *
 * Usage:
 *   node scripts/capture_github_trending_raw.js
 *   node scripts/capture_github_trending_raw.js --date 2026-09-08
 *   node scripts/capture_github_trending_raw.js --replace
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
const PROXY = process.env.COMMUNITY_PULSE_PROXY === undefined
  ? 'http://127.0.0.1:7890'
  : process.env.COMMUNITY_PULSE_PROXY;
const SOURCES = [
  {
    id: 'github-trending',
    name: 'GitHub Trending 每日热榜',
    url: 'https://github.com/trending?since=daily',
    since: 'daily',
    spokenLanguageCode: null,
  },
  {
    id: 'github-trending-cn',
    name: 'GitHub Trending 中文圈',
    url: 'https://github.com/trending?since=daily&spoken_language_code=zh',
    since: 'daily',
    spokenLanguageCode: 'zh',
  },
];

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function beijingDateStr(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
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

function inspectHtml(buffer) {
  const html = buffer.toString('utf8');
  const rows = html.split('class="Box-row"').slice(1);
  const repositoryPaths = [];
  for (const row of rows) {
    const match = row.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"?#]+)"/i);
    if (match) repositoryPaths.push(match[1].trim());
  }
  return { html, rowCount: rows.length, repositoryPaths };
}

function fetchPage(source) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'community-pulse-trending-'));
  const bodyFile = path.join(temporary, 'body');
  const headerFile = path.join(temporary, 'headers');
  const marker = `__TRENDING_${crypto.randomBytes(8).toString('hex')}__`;
  const args = [
    '-sS', '-L', '--compressed', '--max-time', '45',
    '-A', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 community-pulse-source-capture/1',
    '-D', headerFile, '-o', bodyFile,
    '-w', `${marker}%{http_code}\t%{url_effective}\t%{content_type}`,
  ];
  if (PROXY) args.push('-x', PROXY);
  args.push(source.url);

  try {
    const metadata = execFileSync('curl', args, {
      encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 50000,
    });
    if (!metadata.startsWith(marker)) throw new Error('curl response is missing its metadata marker');
    const [statusText, effectiveUrl, contentType] = metadata.slice(marker.length).split('\t');
    const httpStatus = Number(statusText);
    const body = fs.readFileSync(bodyFile);
    const rawHeaders = fs.readFileSync(headerFile);
    if (httpStatus !== 200) throw new Error(`${source.id}: HTTP ${httpStatus}`);

    const evidence = inspectHtml(body);
    if (!/^\s*<!doctype html/i.test(evidence.html) && !/<html[\s>]/i.test(evidence.html)) {
      throw new Error(`${source.id}: response is not an HTML document`);
    }
    if (!/github\.com\/trending/i.test(effectiveUrl || source.url)) {
      throw new Error(`${source.id}: unexpected effective URL ${effectiveUrl}`);
    }
    if (evidence.rowCount === 0) throw new Error(`${source.id}: no Box-row entries found`);
    if (evidence.repositoryPaths.length !== evidence.rowCount) {
      throw new Error(`${source.id}: parsed ${evidence.repositoryPaths.length}/${evidence.rowCount} repository paths`);
    }
    if (new Set(evidence.repositoryPaths).size !== evidence.repositoryPaths.length) {
      throw new Error(`${source.id}: duplicate repository paths in page`);
    }
    return { body, rawHeaders, httpStatus, effectiveUrl, contentType, evidence };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  const observedAt = new Date();
  const today = beijingDateStr(observedAt);
  const targetDate = value(argv, '--date') || today;
  const outRoot = path.resolve(value(argv, '--out-root') || DEFAULT_OUT_ROOT);
  const replace = argv.includes('--replace');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('--date must be YYYY-MM-DD');
  if (targetDate !== today) {
    throw new Error(`GitHub Trending cannot be backfilled: requested ${targetDate}, current Beijing date is ${today}`);
  }

  for (const source of SOURCES) {
    const file = path.join(outRoot, source.id, `${targetDate}.json`);
    if (fs.existsSync(file) && !replace) {
      console.log(`[${source.id}] ${targetDate}: already exists`);
      continue;
    }
    const result = fetchPage(source);
    const data = {
      schemaVersion: 1,
      sourceId: source.id,
      sourceName: source.name,
      targetDate,
      timezone: TIMEZONE,
      status: 'ok',
      complete: true,
      fetchedAt: observedAt.toISOString(),
      itemCount: result.evidence.rowCount,
      contentSha256: sha256(result.body),
      capture: {
        mode: 'observed-snapshot',
        historicalBackfillSupported: false,
        requestUrl: source.url,
        effectiveUrl: result.effectiveUrl,
        since: source.since,
        spokenLanguageCode: source.spokenLanguageCode,
        httpStatus: result.httpStatus,
        contentType: result.contentType,
        bodyByteLength: result.body.length,
        repositoryPaths: result.evidence.repositoryPaths,
      },
      response: {
        transferEncoding: 'base64',
        contentEncoding: 'gzip',
        body: zlib.gzipSync(result.body, { level: 9 }).toString('base64'),
        rawHeaders: result.rawHeaders.toString('base64'),
      },
    };
    atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`[${source.id}] ${targetDate}: wrote ${data.itemCount} rows (${data.capture.bodyByteLength} bytes)`);
  }
}

main();
