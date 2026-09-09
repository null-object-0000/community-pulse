#!/usr/bin/env node
/**
 * Capture Product Hunt GraphQL Post nodes into immutable Beijing-day files.
 *
 * GraphQL has no implicit "whole object": `records` preserves each Post node
 * exactly as returned for the explicit SOURCE_FIELDS projection below. No
 * normalization, enrichment, deduplication, ranking, or truncation is applied.
 *
 * Usage:
 *   node scripts/capture_producthunt_raw.js --start 2026-01-01 --end 2026-09-07
 *   node scripts/capture_producthunt_raw.js --resume --end 2026-09-07
 *   node scripts/capture_producthunt_raw.js --date 2026-09-07
 *
 * Requires PRODUCT_HUNT_TOKEN. Completed days are checkpointed independently,
 * so a rate-limit failure can be resumed without rewriting earlier days.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SOURCE_ID = 'producthunt';
const SOURCE_NAME = 'Product Hunt 新品';
const ENDPOINT = 'https://api.producthunt.com/v2/api/graphql';
const TIMEZONE = 'Asia/Shanghai';
const DEFAULT_START = '2026-01-01';
// Product Hunt currently returns at most 20 posts even when a larger `first`
// value is requested. Keep the request and cursor semantics aligned with that
// observed server-side limit.
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGES_PER_DAY = 100;
// Four complete sweeps stay below the combined capacity of five configured
// applications. A day that still cannot converge must fail for review instead
// of silently hammering every 15-minute quota window.
const MAX_PASSES_PER_DAY = 4;
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_OUT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw', SOURCE_ID);
const PROXY = process.env.COMMUNITY_PULSE_PROXY === undefined
  ? 'http://127.0.0.1:7890'
  : process.env.COMMUNITY_PULSE_PROXY;

// These fields are known to exist in the API used by the current collector.
// Keeping the projection explicit makes schema changes reviewable and avoids
// presenting a normalized downstream record as source-native data.
// Include every source field used by downstream reporting. Older schemaVersion 1
// files used the first six fields only and remain readable; new captures also
// preserve official feature time and engagement metrics so normalization never
// needs a second API request.
const SOURCE_FIELDS = [
  'id', 'name', 'tagline', 'url', 'createdAt', 'description',
  'featuredAt', 'votesCount', 'commentsCount',
  'website', 'productLinks',
];
const SOURCE_PROJECTION = SOURCE_FIELDS
  .map((field) => field === 'productLinks' ? 'productLinks { type url }' : field)
  .join(' ');

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

function parseArgs(argv) {
  const date = value(argv, '--date');
  const pageSize = Number(value(argv, '--page-size') || DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20) {
    throw new Error('--page-size must be an integer between 1 and 20');
  }
  return {
    start: date || value(argv, '--start') || DEFAULT_START,
    end: date || value(argv, '--end') || beijingDateStr(new Date(Date.now() - 86400000)),
    outRoot: path.resolve(value(argv, '--out-root') || DEFAULT_OUT_ROOT),
    pageSize,
    resume: argv.includes('--resume'),
    replace: argv.includes('--replace'),
    waitOnRateLimit: argv.includes('--wait-on-rate-limit'),
    refreshFeatured: argv.includes('--refresh-featured'),
    reverse: argv.includes('--reverse'),
    stopOnRateLimit: argv.includes('--stop-on-rate-limit'),
  };
}

function assertDate(input, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) throw new Error(`${name} must be YYYY-MM-DD: ${input}`);
  const parsed = new Date(`${input}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime()) || beijingDateStr(parsed) !== input) {
    throw new Error(`${name} is not a valid calendar date: ${input}`);
  }
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

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function orderedDates(start, end, reverse) {
  const dates = eachDate(start, end);
  return reverse ? dates.reverse() : dates;
}

function firstMissingDate(outRoot, start, end, reverse) {
  for (const targetDate of orderedDates(start, end, reverse)) {
    if (!fs.existsSync(path.join(outRoot, `${targetDate}.json`))) return targetDate;
  }
  return null;
}

function escapeGraphQLString(input) {
  return JSON.stringify(input);
}

function requestGraphQL(query) {
  const ph = require('./ph_tokens');
  const tokens = ph.getTokens();
  if (!tokens.length) throw new Error('PRODUCT_HUNT_TOKEN is required');
  const marker = `__PRODUCT_HUNT_HTTP_META_${crypto.randomBytes(8).toString('hex')}__`;

  let lastError;
  // 每个 token 最多试 3 次(网络瞬断重试), 429 标记冷却并换下一个
  for (let round = 0; round < tokens.length; round += 1) {
    const token = ph.nextToken();
    if (!token) break; // 全部冷却中
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const args = [
        '-sS', '--max-time', '45', '-X', 'POST', ENDPOINT,
        '-H', `Authorization: Bearer ${token}`,
        '-H', 'Content-Type: application/json',
        '-H', 'Accept: application/json',
        '-H', 'User-Agent: community-pulse-source-capture/1',
        '-d', JSON.stringify({ query }),
        '-w', `\n${marker}%{http_code}|%header{x-rate-limit-limit}|%header{x-rate-limit-remaining}|%header{x-rate-limit-reset}`,
      ];
      if (PROXY) args.push('-x', PROXY);
      else args.push('--noproxy', '*');
      try {
        const output = execFileSync('curl', args, {
          encoding: 'utf8',
          maxBuffer: 30 * 1024 * 1024,
          timeout: 50000,
        });
        const markerIndex = output.lastIndexOf(`\n${marker}`);
        if (markerIndex < 0) throw new Error('curl response is missing its HTTP status marker');
        const body = output.slice(0, markerIndex);
        const meta = output.slice(markerIndex + marker.length + 1).trim().split('|');
        const status = Number(meta[0]);
        const rateLimit = {
          limit: Number(meta[1]) || null,
          remaining: Number(meta[2]) || null,
          resetSeconds: Number(meta[3]) || null,
          credentialIndex: tokens.indexOf(token) + 1,
        };
        let payload;
        try {
          payload = JSON.parse(body);
        } catch (error) {
          throw new Error(`HTTP ${status}: response is not JSON (${error.message})`);
        }
        if (status === 429) {
          ph.markCooldown(token, rateLimit.resetSeconds || Number(payload.errors?.[0]?.details?.reset_in) || 900);
          const rateError = new Error('PH_API_RATE_LIMITED: HTTP 429');
          rateError.code = 'PH_API_RATE_LIMITED';
          rateError.retryAfterSeconds = rateLimit.resetSeconds || Number(payload.errors?.[0]?.details?.reset_in) || 900;
          rateError.rateLimit = rateLimit;
          throw rateError;
        }
        if (status < 200 || status >= 300) throw new Error(`HTTP ${status}: ${body.slice(0, 300)}`);
        if (Array.isArray(payload.errors) && payload.errors.length) {
          const serialized = JSON.stringify(payload.errors);
          if (/rate.?limit/i.test(serialized)) {
            ph.markCooldown(token, rateLimit.resetSeconds || Number(payload.errors[0]?.details?.reset_in) || 900);
            const rateError = new Error(`PH_API_RATE_LIMITED: ${serialized.slice(0, 300)}`);
            rateError.code = 'PH_API_RATE_LIMITED';
            rateError.retryAfterSeconds = rateLimit.resetSeconds || Number(payload.errors[0]?.details?.reset_in) || 900;
            rateError.rateLimit = rateLimit;
            throw rateError;
          }
          throw new Error(`PH_API_ERROR: ${serialized.slice(0, 500)}`);
        }
        if (!payload.data) throw new Error('GraphQL response is missing data');
        return { data: payload.data, rateLimit };
      } catch (error) {
        // execFileSync may echo argv in its error message. Never allow the
        // Authorization token to reach logs, even on curl failures.
        const safeMessage = require('./ph_tokens').redact(String(error.message || error), tokens);
        lastError = new Error(safeMessage);
        lastError.code = error.code;
        lastError.retryAfterSeconds = error.retryAfterSeconds;
        lastError.rateLimit = error.rateLimit;
        if (/PH_API_RATE_LIMITED/.test(safeMessage)) break; // 429 → 换下一个 token
        if (/PH_API_ERROR/.test(safeMessage)) break;
        if (attempt < 3) execFileSync('sleep', [String(attempt)]);
      }
    }
  }
  if (lastError?.code === 'PH_API_RATE_LIMITED' && lastError.rateLimit) {
    const rate = lastError.rateLimit;
    lastError.message += ` (credential ${rate.credentialIndex}, remaining ${rate.remaining ?? '?'}/${rate.limit ?? '?'}, reset ${rate.resetSeconds ?? '?'}s)`;
  }
  throw lastError;
}

function waitForRateLimit(error, targetDate) {
  let remaining = Math.max(1, Math.ceil(Number(error.retryAfterSeconds) || 900)) + 2;
  console.error(`[producthunt] ${targetDate}: rate limited; waiting ${remaining}s before retry`);
  while (remaining > 0) {
    const interval = Math.min(60, remaining);
    execFileSync('sleep', [String(interval)]);
    remaining -= interval;
    if (remaining > 0) console.error(`[producthunt] ${targetDate}: rate-limit wait ${remaining}s remaining`);
  }
}

function queryForDay(targetDate, after, pageSize, featuredOnly = false) {
  const dayStart = new Date(`${targetDate}T00:00:00+08:00`);
  const nextDayStart = new Date(dayStart.getTime() + 86400000);
  // Ask one millisecond beyond the lower boundary and through the next day's
  // midnight, then assign locally. This avoids depending on whether the API's
  // postedAfter/postedBefore comparisons are inclusive.
  const postedAfter = new Date(dayStart.getTime() - 1).toISOString();
  const postedBefore = nextDayStart.toISOString();
  const afterArgument = after ? `, after: ${escapeGraphQLString(after)}` : '';
  const featuredArgument = featuredOnly ? ', featured: true' : '';
  // Ranking changes while votes arrive, which makes offset cursors overlap
  // heavily during a long sweep. Historical NEWEST has tied timestamps, but in
  // practice its source ordering is substantially more stable than RANKING.
  const order = 'NEWEST';
  return `{
    posts(
      order: ${order},
      first: ${pageSize}${afterArgument}${featuredArgument},
      postedAfter: ${escapeGraphQLString(postedAfter)},
      postedBefore: ${escapeGraphQLString(postedBefore)}
    ) {
      edges {
        node { ${SOURCE_PROJECTION} }
      }
      totalCount
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

function fetchDay(targetDate, pageSize, waitOnRateLimit, featuredOnly = false) {
  const records = [];
  const ids = new Set();
  const seenReturnedIds = new Set();
  const excludedAdjacentIds = new Set();
  const pages = [];
  let duplicateEdgeCount = 0;
  let reportedTotalCount = null;

  for (let pass = 1; pass <= MAX_PASSES_PER_DAY; pass += 1) {
    let after = null;
    const cursors = new Set();
    for (let pageInPass = 1; pageInPass <= MAX_PAGES_PER_DAY; pageInPass += 1) {
      let data;
      let response;
      while (!data) {
        try {
          response = requestGraphQL(queryForDay(targetDate, after, pageSize, featuredOnly));
          data = response.data;
        } catch (error) {
          if (waitOnRateLimit && error.code === 'PH_API_RATE_LIMITED') {
            // Keep the pages already fetched for this day in memory and retry
            // the same cursor after reset.
            waitForRateLimit(error, targetDate);
            continue;
          }
          throw error;
        }
      }
      const connection = data.posts;
      if (!connection || !Array.isArray(connection.edges) || !connection.pageInfo) {
        throw new Error(`${targetDate} pass ${pass} page ${pageInPass}: malformed posts connection`);
      }
      if (!Number.isInteger(connection.totalCount) || connection.totalCount < 0) {
        throw new Error(`${targetDate} pass ${pass} page ${pageInPass}: invalid posts.totalCount`);
      }
      if (reportedTotalCount === null) reportedTotalCount = connection.totalCount;
      else if (reportedTotalCount !== connection.totalCount) {
        throw new Error(`${targetDate}: totalCount changed during pagination`);
      }
      const pageInfo = connection.pageInfo;
      if (typeof pageInfo.hasNextPage !== 'boolean') {
        throw new Error(`${targetDate} pass ${pass} page ${pageInPass}: missing pageInfo.hasNextPage`);
      }

      let acceptedCount = 0;
      let newUniqueReturnedCount = 0;
      let pageDuplicateCount = 0;
      for (const [index, edge] of connection.edges.entries()) {
        const record = edge?.node;
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          throw new Error(`${targetDate} pass ${pass} page ${pageInPass} edge ${index}: node is not an object`);
        }
        if (!record.id) throw new Error(`${targetDate} pass ${pass} page ${pageInPass} edge ${index}: node has no id`);
        const id = String(record.id);
        if (seenReturnedIds.has(id)) {
          duplicateEdgeCount += 1;
          pageDuplicateCount += 1;
          continue;
        }
        seenReturnedIds.add(id);
        newUniqueReturnedCount += 1;
        const createdAt = new Date(record.createdAt);
        if (Number.isNaN(createdAt.getTime())) throw new Error(`${targetDate} post ${record.id}: invalid createdAt`);
        if (beijingDateStr(createdAt) !== targetDate) {
          excludedAdjacentIds.add(id);
          continue;
        }
        if (ids.has(id)) throw new Error(`${targetDate}: internal duplicate post id ${record.id}`);
        ids.add(id);
        records.push(record);
        acceptedCount += 1;
      }
      pages.push({
        number: pages.length + 1,
        pass,
        pageInPass,
        returnedEdgeCount: connection.edges.length,
        newUniqueReturnedCount,
        duplicateEdgeCount: pageDuplicateCount,
        acceptedRecordCount: acceptedCount,
        hasNextPage: pageInfo.hasNextPage,
        endCursor: pageInfo.endCursor || null,
        rateLimitAfter: response.rateLimit,
      });
      const kind = featuredOnly ? 'featured' : 'all';
      const rate = response.rateLimit;
      console.error(
        `[producthunt] ${targetDate} ${kind} pass ${pass} page ${pageInPass}: `
        + `${seenReturnedIds.size}/${reportedTotalCount} unique; credential ${rate.credentialIndex}; `
        + `remaining ${rate.remaining ?? '?'}/${rate.limit ?? '?'}, reset ${rate.resetSeconds ?? '?'}s`,
      );

      if (!pageInfo.hasNextPage) {
        if (seenReturnedIds.size === reportedTotalCount) {
          return {
            records,
            pages,
            excludedAdjacentDayCount: excludedAdjacentIds.size,
            reportedTotalCount,
            uniqueReturnedCount: seenReturnedIds.size,
            duplicateEdgeCount,
            passCount: pass,
            featuredOnly,
          };
        }
        // Offset cursors can overlap when equal-ranked rows drift. Start a
        // fresh sweep and union by ID until the API-reported total is covered.
        break;
      }
      if (!pageInfo.endCursor) throw new Error(`${targetDate} pass ${pass} page ${pageInPass}: hasNextPage without endCursor`);
      if (!connection.edges.length) throw new Error(`${targetDate} pass ${pass} page ${pageInPass}: empty page has a next page`);
      if (cursors.has(pageInfo.endCursor)) throw new Error(`${targetDate} pass ${pass}: pagination cursor loop`);
      cursors.add(pageInfo.endCursor);
      after = pageInfo.endCursor;
    }
  }
  throw new Error(`${targetDate}: only found ${seenReturnedIds.size}/${reportedTotalCount} unique posts after ${MAX_PASSES_PER_DAY} passes`);
}

function buildFeaturedSection(options, targetDate, capture) {
  const fetchedAt = new Date().toISOString();
  return {
    filter: { featured: true },
    complete: true,
    itemCount: capture.records.length,
    contentSha256: digest(capture.records),
    fetchedAt,
    capture: {
      id: `producthunt-featured-${targetDate}-${fetchedAt.replace(/[-:.]/g, '')}`,
      endpoint: ENDPOINT,
      apiVersion: 'v2 GraphQL',
      sourceFields: SOURCE_FIELDS,
      order: 'NEWEST',
      pageSize: options.pageSize,
      pageCount: capture.pages.length,
      returnedEdgeCount: capture.pages.reduce((sum, page) => sum + page.returnedEdgeCount, 0),
      reportedTotalCount: capture.reportedTotalCount,
      uniqueReturnedCount: capture.uniqueReturnedCount,
      duplicateEdgeCount: capture.duplicateEdgeCount,
      passCount: capture.passCount,
      excludedAdjacentDayCount: capture.excludedAdjacentDayCount,
      stoppedBecause: 'hasNextPage=false',
      pages: capture.pages,
    },
    records: capture.records,
  };
}

function updateFeaturedSection(options, targetDate, featuredCapture) {
  const file = path.join(options.outRoot, `${targetDate}.json`);
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  const allIds = new Set((document.records || []).map((record) => String(record.id)));
  for (const record of featuredCapture.records) {
    if (!allIds.has(String(record.id))) throw new Error(`${targetDate}: featured post ${record.id} is absent from all posts`);
  }
  document.officialFeatured = buildFeaturedSection(options, targetDate, featuredCapture);
  atomicWrite(file, `${JSON.stringify(document, null, 2)}\n`);
}

function writeDay(options, targetDate, capture, featuredCapture) {
  const file = path.join(options.outRoot, `${targetDate}.json`);
  const contentSha256 = digest(capture.records);
  if (fs.existsSync(file) && !options.replace) {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (existing.contentSha256 !== contentSha256) {
      throw new Error(`${file} already exists with different content; use --replace only after review`);
    }
    return 'unchanged';
  }
  const fetchedAt = new Date().toISOString();
  const document = {
    schemaVersion: 1,
    sourceId: SOURCE_ID,
    sourceName: SOURCE_NAME,
    targetDate,
    timezone: TIMEZONE,
    status: capture.records.length ? 'ok' : 'empty',
    complete: true,
    itemCount: capture.records.length,
    contentSha256,
    fetchedAt,
    capture: {
      id: `producthunt-${targetDate}-${fetchedAt.replace(/[-:.]/g, '')}`,
      mode: options.start === options.end ? 'daily-finalized-date' : 'historical-reconstruction',
      endpoint: ENDPOINT,
      apiVersion: 'v2 GraphQL',
      sourceFields: SOURCE_FIELDS,
      order: 'NEWEST',
      pageSize: options.pageSize,
      pageCount: capture.pages.length,
      returnedEdgeCount: capture.pages.reduce((sum, page) => sum + page.returnedEdgeCount, 0),
      reportedTotalCount: capture.reportedTotalCount,
      uniqueReturnedCount: capture.uniqueReturnedCount,
      duplicateEdgeCount: capture.duplicateEdgeCount,
      passCount: capture.passCount,
      excludedAdjacentDayCount: capture.excludedAdjacentDayCount,
      stoppedBecause: 'hasNextPage=false',
      pages: capture.pages,
    },
    officialFeatured: buildFeaturedSection(options, targetDate, featuredCapture),
    records: capture.records,
  };
  atomicWrite(file, `${JSON.stringify(document, null, 2)}\n`);
  return 'written';
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  assertDate(options.start, '--start');
  assertDate(options.end, '--end');
  if (options.start > options.end) throw new Error('--start must not be after --end');

  if (options.resume) {
    const missingDate = firstMissingDate(options.outRoot, options.start, options.end, options.reverse);
    if (!missingDate) {
      console.log(JSON.stringify({
        sourceId: SOURCE_ID, start: options.start, end: options.end,
        outRoot: options.outRoot, resumed: true, noOp: true,
        reason: 'all daily files already exist',
      }, null, 2));
      return;
    }
    if (options.reverse) options.end = missingDate;
    else options.start = missingDate;
  }

  let written = 0;
  let unchanged = 0;
  let totalRecords = 0;
  let pagesFetched = 0;
  let stoppedAt = null;
  for (const targetDate of orderedDates(options.start, options.end, options.reverse)) {
    try {
      const file = path.join(options.outRoot, `${targetDate}.json`);
      if (fs.existsSync(file) && !options.replace) {
        const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (options.refreshFeatured || !existing.officialFeatured) {
          const featuredCapture = fetchDay(targetDate, options.pageSize, options.waitOnRateLimit, true);
          updateFeaturedSection(options, targetDate, featuredCapture);
          console.error(`[producthunt] ${targetDate}: added ${featuredCapture.records.length} official featured records`);
          written += 1;
          pagesFetched += featuredCapture.pages.length;
          continue;
        }
        unchanged += 1;
        continue;
      }
      const capture = fetchDay(targetDate, options.pageSize, options.waitOnRateLimit);
      const featuredCapture = fetchDay(targetDate, options.pageSize, options.waitOnRateLimit, true);
      const outcome = writeDay(options, targetDate, capture, featuredCapture);
      if (outcome === 'written') written += 1;
      else unchanged += 1;
      totalRecords += capture.records.length;
      pagesFetched += capture.pages.length + featuredCapture.pages.length;
      console.error(`[producthunt] ${targetDate}: ${capture.records.length} all, ${featuredCapture.records.length} official featured`);
    } catch (error) {
      if (options.stopOnRateLimit && error.code === 'PH_API_RATE_LIMITED') {
        stoppedAt = targetDate;
        console.error(`[producthunt] ${targetDate}: rate limited; stopping cleanly before writing this day`);
        break;
      }
      throw error;
    }
  }

  console.log(JSON.stringify({
    sourceId: SOURCE_ID,
    start: options.start,
    end: options.end,
    outRoot: options.outRoot,
    resumed: options.resume,
    pageSize: options.pageSize,
    reverse: options.reverse,
    written,
    unchanged,
    totalRecords,
    pagesFetched,
    stoppedAt,
    stoppedBecause: stoppedAt ? 'rate-limit' : null,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
