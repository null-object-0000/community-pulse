const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { identitiesFor } = require('../scripts/catalog/identity');
const { buildMysqlImport, sqlValue, loadEvidence, repositoryEvidenceDate } = require('../scripts/catalog/build-mysql-import');
const { parseArgs, fetchJson, rangeStats } = require('../scripts/catalog/build-site-snapshot');
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
  assert.deepEqual(tables, new Set(['sources', 'products', 'product_routes', 'product_details', 'product_source_first_seen', 'taxonomy_terms', 'taxonomy_assignments']));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.dialect, 'mysql');
  assert.equal(manifest.source, 'source-raw');
  assert.ok(manifest.inputRows > 0);
  assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  const productSql = fs.readFileSync(path.join(directory, manifest.files.find((file) => file.table === 'products').name), 'utf8');
  assert.match(productSql, /ON DUPLICATE KEY UPDATE/);
  const routeSql = fs.readFileSync(path.join(directory, manifest.files.find((file) => file.table === 'product_routes').name), 'utf8');
  assert.match(routeSql, /\/products\/prd_[a-f0-9]{24}\//);
  const detailSql = fs.readFileSync(path.join(directory, manifest.files.find((file) => file.table === 'product_details').name), 'utf8');
  assert.match(detailSql, /item_json/);
  const assignmentSql = fs.readFileSync(path.join(directory, manifest.files.find((file) => file.table === 'taxonomy_assignments').name), 'utf8');
  assert.match(assignmentSql, /INSERT IGNORE INTO taxonomy_assignments \(product_id,facet,term_id/);
  assert.doesNotMatch(assignmentSql, /taxonomy_assignments \(id,/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('MySQL literals preserve backslashes and quotes', () => {
  assert.equal(sqlValue("path\\segment's"), "'path\\\\segment''s'");
});

test('observed-date source partitions borrow the newest repository snapshot at or before them', () => {
  // V2EX / Trending file their documents under TARGET + 1 while the repository snapshot is captured
  // under TARGET, so the exact-date lookup returned nothing and those items lost homepage, language,
  // stars and topics — which is what left their detail pages without a 官网 button.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devtrends-evidence-'));
  const rawRoot = path.join(directory, 'source-raw');
  fs.mkdirSync(path.join(rawRoot, 'github-repositories'), { recursive: true });
  const snapshot = (date) => ({
    schemaVersion: 1, sourceId: 'github-repositories', sourceName: 'GitHub 仓库快照',
    targetDate: date, timezone: 'Asia/Shanghai', status: 'ok', complete: true,
    records: [{ repository: 'owner/repo', response: {
      html_url: 'https://github.com/owner/repo', full_name: 'owner/repo', description: 'd',
      stargazers_count: 5, forks_count: 1, open_issues_count: 0, language: 'TypeScript',
      license: { spdx_id: 'MIT' }, topics: ['ai'], homepage: 'https://site.dev', default_branch: 'main',
    } }],
  });
  fs.writeFileSync(path.join(rawRoot, 'github-repositories', '2026-09-15.json'), JSON.stringify(snapshot('2026-09-15')));
  fs.writeFileSync(path.join(rawRoot, 'github-repositories', '2026-09-13.json'), JSON.stringify(snapshot('2026-09-13')));
  try {
    assert.equal(repositoryEvidenceDate(rawRoot, '2026-09-16'), '2026-09-15');
    assert.equal(repositoryEvidenceDate(rawRoot, '2026-09-15'), '2026-09-15');
    assert.equal(repositoryEvidenceDate(rawRoot, '2026-09-14'), '2026-09-13');
    assert.equal(repositoryEvidenceDate(rawRoot, '2026-09-12'), null);
    const cache = new Map();
    const observed = loadEvidence(cache, rawRoot, '2026-09-16');
    assert.equal(observed.repositories.get('owner/repo').homepage, 'https://site.dev');
    assert.equal(observed.repositories.get('owner/repo').language, 'TypeScript');
    // A date before every snapshot keeps the old "no facts" behaviour instead of borrowing forwards.
    assert.equal(loadEvidence(cache, rawRoot, '2026-09-12').repositories, null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('site snapshot ranges are deterministic supersets of the recent catalog', () => {
  const products = [
    { trendDate: '2026-09-15', sourceIds: ['a'] },
    { trendDate: '2026-09-01', sourceIds: ['b'] },
    { trendDate: '2026-07-01', sourceIds: ['a', 'b'] },
  ];
  const ranges = rangeStats(products, '2026-09-15');
  assert.equal(ranges.recent.count, 1);
  assert.equal(ranges['4w'].count, 2);
  assert.equal(ranges['12w'].count, 3);
  assert.equal(ranges['12w'].sources, 2);
});

test('site snapshot jobs use the production Worker entry point, not the public zone WAF', () => {
  if (!process.env.CATALOG_API_ORIGIN) assert.equal(parseArgs([]).origin, 'https://community-pulse.nichangen.workers.dev');
  assert.equal(parseArgs(['--origin', 'https://example.test']).origin, 'https://example.test');
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/daily-report.yml'), 'utf8');
  assert.match(workflow, /CATALOG_API_ORIGIN: https:\/\/community-pulse\.nichangen\.workers\.dev/);
  assert.match(workflow, /- name: 预检产品库读入口/);
});

test('snapshot API rejects Cloudflare challenge HTML without retries or logging its body', async () => {
  let calls = 0;
  const challenge = async () => {
    calls++;
    return new Response('<html>secret challenge token</html>', { status: 403, headers: { 'content-type': 'text/html', 'cf-ray': 'test-ray' } });
  };
  await assert.rejects(fetchJson('https://devtrends.site', '/api/v1/sources', challenge), (error) => {
    assert.match(error.message, /HTTP 403.*Cloudflare challenge/);
    assert.match(error.message, /cf-ray test-ray/);
    assert.doesNotMatch(error.message, /secret challenge token/);
    return true;
  });
  assert.equal(calls, 1);
  const sources = await fetchJson('https://community-pulse.nichangen.workers.dev', '/api/v1/sources', async (url, init) => {
    assert.equal(url.hostname, 'community-pulse.nichangen.workers.dev');
    assert.equal(init.headers.accept, 'application/json');
    return new Response(JSON.stringify({ sources: [{ id: 'showhn' }] }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  });
  assert.deepEqual(sources.sources, [{ id: 'showhn' }]);
});

test('snapshot API retries transient JSON 503 with exponential backoff and a bounded error code', async () => {
  let calls = 0;
  const delays = [];
  const model = await fetchJson('https://community-pulse.nichangen.workers.dev', '/api/v1/products', async () => {
    calls++;
    if (calls < 3) return new Response(JSON.stringify({ error: 'catalog_database_unavailable', message: 'do not print this' }),
      { status: 503, headers: { 'content-type': 'application/json', 'cf-ray': `test-${calls}` } });
    return new Response(JSON.stringify({ products: [{ id: 'one' }] }), { headers: { 'content-type': 'application/json' } });
  }, async (ms) => { delays.push(ms); });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.deepEqual(model.products, [{ id: 'one' }]);
  let failedCalls = 0;
  await assert.rejects(fetchJson('https://community-pulse.nichangen.workers.dev', '/api/v1/products', async () => {
    failedCalls++;
    return new Response(JSON.stringify({ error: 'catalog_database_unavailable', message: 'do not print this' }),
      { status: 503, headers: { 'content-type': 'application/json' } });
  }, async () => {}), (error) => {
    assert.match(error.message, /catalog error catalog_database_unavailable/);
    assert.doesNotMatch(error.message, /do not print this/);
    return true;
  });
  assert.equal(failedCalls, 8);
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
