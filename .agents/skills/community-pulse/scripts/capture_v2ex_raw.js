#!/usr/bin/env node
/**
 * Capture the V2EX 「分享创造」 (create) node as an immutable observation snapshot.
 *
 * This is the Chinese-speaking world's main "I built a thing" channel — the
 * counterpart to Show HN — and it fills the gap between 中国独立开发者 (a curated
 * README board) and the submission streams (阮一峰 / HelloGitHub issues).
 *
 * The official public API has no date or pagination parameter: it returns the
 * node's current 10 topics. A file therefore belongs to the Beijing calendar day
 * on which it was observed, and this script refuses to label a live response as
 * another day — the same rule GitHub Trending follows. Older days simply cannot
 * be recovered, so `capture.historicalBackfillSupported` stays false.
 *
 * It deliberately does NOT hit the data: a fresh install reads the public API
 * (`/api/topics/show.json?node_name=create`), whose payload is a curated cache.
 *
 * Usage:
 *   node scripts/capture_v2ex_raw.js
 *   node scripts/capture_v2ex_raw.js --date 2026-09-13
 *   node scripts/capture_v2ex_raw.js --node create
 *   node scripts/capture_v2ex_raw.js --replace
 *   node scripts/capture_v2ex_raw.js --dry-run
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const TIMEZONE = 'Asia/Shanghai';
const SOURCE_ID = 'v2ex';
const SOURCE_NAME = 'V2EX · 分享创造';
// 分享创造 = "I made this". 程序员 covers tooling talk rather than launches, and
// its 10 rows overlap the same limit, so one node keeps the signal clean.
const DEFAULT_NODE = 'create';
const NODE_TITLES = { create: '分享创造', programmer: '程序员', share: '分享发现', ideas: '奇思妙想' };
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_OUT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');
const ENDPOINT = 'https://www.v2ex.com/api/topics/show.json';
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

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function fetchNode(nodeName) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'community-pulse-v2ex-'));
  const bodyFile = path.join(temporary, 'body');
  const headerFile = path.join(temporary, 'headers');
  const marker = `__V2EX_${crypto.randomBytes(8).toString('hex')}__`;
  const url = `${ENDPOINT}?node_name=${encodeURIComponent(nodeName)}`;
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
    if (httpStatus !== 200) throw new Error(`v2ex: HTTP ${httpStatus}`);
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8')); } catch (error) { throw new Error(`v2ex: response is not JSON (${error.message})`); }
    if (!Array.isArray(parsed)) throw new Error('v2ex: response is not an array of topics');
    return { body, rawHeaders, httpStatus, effectiveUrl, contentType, parsed };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function toRecords(topics) {
  return topics.map((topic) => ({
    topicId: topic.id,
    title: topic.title || '',
    url: topic.url || `https://www.v2ex.com/t/${topic.id}`,
    author: (topic.member && topic.member.username) || '',
    createdAt: topic.created ? new Date(topic.created * 1000).toISOString() : null,
    createdAtEpoch: topic.created || null,
    replies: topic.replies || 0,
    content: topic.content || '',
    nodeName: (topic.node && topic.node.name) || '',
  }));
}

function main() {
  const argv = process.argv.slice(2);
  const observedAt = new Date();
  const today = beijingDateStr(observedAt);
  const targetDate = value(argv, '--date') || today;
  const nodeName = value(argv, '--node') || DEFAULT_NODE;
  const outRoot = path.resolve(value(argv, '--out-root') || DEFAULT_OUT_ROOT);
  const replace = argv.includes('--replace');
  const dryRun = argv.includes('--dry-run');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('--date must be YYYY-MM-DD');
  if (targetDate !== today) {
    throw new Error(`V2EX has no historical API: requested ${targetDate}, current Beijing date is ${today}`);
  }
  // The node shows its *current* page, so this file records what the node showed at capture
  // time. `capture.topicsCreatedOnObservedDay` states how many rows actually belong to that
  // Beijing day, and the workflow runs just after midnight, so in practice the page is the
  // previous day's final posts. This deliberately mirrors GitHub Trending rather than adding a
  // time-window guard: a guard would fail the whole daily run whenever GitHub's scheduler
  // drifts past it, and V2EX is a secondary source that must never break the report.

  const file = path.join(outRoot, SOURCE_ID, `${targetDate}.json`);
  if (fs.existsSync(file) && !replace) {
    console.log(`[${SOURCE_ID}] ${targetDate}: already exists`);
    return;
  }
  const result = fetchNode(nodeName);
  // The public API is a curated cache, so a topic may be older than the day it
  // was observed on. Keep them (they are what the node showed that day) but
  // record how many actually belong to the observation day.
  const sameDay = result.parsed.filter((topic) => topic.created
    && beijingDateStr(new Date(topic.created * 1000)) === targetDate).length;
  const data = {
    schemaVersion: 1,
    sourceId: SOURCE_ID,
    sourceName: SOURCE_NAME,
    targetDate,
    timezone: TIMEZONE,
    status: result.parsed.length ? 'ok' : 'empty',
    complete: true,
    fetchedAt: observedAt.toISOString(),
    itemCount: result.parsed.length,
    contentSha256: sha256(result.body),
    capture: {
      mode: 'observed-snapshot',
      historicalBackfillSupported: false,
      endpoint: ENDPOINT,
      requestUrl: `${ENDPOINT}?node_name=${encodeURIComponent(nodeName)}`,
      effectiveUrl: result.effectiveUrl,
      httpStatus: result.httpStatus,
      contentType: result.contentType,
      nodeName,
      nodeTitle: NODE_TITLES[nodeName] || nodeName,
      apiReturnsLatestOnly: true,
      topicsCreatedOnObservedDay: sameDay,
      bodyByteLength: result.body.length,
      topicIds: result.parsed.map((topic) => topic.id),
    },
    records: toRecords(result.parsed),
    response: {
      transferEncoding: 'base64',
      contentEncoding: 'gzip',
      body: zlib.gzipSync(result.body, { level: 9 }).toString('base64'),
    },
  };
  if (!dryRun) atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`[${SOURCE_ID}] ${targetDate}: ${dryRun ? 'would write' : 'wrote'} ${data.itemCount} topics `
    + `(node=${nodeName}, ${sameDay} created on the observed day)`);
}

if (require.main === module) main();

module.exports = {
  // Pure predicates so the observation-only rule stays testable without a network call.
  rejectsHistorical: (targetDate, today) => targetDate !== today,
  lastRejectsFuture: (targetDate, today) => targetDate > today,
  beijingDateStr,
};
