#!/usr/bin/env node
/** Validate Product Hunt daily source/bronze files without network access. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SOURCE_ID = 'producthunt';
const TIMEZONE = 'Asia/Shanghai';
const DEFAULT_START = '2026-01-01';
const BASE_FIELDS = ['id', 'name', 'tagline', 'url', 'createdAt', 'description'];
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw', SOURCE_ID);

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

function validateLinkResolution(section, records, errors, date) {
  const fail = (message) => errors.push(`${date}: linkResolution ${message}`);
  const validUrl = (value, external = false) => {
    try {
      const url = new URL(value);
      return typeof value === 'string' && ['http:', 'https:'].includes(url.protocol)
        && !url.username && !url.password && (!external ||
          !(url.hostname === 'producthunt.com' || url.hostname.endsWith('.producthunt.com')));
    } catch (_) { return false; }
  };
  if (!section || !Array.isArray(section.links)) { fail('links must be an array'); return; }
  const links = section.links;
  if (section.complete !== true) fail('attempts are not complete');
  if (!Number.isFinite(Date.parse(section.fetchedAt))) fail('invalid fetchedAt');
  if (section.itemCount !== links.length) fail('itemCount mismatch');
  if (section.failureCount !== links.filter((link) => link?.ok === false).length) fail('failureCount mismatch');
  if (section.contentSha256 !== digest(links)) fail('hash mismatch');
  const expected = new Set(records.flatMap((record) => [record.website,
    ...(Array.isArray(record.productLinks) ? record.productLinks.map((link) => link?.url) : []),
  ]).filter((url) => typeof url === 'string' && url.length));
  const seen = new Set();
  for (const link of links) {
    if (!link || typeof link !== 'object') { fail('invalid link'); continue; }
    if (seen.has(link.originalUrl)) fail('duplicate originalUrl');
    seen.add(link.originalUrl);
    // Invalid source URLs are allowed only as recorded failures, never successes.
    if (typeof link.originalUrl !== 'string' || !link.originalUrl || (link.ok && !validUrl(link.originalUrl))) fail('invalid originalUrl');
    if (typeof link.ok !== 'boolean' || link.verified !== false) fail('invalid resolution/verification state');
    if (link.ok ? (!validUrl(link.resolvedUrl, true) || link.error !== null)
      : (link.resolvedUrl !== null || typeof link.error !== 'string' || !link.error)) fail('invalid result');
    if (!Number.isFinite(link.elapsedMs) || link.elapsedMs < 0 || !Number.isFinite(Date.parse(link.fetchedAt))) fail('invalid timing');
    if (!Array.isArray(link.chain)) { fail('chain must be an array'); continue; }
    if (link.chain.length > 20) fail('too many requests');
    if (link.ok) {
      try {
        const last = link.chain.at(-1);
        const destination = last ? new URL(last.location, last.url).href : new URL(link.originalUrl).href;
        if (destination !== link.resolvedUrl || (last && !(last.status >= 300 && last.status < 400 && last.location))) {
          fail('resolvedUrl does not match redirect evidence');
        }
      } catch (_) { fail('invalid resolution evidence'); }
    }
    for (const hop of link.chain) {
      if (!hop || !validUrl(hop.url) || validUrl(hop.url, true)
        || !['HEAD', 'GET'].includes(hop.method) || ![1, 2].includes(hop.attempt)
        || !(hop.status === null ? typeof hop.error === 'string'
          : Number.isInteger(hop.status) && hop.status >= 100 && hop.status <= 599)
        || !(hop.location === null || typeof hop.location === 'string')) fail('invalid chain hop');
      if (hop?.location) {
        try { if (!validUrl(new URL(hop.location, hop.url).href) && link.ok) fail('invalid Location'); }
        catch (_) { if (link.ok) fail('invalid Location'); }
      }
    }
  }
  if (seen.size !== expected.size || [...expected].some((url) => !seen.has(url))) fail('source URL coverage mismatch');
}

// Additive by-ID media capture for 日报 rows outside the official-featured subset.
// Every record must be attributable to the same day's full `records` sweep; the
// section never replaces `records` or `officialFeatured`, so their hashes stand.
function validateRecordMedia(section, records, errors, date) {
  const fail = (message) => errors.push(`${date}: recordMedia ${message}`);
  if (!section || typeof section !== 'object' || !Array.isArray(section.records)) {
    fail('records must be an array');
    return;
  }
  if (section.complete !== true) fail('attempts are not complete');
  if (!Number.isFinite(Date.parse(section.fetchedAt))) fail('invalid fetchedAt');
  const fields = section.sourceFields;
  if (!Array.isArray(fields) || ['id', 'thumbnail', 'media'].some((field) => !fields.includes(field))) {
    fail('source field projection is missing media fields');
  }
  if (section.itemCount !== section.records.length) fail('itemCount mismatch');
  if (section.requestedCount !== section.records.length) fail('requestedCount mismatch');
  if (section.failureCount !== section.records.filter((record) => record?.error).length) fail('failureCount mismatch');
  if (section.contentSha256 !== digest(section.records)) fail('hash mismatch');
  const known = new Set(records.map((record) => String(record?.id)));
  const seen = new Set();
  for (const record of section.records) {
    const id = String(record?.id || '');
    if (!id) { fail('record without id'); continue; }
    if (seen.has(id)) fail(`duplicate id ${id}`);
    seen.add(id);
    if (!known.has(id)) fail(`${id} is absent from the day's records`);
    if (record.error) {
      if (typeof record.error !== 'string') fail(`${id} has a non-string error`);
      continue;
    }
    for (const field of ['thumbnail', 'media']) {
      if (!Object.prototype.hasOwnProperty.call(record, field)) fail(`${id} missing ${field}`);
    }
    if (record.thumbnail !== null && typeof record.thumbnail?.url !== 'string') fail(`${id} invalid thumbnail`);
    if (record.media !== null) {
      if (!Array.isArray(record.media) || record.media.some((entry) => typeof entry?.url !== 'string')) {
        fail(`${id} invalid media`);
      }
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  const root = path.resolve(value(argv, '--root') || DEFAULT_ROOT);
  const start = value(argv, '--start') || DEFAULT_START;
  const end = value(argv, '--end') || beijingDateStr(new Date(Date.now() - 86400000));
  const errors = [];
  const globalIds = new Map();
  let totalRecords = 0;
  let totalPages = 0;
  let emptyDays = 0;
  let totalOfficialFeatured = 0;
  let totalProductPageFailures = 0;

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
    if (data.sourceId !== SOURCE_ID) errors.push(`${targetDate}: wrong sourceId`);
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
    if (!data.records.length) emptyDays += 1;

    const capture = data.capture;
    if (!capture || capture.stoppedBecause !== 'hasNextPage=false') {
      errors.push(`${targetDate}: no terminal pagination proof`);
    }
    if (!Array.isArray(capture?.pages) || !capture.pages.length) {
      errors.push(`${targetDate}: capture.pages must be a non-empty array`);
    } else {
      totalPages += capture.pages.length;
      if (capture.pageCount !== capture.pages.length) errors.push(`${targetDate}: pageCount mismatch`);
      if (capture.pages.at(-1).hasNextPage !== false) errors.push(`${targetDate}: last page still hasNextPage`);
      for (const [index, page] of capture.pages.entries()) {
        if (page.number !== index + 1) errors.push(`${targetDate}: non-sequential page number`);
      }
      const accepted = capture.pages.reduce((sum, page) => sum + page.acceptedRecordCount, 0);
      const returned = capture.pages.reduce((sum, page) => sum + page.returnedEdgeCount, 0);
      const uniqueReturned = capture.uniqueReturnedCount ?? returned;
      if (accepted !== data.records.length) errors.push(`${targetDate}: accepted pagination count mismatch`);
      if (returned !== capture.returnedEdgeCount) errors.push(`${targetDate}: returnedEdgeCount mismatch`);
      if (uniqueReturned !== capture.reportedTotalCount) errors.push(`${targetDate}: API totalCount was not fully fetched`);
      if (accepted + capture.excludedAdjacentDayCount !== uniqueReturned) {
        errors.push(`${targetDate}: assigned and excluded records do not cover unique returned posts`);
      }
    }
    const sourceFields = capture?.sourceFields;
    if (!Array.isArray(sourceFields) || BASE_FIELDS.some((field) => !sourceFields.includes(field))) {
      errors.push(`${targetDate}: source field projection is missing base fields`);
    }

    const localIds = new Set();
    for (const record of data.records) {
      totalRecords += 1;
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        errors.push(`${targetDate}: record is not an object`);
        continue;
      }
      for (const field of Array.isArray(sourceFields) ? sourceFields : BASE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(record, field)) errors.push(`${targetDate}: ${record.id || '?'} missing ${field}`);
      }
      if (!record.id) {
        errors.push(`${targetDate}: record without id`);
        continue;
      }
      const id = String(record.id);
      if (localIds.has(id)) errors.push(`${targetDate}: duplicate id ${id}`);
      localIds.add(id);
      if (globalIds.has(id)) errors.push(`${targetDate}: id ${id} also appears on ${globalIds.get(id)}`);
      globalIds.set(id, targetDate);
      const createdAt = new Date(record.createdAt);
      if (Number.isNaN(createdAt.getTime())) errors.push(`${targetDate}: ${id} has invalid createdAt`);
      else if (beijingDateStr(createdAt) !== targetDate) {
        errors.push(`${targetDate}: ${id} belongs to ${beijingDateStr(createdAt)}`);
      }
    }

    const featured = data.officialFeatured;
    if (!featured || featured.filter?.featured !== true || featured.complete !== true) {
      errors.push(`${targetDate}: missing complete officialFeatured section`);
    } else if (!Array.isArray(featured.records)) {
      errors.push(`${targetDate}: officialFeatured.records is not an array`);
    } else {
      totalOfficialFeatured += featured.records.length;
      if (featured.itemCount !== featured.records.length) errors.push(`${targetDate}: officialFeatured itemCount mismatch`);
      if (featured.contentSha256 !== digest(featured.records)) errors.push(`${targetDate}: officialFeatured hash mismatch`);
      const featuredIds = new Set();
      for (const record of featured.records) {
        const id = String(record?.id || '');
        if (!id) errors.push(`${targetDate}: officialFeatured record without id`);
        else if (!localIds.has(id)) errors.push(`${targetDate}: officialFeatured ${id} absent from all records`);
        if (featuredIds.has(id)) errors.push(`${targetDate}: duplicate officialFeatured id ${id}`);
        featuredIds.add(id);
      }
      const fc = featured.capture;
      const featuredFields = fc?.sourceFields;
      if (!Array.isArray(featuredFields) || BASE_FIELDS.some((field) => !featuredFields.includes(field))) {
        errors.push(`${targetDate}: officialFeatured source field projection is missing base fields`);
      }
      for (const record of featured.records) {
        for (const field of Array.isArray(featuredFields) ? featuredFields : BASE_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(record, field)) {
            errors.push(`${targetDate}: officialFeatured ${record?.id || '?'} missing ${field}`);
          }
        }
      }
      if (!Array.isArray(fc?.pages) || !fc.pages.length || fc.pages.at(-1).hasNextPage !== false) {
        errors.push(`${targetDate}: incomplete officialFeatured pagination proof`);
      } else {
        const returned = fc.pages.reduce((sum, page) => sum + page.returnedEdgeCount, 0);
        const uniqueReturned = fc.uniqueReturnedCount ?? returned;
        if (returned !== fc.returnedEdgeCount || uniqueReturned !== fc.reportedTotalCount) {
          errors.push(`${targetDate}: officialFeatured totalCount mismatch`);
        }
      }
    }

    if (data.recordMedia !== undefined) {
      validateRecordMedia(data.recordMedia, data.records || [], errors, targetDate);
    }
    if (data.linkResolution !== undefined) {
      validateLinkResolution(data.linkResolution, featured?.records || [], errors, targetDate);
    }
    if (data.productPages !== undefined) {
      const productPages = data.productPages;
      // 兼容两种格式：
      //  v1 旧格式: {complete, itemCount, contentSha256, pages[]}（无 failures 字段）
      //  v2 新格式: 追加 failures/failureCount/attemptedCount，complete=false 表示当天有个别产品页抓取失败(403/404 等)
      const legacyFormat = !Array.isArray(productPages?.failures);
      if (!Array.isArray(productPages?.pages) || (legacyFormat && productPages?.complete !== true)) {
        errors.push(`${targetDate}: invalid productPages capture`);
      } else if (legacyFormat) {
        if (productPages.itemCount !== productPages.pages.length) errors.push(`${targetDate}: productPages itemCount mismatch`);
        if (productPages.contentSha256 !== digest(productPages.pages)) errors.push(`${targetDate}: productPages hash mismatch`);
        const coveredPostIds = new Set();
        for (const page of productPages.pages) {
          if (!/^https:\/\/www\.producthunt\.com\/products\/[^/]+$/.test(page.url || '')) {
            errors.push(`${targetDate}: invalid product page URL ${page.url || '(missing)'}`);
          }
          let body = '';
          try {
            body = zlib.gunzipSync(Buffer.from(page.response?.body || '', 'base64')).toString('utf8');
          } catch (error) {
            errors.push(`${targetDate}: ${page.url || '?'} invalid compressed body (${error.message})`);
            continue;
          }
          if (page.response?.status !== 200 || !/<html\b/i.test(body)) errors.push(`${targetDate}: ${page.url} invalid HTML response`);
          if (page.response?.byteLength !== Buffer.byteLength(body)) errors.push(`${targetDate}: ${page.url} byteLength mismatch`);
          if (page.response?.contentSha256 !== digest(body)) errors.push(`${targetDate}: ${page.url} body hash mismatch`);
          for (const id of page.postIds || []) coveredPostIds.add(String(id));
        }
        for (const record of featured?.records || []) {
          if (!coveredPostIds.has(String(record.id))) errors.push(`${targetDate}: featured ${record.id} has no product page`);
        }
      } else {
        const pageFailures = productPages.failures;
        const allUrls = [...productPages.pages.map((p) => p.url), ...pageFailures.map((f) => f.url)];
        if (new Set(allUrls).size !== allUrls.length) errors.push(`${targetDate}: duplicate product page URL`);
        if (productPages.complete !== (pageFailures.length === 0)) errors.push(`${targetDate}: productPages complete flag mismatch`);
        if (productPages.itemCount !== productPages.pages.length) errors.push(`${targetDate}: productPages itemCount mismatch`);
        if (productPages.failureCount !== pageFailures.length) errors.push(`${targetDate}: productPages failureCount mismatch`);
        if (productPages.attemptedCount !== allUrls.length) errors.push(`${targetDate}: productPages attemptedCount mismatch`);
        if (productPages.contentSha256 !== digest({ pages: productPages.pages, failures: pageFailures })) {
          errors.push(`${targetDate}: productPages hash mismatch`);
        }
        for (const failure of pageFailures) {
          if (!/^https:\/\/www\.producthunt\.com\/products\/[^/]+$/.test(failure.url || '')) {
            errors.push(`${targetDate}: invalid failed product page URL ${failure.url || '(missing)'}`);
          }
          if (typeof failure.error !== 'string' || !failure.error) errors.push(`${targetDate}: ${failure.url || '?'} missing failure reason`);
        }
        totalProductPageFailures += pageFailures.length;
        const coveredPostIds = new Set();
        for (const page of productPages.pages) {
          if (!/^https:\/\/www\.producthunt\.com\/products\/[^/]+$/.test(page.url || '')) {
            errors.push(`${targetDate}: invalid product page URL ${page.url || '(missing)'}`);
          }
          let body = '';
          try {
            body = zlib.gunzipSync(Buffer.from(page.response?.body || '', 'base64')).toString('utf8');
          } catch (error) {
            errors.push(`${targetDate}: ${page.url || '?'} invalid compressed body (${error.message})`);
            continue;
          }
          if (page.response?.status !== 200 || !/<html\b/i.test(body)) errors.push(`${targetDate}: ${page.url} invalid HTML response`);
          if (page.response?.byteLength !== Buffer.byteLength(body)) errors.push(`${targetDate}: ${page.url} byteLength mismatch`);
          if (page.response?.contentSha256 !== digest(body)) errors.push(`${targetDate}: ${page.url} body hash mismatch`);
          for (const id of page.postIds || []) coveredPostIds.add(String(id));
        }
        // 抓取失败的产品页所覆盖的条目予以豁免(它们已进入 failures 记录)。
        for (const failure of pageFailures) {
          for (const id of failure.postIds || []) coveredPostIds.add(String(id));
        }
        for (const record of featured?.records || []) {
          if (!coveredPostIds.has(String(record.id))) errors.push(`${targetDate}: featured ${record.id} has no product page`);
        }
      }
    }
  }

  const summary = {
    sourceId: SOURCE_ID,
    root,
    start,
    end,
    expectedDays: eachDate(start, end).length,
    emptyDays,
    totalRecords,
    uniqueIds: globalIds.size,
    totalOfficialFeatured,
    totalPages,
    totalProductPageFailures,
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
