#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../../web/shared.js');
const images = require('../image-store.js');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT = path.join(ROOT, 'data', 'catalog', 'site-snapshot');
const FACETS = ['useCases', 'agentRoles', 'languages'];
const WINDOW_DAYS = { recent: 7, '4w': 28, '12w': 84 };
const imageManifest = images.readManifest();
const lightMarks = images.readTones().light;

// 分类库/趋势快照里的条目是 MySQL `item_json` 的投影，图片地址必须和日报行走同一条本地化：同一张
// 官网图标在日报行上是 R2 地址、在分类页上是官网原始地址的话，消费端的 D.localImage 只认镜像与
// 两个回源 host，会把它整个丢掉 —— 线上实测分类页 5 行里 4 行只剩首字母。
// 宽松模式：快照含历史全量，早被 prune 的老地址不该让整次快照失败（顺带带上浅色标志的 markTone）。
function localizeSnapshotProducts(products) {
  for (const product of products || []) images.localizeItem(product, imageManifest, lightMarks, { strict: false });
  return products;
}

function parseArgs(argv) {
  // Internal batch jobs use the same production Worker without the public site's zone WAF.
  const options = { origin: process.env.CATALOG_API_ORIGIN || 'https://community-pulse.nichangen.workers.dev', out: DEFAULT_OUT, concurrency: 1, refresh: false };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    // `--refresh` 是开关，不带值；其它参数都需要值。
    const boolean = name === '--refresh';
    const value = inline === undefined && !boolean ? argv[++index] : inline;
    if (name === '--origin') options.origin = value;
    else if (name === '--out') options.out = path.resolve(value);
    else if (name === '--concurrency') options.concurrency = Math.max(1, Number(value) || 1);
    else if (name === '--from') options.from = value;
    else if (name === '--to') options.to = value;
    else if (name === '--refresh') options.refresh = inline === undefined || inline !== 'false';
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

function offsetDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function fetchJson(origin, route, fetcher = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  let lastError;
  // A snapshot pages through thousands of products. One transient edge/Hyperdrive 5xx must not
  // discard the whole daily batch; 4 quick retries were insufficient on the ATL runner.
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetcher(new URL(route, origin), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !/\bjson\b/i.test(contentType)) {
        const ray = response.headers.get('cf-ray');
        const message = `${route}: HTTP ${response.status}, ${contentType || 'unknown content type'}${ray ? `, cf-ray ${ray}` : ''}`;
        // **「是不是 HTML」不能用来判「永久」**：Cloudflare 的验证页是 HTML（403），但 502/503/504
        // 的源站错误页**也是 HTML** —— 而那些是暂时的，必须重试。2026-09-24 实测踩到：`502, text/html`
        // 被判成永久 → 整批快照丢弃 → 当期日报没提交（那时的 run 35937702792）。
        // 判据改成**按状态码**：403 与 4xx（429 除外）是永久；5xx 一律重试。
        const permanent = response.status === 403
          || (response.status >= 400 && response.status < 500 && response.status !== 429);
        let errorCode = '';
        if (/\bjson\b/i.test(contentType)) {
          try {
            const body = await response.json();
            if (/^[a-z_]{1,80}$/.test(body?.error || '')) errorCode = `, catalog error ${body.error}`;
          } catch (_) {}
        }
        const suffix = permanent ? '（永久，不重试）' : '（暂时，将重试）';
        // 403 保留「possible Cloudflare challenge」这个措辞：它是验证页的特征，也是既有测试
        // 与运维习惯认的信号。**响应体一律不进错误消息**（可能含 challenge token）。
        const hint = response.status === 403 ? '; expected catalog JSON (possible Cloudflare challenge)' : `; expected catalog JSON${suffix}`;
        const error = new Error(`${message}${errorCode}${hint}`);
        if (permanent) error.permanent = true;
        throw error;
      }
      return response.json();
    } catch (error) {
      lastError = error;
      if (error.permanent) break;
      if (attempt < maxAttempts) await sleep(Math.min(30000, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

function segment(type) {
  return { useCases: 'use-cases', agentRoles: 'agent-roles', languages: 'programming-languages' }[type];
}

function rangeStats(products, latest) {
  const stats = {};
  for (const [id, days] of Object.entries(WINDOW_DAYS)) {
    const start = offsetDate(latest, -(days - 1));
    const rows = products.filter((product) => product.trendDate >= start && product.trendDate <= latest);
    stats[id] = { start, end: latest, count: rows.length, sources: new Set(rows.flatMap((row) => row.sourceIds || [row.sourceId])).size };
  }
  return stats;
}

async function categoryProducts(options, type, id, earliest, latest) {
  const products = [];
  let cursor = '';
  for (;;) {
    const query = new URLSearchParams({ facet: type, term: id, from: earliest, to: latest, pageSize: '100' });
    if (cursor) query.set('cursor', cursor);
    const data = await fetchJson(options.origin, `/api/v1/products?${query}`);
    products.push(...(data.products || []).map((product) => {
      const productId = product.productId || product.externalId;
      let projectPath = product.projectPath;
      if (!projectPath && product.githubUrl) {
        try { projectPath = `/projects/${new URL(product.githubUrl).pathname.replace(/^\//, '').replace(/\/$/, '').toLowerCase()}/`; } catch {}
      }
      if (!projectPath && /^prd_[a-f0-9]{24}$/.test(productId || '')) projectPath = `/products/${productId}/`;
      return { ...product, productId, projectPath };
    }));
    if (!data.hasMore) break;
    if (!data.nextCursor) throw new Error(`${type}:${id} did not return a pagination cursor`);
    cursor = data.nextCursor;
  }
  return products;
}

async function mapLimit(values, concurrency, callback) {
  const result = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await callback(values[index], index);
    }
  }));
  return result;
}

function buildCluster(row, type, ranges, projects) {
  return {
    key: `${type}:${row.id}`, type, id: row.id, parentId: row.parentId || null,
    path: row.path, dataPath: `/data/trends/${segment(type)}/${row.id}.json`, ranges,
    recentCount: Number(row.currentCount || 0), baselineCount: Number(row.previousCount || 0),
    sourceCount: Number(row.sourceCount || 0), growthPercent: row.growth === null ? null : Math.round(Number(row.growth) * 100),
    isNew: Boolean(row.isNew), weekly: row.weekly || [],
    examples: (row.examples || []).map((example) => ({
      titleZh: example.title, titleEn: example.title, summaryZh: '', summaryEn: '',
      url: example.url, internal: Boolean(example.internal), date: example.date,
    })),
    projects,
  };
}

async function buildSiteSnapshot(options) {
  const sourceModel = await fetchJson(options.origin, '/api/v1/sources');
  const sources = sourceModel.sources || [];
  if (!sources.length) throw new Error('catalog API returned no sources');
  const databaseLatest = sources.map((source) => String(source.lastSeenDate).slice(0, 10)).sort().at(-1);
  const publishedDates = fs.readdirSync(path.join(ROOT, '知识', '大家都在做什么', 'raw'))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).map((name) => name.slice(0, 10)).sort();
  const latest = options.to || publishedDates.at(-1) || databaseLatest;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(latest) || latest > databaseLatest) throw new Error(`snapshot end ${latest} exceeds MySQL latest ${databaseLatest}`);
  const availableFrom = sources.map((source) => String(source.firstSeenDate).slice(0, 10)).sort()[0];
  const earliest = options.from || offsetDate(latest, -83);
  // Each trend request already parallelizes three bounded MySQL projections inside the Worker.
  // Fetch facets serially here so a daily snapshot does not fan that out to nine simultaneous
  // Hyperdrive result sets and trip the Worker's memory limit on a cold edge location.
  const trendModels = {};
  for (const facet of FACETS) trendModels[facet] = await fetchJson(options.origin,
    `/api/v1/trends?facet=${facet}&from=${offsetDate(latest, -6)}&to=${latest}`);
  const terms = FACETS.flatMap((type) => {
    const definitions = type === 'languages' ? D.languageFacets : D.taxonomyFacets[type];
    return definitions.map(([id]) => ({ type, id }));
  });
  const temp = `${options.out}.tmp`;
  fs.mkdirSync(path.join(temp, 'categories'), { recursive: true });
  const files = [];
  const productRoutes = new Map();
  const categoryModels = await mapLimit(terms, options.concurrency, async ({ type, id }) => {
    const pathname = `categories/${segment(type)}/${id}.json`;
    const target = path.join(temp, pathname);
    let products;
    const prior = fs.existsSync(target) ? target : path.join(options.out, pathname);
    // `--refresh` 强制跳过同版本缓存：MySQL 里的投影变了但 `--to` 没变时（例如历史数据回填后
    // 手工补跑），缓存命中会让整份快照原样吐回来，`catalogVersion` 也不变，产品页继续吃旧内容。
    if (!options.refresh && fs.existsSync(prior)) {
      const cached = JSON.parse(fs.readFileSync(prior, 'utf8'));
      if (cached.latest === latest && cached.ranges?.['12w']?.start === earliest && cached.type === type && cached.id === id) {
        products = cached.projects;
        console.log(`Reused ${type}:${id} (${products.length} products)`);
      }
    }
    if (!products) {
      products = await categoryProducts(options, type, id, earliest, latest);
      console.log(`Fetched ${type}:${id} (${products.length} products)`);
    }
    // 复用上一份快照时也要过一遍：那份缓存可能是本地化之前生成的。
    localizeSnapshotProducts(products);
    for (const product of products) if (product.projectPath) productRoutes.set(product.projectPath, {
      route: product.projectPath, date: product.trendDate || latest, productId: product.productId,
      indexable: String(product.summaryZh || product.summaryEn || product.summary || '').trim().length >= D.DETAIL_SUMMARY_MIN,
    });
    const ranges = rangeStats(products, latest);
    const payload = { schemaVersion: 2, type, id, latest, ranges, projects: products };
    const content = `${JSON.stringify(payload)}\n`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    files.push({ path: pathname, bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') });
    const row = (trendModels[type].results || []).find((candidate) => candidate.id === id) || {
      id, parentId: D.facetParent(type, id), labelZh: D.facetLabel(type, id, 'zh-CN'), labelEn: D.facetLabel(type, id, 'en'),
      currentCount: ranges.recent.count, previousCount: 0, sourceCount: ranges.recent.sources,
      growth: null, isNew: ranges.recent.count > 0, path: `/trends/${segment(type)}/${id}/`, weekly: [], examples: [],
    };
    const recent = products.filter((product) => product.trendDate >= ranges.recent.start);
    return buildCluster(row, type, ranges, recent);
  });
  const first = trendModels.useCases;
  const model = {
    schemaVersion: 5, source: 'mysql-site-snapshot', latest,
    recent: { start: first.filters.from, end: first.filters.to, days: first.filters.days },
    baseline: { ...first.filters.comparison }, thresholds: first.thresholds,
    coverage: first.coverage, sources,
    clusters: categoryModels.filter((cluster) => cluster.recentCount > 0),
    catalogClusters: categoryModels,
  };
  const routes = [...productRoutes.values()].sort((a, b) => a.route.localeCompare(b.route));
  const digestInput = JSON.stringify({ sources, trendModels, files: files.sort((a, b) => a.path.localeCompare(b.path)), routes });
  const catalogVersion = `${latest}-${crypto.createHash('sha256').update(digestInput).digest('hex').slice(0, 16)}`;
  const manifest = { schemaVersion: 1, catalogVersion, generatedAt: new Date().toISOString(), availableFrom, windowStart: earliest, latest,
    files, productRoutes: routes, trends: model };
  fs.writeFileSync(path.join(temp, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  fs.rmSync(options.out, { recursive: true, force: true });
  fs.renameSync(temp, options.out);
  fs.writeFileSync(path.join(ROOT, 'worker', 'catalog-version.mjs'), `// Generated by scripts/catalog/build-site-snapshot.js.\nexport const CATALOG_VERSION = '${catalogVersion}';\n`);
  return manifest;
}

if (require.main === module) {
  buildSiteSnapshot(parseArgs(process.argv.slice(2))).then((manifest) => {
    console.log(`Built MySQL site snapshot ${manifest.catalogVersion}: ${manifest.files.length} category files.`);
  }).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = { parseArgs, offsetDate, fetchJson, rangeStats, buildCluster, buildSiteSnapshot, localizeSnapshotProducts };
