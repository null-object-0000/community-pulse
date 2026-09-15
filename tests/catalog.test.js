const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { identitiesFor } = require('../scripts/catalog/identity');
const { buildMysqlImport, sqlValue } = require('../scripts/catalog/build-mysql-import');
const { loadItems } = require('../.agents/skills/community-pulse/scripts/source_raw_items');

test('catalog identity prefers repository, keeps website and source aliases', () => {
  const identities = identitiesFor({ sourceId: 'showhn', externalId: '42', title: 'Example', url: 'https://example.com/?utm_source=hn', githubUrl: 'https://github.com/Owner/Repo/' });
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

test('source snapshots compile directly into a MySQL import package', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devtrends-mysql-import-'));
  const rawRoot = path.join(__dirname, '..', '知识', '大家都在做什么', 'source-raw');
  const manifest = buildMysqlImport({ out: directory, rawRoot, start: '2026-09-13', end: '2026-09-13', sources: new Set(['producthunt']), taxonomy: true, maxBytes: 100_000 });
  const tables = new Set(manifest.files.map((file) => file.table));
  assert.deepEqual(tables, new Set(['sources', 'products', 'product_source_first_seen', 'taxonomy_terms', 'taxonomy_assignments']));
  assert.equal(manifest.dialect, 'mysql');
  assert.equal(manifest.source, 'source-raw');
  assert.ok(manifest.inputRows > 0);
  assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  const productSql = fs.readFileSync(path.join(directory, manifest.files.find((file) => file.table === 'products').name), 'utf8');
  assert.match(productSql, /ON DUPLICATE KEY UPDATE/);
  const assignmentSql = fs.readFileSync(path.join(directory, manifest.files.find((file) => file.table === 'taxonomy_assignments').name), 'utf8');
  assert.match(assignmentSql, /INSERT IGNORE INTO taxonomy_assignments \(product_id,facet,term_id/);
  assert.doesNotMatch(assignmentSql, /taxonomy_assignments \(id,/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('MySQL literals preserve backslashes and quotes', () => {
  assert.equal(sqlValue("path\\segment's"), "'path\\\\segment''s'");
});

test('MySQL adapter preserves the query prepare-bind-all contract', async () => {
  const calls = [];
  const { mysqlAdapter } = await import('../worker/mysql-db.mjs');
  const db = mysqlAdapter({ async query(sql, bindings) { calls.push({ sql, bindings }); return [[{ id: 'showhn' }], []]; } });
  const result = await db.prepare('SELECT id FROM sources WHERE id = ?').bind('showhn').all();
  assert.deepEqual(result, { results: [{ id: 'showhn' }] });
  assert.deepEqual(calls, [{ sql: 'SELECT id FROM sources WHERE id = ?', bindings: ['showhn'] }]);
});

test('MySQL import splitter ignores semicolons inside quoted source text', async () => {
  const { splitSql } = await import('../worker/catalog-import.mjs');
  assert.deepEqual(splitSql("INSERT INTO products(title) VALUES ('one; two'); INSERT INTO sources(id) VALUES ('s');"), ["INSERT INTO products(title) VALUES ('one; two')", "INSERT INTO sources(id) VALUES ('s')"]);
  assert.deepEqual(splitSql("INSERT INTO products(title) VALUES ('it''s; fine');"), ["INSERT INTO products(title) VALUES ('it''s; fine')"]);
});

test('daily catalog upload compiles and validates MySQL directly before upload', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'daily-report.yml'), 'utf8');
  assert.match(workflow, /node scripts\/catalog\/build-mysql-import\.js[^\n]*\s+node scripts\/catalog\/check-mysql-import\.js\s+node scripts\/catalog\/upload-mysql\.js/);
  assert.doesNotMatch(workflow, /build-database|export-mysql|export-d1|upload-d1/);
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
