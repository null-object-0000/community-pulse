#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..');
const file = path.resolve(process.argv[2] || path.join(ROOT, 'data', 'catalog', 'devtrends.sqlite'));

if (!fs.existsSync(file)) {
  console.error(`catalog database is missing: ${file}`);
  process.exit(1);
}

const db = new DatabaseSync(file, { readOnly: true });
const required = [
  'sources', 'ingestion_runs', 'products', 'product_identities', 'identity_conflicts',
  'source_items', 'observations', 'product_source_first_seen', 'enrichment_runs',
  'enrichment_product_status', 'product_content', 'taxonomy_terms', 'taxonomy_assignments', 'reports', 'report_items',
];
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
const missing = required.filter((table) => !tables.has(table));
if (missing.length) throw new Error(`catalog schema is incomplete: ${missing.join(', ')}`);

const count = (table) => db.prepare(`SELECT count(*) AS value FROM ${table}`).get().value;
const brokenObservations = db.prepare(`SELECT count(*) AS value FROM observations o
  LEFT JOIN products p ON p.id=o.product_id
  LEFT JOIN sources s ON s.id=o.source_id
  LEFT JOIN source_items i ON i.id=o.source_item_id
  WHERE p.id IS NULL OR s.id IS NULL OR i.id IS NULL`).get().value;
const invalidFirstSeen = db.prepare(`SELECT count(*) AS value FROM product_source_first_seen f
  WHERE NOT EXISTS (
    SELECT 1 FROM observations o
    WHERE o.product_id=f.product_id AND o.source_id=f.source_id
      AND o.observed_date=f.first_seen_date
  )`).get().value;
const danglingAssignments = db.prepare(`SELECT count(*) AS value FROM taxonomy_assignments a
  LEFT JOIN taxonomy_terms t ON t.facet=a.facet AND t.id=a.term_id
  WHERE t.id IS NULL`).get().value;
const currentShadowAssignments = db.prepare(`SELECT count(*) AS value FROM taxonomy_assignments a
  JOIN enrichment_runs r ON r.id=a.enrichment_run_id
  WHERE r.kind='catalog-product' AND a.is_current<>0`).get().value;
const currentShadowContent = db.prepare(`SELECT count(*) AS value FROM product_content c
  JOIN enrichment_runs r ON r.id=c.enrichment_run_id
  WHERE r.kind='catalog-product' AND c.is_current<>0`).get().value;
const nonTerminalProductStates = db.prepare(`SELECT count(*) AS value FROM enrichment_product_status s
  JOIN enrichment_runs r ON r.id=s.enrichment_run_id
  WHERE r.status IN ('complete','failed') AND s.status IN ('pending','running')`).get().value;
const summary = {
  file,
  sources: count('sources'),
  products: count('products'),
  sourceItems: count('source_items'),
  observations: count('observations'),
  taxonomyAssignments: count('taxonomy_assignments'),
  identityConflicts: count('identity_conflicts'),
  brokenObservations,
  invalidFirstSeen,
  danglingAssignments,
  currentShadowAssignments,
  currentShadowContent,
  nonTerminalProductStates,
  integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
};
db.close();

if (brokenObservations || invalidFirstSeen || danglingAssignments || currentShadowAssignments
  || currentShadowContent || nonTerminalProductStates || summary.integrity !== 'ok') {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(summary, null, 2));
