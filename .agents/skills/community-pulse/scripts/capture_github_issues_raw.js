#!/usr/bin/env node
/**
 * Capture source-native GitHub Issue objects into immutable Beijing-day files.
 * Pull requests returned by GitHub's Issues endpoint are excluded explicitly.
 *
 * Usage:
 *   node scripts/capture_github_issues_raw.js
 *   node scripts/capture_github_issues_raw.js --start 2026-01-01 --end 2026-09-07
 *   node scripts/capture_github_issues_raw.js --resume --end 2026-09-07
 *   node scripts/capture_github_issues_raw.js --source weekly-issues --date 2026-09-07
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TIMEZONE = 'Asia/Shanghai';
const DEFAULT_START = '2026-01-01';
const PER_PAGE = 100;
const MAX_PAGES = 200;
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_OUT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');
const PRIOR_STORE_ROOT = path.join(VAULT, '.agents', 'skills', 'community-pulse', 'data', 'issues');
const SOURCES = {
  'weekly-issues': {
    name: '阮一峰周刊·用户投稿',
    repo: 'ruanyf/weekly',
    priorStore: 'ruanyf.json',
  },
  'hellogithub-issues': {
    name: 'HelloGitHub·用户投稿',
    repo: '521xueweihan/HelloGitHub',
    priorStore: 'hellogithub.json',
  },
};

function beijingDateStr(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  const date = value('--date');
  const requestedSource = value('--source');
  if (requestedSource && !SOURCES[requestedSource]) {
    throw new Error(`unknown --source: ${requestedSource}`);
  }
  return {
    start: date || value('--start') || DEFAULT_START,
    end: date || value('--end') || beijingDateStr(new Date(Date.now() - 86400000)),
    outRoot: path.resolve(value('--out-root') || DEFAULT_OUT_ROOT),
    sourceIds: requestedSource ? [requestedSource] : Object.keys(SOURCES),
    resume: argv.includes('--resume'),
    replace: argv.includes('--replace'),
  };
}

function assertDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must be YYYY-MM-DD: ${value}`);
  const parsed = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime()) || beijingDateStr(parsed) !== value) {
    throw new Error(`${name} is not a valid calendar date: ${value}`);
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
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function firstMissingDate(root, sourceId, start, end) {
  for (const targetDate of eachDate(start, end)) {
    if (!fs.existsSync(path.join(root, sourceId, `${targetDate}.json`))) return targetDate;
  }
  return null;
}

function ghJson(endpoint) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const output = execFileSync('gh', ['api', endpoint], {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 60000,
      });
      const value = JSON.parse(output);
      if (!Array.isArray(value)) throw new Error('GitHub response is not an array');
      return value;
    } catch (error) {
      lastError = error;
      if (attempt < 3) execFileSync('sleep', [String(attempt)]);
    }
  }
  throw new Error(`gh api failed after 3 attempts: ${lastError.message}`);
}

function fetchSince(repo, start) {
  const since = new Date(`${start}T00:00:00+08:00`).toISOString();
  const records = [];
  let pageCount = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const endpoint = `repos/${repo}/issues?state=all&per_page=${PER_PAGE}&sort=created&direction=asc&since=${encodeURIComponent(since)}&page=${page}`;
    const batch = ghJson(endpoint);
    pageCount += 1;
    records.push(...batch);
    if (batch.length < PER_PAGE) {
      return { records, pageCount, since, stoppedBecause: 'short-page' };
    }
  }
  throw new Error(`${repo} pagination exceeded ${MAX_PAGES} pages`);
}

function loadPriorRecords(fileName, start, end) {
  const file = path.join(PRIOR_STORE_ROOT, fileName);
  if (!fs.existsSync(file)) return [];
  const records = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(records)) throw new Error(`${file} is not an array`);
  return records.filter((record) => {
    if (!record.created_at || Number.isNaN(new Date(record.created_at).getTime())) return false;
    const day = beijingDateStr(new Date(record.created_at));
    return day >= start && day <= end;
  });
}

function captureSource(options, sourceId) {
  const source = SOURCES[sourceId];
  let start = options.start;
  if (options.resume) {
    const missingDate = firstMissingDate(options.outRoot, sourceId, start, options.end);
    if (!missingDate) {
      return {
        sourceId,
        start,
        end: options.end,
        resumed: true,
        noOp: true,
        reason: 'all daily files already exist',
      };
    }
    start = missingDate;
  }

  const fetchedAt = new Date().toISOString();
  const fetched = fetchSince(source.repo, start);
  const apiRecordsInRange = fetched.records.filter((record) => {
    if (!record.created_at || Number.isNaN(new Date(record.created_at).getTime())) return false;
    const day = beijingDateStr(new Date(record.created_at));
    return day >= start && day <= options.end;
  });
  const priorRecordsInRange = loadPriorRecords(source.priorStore, start, options.end);
  const apiIds = new Set(apiRecordsInRange.map((record) => record.id));
  const mergedById = new Map(priorRecordsInRange.map((record) => [record.id, record]));
  for (const record of apiRecordsInRange) mergedById.set(record.id, record);
  const inRangeRecords = [...mergedById.values()].sort((a, b) => {
    const byTime = new Date(a.created_at) - new Date(b.created_at);
    return byTime || String(a.id).localeCompare(String(b.id));
  });
  const pullRequests = inRangeRecords.filter((record) => record.pull_request);
  const issues = inRangeRecords.filter((record) => !record.pull_request);
  const priorOnlyIssueIds = new Set(priorRecordsInRange
    .filter((record) => !record.pull_request && !apiIds.has(record.id))
    .map((record) => record.id));
  const byDay = new Map();
  const pullRequestsByDay = new Map();
  const priorOnlyIssuesByDay = new Map();
  for (const pullRequest of pullRequests) {
    const day = beijingDateStr(new Date(pullRequest.created_at));
    pullRequestsByDay.set(day, (pullRequestsByDay.get(day) || 0) + 1);
  }
  for (const issue of issues) {
    if (!issue.id || !issue.created_at || Number.isNaN(new Date(issue.created_at).getTime())) {
      throw new Error(`${source.repo} returned an issue with invalid id/created_at`);
    }
    const day = beijingDateStr(new Date(issue.created_at));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(issue);
    if (priorOnlyIssueIds.has(issue.id)) {
      priorOnlyIssuesByDay.set(day, (priorOnlyIssuesByDay.get(day) || 0) + 1);
    }
  }

  let written = 0;
  let unchanged = 0;
  let totalRecords = 0;
  for (const targetDate of eachDate(start, options.end)) {
    const file = path.join(options.outRoot, sourceId, `${targetDate}.json`);
    if (fs.existsSync(file) && !options.replace) {
      unchanged += 1;
      continue;
    }
    const records = byDay.get(targetDate) || [];
    totalRecords += records.length;
    const document = {
      schemaVersion: 1,
      sourceId,
      sourceName: source.name,
      repository: source.repo,
      targetDate,
      timezone: TIMEZONE,
      status: records.length ? 'ok' : 'empty',
      complete: true,
      itemCount: records.length,
      contentSha256: digest(records),
      fetchedAt,
      capture: {
        mode: start === options.end ? 'daily-finalized-date' : 'historical-reconstruction',
        endpoint: `https://api.github.com/repos/${source.repo}/issues`,
        querySince: fetched.since,
        pageCount: fetched.pageCount,
        scannedItemCount: fetched.records.length,
        excludedPullRequestCount: pullRequestsByDay.get(targetDate) || 0,
        supplementedFromPriorCaptureCount: priorOnlyIssuesByDay.get(targetDate) || 0,
        priorCapturePath: `.agents/skills/community-pulse/data/issues/${source.priorStore}`,
        stoppedBecause: fetched.stoppedBecause,
      },
      records,
    };
    atomicWrite(file, `${JSON.stringify(document, null, 2)}\n`);
    written += 1;
  }

  return {
    sourceId,
    repository: source.repo,
    start,
    end: options.end,
    resumed: options.resume,
    pagesFetched: fetched.pageCount,
    scannedItemCount: fetched.records.length,
    apiRecordsInRange: apiRecordsInRange.length,
    priorRecordsInRange: priorRecordsInRange.length,
    excludedPullRequestCount: pullRequests.length,
    supplementedFromPriorCaptureCount: priorOnlyIssueIds.size,
    written,
    unchanged,
    totalRecords,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  assertDate(options.start, '--start');
  assertDate(options.end, '--end');
  if (options.start > options.end) throw new Error('--start must not be after --end');
  const results = options.sourceIds.map((sourceId) => captureSource(options, sourceId));
  console.log(JSON.stringify({ outRoot: options.outRoot, results }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
