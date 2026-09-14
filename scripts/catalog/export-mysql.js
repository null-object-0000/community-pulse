#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DATABASE = path.join(ROOT, 'data', 'catalog', 'devtrends.sqlite');
const DEFAULT_OUTPUT = path.join(ROOT, 'data', 'catalog', 'mysql-import');
const TABLES = {
  trends: ['sources', 'products', 'product_source_first_seen', 'taxonomy_terms', 'taxonomy_assignments'],
  full: [
    'sources', 'ingestion_runs', 'products', 'product_identities', 'identity_conflicts',
    'source_items', 'observations', 'product_source_first_seen', 'enrichment_runs',
    'product_content', 'taxonomy_terms', 'taxonomy_assignments', 'reports', 'report_items',
  ],
};

const UPSERTS = {
  sources: `ON DUPLICATE KEY UPDATE
    name=VALUES(name), description=VALUES(description), enabled=VALUES(enabled),
    sort_order=VALUES(sort_order), updated_at=CURRENT_TIMESTAMP(3)`,
  products: `ON DUPLICATE KEY UPDATE
    title=CASE WHEN length(VALUES(title)) > length(products.title) THEN VALUES(title) ELSE products.title END,
    canonical_url=COALESCE(NULLIF(products.canonical_url, ''), VALUES(canonical_url)),
    github_repo=COALESCE(NULLIF(products.github_repo, ''), VALUES(github_repo)),
    first_seen_date=LEAST(products.first_seen_date, VALUES(first_seen_date)),
    last_seen_date=GREATEST(products.last_seen_date, VALUES(last_seen_date)), updated_at=CURRENT_TIMESTAMP(3)`,
  product_source_first_seen: `ON DUPLICATE KEY UPDATE
    first_seen_date=LEAST(product_source_first_seen.first_seen_date, VALUES(first_seen_date)),
    last_seen_date=GREATEST(product_source_first_seen.last_seen_date, VALUES(last_seen_date)),
    observation_count=GREATEST(product_source_first_seen.observation_count, VALUES(observation_count))`,
  taxonomy_terms: `ON DUPLICATE KEY UPDATE
    parent_id=VALUES(parent_id), label_zh=VALUES(label_zh), label_en=VALUES(label_en),
    sort_order=VALUES(sort_order), active=VALUES(active)`,
};

function parseArgs(argv) {
  const options = { database: DEFAULT_DATABASE, out: DEFAULT_OUTPUT, profile: 'trends', maxBytes: 3_500_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined ? argv[++index] : inline;
    if (name === '--database') options.database = path.resolve(value);
    else if (name === '--out') options.out = path.resolve(value);
    else if (name === '--profile') options.profile = value;
    else if (name === '--max-bytes') options.maxBytes = Number(value);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!TABLES[options.profile]) throw new Error(`unknown profile: ${options.profile}`);
  if (!Number.isFinite(options.maxBytes) || options.maxBytes < 100_000) throw new Error('--max-bytes is too small');
  return options;
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

function exportDatabase(options) {
  if (!fs.existsSync(options.database)) throw new Error(`database is missing: ${options.database}`);
  fs.mkdirSync(options.out, { recursive: true });
  for (const name of fs.readdirSync(options.out)) {
    if (/^\d{5}-.*\.sql$|^manifest\.json$|^\.uploaded\.json$/.test(name)) fs.rmSync(path.join(options.out, name));
  }
  const db = new DatabaseSync(options.database, { readOnly: true });
  const files = [];
  let sequence = 0;
  try {
    for (const table of TABLES[options.profile]) {
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
        const insert = UPSERTS[table] ? 'INSERT INTO' : 'INSERT IGNORE INTO';
        const upsert = UPSERTS[table] ? `\n${UPSERTS[table]}` : '';
        statements.push(`${insert} ${table} (${columns.join(',')}) VALUES\n${statementRows.join(',\n')}${upsert};`);
        statementRows = [];
      };
      const flushFile = () => {
        flushStatement();
        if (!statements.length) return;
        const name = `${String(sequence++).padStart(5, '0')}-${table}.sql`;
        const content = `${statements.join('\n')}\n`;
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
  } finally { db.close(); }
  const manifest = {
    schemaVersion: 1, dialect: 'mysql', profile: options.profile,
    database: options.database, generatedAt: new Date().toISOString(), files,
    totalRows: files.reduce((sum, file) => sum + file.rows, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
  fs.writeFileSync(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (require.main === module) {
  try { console.log(JSON.stringify(exportDatabase(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { parseArgs, sqlValue, exportDatabase, TABLES };
