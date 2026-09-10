#!/usr/bin/env node
/**
 * Capture the exact dated Markdown sections from 1c7/chinese-independent-developer.
 * The README section is the source-native record; parsing into normalized items
 * belongs to a downstream layer.
 *
 * Usage:
 *   node scripts/capture_chinese_indie_raw.js --start 2026-01-01 --end 2026-09-07
 *   node scripts/capture_chinese_indie_raw.js --resume --end 2026-09-07
 *   node scripts/capture_chinese_indie_raw.js --date 2026-09-07
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SOURCE_ID = 'chinese-indie-dev';
const SOURCE_NAME = '中国独立开发者';
const REPOSITORY = '1c7/chinese-independent-developer';
const ENDPOINT = `https://api.github.com/repos/${REPOSITORY}/readme`;
const TIMEZONE = 'Asia/Shanghai';
const DEFAULT_START = '2026-01-01';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_OUT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw', SOURCE_ID);
const DATE_HEADING = /^###\s+(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*号添加\s*$/;
const PROJECT_LINE = /^[-*]\s*:(white_check_mark|clock8|x):\s*\[[^\]]+\]\([^)]+\)/;

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
  return {
    start: date || value('--start') || DEFAULT_START,
    end: date || value('--end') || beijingDateStr(new Date(Date.now() - 86400000)),
    outRoot: path.resolve(value('--out-root') || DEFAULT_OUT_ROOT),
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

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function firstMissingDate(outRoot, start, end) {
  for (const targetDate of eachDate(start, end)) {
    if (!fs.existsSync(path.join(outRoot, `${targetDate}.json`))) return targetDate;
  }
  return null;
}

function fetchReadme() {
  const output = execFileSync('gh', ['api', `repos/${REPOSITORY}/readme`], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60000,
  });
  const payload = JSON.parse(output);
  if (!payload.content || payload.encoding !== 'base64' || !payload.sha) {
    throw new Error('GitHub README response is missing content/encoding/sha');
  }
  return {
    payload,
    markdown: Buffer.from(payload.content.replace(/\n/g, ''), 'base64').toString('utf8'),
  };
}

function parseSections(markdown, requestedStart, requestedEnd) {
  const lines = markdown.split(/(?<=\n)/);
  const headings = [];
  let offset = 0;
  for (const line of lines) {
    const text = line.replace(/\r?\n$/, '');
    const match = text.match(DATE_HEADING);
    if (match) {
      headings.push({
        date: `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`,
        heading: text,
        start: offset,
      });
    }
    offset += line.length;
  }

  const byDate = new Map();
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const requested = heading.date >= requestedStart && heading.date <= requestedEnd;
    if (byDate.has(heading.date)) {
      if (requested) throw new Error(`duplicate README date section: ${heading.date}`);
      continue;
    }
    const end = headings[index + 1]?.start ?? markdown.length;
    const sectionMarkdown = markdown.slice(heading.start, end);
    const sectionLines = sectionMarkdown.split(/\r?\n/);
    const itemCount = sectionLines.filter((line) => PROJECT_LINE.test(line)).length;
    const statusLikeCount = sectionLines.filter((line) => /^[-*]\s*:/.test(line)).length;
    if (requested && itemCount !== statusLikeCount) {
      throw new Error(`${heading.date} contains ${statusLikeCount - itemCount} unrecognized project lines`);
    }
    if (requested && !itemCount) throw new Error(`${heading.date} section contains no recognizable project lines`);
    byDate.set(heading.date, {
      heading: heading.heading,
      sectionMarkdown,
      itemCount,
      authorHeadingCount: sectionLines.filter((line) => /^####\s+/.test(line)).length,
    });
  }
  return { byDate, totalDatedSectionCount: headings.length };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  assertDate(options.start, '--start');
  assertDate(options.end, '--end');
  if (options.start > options.end) throw new Error('--start must not be after --end');
  if (options.resume) {
    const missingDate = firstMissingDate(options.outRoot, options.start, options.end);
    if (!missingDate) {
      console.log(JSON.stringify({
        sourceId: SOURCE_ID,
        start: options.start,
        end: options.end,
        outRoot: options.outRoot,
        resumed: true,
        noOp: true,
        reason: 'all daily files already exist',
      }, null, 2));
      return;
    }
    options.start = missingDate;
  }

  const fetchedAt = new Date().toISOString();
  const { payload, markdown } = fetchReadme();
  const parsed = parseSections(markdown, options.start, options.end);
  let written = 0;
  let unchanged = 0;
  let totalProjects = 0;
  let emptyDays = 0;
  for (const targetDate of eachDate(options.start, options.end)) {
    const file = path.join(options.outRoot, `${targetDate}.json`);
    if (fs.existsSync(file) && !options.replace) {
      unchanged += 1;
      continue;
    }
    const section = parsed.byDate.get(targetDate) || null;
    const sectionMarkdown = section?.sectionMarkdown || '';
    const itemCount = section?.itemCount || 0;
    totalProjects += itemCount;
    if (!section) emptyDays += 1;
    const document = {
      schemaVersion: 1,
      sourceId: SOURCE_ID,
      sourceName: SOURCE_NAME,
      repository: REPOSITORY,
      targetDate,
      timezone: TIMEZONE,
      status: section ? 'ok' : 'empty',
      complete: true,
      itemCount,
      contentSha256: digest(sectionMarkdown),
      fetchedAt,
      capture: {
        mode: options.start === options.end ? 'daily-finalized-date' : 'historical-reconstruction',
        endpoint: ENDPOINT,
        readmePath: payload.path,
        readmeSha: payload.sha,
        readmeSize: payload.size,
        downloadUrl: payload.download_url,
        totalDatedSectionCount: parsed.totalDatedSectionCount,
        sectionHeading: section?.heading || null,
        authorHeadingCount: section?.authorHeadingCount || 0,
      },
      sectionMarkdown,
    };
    atomicWrite(file, `${JSON.stringify(document, null, 2)}\n`);
    written += 1;
  }

  console.log(JSON.stringify({
    sourceId: SOURCE_ID,
    start: options.start,
    end: options.end,
    outRoot: options.outRoot,
    resumed: options.resume,
    readmeSha: payload.sha,
    readmeSize: payload.size,
    observedDatedSections: parsed.totalDatedSectionCount,
    written,
    unchanged,
    emptyDays,
    totalProjects,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
