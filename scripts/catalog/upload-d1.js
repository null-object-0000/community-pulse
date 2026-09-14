#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const directory = path.resolve(process.argv.find((arg) => arg.startsWith('--dir='))?.slice(6)
  || path.join(ROOT, 'data', 'catalog', 'd1-import'));
const database = process.argv.find((arg) => arg.startsWith('--database='))?.slice(11) || 'devtrends-catalog';
const manifestFile = path.join(directory, 'manifest.json');
const progressFile = path.join(directory, '.uploaded.json');
if (!fs.existsSync(manifestFile)) throw new Error(`D1 import manifest is missing: ${manifestFile}`);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const progress = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, 'utf8')) : {};
const completed = new Set(progress.database === database ? progress.files || [] : []);

for (const entry of manifest.files) {
  if (completed.has(entry.name)) continue;
  console.log(`Uploading ${entry.name} (${entry.rows} rows)`);
  let result;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    result = spawnSync('npx', ['wrangler', 'd1', 'execute', database, '--remote', '--file', path.join(directory, entry.name)], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (result.status === 0) break;
    if (attempt < 4) {
      console.warn(`Upload attempt ${attempt} failed; retrying the idempotent chunk.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 2000);
    }
  }
  if (result?.status !== 0) process.exit(result?.status || 1);
  completed.add(entry.name);
  fs.writeFileSync(progressFile, `${JSON.stringify({ database, files: [...completed] }, null, 2)}\n`);
}
console.log(`Uploaded ${completed.size} D1 import chunks.`);
