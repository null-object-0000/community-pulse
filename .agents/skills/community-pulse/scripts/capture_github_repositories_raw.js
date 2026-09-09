#!/usr/bin/env node
/**
 * Capture GitHub repository API objects for every repository referenced by the
 * day's normalized source records. This is an auxiliary source/bronze layer:
 * report generation reads it offline and never calls GitHub itself.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadItems } = require('./source_raw_items');
const { repositoryKey } = require('./github_repo_utils');

const TIMEZONE = 'Asia/Shanghai';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const CONFIG = path.join(__dirname, '..', 'config', 'sources.json');
const DEFAULT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');

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

function digest(valueToHash) {
  return crypto.createHash('sha256').update(JSON.stringify(valueToHash)).digest('hex');
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function fetchRepository(repository) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const output = execFileSync('gh', [
        'api', `repos/${repository}`,
        '-H', 'Accept: application/vnd.github+json',
        '-H', 'X-GitHub-Api-Version: 2022-11-28',
      ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 30000 });
      const response = JSON.parse(output);
      if (!response.full_name || !response.html_url) throw new Error('repository response is missing identity fields');
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 3 && !/HTTP 404|Not Found/i.test(String(error.message))) {
        execFileSync('sleep', [String(attempt)]);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

function main() {
  const argv = process.argv.slice(2);
  const targetDate = value(argv, '--date') || beijingDateStr(new Date(Date.now() - 86400000));
  const observedDate = value(argv, '--observed-date') || targetDate;
  const rawRoot = path.resolve(value(argv, '--source-raw-root') || DEFAULT_ROOT);
  const outRoot = path.resolve(value(argv, '--out-root') || path.join(rawRoot, 'github-repositories'));
  const replace = argv.includes('--replace');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('--date must be YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observedDate)) throw new Error('--observed-date must be YYYY-MM-DD');

  const outputFile = path.join(outRoot, `${targetDate}.json`);
  if (fs.existsSync(outputFile) && !replace) {
    console.log(`[github-repositories] ${targetDate}: already exists`);
    return;
  }

  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const candidates = new Map();
  for (const source of config.sources.filter((item) => item.enabled)) {
    const loaded = loadItems(source, { date: targetDate, observedDate, rawRoot });
    for (const item of loaded.items) {
      const key = repositoryKey(item.githubUrl || item.github?.url);
      if (!key) continue;
      if (!candidates.has(key)) candidates.set(key, { repository: key, references: [] });
      candidates.get(key).references.push({
        sourceId: source.id,
        externalId: item.externalId,
        title: item.title,
        githubUrl: item.githubUrl || item.github.url,
      });
    }
  }

  const records = [];
  const failures = [];
  const entries = [...candidates.values()].sort((a, b) => a.repository.localeCompare(b.repository));
  for (const [index, candidate] of entries.entries()) {
    process.stderr.write(`[github repository ${index + 1}/${entries.length}] ${candidate.repository}\n`);
    try {
      const response = fetchRepository(candidate.repository);
      records.push({
        repository: candidate.repository,
        resolvedRepository: repositoryKey(response.html_url),
        references: candidate.references,
        response,
      });
    } catch (error) {
      failures.push({
        repository: candidate.repository,
        references: candidate.references,
        error: String(error.message || error).slice(0, 500),
      });
    }
  }

  const fetchedAt = new Date().toISOString();
  const content = { records, failures };
  const document = {
    schemaVersion: 1,
    sourceId: 'github-repositories',
    sourceName: 'GitHub 仓库信息',
    targetDate,
    timezone: TIMEZONE,
    status: entries.length ? 'ok' : 'empty',
    complete: true,
    fetchedAt,
    itemCount: records.length,
    candidateCount: entries.length,
    failureCount: failures.length,
    contentSha256: digest(content),
    capture: {
      mode: 'daily-reference-snapshot',
      endpoint: 'https://api.github.com/repos/{owner}/{repo}',
      observedDate,
      candidateRepositories: entries.map((entry) => entry.repository),
    },
    records,
    failures,
  };
  atomicWrite(outputFile, `${JSON.stringify(document, null, 2)}\n`);
  console.log(JSON.stringify({
    sourceId: document.sourceId,
    targetDate,
    candidateCount: document.candidateCount,
    itemCount: document.itemCount,
    failureCount: document.failureCount,
    outputFile,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
