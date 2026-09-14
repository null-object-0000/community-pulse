#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const D = require('../../web/shared.js');
const {
  localize: sharedLocalize,
  sourceHash,
  PROMPT_VERSION,
} = require('../../.agents/skills/community-pulse/scripts/enhance.js');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DATABASE = path.join(ROOT, 'data', 'catalog', 'devtrends.sqlite');
const STATUS_MIGRATION = path.join(ROOT, 'migrations', '0003_enrichment_product_status.sql');
const PROCESSOR = 'enhance.localize';
const PROCESSOR_VERSION = 'catalog-localize-v1';

function parseArgs(argv) {
  const options = {
    database: DEFAULT_DATABASE,
    concurrency: 5,
    mode: 'shadow',
    resume: false,
    retryFailed: false,
    processorVersion: PROCESSOR_VERSION,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined && !['--resume', '--retry-failed'].includes(name) ? argv[++index] : inline;
    if (name === '--date') options.date = value;
    else if (name === '--database') options.database = path.resolve(value);
    else if (name === '--concurrency') options.concurrency = Number(value);
    else if (name === '--mode') options.mode = value;
    else if (name === '--processor-version') options.processorVersion = value;
    else if (name === '--product-id') options.productId = value;
    else if (name === '--resume') options.resume = true;
    else if (name === '--retry-failed') options.retryFailed = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date || '')) throw new Error('--date YYYY-MM-DD is required');
  if (options.mode !== 'shadow') throw new Error('only --mode shadow is supported; activation is a separate reviewed operation');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 50) {
    throw new Error('--concurrency must be an integer between 1 and 50');
  }
  if (!options.processorVersion) throw new Error('--processor-version must not be empty');
  return options;
}

function stableRunId(options) {
  const key = [options.date, options.mode, options.processorVersion, PROMPT_VERSION].join('\u0000');
  return `enr_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function ensureStatusSchema(db) {
  db.exec(fs.readFileSync(STATUS_MIGRATION, 'utf8'));
}

function loadProducts(db, options) {
  const rows = db.prepare(`
    WITH candidates AS (
      SELECT o.product_id, p.title AS product_title, s.id AS source_item_id,
        s.source_id, s.title AS source_title, s.summary,
        row_number() OVER (
          PARTITION BY o.product_id
          ORDER BY length(trim(s.summary)) DESC, length(trim(s.title)) DESC, s.source_id, s.id
        ) AS rank
      FROM observations o
      JOIN products p ON p.id=o.product_id
      JOIN source_items s ON s.id=o.source_item_id
      WHERE o.observed_date=?
    )
    SELECT product_id, source_item_id, source_id,
      CASE WHEN trim(source_title) <> '' THEN source_title ELSE product_title END AS title,
      COALESCE(summary, '') AS summary
    FROM candidates
    WHERE rank=1
    ORDER BY product_id
  `).all(options.date);
  return options.productId ? rows.filter((row) => row.product_id === options.productId) : rows;
}

function localizationInput(row) {
  const title = String(row.title || '').trim();
  return { heading: title, title, desc: String(row.summary || '').trim(), section: row.source_id };
}

function seedPrimaryCategories(db) {
  const insert = db.prepare(`INSERT OR IGNORE INTO taxonomy_terms
    (facet, id, parent_id, label_zh, label_en, sort_order) VALUES ('primaryCategory', ?, NULL, ?, ?, ?)`);
  D.categories.forEach((category, index) => insert.run(category.id, category.labelZh, category.labelEn, index));
}

function writeResult(db, context, row, input, localized, requestCount) {
  const now = new Date().toISOString();
  const contentSource = `llm:${context.processorVersion}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`DELETE FROM product_content
      WHERE product_id=? AND content_source=? AND is_current=0`).run(row.product_id, contentSource);
    const content = db.prepare(`INSERT INTO product_content
      (product_id, locale, title, summary, content_source, enrichment_run_id, is_current, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)`);
    content.run(row.product_id, 'zh-CN', input.title, localized.summaryZh, contentSource, context.runId, now);
    content.run(row.product_id, 'en', localized.titleEn, localized.summaryEn, contentSource, context.runId, now);

    db.prepare(`DELETE FROM taxonomy_assignments
      WHERE product_id=? AND assignment_source='llm' AND processor_version=? AND is_current=0`)
      .run(row.product_id, context.processorVersion);
    const assignment = db.prepare(`INSERT INTO taxonomy_assignments
      (product_id, facet, term_id, assignment_source, confidence, processor_version, enrichment_run_id, is_current, created_at)
      VALUES (?, ?, ?, 'llm', NULL, ?, ?, 0, ?)`);
    assignment.run(row.product_id, 'primaryCategory', localized.primaryCategory, context.processorVersion, context.runId, now);
    for (const [facet, termIds] of Object.entries(localized.taxonomy)) {
      if (!D.taxonomyFacets[facet] || !Array.isArray(termIds)) continue;
      for (const termId of termIds) {
        assignment.run(row.product_id, facet, termId, context.processorVersion, context.runId, now);
      }
    }
    db.prepare(`UPDATE enrichment_product_status SET status='complete', model_request_count=model_request_count+?,
      error=NULL, completed_at=?, updated_at=? WHERE enrichment_run_id=? AND product_id=?`)
      .run(requestCount, now, now, context.runId, row.product_id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function writeFailure(db, context, row, error, requestCount) {
  const now = new Date().toISOString();
  db.prepare(`UPDATE enrichment_product_status SET status='failed', model_request_count=model_request_count+?,
    error=?, completed_at=?, updated_at=? WHERE enrichment_run_id=? AND product_id=?`)
    .run(requestCount, String(error.stack || error.message || error).slice(0, 4000), now, now, context.runId, row.product_id);
}

async function runEnrichment(options, dependencies = {}) {
  if (!fs.existsSync(options.database)) throw new Error(`catalog database is missing: ${options.database}`);
  const localize = dependencies.localize || sharedLocalize;
  const started = Date.now();
  const db = new DatabaseSync(options.database);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  ensureStatusSchema(db);
  seedPrimaryCategories(db);
  const runId = stableRunId(options);
  const rows = loadProducts(db, options);
  if (!rows.length) throw new Error(`no products observed on ${options.date}${options.productId ? ` for ${options.productId}` : ''}`);

  db.prepare(`INSERT OR IGNORE INTO enrichment_runs
    (id, kind, processor, processor_version, prompt_version, status)
    VALUES (?, 'catalog-product', ?, ?, ?, 'pending')`)
    .run(runId, PROCESSOR, options.processorVersion, PROMPT_VERSION);
  db.prepare(`UPDATE enrichment_runs SET status='running', started_at=COALESCE(started_at, CURRENT_TIMESTAMP),
    completed_at=NULL, error=NULL WHERE id=?`).run(runId);

  const getStatus = db.prepare(`SELECT status,input_hash FROM enrichment_product_status
    WHERE enrichment_run_id=? AND product_id=?`);
  const insertStatus = db.prepare(`INSERT INTO enrichment_product_status
    (enrichment_run_id, product_id, status, input_hash) VALUES (?, ?, 'pending', ?)`);
  const resetStatus = db.prepare(`UPDATE enrichment_product_status SET status='pending', input_hash=?, error=NULL,
    completed_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE enrichment_run_id=? AND product_id=?`);
  const pending = [];
  let skippedComplete = 0;
  let skippedFailed = 0;
  for (const row of rows) {
    const input = localizationInput(row);
    const inputHash = sourceHash(input);
    const status = getStatus.get(runId, row.product_id);
    if (!status) {
      insertStatus.run(runId, row.product_id, inputHash);
      pending.push({ row, input, inputHash });
    } else if (status.input_hash !== inputHash) {
      resetStatus.run(inputHash, runId, row.product_id);
      pending.push({ row, input, inputHash });
    } else if (status.status === 'complete') {
      skippedComplete += 1;
    } else if (status.status === 'failed') {
      if (options.retryFailed) {
        resetStatus.run(inputHash, runId, row.product_id);
        pending.push({ row, input, inputHash });
      } else skippedFailed += 1;
    } else if (options.resume) {
      resetStatus.run(inputHash, runId, row.product_id);
      pending.push({ row, input, inputHash });
    }
  }

  const markRunning = db.prepare(`UPDATE enrichment_product_status SET status='running',
    attempt_count=attempt_count+1, started_at=CURRENT_TIMESTAMP, completed_at=NULL,
    error=NULL, updated_at=CURRENT_TIMESTAMP WHERE enrichment_run_id=? AND product_id=?`);
  let cursor = 0;
  let modelRequests = 0;
  let succeeded = 0;
  let failed = 0;
  let processed = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const entry = pending[cursor++];
      markRunning.run(runId, entry.row.product_id);
      let productRequests = 0;
      try {
        const localized = await localize(entry.input, {
          onRequest: () => { productRequests += 1; modelRequests += 1; },
        });
        writeResult(db, { runId, processorVersion: options.processorVersion }, entry.row, entry.input, localized, productRequests);
        succeeded += 1;
      } catch (error) {
        writeFailure(db, { runId }, entry.row, error, productRequests);
        failed += 1;
      }
      processed += 1;
      if (dependencies.onProgress) dependencies.onProgress({ processed, total: pending.length });
      else if (processed % 25 === 0 || processed === pending.length) console.error(`[enrich] ${processed}/${pending.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, pending.length) }, worker));

  const states = Object.fromEntries(db.prepare(`SELECT status,count(*) AS count FROM enrichment_product_status
    WHERE enrichment_run_id=? GROUP BY status`).all(runId).map((row) => [row.status, row.count]));
  const terminalStatus = (states.failed || states.pending || states.running) ? 'failed' : 'complete';
  const completedAt = new Date().toISOString();
  db.prepare(`UPDATE enrichment_runs SET status=?, completed_at=?, error=? WHERE id=?`).run(
    terminalStatus, completedAt,
    terminalStatus === 'failed' ? `${states.failed || 0} failed, ${states.pending || 0} pending, ${states.running || 0} running` : null,
    runId,
  );
  const summary = {
    runId,
    date: options.date,
    mode: options.mode,
    processorVersion: options.processorVersion,
    selectedProducts: rows.length,
    pendingProducts: pending.length,
    skippedComplete,
    skippedFailed,
    modelRequests,
    succeeded,
    failed,
    states: { pending: states.pending || 0, running: states.running || 0, complete: states.complete || 0, failed: states.failed || 0 },
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(3)),
  };
  db.close();
  return summary;
}

if (require.main === module) {
  runEnrichment(parseArgs(process.argv.slice(2))).then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    if (summary.failed || summary.states.pending || summary.states.running) process.exitCode = 1;
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  stableRunId,
  ensureStatusSchema,
  loadProducts,
  localizationInput,
  runEnrichment,
  PROCESSOR_VERSION,
};
