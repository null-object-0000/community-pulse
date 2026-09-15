#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const directory = path.resolve(process.argv.find((arg) => arg.startsWith('--dir='))?.slice(6)
  || path.join(ROOT, 'data', 'catalog', 'mysql-import'));
const manifestFile = path.join(directory, 'manifest.json');
if (!fs.existsSync(manifestFile)) throw new Error(`MySQL import manifest is missing: ${manifestFile}`);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
if (manifest.dialect !== 'mysql' || manifest.schemaVersion !== 3 || manifest.source !== 'source-raw') {
  throw new Error('unsupported MySQL import manifest');
}
const required = new Set(['sources', 'products', 'product_routes', 'product_details', 'product_source_first_seen', 'taxonomy_terms', 'taxonomy_assignments']);
const seen = new Set();
let totalRows = 0;
let totalBytes = 0;
for (const entry of manifest.files) {
  if (!/^\d{5}-[a-z_]+\.sql$/.test(entry.name) || !required.has(entry.table)) throw new Error(`invalid import entry: ${entry.name}`);
  const file = path.join(directory, entry.name);
  const content = fs.readFileSync(file);
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  if (content.length !== entry.bytes || digest !== entry.sha256) throw new Error(`import chunk changed after generation: ${entry.name}`);
  if (!/^INSERT (?:IGNORE )?INTO [a-z_]+ /i.test(content.toString('utf8'))) throw new Error(`unexpected statement in ${entry.name}`);
  seen.add(entry.table);
  totalRows += entry.rows;
  totalBytes += entry.bytes;
}
const missing = [...required].filter((table) => !seen.has(table));
if (missing.length) throw new Error(`MySQL import is incomplete: ${missing.join(', ')}`);
if (totalRows !== manifest.totalRows || totalBytes !== manifest.totalBytes) throw new Error('MySQL import totals do not match the manifest');
console.log(JSON.stringify({ directory, files: manifest.files.length, totalRows, totalBytes, tables: [...seen] }, null, 2));
