#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('../../web/shared.js');
const { identitiesFor, productId } = require('./identity');
const {
  loadItems, loadGithubRepositories, attachRepositoryFacts,
  loadSiteDescriptions, attachDescriptionFallback,
} = require('../../.agents/skills/community-pulse/scripts/source_raw_items');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_RAW_ROOT = path.join(ROOT, '知识', '大家都在做什么', 'source-raw');
const DEFAULT_OUTPUT = path.join(ROOT, 'data', 'catalog', 'mysql-import');
const SOURCE_CONFIG = path.join(ROOT, '.agents', 'skills', 'community-pulse', 'config', 'sources.json');
const TAXONOMY_VERSION = 'legacy-infer-v1';

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
  product_details: {
    columns: ['product_id', 'observed_date', 'content_score', 'item_json', 'content_hash'],
    upsert: `ON DUPLICATE KEY UPDATE
      item_json=IF(VALUES(observed_date) > product_details.observed_date OR
        (VALUES(observed_date) = product_details.observed_date AND VALUES(content_score) >= product_details.content_score),
        VALUES(item_json), product_details.item_json),
      content_hash=IF(VALUES(observed_date) > product_details.observed_date OR
        (VALUES(observed_date) = product_details.observed_date AND VALUES(content_score) >= product_details.content_score),
        VALUES(content_hash), product_details.content_hash),
      content_score=IF(VALUES(observed_date) > product_details.observed_date OR
        (VALUES(observed_date) = product_details.observed_date AND VALUES(content_score) >= product_details.content_score),
        VALUES(content_score), product_details.content_score),
      observed_date=GREATEST(product_details.observed_date, VALUES(observed_date)), updated_at=CURRENT_TIMESTAMP(3)`,
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
    const boolean = name === '--no-taxonomy';
    const value = inline === undefined && !boolean ? argv[++index] : inline;
    if (name === '--out') options.out = path.resolve(value);
    else if (name === '--raw-root') options.rawRoot = path.resolve(value);
    else if (name === '--start') options.start = value;
    else if (name === '--end') options.end = value;
    else if (name === '--sources') options.sources = new Set(value.split(',').filter(Boolean));
    else if (name === '--max-bytes') options.maxBytes = Number(value);
    else if (name === '--no-taxonomy') options.taxonomy = false;
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
  'sourceId', 'sourceName', 'externalId', 'title', 'titleZh', 'titleEn', 'summary', 'summaryZh', 'summaryEn',
  'url', 'websiteUrl', 'githubUrl', 'issueUrl', 'relatedIssue', 'hnUrl', 'vibecafeUrl', 'productHuntUrl',
  'author', 'authorUrl', 'publishedAt', 'tags', 'taxonomy', 'primaryCategory', 'language', 'lang',
  'logo', 'icon', 'siteLogo', 'image', 'images', 'imageUrls', 'metrics', 'github',
];

function detailItem(item, source) {
  const detail = { sourceId: item.sourceId || source.id, sourceName: item.sourceName || source.name };
  for (const key of DETAIL_FIELDS) if (item[key] !== undefined) detail[key] = item[key];
  return detail;
}

function detailScore(item) {
  return String(item.summaryZh || item.summaryEn || item.summary || '').length
    + (item.github ? 200 : 0) + ((item.images || item.imageUrls || []).length * 20)
    + (item.logo || item.icon || item.siteLogo ? 50 : 0);
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

  for (const source of sources) {
    for (const date of sourceDates(options.rawRoot, source.id, options)) {
      const loaded = loadItems(source, {
        date, observedDate: date, rawRoot: options.rawRoot, maxItems: Infinity, productHuntView: 'all',
      });
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
        const title = String(item.title || '');
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
        if (!knownDetail || date > knownDetail.date || (date === knownDetail.date && score >= knownDetail.score)) {
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
    days, rows,
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
  // INSERT IGNORE over the taxonomy unique key costs more Worker CPU per byte than the plain
  // detail upsert. Keep those statements smaller so the temporary import Worker stays below 1102.
  const byteLimit = table === 'taxonomy_assignments' ? Math.min(maxBytes, 750_000) : maxBytes;
  let tuples = [];
  let tupleBytes = 0;
  const flush = () => {
    if (!tuples.length) return;
    const verb = upsert ? 'INSERT INTO' : 'INSERT IGNORE INTO';
    const content = `${verb} ${table} (${columns.join(',')}) VALUES\n${tuples.join(',\n')}${upsert ? `\n${upsert}` : ''};\n`;
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
  fs.mkdirSync(options.out, { recursive: true });
  for (const name of fs.readdirSync(options.out)) {
    if (/^\d{5}-.*\.sql$|^manifest\.json$|^\.uploaded\.json$/.test(name)) fs.rmSync(path.join(options.out, name));
  }
  const collected = collectRows(options);
  const state = { sequence: 0, files: [] };
  for (const [table, rows] of Object.entries(collected.tables)) writeTable(options.out, table, rows, options.maxBytes, state);
  const manifest = {
    schemaVersion: 3, dialect: 'mysql', source: 'source-raw', generatedAt: new Date().toISOString(),
    range: { start: options.start || null, end: options.end || null }, days: collected.days, inputRows: collected.rows,
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

module.exports = { parseArgs, sourceDates, sqlValue, taxonomyRows, collectRows, buildMysqlImport, loadEvidence, repositoryEvidenceDate, TABLES };
