#!/usr/bin/env node
/** Validate Chinese independent developer source-native daily Markdown files. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SOURCE_ID = 'chinese-indie-dev';
const REPOSITORY = '1c7/chinese-independent-developer';
const TIMEZONE = 'Asia/Shanghai';
const DEFAULT_START = '2026-01-01';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw', SOURCE_ID);
const PROJECT_LINE = /^[-*]\s*:(white_check_mark|clock8|x):\s*\[[^\]]+\]\([^)]+\)/;

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
  return crypto.createHash('sha256').update(valueToHash).digest('hex');
}

function main() {
  const argv = process.argv.slice(2);
  const start = value(argv, '--start') || DEFAULT_START;
  const end = value(argv, '--end') || beijingDateStr(new Date(Date.now() - 86400000));
  const root = path.resolve(value(argv, '--root') || DEFAULT_ROOT);
  const errors = [];
  const readmeShas = new Set();
  let totalProjects = 0;
  let emptyDays = 0;
  let activeDays = 0;

  for (const targetDate of eachDate(start, end)) {
    const file = path.join(root, `${targetDate}.json`);
    if (!fs.existsSync(file)) {
      errors.push(`${targetDate}: missing file`);
      continue;
    }
    let document;
    try {
      document = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push(`${targetDate}: invalid JSON (${error.message})`);
      continue;
    }
    if (document.sourceId !== SOURCE_ID) errors.push(`${targetDate}: wrong sourceId`);
    if (document.repository !== REPOSITORY) errors.push(`${targetDate}: wrong repository`);
    if (document.targetDate !== targetDate) errors.push(`${targetDate}: wrong targetDate`);
    if (document.timezone !== TIMEZONE) errors.push(`${targetDate}: wrong timezone`);
    if (document.complete !== true) errors.push(`${targetDate}: not complete`);
    if (typeof document.sectionMarkdown !== 'string') {
      errors.push(`${targetDate}: sectionMarkdown is not a string`);
      continue;
    }
    if (document.contentSha256 !== digest(document.sectionMarkdown)) errors.push(`${targetDate}: digest mismatch`);
    const lines = document.sectionMarkdown.split(/\r?\n/);
    const itemCount = lines.filter((line) => PROJECT_LINE.test(line)).length;
    const statusLikeCount = lines.filter((line) => /^[-*]\s*:/.test(line)).length;
    if (itemCount !== statusLikeCount) errors.push(`${targetDate}: unrecognized project line`);
    if (document.itemCount !== itemCount) errors.push(`${targetDate}: itemCount mismatch`);
    if (document.status === 'ok') {
      activeDays += 1;
      const month = Number(targetDate.slice(5, 7));
      const day = Number(targetDate.slice(8, 10));
      const expectedHeading = new RegExp(`^###\\s+${targetDate.slice(0, 4)}\\s*年\\s*0?${month}\\s*月\\s*0?${day}\\s*号添加`);
      if (!expectedHeading.test(document.sectionMarkdown)) errors.push(`${targetDate}: section heading mismatch`);
      if (!itemCount) errors.push(`${targetDate}: ok section has no projects`);
    } else if (document.status === 'empty') {
      emptyDays += 1;
      if (document.sectionMarkdown !== '' || itemCount !== 0) errors.push(`${targetDate}: empty day has content`);
    } else {
      errors.push(`${targetDate}: invalid status`);
    }
    totalProjects += itemCount;
    if (document.capture?.readmeSha) readmeShas.add(document.capture.readmeSha);
  }

  console.log(JSON.stringify({
    sourceId: SOURCE_ID,
    root,
    start,
    end,
    expectedDays: eachDate(start, end).length,
    activeDays,
    emptyDays,
    totalProjects,
    readmeRevisions: readmeShas.size,
    errorCount: errors.length,
    errors,
  }, null, 2));
  if (errors.length) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
