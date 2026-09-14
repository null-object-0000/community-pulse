#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class StatementAdapter {
  constructor(statement) {
    this.statement = statement;
    this.bindings = [];
  }
  bind(...bindings) {
    this.bindings = bindings;
    return this;
  }
  async first() { return this.statement.get(...this.bindings) || null; }
  async all() { return { results: this.statement.all(...this.bindings) }; }
}

class DatabaseAdapter {
  constructor(database) { this.database = database; }
  prepare(sql) { return new StatementAdapter(this.database.prepare(sql)); }
}

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const databaseArg = process.argv.find((arg) => arg.startsWith('--database='));
  const file = path.resolve(databaseArg?.slice('--database='.length)
    || path.join(root, 'data', 'catalog', 'devtrends.sqlite'));
  if (!fs.existsSync(file)) throw new Error(`catalog database is missing: ${file}`);
  const query = process.argv.find((arg) => arg.startsWith('?')) || '?';
  const db = new DatabaseSync(file, { readOnly: true });
  const adapter = new DatabaseAdapter(db);
  const { availableSources, parseTrendFilters, queryTrends } = await import('../../worker/catalog-api.mjs');
  const sources = await availableSources(adapter);
  const latest = sources.map((source) => source.lastSeenDate).filter(Boolean).sort().at(-1);
  const filters = parseTrendFilters(new URL(`https://devtrends.site/api/v1/trends${query}`), sources.map((source) => source.id), latest);
  console.log(JSON.stringify(await queryTrends(adapter, filters), null, 2));
  db.close();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
