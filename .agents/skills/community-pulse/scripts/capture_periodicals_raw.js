#!/usr/bin/env node
/**
 * Capture source-native GitHub Contents API objects for published periodicals.
 * Publication dates come from explicit release commits, converted to Beijing day.
 *
 * Usage:
 *   node scripts/capture_periodicals_raw.js --start 2026-01-01 --end 2026-09-07
 *   node scripts/capture_periodicals_raw.js --resume --end 2026-09-07
 *   node scripts/capture_periodicals_raw.js --source weekly-issue --date 2026-09-04
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TIMEZONE = 'Asia/Shanghai';
const DEFAULT_START = '2026-01-01';
const PER_PAGE = 100;
const MAX_PAGES = 20;
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_OUT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');
const SOURCES = {
  'weekly-issue': {
    name: '阮一峰周刊·正刊',
    repo: 'ruanyf/weekly',
    releasePattern: /release issue\s+(\d+)/i,
    documentPath: (number) => `docs/issue-${number}.md`,
  },
  'hellogithub-issue': {
    name: 'HelloGitHub·月刊',
    repo: '521xueweihan/HelloGitHub',
    releasePattern: /发布：?《HelloGitHub》第\s*(\d+)\s*期/,
    documentPath: (number) => `content/HelloGitHub${number}.md`,
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
  const sourceId = value('--source');
  if (sourceId && !SOURCES[sourceId]) throw new Error(`unknown --source: ${sourceId}`);
  return {
    start: date || value('--start') || DEFAULT_START,
    end: date || value('--end') || beijingDateStr(new Date(Date.now() - 86400000)),
    outRoot: path.resolve(value('--out-root') || DEFAULT_OUT_ROOT),
    sourceIds: sourceId ? [sourceId] : Object.keys(SOURCES),
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

function rangeBounds(start, end) {
  return {
    since: new Date(`${start}T00:00:00+08:00`).toISOString(),
    until: new Date(`${end}T23:59:59.999+08:00`).toISOString(),
  };
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
      return JSON.parse(execFileSync('gh', ['api', endpoint], {
        encoding: 'utf8',
        maxBuffer: 30 * 1024 * 1024,
        timeout: 60000,
      }));
    } catch (error) {
      lastError = error;
      if (attempt < 3) execFileSync('sleep', [String(attempt)]);
    }
  }
  throw new Error(`gh api failed after 3 attempts: ${lastError.message}`);
}

function fetchCommits(repo, start, end) {
  const bounds = rangeBounds(start, end);
  const commits = [];
  let pageCount = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const endpoint = `repos/${repo}/commits?since=${encodeURIComponent(bounds.since)}&until=${encodeURIComponent(bounds.until)}&per_page=${PER_PAGE}&page=${page}`;
    const batch = ghJson(endpoint);
    if (!Array.isArray(batch)) throw new Error(`${repo} commits response is not an array`);
    commits.push(...batch);
    pageCount += 1;
    if (batch.length < PER_PAGE) return { commits, pageCount, ...bounds };
  }
  throw new Error(`${repo} commit pagination exceeded ${MAX_PAGES} pages`);
}

function findReleases(source, commits, start, end) {
  const byIssue = new Map();
  for (const commit of commits) {
    const message = commit.commit?.message?.split('\n')[0] || '';
    const match = message.match(source.releasePattern);
    if (!match) continue;
    const committedAt = commit.commit.committer?.date;
    if (!committedAt || Number.isNaN(new Date(committedAt).getTime())) {
      throw new Error(`${source.repo} release commit ${commit.sha} has no valid committer date`);
    }
    const targetDate = beijingDateStr(new Date(committedAt));
    if (targetDate < start || targetDate > end) continue;
    const issueNumber = Number(match[1]);
    const candidate = {
      issueNumber,
      targetDate,
      releaseCommitSha: commit.sha,
      releaseCommittedAt: committedAt,
      releaseCommitUrl: commit.html_url,
      releaseCommitMessage: message,
    };
    const existing = byIssue.get(issueNumber);
    if (existing && existing.targetDate !== targetDate) {
      throw new Error(`${source.repo} issue ${issueNumber} has release commits on multiple Beijing days`);
    }
    if (!existing || new Date(candidate.releaseCommittedAt) > new Date(existing.releaseCommittedAt)) {
      byIssue.set(issueNumber, candidate);
    }
  }
  return [...byIssue.values()].sort((a, b) => a.releaseCommittedAt.localeCompare(b.releaseCommittedAt));
}

function fetchDocument(source, release) {
  const documentPath = source.documentPath(release.issueNumber);
  const record = ghJson(`repos/${source.repo}/contents/${documentPath}`);
  if (!record || record.type !== 'file' || record.encoding !== 'base64' || !record.content) {
    throw new Error(`${source.repo}/${documentPath} is not a base64 file response`);
  }
  return { record, documentPath };
}

function captureSource(options, sourceId) {
  const source = SOURCES[sourceId];
  let start = options.start;
  if (options.resume) {
    const missingDate = firstMissingDate(options.outRoot, sourceId, start, options.end);
    if (!missingDate) {
      return { sourceId, start, end: options.end, resumed: true, noOp: true, reason: 'all daily files already exist' };
    }
    start = missingDate;
  }

  const fetchedAt = new Date().toISOString();
  const commitCapture = fetchCommits(source.repo, start, options.end);
  const releases = findReleases(source, commitCapture.commits, start, options.end);
  const byDay = new Map();
  for (const release of releases) {
    const { record, documentPath } = fetchDocument(source, release);
    const publication = { ...release, documentPath, contentBlobSha: record.sha };
    if (!byDay.has(release.targetDate)) byDay.set(release.targetDate, []);
    byDay.get(release.targetDate).push({ publication, record });
  }

  let written = 0;
  let unchanged = 0;
  let publicationDays = 0;
  let totalDocuments = 0;
  for (const targetDate of eachDate(start, options.end)) {
    const file = path.join(options.outRoot, sourceId, `${targetDate}.json`);
    if (fs.existsSync(file) && !options.replace) {
      unchanged += 1;
      continue;
    }
    const entries = byDay.get(targetDate) || [];
    const records = entries.map((entry) => entry.record);
    const publications = entries.map((entry) => entry.publication);
    if (records.length) publicationDays += 1;
    totalDocuments += records.length;
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
        endpoint: `https://api.github.com/repos/${source.repo}`,
        commitQuerySince: commitCapture.since,
        commitQueryUntil: commitCapture.until,
        commitPageCount: commitCapture.pageCount,
        scannedCommitCount: commitCapture.commits.length,
        releaseEvidence: publications,
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
    commitPagesFetched: commitCapture.pageCount,
    scannedCommitCount: commitCapture.commits.length,
    releaseCount: releases.length,
    publicationDays,
    totalDocuments,
    written,
    unchanged,
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
