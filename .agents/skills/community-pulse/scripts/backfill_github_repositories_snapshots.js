#!/usr/bin/env node
/**
 * Backfill GitHub repository snapshots for report days that only have the current-day trade-off.
 *
 * Why this is allowed for `language` specifically: `language` is a repository *identity* attribute, not
 * a measurement that moves day to day. Across the 12 existing snapshots, 273 repositories appear on
 * several days and their language never changed once. Stars/forks are measurements and are NOT
 * treated this way.
 *
 * What this script therefore does NOT do: relabel today's response as the report day's value. Each
 * output file keeps the report day (which rows it describes) separate from the observation day (when
 * it was actually fetched), exactly as the existing 2026-09-12 file does (targetDate 09-12,
 * observedDate 09-13). A consumer must never read a backfilled file's stars/forks as that day's.
 *
 * It also does not reuse the daily capture script: that one re-derives the day's candidate repositories
 * from the source-raw layer, which only exists from 2026-09-01. The candidates for an older day come
 * from the published report instead (raw/<date>.json), which is what the trend model actually reads.
 *
 * Usage:
 *   node scripts/backfill_github_repositories_snapshots.js --dry-run
 *   node scripts/backfill_github_repositories_snapshots.js --start 2026-01-01 --end 2026-08-31
 *   node scripts/backfill_github_repositories_snapshots.js --date 2026-08-15
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TIMEZONE = 'Asia/Shanghai';
const SOURCE_ID = 'github-repositories';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const RAW_DIR = path.join(VAULT, '知识', '大家都在做什么', 'raw');
const DEFAULT_OUT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw', SOURCE_ID);
const ENDPOINT = 'https://api.github.com/repos';
const PROXY = process.env.COMMUNITY_PULSE_PROXY === undefined
  ? 'http://127.0.0.1:7890'
  : process.env.COMMUNITY_PULSE_PROXY;
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

// Unauthenticated GitHub allows 60 requests/hour, which a multi-day backfill blows through. When no
// token is in the environment, reuse the one the gh CLI already holds (5000/hour) — otherwise the run
// silently half-fails on rate limits and writes those repositories as permanent failures.
function resolveToken() {
  if (TOKEN) return { token: TOKEN, origin: 'environment' };
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
    if (token) return { token, origin: 'gh auth token' };
  } catch (_) { /* gh unavailable or not logged in: fall back to anonymous */ }
  return { token: '', origin: 'anonymous (60 requests/hour)' };
}

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

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function repositoryKey(url) {
  const match = String(url || '').match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  return match ? `${match[1]}/${match[2]}`.replace(/\.git$/i, '').toLowerCase() : '';
}

function eachDate(start, end) {
  const out = [];
  for (let d = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

// Candidates come from the published report, not the source-raw layer (which predates most reports).
function candidatesFor(date) {
  const file = path.join(RAW_DIR, `${date}.json`);
  if (!fs.existsSync(file)) return null;
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byRepo = new Map();
  for (const source of report.results || []) {
    for (const item of source.items || []) {
      const key = repositoryKey(item.githubUrl || (item.github && item.github.url));
      if (!key) continue;
      if (!byRepo.has(key)) byRepo.set(key, []);
      byRepo.get(key).push({
        sourceId: source.sourceId,
        externalId: item.externalId,
        title: item.title,
        githubUrl: item.githubUrl || (item.github && item.github.url),
      });
    }
  }
  return byRepo;
}

function fetchRepository(repository, token, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const args = ['-sS', '-L', '--max-time', '30',
        '-H', 'Accept: application/vnd.github+json',
        '-H', 'User-Agent: community-pulse-repository-backfill/1',
        '-H', 'X-GitHub-Api-Version: 2022-11-28'];
      if (token) args.push('-H', `Authorization: Bearer ${token}`);
      if (PROXY) args.push('-x', PROXY);
      args.push(`${ENDPOINT}/${repository}`);
      const body = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 40000 });
      const parsed = JSON.parse(body);
      if (parsed.message && !parsed.id) throw new Error(`GitHub API: ${parsed.message}`);
      if (typeof parsed.stargazers_count !== 'number') throw new Error('response has no stargazers_count');
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) execFileSync('sleep', [String(attempt)]);
    }
  }
  throw lastError;
}

function main() {
  const argv = process.argv.slice(2);
  const observedDate = value(argv, '--observed-date') || beijingDateStr(new Date());
  const outRoot = path.resolve(value(argv, '--out-root') || DEFAULT_OUT_ROOT);
  const dryRun = argv.includes('--dry-run');
  const replace = argv.includes('--replace');
  // A day that exists but still lists failures is incomplete for our purposes. Re-running only those
  // is the normal recovery path after a rate limit, and it must not require --replace, which would
  // re-fetch every repository (and refetch days that are already whole).
  const retryFailed = argv.includes('--retry-failed');
  const { token, origin: tokenOrigin } = resolveToken();
  const single = value(argv, '--date');
  const start = value(argv, '--start');
  const end = value(argv, '--end');
  if (single && (start || end)) throw new Error('use either --date or --start/--end, not both');

  let dates;
  if (single) dates = [single];
  else if (start && end) dates = eachDate(start, end);
  else throw new Error('provide --date YYYY-MM-DD or --start/--end');
  if (dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new Error('dates must be YYYY-MM-DD');

  // Repository responses are identical across the days a project appears on, so the network work is
  // done once per repository and reused. Without this the same repo would be fetched daily.
  const cache = new Map();
  let filesWritten = 0, filesSkipped = 0, fetched = 0, reuses = 0, failures = 0;
  const summary = [];
  for (const targetDate of dates) {
    const outFile = path.join(outRoot, `${targetDate}.json`);
    let existing = null;
    if (fs.existsSync(outFile)) {
      if (!replace) {
        if (!retryFailed) { filesSkipped += 1; continue; }
        existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        if (!(existing.failures || []).length) { filesSkipped += 1; continue; }
      }
    }
    const candidates = candidatesFor(targetDate);
    if (!candidates) { console.log(`[${SOURCE_ID}] ${targetDate}: no report, skipped`); filesSkipped += 1; continue; }
    // On a retry, keep the records already captured and only re-fetch the failures.
    const alreadyHave = new Set((replace ? [] : (existing?.records || [])).map(record => record.repository));
    for (const failure of replace ? [] : (existing?.failures || [])) alreadyHave.delete(failure.repository);

    const records = [], failed = [];
    for (const [repository, references] of [...candidates.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (alreadyHave.has(repository)) { records.push((existing.records).find(record => record.repository === repository)); reuses += 1; continue; }
      let response = cache.get(repository);
      if (response) reuses += 1;
      else if (dryRun) response = { language: '(dry-run)', stargazers_count: 0, forks_count: 0, html_url: `https://github.com/${repository}` };
      else {
        try { response = fetchRepository(repository, token); fetched += 1; cache.set(repository, response); }
        catch (error) { failed.push({ repository, references, error: String(error.message || error).slice(0, 500) }); failures += 1; continue; }
      }
      records.push({ repository, resolvedRepository: repositoryKey(response.html_url), references, response });
    }

    const document = {
      schemaVersion: 1,
      sourceId: SOURCE_ID,
      sourceName: 'GitHub 仓库信息',
      targetDate,
      timezone: TIMEZONE,
      status: records.length ? 'ok' : 'empty',
      complete: true,
      fetchedAt: new Date().toISOString(),
      itemCount: records.length,
      candidateCount: candidates.size,
      failureCount: failed.length,
      contentSha256: sha256({ records, failures: failed }),
      capture: {
        mode: 'backfilled-reference-snapshot',
        endpoint: `${ENDPOINT}/{owner}/{repo}`,
        observedDate,
        // Read this before using any metric: the report day says which rows the file describes, the
        // observation day says when the values were actually read. They differ here by design.
        metricsObservedAt: observedDate,
        authOrigin: tokenOrigin,
        derivedFrom: `知识/大家都在做什么/raw/${targetDate}.json`,
        candidateRepositories: [...candidates.keys()].sort(),
      },
      records,
      failures: failed,
    };
    if (!dryRun) atomicWrite(outFile, `${JSON.stringify(document, null, 2)}\n`);
    filesWritten += 1;
    if (summary.length < 3 || dates.length <= 5) summary.push({ date: targetDate, candidates: candidates.size, records: records.length, failed: failed.length });
  }

  console.log(JSON.stringify({
    observedDate, authOrigin: tokenOrigin, days: dates.length, filesWritten, filesSkipped,
    repositoriesFetched: fetched, repositoryReuses: reuses, failures,
    sample: summary, dryRun,
  }, null, 2));
}

if (require.main === module) main();
