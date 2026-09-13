#!/usr/bin/env node
/**
 * Attach `language` from the repository snapshot layer onto published reports.
 *
 * Why only `language`: it is a repository identity attribute, not a measurement. Across every snapshot
 * the project has, a repository's language never changed, while stars/forks move daily. Carrying
 * stars/forks from a backfilled (当前值) snapshot into an old report would present today's numbers as
 * that day's — exactly what the project's snapshot rule forbids. `language` carries no such risk, and
 * it is the only field the trends model needs from this layer.
 *
 * This is the second half of the backfill: the snapshot files alone change nothing, because the trend
 * model reads the published reports (raw/<date>.json). A report is only re-derived offline — no
 * network, no collect.js — by attaching the single field, so every other byte of the report is kept.
 *
 * Usage:
 *   node scripts/attach_repository_language.js --date 2026-08-28 --dry-run
 *   node scripts/attach_repository_language.js --start 2026-01-01 --end 2026-09-12
 */
const fs = require('fs');
const path = require('path');

const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const RAW_DIR = path.join(VAULT, '知识', '大家都在做什么', 'raw');
const SNAPSHOT_DIR = path.join(VAULT, '知识', '大家都在做什么', 'source-raw', 'github-repositories');
const BACKUP_DIR = path.join(VAULT, '.scratch', 'backup-language-backfill');

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function eachDate(start, end) {
  const out = [];
  for (let d = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function repositoryKey(url) {
  const match = String(url || '').match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  return match ? `${match[1]}/${match[2]}`.replace(/\.git$/i, '').toLowerCase() : '';
}

function loadLanguages(date) {
  const file = path.join(SNAPSHOT_DIR, `${date}.json`);
  if (!fs.existsSync(file)) return { index: new Map(), observedAt: null, missing: true };
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  const index = new Map();
  for (const record of document.records || []) {
    const language = record.response && record.response.language;
    if (!language) continue;
    index.set(record.repository, language);
    // Reports link repositories by URL, which may differ in case from the snapshot's key.
    const resolved = record.resolvedRepository || repositoryKey(record.response?.html_url);
    if (resolved) index.set(resolved, language);
  }
  return {
    index,
    observedAt: (document.capture || {}).metricsObservedAt || (document.capture || {}).observedDate || null,
    mode: (document.capture || {}).mode || null,
    missing: false,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const single = value(argv, '--date');
  const start = value(argv, '--start');
  const end = value(argv, '--end');
  if (single && (start || end)) throw new Error('use either --date or --start/--end, not both');
  let dates;
  if (single) dates = [single];
  else if (start && end) dates = eachDate(start, end);
  else throw new Error('provide --date YYYY-MM-DD or --start/--end');
  if (dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new Error('dates must be YYYY-MM-DD');

  let changedFiles = 0, skipped = 0, attached = 0, unmatched = 0, already = 0;
  const unmatchedSamples = [];
  for (const date of dates) {
    const rawFile = path.join(RAW_DIR, `${date}.json`);
    if (!fs.existsSync(rawFile)) { skipped += 1; continue; }
    const languages = loadLanguages(date);
    if (languages.missing || !languages.index.size) { skipped += 1; continue; }

    const report = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
    let fileChanged = 0, fileUnmatched = 0;
    for (const source of report.results || []) {
      for (const item of source.items || []) {
        const key = repositoryKey(item.githubUrl || (item.github && item.github.url));
        if (!key) continue;
        if (item.github && item.github.language) { already += 1; continue; }
        const language = languages.index.get(key);
        if (!language) {
          fileUnmatched += 1; unmatched += 1;
          if (unmatchedSamples.length < 8) unmatchedSamples.push(`${date} ${key}`);
          continue;
        }
        // Only the language is added. Stars/forks stay absent: a backfilled snapshot's values are
        // today's, and writing them here would misdate them.
        item.github = { ...(item.github || {}), url: item.github?.url || item.githubUrl, language };
        if (!item.githubUrl) item.githubUrl = item.github.url;
        fileChanged += 1;
        attached += 1;
      }
    }
    if (!fileChanged) { skipped += 1; continue; }
    if (!dryRun) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.copyFileSync(rawFile, path.join(BACKUP_DIR, `${date}.json`));
      fs.writeFileSync(rawFile, `${JSON.stringify(report, null, 2)}\n`);
    }
    changedFiles += 1;
  }

  console.log(JSON.stringify({
    days: dates.length, filesChanged: changedFiles, daysSkipped: skipped,
    languagesAttached: attached, alreadyPresent: already, repositoriesUnmatched: unmatched,
    observedAtSample: loadLanguages(dates[0]).observedAt,
    unmatchedSamples, dryRun,
  }, null, 2));
}

if (require.main === module) main();
