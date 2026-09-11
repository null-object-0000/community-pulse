#!/usr/bin/env node
// Check that every mirrored product mark in assets/images is actually reachable on IMAGE_BASE.
//
//   IMAGE_BASE=https://img.devtrends.site npm run images:verify
//   IMAGE_BASE=https://img.devtrends.site npm run images:verify -- --sample 20
//
// This is the gate for dropping the mirrors from Git: only untrack `assets/images/*` once this
// reports every file as reachable. It is also a cheap post-deploy smoke test for the daily upload.
const { readManifest } = require('./image-store.js');

const origin = (process.env.IMAGE_BASE || '').trim().replace(/\/+$/, '');
const concurrency = Math.max(1, Number(process.env.R2_CONCURRENCY) || 8);
const sampleIndex = process.argv.indexOf('--sample');
const sampleSize = sampleIndex === -1 ? 0 : Math.max(1, Number(process.argv[sampleIndex + 1]) || 0);

function expectedPaths(manifest) {
  return [...new Set(Object.values(manifest).filter(value => typeof value === 'string' && value.startsWith('/images/')))].sort();
}

async function check(pathname) {
  try {
    const response = await fetch(origin + pathname, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
    await response.body?.cancel();
    if (!response.ok) return { pathname, status: response.status };
    const type = response.headers.get('content-type') || '';
    // R2 serves the object's stored content type; anything else means the metadata was lost.
    return type.startsWith('image/') ? { pathname, ok: true } : { pathname, status: 200, type };
  } catch (error) {
    // fetch wraps network/DNS failures: surface the underlying code so a missing domain is obvious.
    return { pathname, status: error.cause?.code || error.name || 'error' };
  }
}

async function main() {
  if (!origin) throw new Error('IMAGE_BASE is required, for example IMAGE_BASE=https://img.devtrends.site npm run images:verify');
  let paths = expectedPaths(readManifest());
  if (sampleSize && sampleSize < paths.length) paths = paths.filter((_, index) => index % Math.ceil(paths.length / sampleSize) === 0);
  const queue = [...paths];
  const bad = [];
  let ok = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const result = await check(queue.shift());
      if (result.ok) ok++;
      else bad.push(result);
      if ((ok + bad.length) % 100 === 0) console.log(`Verified ${ok + bad.length}/${paths.length}`);
    }
  }));
  console.log(`Images: ${ok}/${paths.length} reachable on ${origin}, ${bad.length} missing or misconfigured.`);
  for (const failure of bad.slice(0, 10)) console.log(`  ${failure.status} ${origin}${failure.pathname}${failure.type ? ` (content-type ${failure.type})` : ''}`);
  if (bad.length > 10) console.log(`  ...and ${bad.length - 10} more`);
  if (bad.length) process.exitCode = 1;
}

module.exports = { expectedPaths, check };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
