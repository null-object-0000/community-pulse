#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DATABASE = path.join(ROOT, 'data', 'catalog', 'devtrends.sqlite');
const DEFAULT_OUTPUT = path.join(ROOT, 'data', 'catalog', 'd1-import');
const TABLES = {
  trends: ['sources', 'products', 'product_source_first_seen', 'taxonomy_terms', 'taxonomy_assignments'],
  full: [
    'sources', 'ingestion_runs', 'products', 'product_identities', 'identity_conflicts',
    'source_items', 'observations', 'product_source_first_seen', 'enrichment_runs',
    'product_content', 'taxonomy_terms', 'taxonomy_assignments', 'reports', 'report_items',
  ],
};

// Trend projection imports may be a normal daily increment or a late historical
// backfill. These tables therefore merge dates/metadata instead of ignoring an
// already-known stable key. All other tables use their logical unique key and
// remain idempotent INSERT OR IGNORE operations.
const UPSERTS = {
  sources: `ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, description=excluded.description, enabled=excluded.enabled,
    sort_order=excluded.sort_order, updated_at=CURRENT_TIMESTAMP`,
  products: `ON CONFLICT(id) DO UPDATE SET
    title=CASE WHEN length(excluded.title) > length(products.title) THEN excluded.title ELSE products.title END,
    canonical_url=COALESCE(NULLIF(products.canonical_url, ''), excluded.canonical_url),
    github_repo=COALESCE(NULLIF(products.github_repo, ''), excluded.github_repo),
    first_seen_date=min(products.first_seen_date, excluded.first_seen_date),
    last_seen_date=max(products.last_seen_date, excluded.last_seen_date), updated_at=CURRENT_TIMESTAMP`,
  product_source_first_seen: `ON CONFLICT(product_id,source_id) DO UPDATE SET
    first_seen_date=min(product_source_first_seen.first_seen_date, excluded.first_seen_date),
    last_seen_date=max(product_source_first_seen.last_seen_date, excluded.last_seen_date),
    observation_count=max(product_source_first_seen.observation_count, excluded.observation_count)`,
  taxonomy_terms: `ON CONFLICT(facet,id) DO UPDATE SET
    parent_id=excluded.parent_id, label_zh=excluded.label_zh, label_en=excluded.label_en,
    sort_order=excluded.sort_order, active=excluded.active`,
};

function parseArgs(argv) {
  const options = { database: DEFAULT_DATABASE, out: DEFAULT_OUTPUT, profile: 'trends', maxBytes: 3_500_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--database') options.database = path.resolve(argv[++index]);
    else if (arg === '--out') options.out = path.resolve(argv[++index]);
    else if (arg === '--profile') options.profile = argv[++index];
    else if (arg === '--max-bytes') options.maxBytes = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!TABLES[options.profile]) throw new Error(`unknown profile: ${options.profile}`);
  if (!Number.isFinite(options.maxBytes) || options.maxBytes < 100_000) throw new Error('--max-bytes is too small');
  return options;
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  return `'${String(value).replace(/'/g, "''")}'`;
}

function exportDatabase(options) {
  if (!fs.existsSync(options.database)) throw new Error(`database is missing: ${options.database}`);
  fs.mkdirSync(options.out, { recursive: true });
  for (const name of fs.readdirSync(options.out)) {
    if (/^\d{5}-.*\.sql$|^manifest\.json$/.test(name)) fs.rmSync(path.join(options.out, name));
  }
  const db = new DatabaseSync(options.database, { readOnly: true });
  const files = [];
  let sequence = 0;
  for (const table of TABLES[options.profile]) {
    // Fresh daily databases restart INTEGER PRIMARY KEY counters at 1. Exporting
    // those surrogate ids would collide with unrelated remote rows and make
    // INSERT OR IGNORE silently discard valid observations/assignments. Let D1
    // allocate them; stable text and composite primary keys remain in the export.
    const columns = db.prepare(`PRAGMA table_info(${table})`).all()
      .filter((column) => !(column.pk === 1 && /^INTEGER$/i.test(column.type) && column.name === 'id'))
      .map((column) => column.name);
    const rows = db.prepare(`SELECT * FROM ${table}`).iterate();
    let statements = [];
    let statementRows = [];
    let bytes = 0;
    let rowCount = 0;
    const flushStatement = () => {
      if (!statementRows.length) return;
      const insert = UPSERTS[table] ? 'INSERT INTO' : 'INSERT OR IGNORE INTO';
      const upsert = UPSERTS[table] ? `\n${UPSERTS[table]}` : '';
      statements.push(`${insert} ${table} (${columns.join(',')}) VALUES\n${statementRows.join(',\n')}${upsert};`);
      statementRows = [];
    };
    const flushFile = () => {
      flushStatement();
      if (!statements.length) return;
      const name = `${String(sequence++).padStart(5, '0')}-${table}.sql`;
      const content = `PRAGMA foreign_keys=ON;\n${statements.join('\n')}\n`;
      fs.writeFileSync(path.join(options.out, name), content);
      files.push({ name, table, rows: rowCount, bytes: Buffer.byteLength(content) });
      statements = [];
      bytes = 0;
      rowCount = 0;
    };
    for (const row of rows) {
      const tuple = `(${columns.map((column) => sqlValue(row[column])).join(',')})`;
      if (statementRows.length >= 200) flushStatement();
      if (bytes + Buffer.byteLength(tuple) > options.maxBytes && (statements.length || statementRows.length)) flushFile();
      statementRows.push(tuple);
      bytes += Buffer.byteLength(tuple) + 2;
      rowCount += 1;
    }
    flushFile();
  }
  db.close();
  const manifest = {
    schemaVersion: 1,
    profile: options.profile,
    database: options.database,
    generatedAt: new Date().toISOString(),
    files,
    totalRows: files.reduce((sum, file) => sum + file.rows, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
  fs.writeFileSync(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // A new export invalidates any upload progress from an older manifest even if
  // chunk filenames happen to be identical.
  const progress = path.join(options.out, '.uploaded.json');
  if (fs.existsSync(progress)) fs.rmSync(progress);
  return manifest;
}

if (require.main === module) {
  try { console.log(JSON.stringify(exportDatabase(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { parseArgs, sqlValue, exportDatabase, TABLES };
