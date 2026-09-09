#!/usr/bin/env node
/** Validate a daily GitHub repository reference snapshot without network I/O. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { repositoryKey } = require('./github_repo_utils');

const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw', 'github-repositories');

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function digest(valueToHash) {
  return crypto.createHash('sha256').update(JSON.stringify(valueToHash)).digest('hex');
}

function main() {
  const argv = process.argv.slice(2);
  const targetDate = value(argv, '--date');
  const root = path.resolve(value(argv, '--root') || DEFAULT_ROOT);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate || '')) throw new Error('--date YYYY-MM-DD is required');
  const file = path.join(root, `${targetDate}.json`);
  const errors = [];
  if (!fs.existsSync(file)) throw new Error(`missing file: ${file}`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (data.sourceId !== 'github-repositories') errors.push('sourceId mismatch');
  if (data.targetDate !== targetDate) errors.push('targetDate mismatch');
  if (data.timezone !== 'Asia/Shanghai') errors.push('timezone mismatch');
  if (data.complete !== true) errors.push('capture is incomplete');
  if (!Array.isArray(data.records)) errors.push('records is not an array');
  if (!Array.isArray(data.failures)) errors.push('failures is not an array');
  if (errors.length) finish(data, errors);

  if (data.itemCount !== data.records.length) errors.push('itemCount mismatch');
  if (data.failureCount !== data.failures.length) errors.push('failureCount mismatch');
  if (data.candidateCount !== data.records.length + data.failures.length) errors.push('candidateCount mismatch');
  if (data.contentSha256 !== digest({ records: data.records, failures: data.failures })) errors.push('contentSha256 mismatch');
  const expected = data.capture?.candidateRepositories || [];
  const actual = [...data.records, ...data.failures].map((entry) => entry.repository).sort();
  if (JSON.stringify([...expected].sort()) !== JSON.stringify(actual)) errors.push('candidate repository coverage mismatch');
  if (new Set(actual).size !== actual.length) errors.push('duplicate repositories');

  for (const record of data.records) {
    const resolvedRepository = repositoryKey(record.response?.html_url);
    if (!resolvedRepository) errors.push(`${record.repository}: response identity is missing`);
    if (record.resolvedRepository && record.resolvedRepository !== resolvedRepository) errors.push(`${record.repository}: resolved identity mismatch`);
    if (!Number.isInteger(record.response?.stargazers_count)) errors.push(`${record.repository}: missing stargazers_count`);
    if (!Number.isInteger(record.response?.forks_count)) errors.push(`${record.repository}: missing forks_count`);
    if (!Array.isArray(record.references) || !record.references.length) errors.push(`${record.repository}: missing references`);
  }
  finish(data, errors);
}

function finish(data, errors) {
  console.log(JSON.stringify({
    sourceId: data.sourceId,
    targetDate: data.targetDate,
    candidateCount: data.candidateCount,
    itemCount: data.itemCount,
    failureCount: data.failureCount,
    errorCount: errors.length,
  }, null, 2));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
