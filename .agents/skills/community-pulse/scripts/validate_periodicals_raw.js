#!/usr/bin/env node
/** Validate source-native periodical files without network access. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TIMEZONE = 'Asia/Shanghai';
const DEFAULT_START = '2026-01-01';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');
const SOURCES = {
  'weekly-issue': {
    repo: 'ruanyf/weekly',
    pathPattern: /^docs\/issue-(\d+)\.md$/,
    titlePattern: /^#\s+科技爱好者周刊（第\s*(\d+)\s*期）/,
  },
  'hellogithub-issue': {
    repo: '521xueweihan/HelloGitHub',
    pathPattern: /^content\/HelloGitHub(\d+)\.md$/,
    titlePattern: /^#\s+《HelloGitHub》第\s*(\d+)\s*期/,
  },
};

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

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

function digest(valueToHash) {
  return crypto.createHash('sha256').update(JSON.stringify(valueToHash)).digest('hex');
}

function gitBlobSha(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`);
  return crypto.createHash('sha1').update(Buffer.concat([header, buffer])).digest('hex');
}

function main() {
  const argv = process.argv.slice(2);
  const start = value(argv, '--start') || DEFAULT_START;
  const end = value(argv, '--end') || beijingDateStr(new Date(Date.now() - 86400000));
  const root = path.resolve(value(argv, '--root') || DEFAULT_ROOT);
  const requestedSource = value(argv, '--source');
  if (requestedSource && !SOURCES[requestedSource]) throw new Error(`unknown --source: ${requestedSource}`);
  const sourceIds = requestedSource ? [requestedSource] : Object.keys(SOURCES);
  const errors = [];
  const results = [];

  for (const sourceId of sourceIds) {
    const source = SOURCES[sourceId];
    const seenIssues = new Set();
    let publicationDays = 0;
    let emptyDays = 0;
    let totalDocuments = 0;
    for (const targetDate of eachDate(start, end)) {
      const file = path.join(root, sourceId, `${targetDate}.json`);
      if (!fs.existsSync(file)) {
        errors.push(`${sourceId}/${targetDate}: missing file`);
        continue;
      }
      let document;
      try {
        document = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        errors.push(`${sourceId}/${targetDate}: invalid JSON (${error.message})`);
        continue;
      }
      if (document.sourceId !== sourceId) errors.push(`${sourceId}/${targetDate}: wrong sourceId`);
      if (document.repository !== source.repo) errors.push(`${sourceId}/${targetDate}: wrong repository`);
      if (document.targetDate !== targetDate) errors.push(`${sourceId}/${targetDate}: wrong targetDate`);
      if (document.timezone !== TIMEZONE) errors.push(`${sourceId}/${targetDate}: wrong timezone`);
      if (document.complete !== true) errors.push(`${sourceId}/${targetDate}: not complete`);
      if (!Array.isArray(document.records)) {
        errors.push(`${sourceId}/${targetDate}: records is not an array`);
        continue;
      }
      const evidence = document.capture?.releaseEvidence;
      if (!Array.isArray(evidence) || evidence.length !== document.records.length) {
        errors.push(`${sourceId}/${targetDate}: release evidence mismatch`);
        continue;
      }
      if (document.itemCount !== document.records.length) errors.push(`${sourceId}/${targetDate}: itemCount mismatch`);
      if (document.status !== (document.records.length ? 'ok' : 'empty')) errors.push(`${sourceId}/${targetDate}: status mismatch`);
      if (document.contentSha256 !== digest(document.records)) errors.push(`${sourceId}/${targetDate}: digest mismatch`);
      if (document.records.length) publicationDays += 1;
      else emptyDays += 1;
      totalDocuments += document.records.length;

      for (let index = 0; index < document.records.length; index += 1) {
        const record = document.records[index];
        const release = evidence[index];
        const pathMatch = typeof record.path === 'string' ? record.path.match(source.pathPattern) : null;
        if (!pathMatch) {
          errors.push(`${sourceId}/${targetDate}: invalid document path`);
          continue;
        }
        const issueNumber = Number(pathMatch[1]);
        if (seenIssues.has(issueNumber)) errors.push(`${sourceId}/${targetDate}: duplicate issue ${issueNumber}`);
        seenIssues.add(issueNumber);
        if (release.issueNumber !== issueNumber || release.documentPath !== record.path) {
          errors.push(`${sourceId}/${targetDate}: issue ${issueNumber} release evidence does not match record`);
        }
        if (!release.releaseCommittedAt || beijingDateStr(new Date(release.releaseCommittedAt)) !== targetDate) {
          errors.push(`${sourceId}/${targetDate}: issue ${issueNumber} release date mismatch`);
        }
        if (record.type !== 'file' || record.encoding !== 'base64' || typeof record.content !== 'string') {
          errors.push(`${sourceId}/${targetDate}: issue ${issueNumber} is not a base64 file record`);
          continue;
        }
        const markdown = Buffer.from(record.content.replace(/\n/g, ''), 'base64');
        if (gitBlobSha(markdown) !== record.sha) errors.push(`${sourceId}/${targetDate}: issue ${issueNumber} blob SHA mismatch`);
        const titleMatch = markdown.toString('utf8').match(source.titlePattern);
        if (!titleMatch || Number(titleMatch[1]) !== issueNumber) {
          errors.push(`${sourceId}/${targetDate}: issue ${issueNumber} document title mismatch`);
        }
      }
    }
    results.push({
      sourceId,
      repository: source.repo,
      expectedDays: eachDate(start, end).length,
      publicationDays,
      emptyDays,
      totalDocuments,
      uniqueIssues: seenIssues.size,
    });
  }

  console.log(JSON.stringify({ root, start, end, results, errorCount: errors.length, errors }, null, 2));
  if (errors.length) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
