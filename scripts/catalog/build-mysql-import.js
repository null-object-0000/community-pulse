#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('../../web/shared.js');
const images = require('../image-store.js');
const { identitiesFor, productId } = require('./identity');
const {
  loadItems, loadGithubRepositories, attachRepositoryFacts,
  loadSiteDescriptions, attachDescriptionFallback,
} = require('../../.agents/skills/community-pulse/scripts/source_raw_items');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_RAW_ROOT = path.join(ROOT, '知识', '大家都在做什么', 'source-raw');
const DEFAULT_OUTPUT = path.join(ROOT, 'data', 'catalog', 'mysql-import');
const SOURCE_CONFIG = path.join(ROOT, '.agents', 'skills', 'community-pulse', 'config', 'sources.json');
// 与日报发布记录共用同一个版本号（web/shared.js 的 D.taxonomyVersion）。
const TAXONOMY_VERSION = D.taxonomyVersion;
// 图片清单与色调清单读一次即可：导入包是「历史全量」的投影，逐条读盘会让 32 万条观察变成 32 万次 IO。
const imageManifest = images.readManifest();
const lightMarks = images.readTones().light;

// 详情行「这次导入的版本该不该覆盖库里那一行」。三条任一成立就覆盖：
//   ① 内容分更高（更丰富的那次观测赢）；
//   ② 同分取更新的那次观测；
//   ③ 同一次观测重算（observed_date 相同）—— 仓库里那天的数据被修正过，直接覆盖，不比分数。
const DETAIL_ROW_WINS = `(VALUES(content_score) > product_details.content_score
        OR (VALUES(content_score) = product_details.content_score AND VALUES(observed_date) >= product_details.observed_date)
        OR VALUES(observed_date) = product_details.observed_date)`;
// 全量导入（`--replace-details`，构建期看到的是整段历史）时详情行无条件覆盖：这一次构建的结果就是
// 当前仓库数据的权威投影。**这是修历史数据的唯一通道** —— 部分导入必须保留分数比较（日更只看两天，
// 比不了），而分数比较天然拒绝「变短」的修正，所以清理过的历史行只能靠全量重建写回去。
const DETAILS_REPLACE_ALL = `ON DUPLICATE KEY UPDATE
      item_json=VALUES(item_json), content_hash=VALUES(content_hash), content_score=VALUES(content_score),
      observed_date=VALUES(observed_date), updated_at=CURRENT_TIMESTAMP(3)`;
const TABLES = {
  sources: {
    columns: ['id', 'name', 'description', 'enabled', 'sort_order'],
    upsert: `ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description),
      enabled=VALUES(enabled), sort_order=VALUES(sort_order), updated_at=CURRENT_TIMESTAMP(3)`,
  },
  products: {
    columns: ['id', 'canonical_key', 'title', 'canonical_url', 'github_repo', 'first_seen_date', 'last_seen_date'],
    upsert: `ON DUPLICATE KEY UPDATE
      title=CASE WHEN length(VALUES(title)) > length(products.title) THEN VALUES(title) ELSE products.title END,
      canonical_url=COALESCE(NULLIF(products.canonical_url, ''), VALUES(canonical_url)),
      github_repo=COALESCE(NULLIF(products.github_repo, ''), VALUES(github_repo)),
      first_seen_date=LEAST(products.first_seen_date, VALUES(first_seen_date)),
      last_seen_date=GREATEST(products.last_seen_date, VALUES(last_seen_date)), updated_at=CURRENT_TIMESTAMP(3)`,
  },
  product_routes: {
    columns: ['route_path', 'product_id', 'route_kind'],
    upsert: `ON DUPLICATE KEY UPDATE product_id=VALUES(product_id), route_kind=VALUES(route_kind),
      updated_at=CURRENT_TIMESTAMP(3)`,
  },
  // 与 detailRanksHigher 逐字对应：内容分高的赢，同分取更新的那次观测。日更只导入两天，构建期看不到
  // 更早的好行，所以这条规则必须由 upsert 自己复算一遍，否则第二天一条空描述的观测就会把好行顶掉。
  // observed_date 跟着赢的那一行走（不再取 GREATEST），让「日期 + 分数」始终描述同一行；真实最新
  // 观测日期由 products.last_seen_date 承担，详情页的「最近收录」读的是它。
  //
  // 第三个条件是 2026-09-18 补的：**同一个 observed_date 的重导入等于「同一次观测重算」**，仓库里
  // 那天的数据就是修正后的真值，直接覆盖，不比分数。缺了它就会出现「修不动」的死角 —— 简介清洗把
  // 文本变短，content_score 只会更低，而前两个条件都要求分数不降，于是清理过的行永远进不了库
  // （09-17 的投稿插图回填之后，1194 行详情页还挂着 `<img … src=" />` 残骸，就是这么留下来的）。
  product_details: {
    columns: ['product_id', 'observed_date', 'content_score', 'item_json', 'content_hash'],
    upsert: `ON DUPLICATE KEY UPDATE
      item_json=IF(${DETAIL_ROW_WINS}, VALUES(item_json), product_details.item_json),
      content_hash=IF(${DETAIL_ROW_WINS}, VALUES(content_hash), product_details.content_hash),
      content_score=IF(${DETAIL_ROW_WINS}, VALUES(content_score), product_details.content_score),
      observed_date=IF(${DETAIL_ROW_WINS}, VALUES(observed_date), product_details.observed_date), updated_at=CURRENT_TIMESTAMP(3)`,
  },
  product_source_first_seen: {
    columns: ['product_id', 'source_id', 'first_seen_date', 'last_seen_date', 'observation_count'],
    upsert: `ON DUPLICATE KEY UPDATE
      first_seen_date=LEAST(product_source_first_seen.first_seen_date, VALUES(first_seen_date)),
      last_seen_date=GREATEST(product_source_first_seen.last_seen_date, VALUES(last_seen_date)),
      observation_count=GREATEST(product_source_first_seen.observation_count, VALUES(observation_count))`,
  },
  taxonomy_terms: {
    columns: ['facet', 'id', 'parent_id', 'label_zh', 'label_en', 'sort_order', 'active'],
    upsert: `ON DUPLICATE KEY UPDATE parent_id=VALUES(parent_id), label_zh=VALUES(label_zh),
      label_en=VALUES(label_en), sort_order=VALUES(sort_order), active=VALUES(active)`,
  },
  taxonomy_assignments: {
    columns: ['product_id', 'facet', 'term_id', 'assignment_source', 'confidence', 'processor_version', 'is_current'],
  },
};

function parseArgs(argv) {
  const options = { out: DEFAULT_OUTPUT, rawRoot: DEFAULT_RAW_ROOT, taxonomy: true, maxBytes: 3_500_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const boolean = name === '--no-taxonomy' || name === '--replace-details';
    const value = inline === undefined && !boolean ? argv[++index] : inline;
    if (name === '--out') options.out = path.resolve(value);
    else if (name === '--raw-root') options.rawRoot = path.resolve(value);
    else if (name === '--start') options.start = value;
    else if (name === '--end') options.end = value;
    else if (name === '--sources') options.sources = new Set(value.split(',').filter(Boolean));
    else if (name === '--max-bytes') options.maxBytes = Number(value);
    else if (name === '--no-taxonomy') options.taxonomy = false;
    else if (name === '--replace-details') options.replaceDetails = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!Number.isFinite(options.maxBytes) || options.maxBytes < 100_000) throw new Error('--max-bytes is too small');
  return options;
}

function sourceDates(rawRoot, sourceId, options) {
  const directory = path.join(rawRoot, sourceId);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter((date) => date && (!options.start || date >= options.start) && (!options.end || date <= options.end))
    .sort();
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

function taxonomyRows() {
  const rows = [];
  const facets = { ...D.taxonomyFacets, languages: D.languageFacets };
  for (const [facet, terms] of Object.entries(facets)) {
    const byId = new Map(terms.map((term, index) => [term[0], { term, index }]));
    const inserted = new Set();
    const insert = (id) => {
      if (inserted.has(id)) return;
      const entry = byId.get(id);
      if (!entry) throw new Error(`unknown taxonomy term ${facet}:${id}`);
      const parent = D.taxonomyParents[facet]?.[id] || null;
      if (parent) insert(parent);
      const [, zh, en] = entry.term;
      rows.push([facet, id, parent, zh, en, entry.index, 1]);
      inserted.add(id);
    };
    for (const [id] of terms) insert(id);
  }
  return rows;
}

// Repository snapshots are captured per report date (`capture_github_repositories_raw.js --date
// $TARGET`), but V2EX and both GitHub Trending sources file their documents under the *observed*
// date (`$OBSERVED = TARGET + 1`). Walking document dates therefore looked for
// `github-repositories/<observed>.json`, found nothing, and passed `repositories: null` — so every
// item in those partitions lost its homepage, language, stars and topics. That is what left their
// detail pages without a 官网 button even though the report row (enriched from the TARGET snapshot)
// had the site. Fall back to the newest snapshot at or before the document date; the facts keep
// their own `snapshotDate`, so a page still reports how old the numbers are.
const repositorySnapshotDates = new Map();
function repositoryEvidenceDate(rawRoot, date) {
  if (!repositorySnapshotDates.has(rawRoot)) {
    const directory = path.join(rawRoot, 'github-repositories');
    repositorySnapshotDates.set(rawRoot, fs.existsSync(directory)
      ? fs.readdirSync(directory).map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter(Boolean).sort()
      : []);
  }
  let found = null;
  for (const value of repositorySnapshotDates.get(rawRoot)) {
    if (value > date) break;
    found = value;
  }
  return found;
}

const repositorySnapshots = new Map();
function repositoriesFor(rawRoot, evidenceDate) {
  const key = `${rawRoot}\0${evidenceDate}`;
  if (!repositorySnapshots.has(key)) repositorySnapshots.set(key, loadGithubRepositories(rawRoot, evidenceDate).repositories);
  return repositorySnapshots.get(key);
}

function loadEvidence(cache, rawRoot, date) {
  if (cache.has(date)) return cache.get(date);
  const evidenceDate = repositoryEvidenceDate(rawRoot, date);
  const evidence = {
    repositories: evidenceDate ? repositoriesFor(rawRoot, evidenceDate) : null,
    descriptions: loadSiteDescriptions(date, rawRoot),
  };
  cache.set(date, evidence);
  return evidence;
}

// `hnUrl` is the Show HN thread. It is the only origin URL those items carry (their `url` is the
// repository or the product site), so dropping it here left Show HN detail pages with no source
// but the board. Adding a field changes content_hash, which is why the catalogue version follows.
const DETAIL_FIELDS = [
  'sourceId', 'sourceName', 'externalId', 'title', 'titleFallback', 'titleFallbackSource', 'titleZh', 'titleEn', 'summary', 'summaryZh', 'summaryEn',
  'url', 'websiteUrl', 'githubUrl', 'issueUrl', 'relatedIssue', 'hnUrl', 'vibecafeUrl', 'productHuntUrl',
  'author', 'authorUrl', 'publishedAt', 'tags', 'taxonomy', 'primaryCategory', 'language', 'lang',
  'logo', 'icon', 'siteLogo', 'image', 'images', 'imageUrls', 'metrics', 'github',
];

function detailItem(item, source) {
  item = D.withTitleFallback(item);
  const detail = { sourceId: item.sourceId || source.id, sourceName: item.sourceName || source.name };
  for (const key of DETAIL_FIELDS) if (item[key] !== undefined) detail[key] = item[key];
  // 这份 item 是详情页与分类页的唯一输入（Worker 从 MySQL 现场渲染），而它以前存的是**官网原始
  // 地址**：Worker 的 trustedImage() 只放行镜像域名与两个回源 host，于是官网图标全被丢掉 —— 实测
  // 6,895 个有标志的产品里 1,552 个（22%）详情页只剩首字母，而同一期日报行是正常的。现在两条链
  // 共用 image-store 的同一段本地化（顺带带上浅色标志的 markTone）。
  // 宽松模式：历史全量里难免有源已失效、清单已 prune 掉的老地址，一张图不该让整次导入失败。
  return images.localizeItem(detail, imageManifest, lightMarks, { strict: false });
}

function detailScore(item) {
  return String(item.summaryZh || item.summaryEn || item.summary || '').length
    + (item.github ? 200 : 0) + ((item.images || item.imageUrls || []).length * 20)
    + (item.logo || item.icon || item.siteLogo ? 50 : 0);
}

// 一个产品在 product_details 里只留一行，这一行给详情页当正文。择优规则是**内容分高的赢，同分取
// 更新的那次观测**。以前是反过来的（日期新的无条件覆盖），于是一条没有描述的 GitHub Trending 观测
// 会把几周前一条上千字的投稿描述顶掉：详情页只剩占位符，还被收录门禁判成薄页 noindex —— 2026-09-17
// 的 GSC 报告里 cross-stitch（09-02 的 160 字介绍被 09-04 一条 score 0 的 Show HN 链接帖覆盖）与
// coding-tools-mcp（05-21 的 1689 字自荐被 9 月一条空描述的 trending 行覆盖）就是这么来的。
//
// 为什么是「评分优先」而不是「以最新行为基底、把更好的摘要搬过来」：MySQL 的 upsert 必须独立复算
// 同一个规则，而日更只导入 TARGET..OBSERVED 两天 —— 构建期根本看不到那条旧的好行。字段级合并要
// 在 SQL 里做 JSON 手术（且阈值要抄进 SQL），分叉出第二份难测的实现；评分优先只需比较已经存在
// 的 content_score 列，两条链天然一致。代价是这一行的官网 / 配图也停在更丰富的那次观测上，而
// 「最近收录」来自 products 表，仍然是最新的。
// 改 detailScore 的权重就等于换了度量：旧行存的是旧公式算的分，必须跑一次全量导入（catalog-refresh
// 的 full_rebuild）才会重新评分 —— 部分导入比的是新分与旧分，改过公式之后两边不可比。
//
// 这个函数只负责「本次构建内部，同一个产品的多次观测选哪一次」；与库里的存量行比大小是 upsert 的事
// （`DETAIL_ROW_WINS`，比这里多一条「同一次观测重算直接覆盖」）。
function detailRanksHigher(candidate, known) {
  if (!known) return true;
  if (candidate.score !== known.score) return candidate.score > known.score;
  return candidate.date >= known.date;
}

function collectRows(options) {
  const config = JSON.parse(fs.readFileSync(SOURCE_CONFIG, 'utf8'));
  const sources = config.sources.filter((source) => source.enabled && (!options.sources || options.sources.has(source.id)));
  const products = new Map();
  const routes = new Map();
  const details = new Map();
  const identityOwners = new Map();
  const firstSeen = new Map();
  const assignments = new Map();
  const observations = new Set();
  const evidenceCache = new Map();
  let days = 0;
  let rows = 0;
  const admissionDecisions = [];

  for (const source of sources) {
    for (const date of sourceDates(options.rawRoot, source.id, options)) {
      const loaded = loadItems(source, {
        date, observedDate: date, rawRoot: options.rawRoot, maxItems: Infinity, productHuntView: 'all',
      });
      admissionDecisions.push(...(loaded.sourceRaw?.admissionDecisions || []).map(d => ({ date, ...d })));
      const evidence = loadEvidence(evidenceCache, options.rawRoot, date);
      const items = attachDescriptionFallback(attachRepositoryFacts(loaded.items, evidence.repositories), evidence);
      days += 1;
      rows += items.length;
      for (const item of items) {
        const identities = identitiesFor(item);
        const owner = identities.map((identity) => identityOwners.get(`${identity.kind}\0${identity.normalizedValue}`)).find(Boolean);
        const primary = identities[0];
        const id = owner || productId(primary);
        for (const identity of identities) {
          const key = `${identity.kind}\0${identity.normalizedValue}`;
          if (!identityOwners.has(key)) identityOwners.set(key, id);
        }
        const existing = products.get(id);
        const title = D.titleFallback(item)?.value || String(item.title || '');
        products.set(id, {
          id,
          canonicalKey: existing?.canonicalKey || primary.canonicalKey,
          title: !existing || title.length > existing.title.length ? title : existing.title,
          canonicalUrl: existing?.canonicalUrl || primary.canonicalUrl || item.url || '',
          githubRepo: existing?.githubRepo || primary.githubRepo || '',
          firstSeenDate: existing ? [existing.firstSeenDate, date].sort()[0] : date,
          lastSeenDate: existing ? [existing.lastSeenDate, date].sort().at(-1) : date,
        });
        routes.set(`/products/${id}/`, [`/products/${id}/`, id, 'product']);
        const githubRepo = existing?.githubRepo || primary.githubRepo || '';
        if (githubRepo) routes.set(`/projects/${githubRepo}/`, [`/projects/${githubRepo}/`, id, 'github']);
        const projected = detailItem(item, source);
        const score = detailScore(projected);
        const knownDetail = details.get(id);
        if (detailRanksHigher({ date, score }, knownDetail)) {
          const json = JSON.stringify(projected);
          details.set(id, { id, date, score, json, hash: crypto.createHash('sha256').update(json).digest('hex') });
        }
        const externalId = String(item.externalId || item.url || item.title || 'untitled');
        const observationKey = `${source.id}\0${externalId}\0${date}`;
        const pairKey = `${id}\0${source.id}`;
        const pair = firstSeen.get(pairKey);
        if (!observations.has(observationKey)) {
          observations.add(observationKey);
          firstSeen.set(pairKey, {
            productId: id, sourceId: source.id,
            firstSeenDate: pair ? [pair.firstSeenDate, date].sort()[0] : date,
            lastSeenDate: pair ? [pair.lastSeenDate, date].sort().at(-1) : date,
            observationCount: (pair?.observationCount || 0) + 1,
          });
        }
        if (!options.taxonomy) continue;
        const taxonomy = D.itemTaxonomy(item);
        for (const [facet, terms] of Object.entries(taxonomy)) {
          if (!Array.isArray(terms) || !D.taxonomyFacets[facet]) continue;
          for (const term of terms) assignments.set(`${id}\0${facet}\0${term}`, [id, facet, term, 'rule', null, TAXONOMY_VERSION, 1]);
        }
        for (const language of D.itemLanguages(item)) {
          assignments.set(`${id}\0languages\0${language}`, [id, 'languages', language, 'rule', null, TAXONOMY_VERSION, 1]);
        }
      }
    }
  }

  return {
    days, rows, admissionDecisions,
    tables: {
      sources: sources.map((source, index) => [source.id, source.name, source.desc || '', 1, index]),
      products: [...products.values()].map((p) => [p.id, p.canonicalKey, p.title, p.canonicalUrl, p.githubRepo, p.firstSeenDate, p.lastSeenDate]),
      product_routes: [...routes.values()],
      product_details: [...details.values()].map((p) => [p.id, p.date, p.score, p.json, p.hash]),
      product_source_first_seen: [...firstSeen.values()].map((p) => [p.productId, p.sourceId, p.firstSeenDate, p.lastSeenDate, p.observationCount]),
      taxonomy_terms: options.taxonomy ? taxonomyRows() : [],
      taxonomy_assignments: [...assignments.values()],
    },
  };
}

function writeTable(directory, table, rows, maxBytes, state) {
  if (!rows.length) return;
  const { columns, upsert } = TABLES[table];
  const effectiveUpsert = table === 'product_details' && state.replaceDetails ? DETAILS_REPLACE_ALL : upsert;
  // INSERT IGNORE over the taxonomy unique key costs more Worker CPU per byte than the plain
  // detail upsert. Keep those statements smaller so the temporary import Worker stays below 1102.
  const byteLimit = table === 'taxonomy_assignments' ? Math.min(maxBytes, 750_000) : maxBytes;
  let tuples = [];
  let tupleBytes = 0;
  const flush = () => {
    if (!tuples.length) return;
    const verb = effectiveUpsert ? 'INSERT INTO' : 'INSERT IGNORE INTO';
    const content = `${verb} ${table} (${columns.join(',')}) VALUES\n${tuples.join(',\n')}${effectiveUpsert ? `\n${effectiveUpsert}` : ''};\n`;
    const name = `${String(state.sequence++).padStart(5, '0')}-${table}.sql`;
    fs.writeFileSync(path.join(directory, name), content);
    state.files.push({ name, table, rows: tuples.length, bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') });
    tuples = [];
    tupleBytes = 0;
  };
  for (const row of rows) {
    const tuple = `(${row.map(sqlValue).join(',')})`;
    // Keep each statement below the upload/packet budget, but do not impose a tiny row cap: the
    // full catalog contains hundreds of thousands of rows and 200-row chunks created 8k HTTP
    // uploads. Byte-bounded statements stay safe while reducing a full replay to a few hundred.
    if (tuples.length && tupleBytes + Buffer.byteLength(tuple) > byteLimit) flush();
    tuples.push(tuple);
    tupleBytes += Buffer.byteLength(tuple) + 2;
  }
  flush();
}

function buildMysqlImport(options) {
  options = { ...options, out: path.resolve(options.out || DEFAULT_OUTPUT), rawRoot: path.resolve(options.rawRoot || DEFAULT_RAW_ROOT) };
  // 无条件覆盖的前提是「构建期看到了这个产品的全部观测」。带上日期范围或来源过滤就不再成立 ——
  // 那会把范围外那条更丰富的老观测顶掉（正是 detailRanksHigher 要防的事）。
  if (options.replaceDetails && (options.start || options.end || options.sources)) {
    throw new Error('--replace-details 只能用于全量导入：不能和 --start / --end / --sources 一起用');
  }
  fs.mkdirSync(options.out, { recursive: true });
  for (const name of fs.readdirSync(options.out)) {
    if (/^\d{5}-.*\.sql$|^manifest\.json$|^\.uploaded\.json$/.test(name)) fs.rmSync(path.join(options.out, name));
  }
  const collected = collectRows(options);
  const state = { sequence: 0, files: [], replaceDetails: Boolean(options.replaceDetails) };
  for (const [table, rows] of Object.entries(collected.tables)) writeTable(options.out, table, rows, options.maxBytes, state);
  const manifest = {
    schemaVersion: 3, dialect: 'mysql', source: 'source-raw', generatedAt: new Date().toISOString(),
    range: { start: options.start || null, end: options.end || null }, replaceDetails: Boolean(options.replaceDetails), days: collected.days, inputRows: collected.rows,
    admissionDecisions: collected.admissionDecisions,
    files: state.files, totalRows: state.files.reduce((sum, file) => sum + file.rows, 0),
    totalBytes: state.files.reduce((sum, file) => sum + file.bytes, 0),
  };
  fs.writeFileSync(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (require.main === module) {
  try { console.log(JSON.stringify(buildMysqlImport(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { parseArgs, sourceDates, sqlValue, taxonomyRows, collectRows, buildMysqlImport, loadEvidence, repositoryEvidenceDate, detailScore, detailRanksHigher, TABLES };
