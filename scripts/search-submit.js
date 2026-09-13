const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');

const root = path.resolve(__dirname, '..');
const rawDir = path.join(root, '知识', '大家都在做什么', 'raw');
const config = JSON.parse(fs.readFileSync(path.join(root, 'site.config.json'), 'utf8'));

function reportDates() {
  return fs.readdirSync(rawDir)
    .map(name => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter(Boolean)
    .sort()
    .reverse();
}

function loadReport(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error(`Invalid report date: ${date || '(empty)'}`);
  const file = path.join(rawDir, `${date}.json`);
  if (!fs.existsSync(file)) throw new Error(`Report not found: ${date}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function submissionUrls(report, date) {
  const routes = new Set(['/', '/reports/', `/reports/${date}/`]);
  for (const item of D.reportItems(report)) {
    const repository = D.repository(item);
    if (repository) routes.add(repository.path);
  }
  const chinese = [...routes].map(route => D.origin + D.localPath(route, 'zh-CN'));
  const indexNow = [...chinese, ...[...routes].map(route => D.origin + D.localPath(route, 'en'))];
  return { chinese, indexNow: [...new Set(indexNow)] };
}

async function submitIndexNow(urls, fetchImpl = fetch) {
  const key = config.indexNowKey;
  if (!/^[a-f0-9]{8,128}$/i.test(key || '')) throw new Error('Invalid IndexNow key in site.config.json');
  const endpoint = process.env.INDEXNOW_ENDPOINT || 'https://api.indexnow.org/indexnow';
  const host = new URL(D.origin).hostname;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host, key, keyLocation: `${D.origin}/${key}.txt`, urlList: urls }),
    signal: AbortSignal.timeout(30000),
  });
  if (![200, 202].includes(response.status)) throw new Error(`IndexNow rejected the submission with HTTP ${response.status}`);
  return { status: response.status, submitted: urls.length };
}

async function submitBaidu(urls, fetchImpl = fetch) {
  const token = process.env.BAIDU_SITE_TOKEN;
  if (!token) return { skipped: true, reason: 'BAIDU_SITE_TOKEN is not configured' };
  const endpoint = new URL(process.env.BAIDU_SUBMIT_ENDPOINT || 'http://data.zz.baidu.com/urls');
  endpoint.searchParams.set('site', process.env.BAIDU_SITE || new URL(D.origin).hostname);
  endpoint.searchParams.set('token', token);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: urls.join('\n'),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = {}; }
  if (!response.ok || result.error) throw new Error(`Baidu rejected the submission with HTTP ${response.status}${result.message ? `: ${result.message}` : ''}`);
  return { status: response.status, submitted: Number(result.success) || 0, remaining: Number(result.remain) || 0 };
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function main() {
  const date = argumentValue('--date') || reportDates()[0];
  const targets = submissionUrls(loadReport(date), date);
  const dryRun = process.argv.includes('--dry-run');
  const indexNowOnly = process.argv.includes('--indexnow-only');
  const baiduOnly = process.argv.includes('--baidu-only');
  if (indexNowOnly && baiduOnly) throw new Error('--indexnow-only and --baidu-only cannot be combined');
  const result = { date, indexNowUrls: targets.indexNow.length, baiduUrls: targets.chinese.length };
  if (dryRun) {
    result.dryRun = true;
    result.urls = targets;
  } else {
    if (!baiduOnly) result.indexNow = await submitIndexNow(targets.indexNow);
    if (!indexNowOnly) result.baidu = await submitBaidu(targets.chinese);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { reportDates, loadReport, submissionUrls, submitIndexNow, submitBaidu };
