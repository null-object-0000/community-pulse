#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const directory = path.resolve(process.argv.find((arg) => arg.startsWith('--dir='))?.slice(6)
  || path.join(ROOT, 'data', 'catalog', 'mysql-import'));
const config = path.join(ROOT, 'wrangler.mysql-import.toml');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
const progressFile = path.join(directory, '.uploaded.json');
const progress = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, 'utf8')) : { files: [] };
const completed = new Set(progress.files || []);
const token = crypto.randomBytes(32).toString('hex');
let failure = 0;

const deploy = spawnSync('npx', ['wrangler', 'deploy', '--config', config, '--var', `IMPORT_TOKEN:${token}`], {
  cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
process.stdout.write(deploy.stdout || '');
process.stderr.write(deploy.stderr || '');
if (deploy.status !== 0) process.exit(deploy.status || 1);
const endpoint = `${deploy.stdout || ''}\n${deploy.stderr || ''}`.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
if (!endpoint) throw new Error('temporary import Worker URL was not reported');

try {
  for (const [index, entry] of manifest.files.entries()) {
    if (completed.has(entry.name)) continue;
    console.log(`[${index + 1}/${manifest.files.length}] ${entry.name}: ${entry.rows} rows`);
    const upload = spawnSync('curl', [
      '--silent', '--show-error', '--fail-with-body', '--retry', '5', '--retry-all-errors', '--retry-delay', '2',
      '--max-time', '180', '-X', 'POST', '-H', `Authorization: Bearer ${token}`,
      '--data-binary', `@${path.join(directory, entry.name)}`, `${endpoint}/import`,
    ], { cwd: ROOT, encoding: 'utf8' });
    if (upload.status !== 0) {
      process.stdout.write(upload.stdout || '');
      process.stderr.write(upload.stderr || '');
      failure = upload.status || 1;
      break;
    }
    completed.add(entry.name);
    fs.writeFileSync(progressFile, `${JSON.stringify({ files: [...completed] }, null, 2)}\n`);
  }
} finally {
  const cleanup = spawnSync('npx', ['wrangler', 'delete', '--config', config, '--force'], { cwd: ROOT, stdio: 'inherit' });
  if (!failure && cleanup.status !== 0) failure = cleanup.status || 1;
}
console.log(`Uploaded ${completed.size}/${manifest.files.length} MySQL chunks.`);
process.exit(failure);
