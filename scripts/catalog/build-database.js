#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const D = require('../../web/shared.js');
const { identitiesFor, productId, sourceItemId, stableId } = require('./identity');
const { loadItems, OBSERVED_SOURCES } = require('../../.agents/skills/community-pulse/scripts/source_raw_items');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_RAW_ROOT = path.join(ROOT, '知识', '大家都在做什么', 'source-raw');
const DEFAULT_DATABASE = path.join(ROOT, 'data', 'catalog', 'devtrends.sqlite');
const SOURCE_CONFIG = path.join(ROOT, '.agents', 'skills', 'community-pulse', 'config', 'sources.json');
const MIGRATIONS = path.join(ROOT, 'migrations');
const PARSER_VERSION = 'catalog-v1';
const TAXONOMY_VERSION = 'legacy-infer-v1';

function parseArgs(argv) {
  const options = { out: DEFAULT_DATABASE, rawRoot: DEFAULT_RAW_ROOT, replace: false, incremental: false, taxonomy: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') options.out = path.resolve(argv[++index]);
    else if (arg === '--raw-root') options.rawRoot = path.resolve(argv[++index]);
    else if (arg === '--start') options.start = argv[++index];
    else if (arg === '--end') options.end = argv[++index];
    else if (arg === '--sources') options.sources = new Set(argv[++index].split(',').filter(Boolean));
    else if (arg === '--replace') options.replace = true;
    else if (arg === '--incremental') options.incremental = true;
    else if (arg === '--no-taxonomy') options.taxonomy = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()
    .map((name) => path.join(MIGRATIONS, name));
}

function applyMigrations(db) {
  for (const file of migrationFiles()) db.exec(fs.readFileSync(file, 'utf8'));
}

function sourceDates(rawRoot, sourceId, options) {
  const directory = path.join(rawRoot, sourceId);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter((date) => date && (!options.start || date >= options.start) && (!options.end || date <= options.end))
    .sort();
}

function prepareStatements(db) {
  return {
    source: db.prepare(`INSERT INTO sources (id, name, description, enabled, sort_order)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
        enabled=excluded.enabled, sort_order=excluded.sort_order, updated_at=CURRENT_TIMESTAMP`),
    run: db.prepare(`INSERT INTO ingestion_runs
      (id, source_id, target_date, capture_mode, snapshot_path, snapshot_sha256, parser_version, status, item_count, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(source_id, target_date, snapshot_path, parser_version) DO UPDATE SET
        snapshot_sha256=excluded.snapshot_sha256, status='complete', item_count=excluded.item_count,
        completed_at=CURRENT_TIMESTAMP, error=NULL`),
    identityOwner: db.prepare('SELECT product_id FROM product_identities WHERE kind = ? AND normalized_value = ?'),
    product: db.prepare(`INSERT INTO products
      (id, canonical_key, title, canonical_url, github_repo, first_seen_date, last_seen_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=CASE WHEN length(excluded.title) > length(products.title) THEN excluded.title ELSE products.title END,
        canonical_url=COALESCE(NULLIF(products.canonical_url, ''), excluded.canonical_url),
        github_repo=COALESCE(NULLIF(products.github_repo, ''), excluded.github_repo),
        first_seen_date=min(products.first_seen_date, excluded.first_seen_date),
        last_seen_date=max(products.last_seen_date, excluded.last_seen_date), updated_at=CURRENT_TIMESTAMP`),
    identity: db.prepare(`INSERT OR IGNORE INTO product_identities
      (product_id, kind, normalized_value, display_value, source_id, confidence, is_primary)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    conflict: db.prepare(`INSERT OR IGNORE INTO identity_conflicts
      (kind, normalized_value, existing_product_id, candidate_product_id, source_id, external_id)
      VALUES (?, ?, ?, ?, ?, ?)`),
    sourceItem: db.prepare(`INSERT INTO source_items
      (id, source_id, external_id, product_id, title, summary, url, published_at, payload_json, raw_locator, projection_json, first_observed_date, last_observed_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        product_id=excluded.product_id,
        title=CASE WHEN length(excluded.title) > length(source_items.title) THEN excluded.title ELSE source_items.title END,
        summary=CASE WHEN length(excluded.summary) > length(source_items.summary) THEN excluded.summary ELSE source_items.summary END,
        url=COALESCE(NULLIF(source_items.url, ''), excluded.url),
        published_at=COALESCE(source_items.published_at, excluded.published_at),
        raw_locator=excluded.raw_locator,
        projection_json=excluded.projection_json,
        first_observed_date=min(source_items.first_observed_date, excluded.first_observed_date),
        last_observed_date=max(source_items.last_observed_date, excluded.last_observed_date),
        updated_at=CURRENT_TIMESTAMP`),
    observation: db.prepare(`INSERT OR IGNORE INTO observations
      (product_id, source_id, source_item_id, observed_date, published_at, ingestion_run_id)
      VALUES (?, ?, ?, ?, ?, ?)`),
    firstSeen: db.prepare(`INSERT INTO product_source_first_seen
      (product_id, source_id, first_seen_date, last_seen_date, observation_count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(product_id, source_id) DO UPDATE SET
        first_seen_date=min(product_source_first_seen.first_seen_date, excluded.first_seen_date),
        last_seen_date=max(product_source_first_seen.last_seen_date, excluded.last_seen_date),
        observation_count=product_source_first_seen.observation_count + 1`),
    term: db.prepare(`INSERT OR IGNORE INTO taxonomy_terms
      (facet, id, parent_id, label_zh, label_en, sort_order) VALUES (?, ?, ?, ?, ?, ?)`),
    assignment: db.prepare(`INSERT OR IGNORE INTO taxonomy_assignments
      (product_id, facet, term_id, assignment_source, confidence, processor_version, is_current)
      VALUES (?, ?, ?, 'rule', NULL, ?, 1)`),
  };
}

function seedTaxonomy(statements) {
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
      statements.term.run(facet, id, parent, zh, en, entry.index);
      inserted.add(id);
    };
    for (const [id] of terms) insert(id);
  }
}

function resolveProduct(statements, item, observedDate) {
  const identities = identitiesFor(item);
  const owners = identities
    .map((identity) => statements.identityOwner.get(identity.kind, identity.normalizedValue)?.product_id)
    .filter(Boolean);
  const primary = identities[0];
  const id = owners[0] || productId(primary);
  statements.product.run(
    id, primary.canonicalKey, item.title || '', primary.canonicalUrl || item.url || '',
    primary.githubRepo || '', observedDate, observedDate,
  );
  identities.forEach((identity, index) => {
    const existing = statements.identityOwner.get(identity.kind, identity.normalizedValue)?.product_id;
    if (existing && existing !== id) {
      statements.conflict.run(identity.kind, identity.normalizedValue, existing, id, item.sourceId, String(item.externalId || ''));
      return;
    }
    statements.identity.run(
      id, identity.kind, identity.normalizedValue, identity.displayValue,
      item.sourceId || null, index === 0 ? 1 : 0.9, index === 0 ? 1 : 0,
    );
  });
  return id;
}

function importDay(db, statements, source, date, options) {
  const snapshot = path.join(options.rawRoot, source.id, `${date}.json`);
  const loaded = loadItems(source, {
    date,
    observedDate: date,
    rawRoot: options.rawRoot,
    maxItems: Infinity,
    productHuntView: 'all',
  });
  const relativeSnapshot = path.relative(ROOT, snapshot);
  const runId = stableId('run', `${source.id}\u0000${date}\u0000${PARSER_VERSION}`);
  const captureMode = OBSERVED_SOURCES.has(source.id) ? 'observed-snapshot' : 'date-addressable';
  statements.run.run(
    runId, source.id, date, captureMode, relativeSnapshot, sha256File(snapshot),
    PARSER_VERSION, loaded.items.length,
  );
  for (const item of loaded.items) {
    const externalId = String(item.externalId || item.url || item.title || 'untitled');
    const id = resolveProduct(statements, item, date);
    const itemId = sourceItemId(source.id, externalId);
    const projection = {
      metrics: item.metrics || {},
      tags: item.tags || [],
      websiteUrl: item.websiteUrl || '',
      githubUrl: item.githubUrl || item.github?.url || '',
      logo: item.logo || item.icon || item.siteLogo || '',
      images: item.images || item.imageUrls || [],
    };
    const summary = D.summary(item, 'zh-CN').text;
    statements.sourceItem.run(
      itemId, source.id, externalId, id, item.title || '', summary || '', item.url || '', item.publishedAt || null,
      relativeSnapshot, JSON.stringify(projection), date, date,
    );
    const inserted = statements.observation.run(id, source.id, itemId, date, item.publishedAt || null, runId);
    if (inserted.changes) statements.firstSeen.run(id, source.id, date, date);
    if (options.taxonomy) {
      const taxonomy = D.itemTaxonomy(item);
      for (const [facet, terms] of Object.entries(taxonomy)) {
        if (!Array.isArray(terms) || !D.taxonomyFacets[facet]) continue;
        for (const term of terms) statements.assignment.run(id, facet, term, TAXONOMY_VERSION);
      }
      for (const language of D.itemLanguages(item)) {
        statements.assignment.run(id, 'languages', language, TAXONOMY_VERSION);
      }
    }
  }
  return loaded.items.length;
}

function counts(db) {
  const tableCount = (table) => db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
  return {
    sources: tableCount('sources'),
    products: tableCount('products'),
    sourceItems: tableCount('source_items'),
    observations: tableCount('observations'),
    taxonomyAssignments: tableCount('taxonomy_assignments'),
    identityConflicts: tableCount('identity_conflicts'),
  };
}

function buildCatalog(options) {
  const output = path.resolve(options.out || DEFAULT_DATABASE);
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  if (options.incremental && options.replace) throw new Error('--incremental and --replace are mutually exclusive');
  if (options.incremental && (!options.start || !options.end)) {
    throw new Error('--incremental requires an explicit --start and --end range');
  }
  if (options.incremental && !fs.existsSync(output)) {
    throw new Error(`catalog database is missing: ${output}; build it before importing incrementally`);
  }
  if (fs.existsSync(output) && !options.replace && !options.incremental) {
    throw new Error(`database already exists: ${output}; pass --replace to rebuild it or --incremental to update it`);
  }
  const temporary = options.incremental ? output : `${output}.building`;
  if (!options.incremental && fs.existsSync(temporary)) fs.rmSync(temporary);
  const db = new DatabaseSync(temporary);
  try {
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;');
    applyMigrations(db);
    const statements = prepareStatements(db);
    const config = JSON.parse(fs.readFileSync(SOURCE_CONFIG, 'utf8'));
    const sources = config.sources.filter((source) => source.enabled && (!options.sources || options.sources.has(source.id)));
    sources.forEach((source, index) => statements.source.run(source.id, source.name, source.desc || '', 1, index));
    seedTaxonomy(statements);
    let days = 0;
    let rows = 0;
    for (const source of sources) {
      for (const date of sourceDates(options.rawRoot, source.id, options)) {
        db.exec('BEGIN');
        try {
          rows += importDay(db, statements, source, date, options);
          db.exec('COMMIT');
          days += 1;
        } catch (error) {
          db.exec('ROLLBACK');
          throw new Error(`${source.id}/${date}: ${error.message}`, { cause: error });
        }
      }
    }
    db.exec('PRAGMA optimize;');
    const summary = { output, days, rows, ...counts(db) };
    db.close();
    if (!options.incremental) {
      if (fs.existsSync(output)) fs.rmSync(output);
      fs.renameSync(temporary, output);
    }
    return summary;
  } catch (error) {
    try { db.close(); } catch (_) {}
    throw error;
  }
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(buildCatalog(parseArgs(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, applyMigrations, buildCatalog, sourceDates, counts };
