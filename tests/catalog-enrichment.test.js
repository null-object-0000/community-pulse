const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('../scripts/catalog/build-database');
const { runEnrichment, PROCESSOR_VERSION } = require('../scripts/catalog/enrich-products');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devtrends-enrichment-'));
  const database = path.join(directory, 'test.sqlite');
  const db = new DatabaseSync(database);
  applyMigrations(db);
  db.exec(`
    INSERT INTO sources(id,name) VALUES ('showhn','Show HN'),('producthunt','Product Hunt');
    INSERT INTO products(id,canonical_key,title,first_seen_date,last_seen_date) VALUES
      ('p1','source:showhn:1','One','2026-09-13','2026-09-13'),
      ('p2','source:producthunt:2','Two','2026-09-13','2026-09-13');
    INSERT INTO source_items(id,source_id,external_id,product_id,title,summary,payload_json,first_observed_date,last_observed_date) VALUES
      ('s1','showhn','1','p1','One','Short description','{}','2026-09-13','2026-09-13'),
      ('s1b','producthunt','1b','p1','One richer','This is the longest description and must win.','{}','2026-09-13','2026-09-13'),
      ('s2','producthunt','2','p2','Two','Second description','{}','2026-09-13','2026-09-13');
    INSERT INTO observations(product_id,source_id,source_item_id,observed_date) VALUES
      ('p1','showhn','s1','2026-09-13'),('p1','producthunt','s1b','2026-09-13'),
      ('p2','producthunt','s2','2026-09-13');
    INSERT INTO taxonomy_terms(facet,id,label_zh,label_en) VALUES
      ('useCases','software-development','软件开发','Software development');
    INSERT INTO taxonomy_assignments(product_id,facet,term_id,assignment_source,processor_version,is_current)
      VALUES ('p1','useCases','software-development','rule','rule-v1',1);
  `);
  db.close();
  return { directory, database };
}

function localized(title, useCase = 'software-development') {
  return {
    titleEn: `${title} English`, summaryZh: `${title} 中文摘要`, summaryEn: `${title} English summary`,
    primaryCategory: 'developer-tools',
    taxonomy: { version: 1, useCases: [useCase], agentRoles: [], productForms: [], platforms: [], integrations: [] },
  };
}

test('catalog enrichment writes shadow rows and an unchanged input makes zero model requests', async () => {
  const { directory, database } = fixture();
  let calls = 0;
  const fakeLocalize = async (input, options) => { calls += 1; options.onRequest(); return localized(input.title); };
  const options = { database, date: '2026-09-13', concurrency: 2, mode: 'shadow', resume: false, processorVersion: PROCESSOR_VERSION };
  const first = await runEnrichment(options, { localize: fakeLocalize, onProgress() {} });
  assert.equal(first.selectedProducts, 2);
  assert.equal(first.modelRequests, 2);
  assert.equal(first.succeeded, 2);
  assert.equal(calls, 2);

  const second = await runEnrichment({ ...options, resume: true }, { localize: fakeLocalize, onProgress() {} });
  assert.equal(second.modelRequests, 0);
  assert.equal(second.pendingProducts, 0);
  assert.equal(calls, 2);

  const db = new DatabaseSync(database, { readOnly: true });
  assert.equal(db.prepare(`SELECT count(*) n FROM enrichment_product_status WHERE status='complete'`).get().n, 2);
  assert.equal(db.prepare(`SELECT count(*) n FROM product_content WHERE is_current<>0`).get().n, 0);
  assert.equal(db.prepare(`SELECT count(*) n FROM product_content`).get().n, 4);
  assert.equal(db.prepare(`SELECT count(*) n FROM taxonomy_assignments WHERE assignment_source='llm' AND is_current<>0`).get().n, 0);
  assert.equal(db.prepare(`SELECT count(*) n FROM taxonomy_assignments WHERE assignment_source='rule' AND is_current=1`).get().n, 1);
  assert.equal(db.prepare(`SELECT count(*) n FROM taxonomy_assignments WHERE facet='primaryCategory' AND assignment_source='llm'`).get().n, 2);
  assert.equal(db.prepare(`SELECT title FROM product_content WHERE product_id='p1' AND locale='zh-CN'`).get().title, 'One richer');
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('catalog enrichment reruns only changed input and replaces its versioned shadow projection', async () => {
  const { directory, database } = fixture();
  let calls = 0;
  const fakeLocalize = async (input, options) => { calls += 1; options.onRequest(); return localized(input.title); };
  const options = { database, date: '2026-09-13', concurrency: 2, mode: 'shadow', resume: false, processorVersion: PROCESSOR_VERSION };
  await runEnrichment(options, { localize: fakeLocalize, onProgress() {} });
  const db = new DatabaseSync(database);
  db.prepare(`UPDATE source_items SET summary=? WHERE id='s2'`).run('Changed second description');
  db.close();
  const rerun = await runEnrichment({ ...options, resume: true }, { localize: fakeLocalize, onProgress() {} });
  assert.equal(rerun.pendingProducts, 1);
  assert.equal(rerun.modelRequests, 1);
  assert.equal(rerun.skippedComplete, 1);
  const verify = new DatabaseSync(database, { readOnly: true });
  assert.equal(verify.prepare(`SELECT count(*) n FROM product_content`).get().n, 4);
  assert.equal(verify.prepare(`SELECT attempt_count FROM enrichment_product_status WHERE product_id='p2'`).get().attempt_count, 2);
  verify.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('failed products have a terminal state and can be resumed independently', async () => {
  const { directory, database } = fixture();
  const options = { database, date: '2026-09-13', concurrency: 1, mode: 'shadow', resume: false, processorVersion: PROCESSOR_VERSION, productId: 'p1' };
  const failed = await runEnrichment(options, { localize: async (_input, hooks) => { hooks.onRequest(); throw new Error('synthetic failure'); }, onProgress() {} });
  assert.equal(failed.failed, 1);
  assert.deepEqual(failed.states, { pending: 0, running: 0, complete: 0, failed: 1 });
  const idempotent = await runEnrichment({ ...options, resume: true }, {
    localize: async () => { throw new Error('ordinary resume must not retry terminal failures'); }, onProgress() {},
  });
  assert.equal(idempotent.modelRequests, 0);
  assert.equal(idempotent.skippedFailed, 1);
  const resumed = await runEnrichment({ ...options, resume: true, retryFailed: true }, {
    localize: async (input, hooks) => { hooks.onRequest(); return localized(input.title); }, onProgress() {},
  });
  assert.equal(resumed.succeeded, 1);
  assert.equal(resumed.states.complete, 1);
  const db = new DatabaseSync(database, { readOnly: true });
  const status = db.prepare(`SELECT status,attempt_count,model_request_count,error FROM enrichment_product_status`).get();
  assert.deepEqual({ ...status }, { status: 'complete', attempt_count: 2, model_request_count: 2, error: null });
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
