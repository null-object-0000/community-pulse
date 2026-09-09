#!/usr/bin/env node
/** Validate daily source-native GitHub Issue files without network access. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TIMEZONE = 'Asia/Shanghai';
const DEFAULT_START = '2026-01-01';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');
const SOURCES = {
  'weekly-issues': 'ruanyf/weekly',
  'hellogithub-issues': '521xueweihan/HelloGitHub',
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

function digest(records) {
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
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
    const repo = SOURCES[sourceId];
    const seenIds = new Set();
    let totalRecords = 0;
    let emptyDays = 0;
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
      if (document.repository !== repo) errors.push(`${sourceId}/${targetDate}: wrong repository`);
      if (document.targetDate !== targetDate) errors.push(`${sourceId}/${targetDate}: wrong targetDate`);
      if (document.timezone !== TIMEZONE) errors.push(`${sourceId}/${targetDate}: wrong timezone`);
      if (document.complete !== true) errors.push(`${sourceId}/${targetDate}: not complete`);
      if (!Array.isArray(document.records)) {
        errors.push(`${sourceId}/${targetDate}: records is not an array`);
        continue;
      }
      if (document.itemCount !== document.records.length) errors.push(`${sourceId}/${targetDate}: itemCount mismatch`);
      if (document.status !== (document.records.length ? 'ok' : 'empty')) errors.push(`${sourceId}/${targetDate}: status mismatch`);
      if (document.contentSha256 !== digest(document.records)) errors.push(`${sourceId}/${targetDate}: digest mismatch`);
      if (!document.records.length) emptyDays += 1;
      totalRecords += document.records.length;

      for (const issue of document.records) {
        if (issue.pull_request) errors.push(`${sourceId}/${targetDate}: PR #${issue.number} included`);
        if (!issue.id || seenIds.has(issue.id)) errors.push(`${sourceId}/${targetDate}: missing/duplicate id ${issue.id}`);
        if (issue.id) seenIds.add(issue.id);
        if (!issue.created_at || Number.isNaN(new Date(issue.created_at).getTime())) {
          errors.push(`${sourceId}/${targetDate}: invalid created_at for #${issue.number}`);
        } else if (beijingDateStr(new Date(issue.created_at)) !== targetDate) {
          errors.push(`${sourceId}/${targetDate}: #${issue.number} belongs to another Beijing day`);
        }
        if (typeof issue.html_url !== 'string' || !issue.html_url.startsWith(`https://github.com/${repo}/issues/`)) {
          errors.push(`${sourceId}/${targetDate}: wrong html_url for #${issue.number}`);
        }
      }
    }
    results.push({
      sourceId,
      repository: repo,
      expectedDays: eachDate(start, end).length,
      emptyDays,
      totalRecords,
      uniqueIds: seenIds.size,
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
