const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');
const { identitiesFor, productId } = require('./catalog/identity.js');

const root = path.resolve(__dirname, '..');
const rawDir = path.join(root, '知识', '大家都在做什么', 'raw');
const config = JSON.parse(fs.readFileSync(path.join(root, 'site.config.json'), 'utf8'));
const snapshotFile = path.join(root, 'data', 'catalog', 'site-snapshot', 'manifest.json');

// 详情页在摘要短于这个长度时是 `noindex`（判定见 worker/project-page.mjs，两处必须一致）：
// 把百度引到不该收录的薄页上，等于白白花掉当天只有个位数的配额。
const DETAIL_SUMMARY_MIN = 20;
// 入口页：今日发现 / 趋势洞察。历史归档 `/reports/` 不在百度日推集合里 —— 它有全站导航内链、
// 也在 sitemap 里，每天占一个名额换不来收录（IndexNow 没有配额，仍旧带它）。
const HUB_ROUTES = ['/', '/trends/'];

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

// 条目 → 站内详情页：GitHub 仓库是 `/projects/<owner>/<repo>/`，其余一律是产品库的
// `/products/prd_<id>/`（跟 scripts/build-site.js 用同一套 identity 逻辑，所以离线一致）。
function detailRoute(item, sourceId) {
  const repository = D.repository(item);
  if (repository) return repository.path;
  if (!(item.url || item.websiteUrl || item.githubUrl)) return null;
  try {
    return `/products/${productId(identitiesFor({ ...item, sourceId: item.sourceId || sourceId })[0])}/`;
  } catch {
    return null;
  }
}

// 快照给出的是「这份路由到底可不可索引」（构建期算好、sitemap 用的是同一个标记）；
// 快照没覆盖到的路由（例如刚收录、还没进快照的）退回日报条目自身的摘要长度判定。
function loadIndexableRoutes(file = snapshotFile) {
  try {
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Map((snapshot.productRoutes || []).map(product => [product.route, product.indexable]));
  } catch {
    return new Map();
  }
}

function isIndexableDetail(item, route, indexableRoutes) {
  const known = indexableRoutes.get(route);
  if (known !== undefined) return known;
  return String(item.summaryZh || item.summaryEn || item.summary || '').trim().length >= DETAIL_SUMMARY_MIN;
}

function detailRoutes(report) {
  const entries = [];
  for (const source of report.results || []) for (const item of source.items || []) {
    const route = detailRoute(item, source.sourceId);
    if (route) entries.push({ route, item });
  }
  return entries;
}

// 每日推送集合：三个入口页（今日发现 / 趋势洞察 / 当天日报）+ 当天详情页，顺序照搬日报自身
// 的排序，所以「当天最值得看的 5 个项目」一定排在配额能覆盖到的位置。`baidu` 受配额约束
// （见 submitBaidu，配额用满即停），`indexNow` 没有配额，多带上历史归档页。
function submissionUrls(report, date, indexableRoutes = loadIndexableRoutes()) {
  const detail = detailRoutes(report)
    .filter(entry => isIndexableDetail(entry.item, entry.route, indexableRoutes))
    .map(entry => entry.route);
  const baiduRoutes = [...new Set([...HUB_ROUTES, `/reports/${date}/`, ...detail])];
  const indexNowRoutes = [...new Set(['/', '/reports/', ...baiduRoutes])];
  return {
    baidu: baiduRoutes.map(route => D.origin + D.localPath(route, 'zh-CN')),
    indexNow: indexNowRoutes.flatMap(route => [D.origin + D.localPath(route, 'zh-CN'), D.origin + D.localPath(route, 'en')]),
  };
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

// 百度「普通收录」对超额批次是**整批拒绝**：配额只剩 7 条时推 53 条，HTTP 400 `over quota`，
// 一条都不会收录（实测 remain 不变），而站点日配额目前只有个位数，比一期日报要推的 URL 少得多。
// 所以整批提交在这里等于「配额够也推不进去、配额不够全丢，还把 workflow 判成失败」。
// 现在按条提交、把当天配额用满即停，剩下的记为 deferred —— 那部分本来就由 sitemap-baidu.xml
// 与百度自己的抓取兜底，是配额约束而不是站点故障，因此不抛错。
async function submitBaidu(urls, fetchImpl = fetch) {
  const token = process.env.BAIDU_SITE_TOKEN;
  if (!token) return { skipped: true, reason: 'BAIDU_SITE_TOKEN is not configured' };
  const endpoint = new URL(process.env.BAIDU_SUBMIT_ENDPOINT || 'http://data.zz.baidu.com/urls');
  endpoint.searchParams.set('site', process.env.BAIDU_SITE || new URL(D.origin).hostname);
  endpoint.searchParams.set('token', token);
  const quotaReached = deferred => {
    console.error(`百度今日配额已用完：已提交 ${submitted} 条，${deferred} 条未提交（由 sitemap-baidu.xml 兜底）`);
    return { status, submitted, remaining: 0, quotaExhausted: true, deferred };
  };
  let status = 0;
  let submitted = 0;
  let remaining = 0;
  for (let index = 0; index < urls.length; index += 1) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: urls[index],
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { result = {}; }
    status = response.status;
    if (!response.ok || result.error) {
      // 超额是预期内的配额上限；其它错误（token / site 不匹配等）仍旧硬失败。
      if (/over quota/i.test(result.message || '')) return quotaReached(urls.length - index);
      throw new Error(`Baidu rejected the submission with HTTP ${response.status}${result.message ? `: ${result.message}` : ''}`);
    }
    submitted += Number(result.success) || 0;
    remaining = Number(result.remain) || 0;
    if (remaining <= 0 && index + 1 < urls.length) return quotaReached(urls.length - index - 1);
  }
  return { status, submitted, remaining };
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
  const result = { date, indexNowUrls: targets.indexNow.length, baiduUrls: targets.baidu.length };
  if (dryRun) {
    result.dryRun = true;
    result.urls = targets;
  } else {
    if (!baiduOnly) result.indexNow = await submitIndexNow(targets.indexNow);
    if (!indexNowOnly) result.baidu = await submitBaidu(targets.baidu);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { reportDates, loadReport, submissionUrls, submitIndexNow, submitBaidu, detailRoute, loadIndexableRoutes };
