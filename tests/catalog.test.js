const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('../scripts/catalog/build-database');
const { identitiesFor } = require('../scripts/catalog/identity');
const { exportDatabase } = require('../scripts/catalog/export-mysql');
const { loadItems } = require('../.agents/skills/community-pulse/scripts/source_raw_items');

class QueryStatementAdapter {
  constructor(statement) {
    this.statement = statement;
    this.values = [];
  }
  bind(...values) {
    this.values = values;
    return this;
  }
  async first() {
    return this.statement.get(...this.values) || null;
  }
  async all() {
    return { results: this.statement.all(...this.values) };
  }
}

class QueryAdapter {
  constructor(database) { this.database = database; }
  prepare(sql) { return new QueryStatementAdapter(this.database.prepare(sql)); }
}

test('catalog identity prefers repository, keeps website and source aliases', () => {
  const identities = identitiesFor({
    sourceId: 'showhn', externalId: '42', title: 'Example',
    url: 'https://example.com/?utm_source=hn',
    githubUrl: 'https://github.com/Owner/Repo/',
  });
  assert.deepEqual(identities.map((identity) => identity.kind), ['github', 'url', 'source']);
  assert.equal(identities[0].normalizedValue, 'owner/repo');
  assert.equal(identities[1].normalizedValue, 'https://example.com');
});

test('Product Hunt catalog view includes the full ledger without changing the report view', () => {
  const src = { id: 'producthunt', max_items: 15 };
  const options = { date: '2026-09-13', observedDate: '2026-09-13', maxItems: Infinity };
  const report = loadItems(src, options).items;
  const catalog = loadItems(src, { ...options, productHuntView: 'all' }).items;
  assert.ok(catalog.length > report.length);
  assert.ok(report.every((item) => item.tags.includes('official-featured')));
  assert.ok(catalog.some((item) => !item.tags.includes('official-featured')));
});

test('trend query recomputes first-seen within the selected source set', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devtrends-catalog-'));
  const db = new DatabaseSync(path.join(directory, 'test.sqlite'));
  applyMigrations(db);
  db.exec(`
    INSERT INTO sources(id,name,sort_order) VALUES ('producthunt','Product Hunt',0),('showhn','Show HN',1);
    INSERT INTO products(id,canonical_key,title,first_seen_date,last_seen_date) VALUES
      ('p1','url:https://one.example','One','2026-09-01','2026-09-08'),
      ('p2','url:https://two.example','Two','2026-09-09','2026-09-09');
    INSERT INTO product_source_first_seen(product_id,source_id,first_seen_date,last_seen_date) VALUES
      ('p1','producthunt','2026-09-01','2026-09-01'),
      ('p1','showhn','2026-09-08','2026-09-08'),
      ('p2','showhn','2026-09-09','2026-09-09');
    INSERT INTO taxonomy_terms(facet,id,parent_id,label_zh,label_en,sort_order) VALUES
      ('useCases','content-creation',NULL,'内容创作','Content creation',0),
      ('useCases','novel-writing','content-creation','小说创作','Novel writing',1);
    INSERT INTO taxonomy_assignments(product_id,facet,term_id,assignment_source,processor_version) VALUES
      ('p1','useCases','novel-writing','rule','test'),
      ('p2','useCases','content-creation','rule','test');
  `);
  const { queryTrends, queryProducts } = await import('../worker/catalog-api.mjs');
  const base = {
    from: '2026-09-08', to: '2026-09-14', days: 7, facet: 'useCases',
    previousFrom: '2026-09-01', previousTo: '2026-09-07',
  };
  const allSources = await queryTrends(new QueryAdapter(db), { ...base, sources: ['producthunt', 'showhn'] });
  assert.equal(allSources.coverage.uniqueProducts, 1);
  assert.equal(allSources.results.find((row) => row.id === 'novel-writing').previousCount, 1);
  const allSourcesFastPath = await queryTrends(new QueryAdapter(db), { ...base, sources: ['producthunt', 'showhn'] }, null, { allSources: true });
  assert.deepEqual(allSourcesFastPath, allSources);

  const showHn = await queryTrends(new QueryAdapter(db), { ...base, sources: ['showhn'] });
  assert.equal(showHn.coverage.uniqueProducts, 2);
  assert.equal(showHn.results.find((row) => row.id === 'novel-writing').currentCount, 1);
  assert.equal(showHn.results.find((row) => row.id === 'content-creation').currentCount, 2);
  assert.equal(showHn.results.find((row) => row.id === 'novel-writing').share, 0.5);
  const content = showHn.results.find((row) => row.id === 'content-creation');
  assert.equal(content.sourceCount, 1);
  assert.equal(content.path, '/trends/use-cases/content-creation/');
  assert.equal(content.weekly.length, 12);
  assert.deepEqual(content.examples.map((example) => example.title), ['Two', 'One']);
  const products = await queryProducts(new QueryAdapter(db), { ...base, sources: ['showhn'] }, 'content-creation');
  assert.equal(products.count, 2);
  assert.equal(products.sourceCount, 1);
  assert.deepEqual(products.products.map((product) => product.title), ['Two', 'One']);
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('MySQL exports omit local surrogate ids, upsert dates and preserve backslashes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devtrends-export-'));
  const database = path.join(directory, 'test.sqlite');
  const output = path.join(directory, 'out');
  const db = new DatabaseSync(database);
  applyMigrations(db);
  db.exec(`
    INSERT INTO sources(id,name) VALUES ('showhn','Show HN');
    INSERT INTO products(id,canonical_key,title,first_seen_date,last_seen_date)
      VALUES ('p1','source:showhn:1','One','2026-09-14','2026-09-14');
    UPDATE products SET canonical_url='https://example.com/path\\segment' WHERE id='p1';
    INSERT INTO product_source_first_seen(product_id,source_id,first_seen_date,last_seen_date)
      VALUES ('p1','showhn','2026-09-14','2026-09-14');
    INSERT INTO taxonomy_terms(facet,id,label_zh,label_en)
      VALUES ('useCases','software-development','软件开发','Software development');
    INSERT INTO taxonomy_assignments(product_id,facet,term_id,assignment_source,processor_version)
      VALUES ('p1','useCases','software-development','rule','test');
  `);
  db.close();
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, '.uploaded.json'), '{"files":["stale.sql"]}\n');
  const manifest = exportDatabase({ database, out: output, profile: 'trends', maxBytes: 100_000 });
  const assignmentFile = manifest.files.find((file) => file.table === 'taxonomy_assignments');
  const sql = fs.readFileSync(path.join(output, assignmentFile.name), 'utf8');
  assert.match(sql, /INSERT IGNORE INTO taxonomy_assignments \(product_id,facet,term_id/);
  assert.doesNotMatch(sql, /taxonomy_assignments \(id,/);
  const firstSeenFile = manifest.files.find((file) => file.table === 'product_source_first_seen');
  const firstSeenSql = fs.readFileSync(path.join(output, firstSeenFile.name), 'utf8');
  assert.match(firstSeenSql, /ON DUPLICATE KEY UPDATE/);
  assert.match(firstSeenSql, /first_seen_date=LEAST\(product_source_first_seen\.first_seen_date, VALUES\(first_seen_date\)\)/);
  const productFile = manifest.files.find((file) => file.table === 'products');
  const productSql = fs.readFileSync(path.join(output, productFile.name), 'utf8');
  assert.match(productSql, /path\\\\segment/);
  assert.equal(manifest.dialect, 'mysql');
  assert.equal(fs.existsSync(path.join(output, '.uploaded.json')), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('MySQL adapter preserves the query prepare-bind-all contract', async () => {
  const calls = [];
  const { mysqlAdapter } = await import('../worker/mysql-db.mjs');
  const db = mysqlAdapter({
    async query(sql, bindings) {
      calls.push({ sql, bindings });
      return [[{ id: 'showhn' }], []];
    },
  });
  const result = await db.prepare('SELECT id FROM sources WHERE id = ?').bind('showhn').all();
  assert.deepEqual(result, { results: [{ id: 'showhn' }] });
  assert.deepEqual(calls, [{ sql: 'SELECT id FROM sources WHERE id = ?', bindings: ['showhn'] }]);
});

test('MySQL import splitter ignores semicolons inside quoted source text', async () => {
  const { splitSql } = await import('../worker/catalog-import.mjs');
  assert.deepEqual(splitSql("INSERT INTO products(title) VALUES ('one; two'); INSERT INTO sources(id) VALUES ('s');"), [
    "INSERT INTO products(title) VALUES ('one; two')",
    "INSERT INTO sources(id) VALUES ('s')",
  ]);
  assert.deepEqual(splitSql("INSERT INTO products(title) VALUES ('it''s; fine');"), [
    "INSERT INTO products(title) VALUES ('it''s; fine')",
  ]);
});

test('daily catalog upload writes the MySQL projection in one blocking step', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'daily-report.yml'), 'utf8');
  assert.match(workflow, /node scripts\/catalog\/export-mysql\.js --database data\/catalog\/daily\.sqlite --profile trends\s+node scripts\/catalog\/upload-mysql\.js/);
  assert.doesNotMatch(workflow, /export-d1|upload-d1/);
  assert.match(workflow, /run: npm ci/);
});

test('dynamic trend cards retain charts, examples and category links', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  assert.match(app, /row\.weekly/);
  assert.match(app, /row\.examples/);
  assert.match(app, /localTrendPath\(row\.path\)/);
  assert.match(app, /class="trend-bar" data-trend-week/);
  assert.match(app, /\/api\/v1\/products\?/);
  assert.doesNotMatch(app, /if \(period\) period\.hidden = true/);
});
