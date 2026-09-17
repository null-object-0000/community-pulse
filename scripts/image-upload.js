#!/usr/bin/env node
// Copy the mirrored product marks from assets/images into the R2 bucket behind IMAGE_BASE.
//
//   IMAGE_BASE=https://img.devtrends.site npm run images:upload
//   IMAGE_BASE=https://img.devtrends.site npm run images:upload -- --dry-run
//
// Objects are content-addressed, so a file that already answers on the origin is skipped and
// re-running after a failure is always safe. Authentication is wrangler's own: either a local
// `npx wrangler login`, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment
// (that is how the daily workflow uploads new marks).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readManifest, imageOrigin } = require('./image-store.js');

const storeDir = path.resolve(__dirname, '../assets/images');
const contentType = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};
const cacheControl = 'public, max-age=31536000, immutable';
const bucket = process.env.R2_BUCKET || 'community-pulse-images';
const prefix = (process.env.R2_PREFIX || 'images').replace(/^\/+|\/+$/g, '');
const origin = imageOrigin();
// Probing is one HEAD per object and uploading spawns a wrangler process per object, so they want
// different widths. Both stay at 4: a higher probe concurrency was tried (16) and it tripped the
// CDN's bot protection — unverifiable probes went from 1 to 28 in a single daily run, which the
// 403-is-not-404 contract below then turned into a failed report. Revisit only with measurements
// from a real run, not from a laptop behind a proxy.
const concurrency = Math.max(1, Number(process.env.R2_CONCURRENCY) || 4);
const probeConcurrency = Math.max(
  1,
  Number(process.env.R2_PROBE_CONCURRENCY) || 4,
);
const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');
// npx resolves (and caches) wrangler on demand; installing it locally or globally makes this faster.
const wranglerBin = process.env.WRANGLER_BIN || 'npx';
const wranglerArgs = wranglerBin === 'npx' ? ['--yes', 'wrangler@4'] : [];

// Every manifest value is `/images/<sha256>.<ext>`; the CDN keeps both the prefix and the name so
// the markup does not change when the site stops serving the files itself.
function uploadEntries(manifest, directory = storeDir) {
  const entries = new Map();
  for (const local of Object.values(manifest)) {
    if (typeof local !== 'string' || !local.startsWith('/images/')) continue;
    const name = path.basename(local);
    const type = contentType[path.extname(name).toLowerCase()];
    if (!type) throw new Error(`Unsupported image extension in manifest: ${local}`);
    const file = path.join(directory, name);
    entries.set(`${prefix}/${name}`, { local, type, file: fs.existsSync(file) ? file : null });
  }
  return [...entries].map(([key, entry]) => ({ key, ...entry })).sort((a, b) => a.key.localeCompare(b.key));
}

// A HEAD against the public origin is the cheapest way to learn what is already there: it needs no
// R2 credentials and costs nothing while it is cached. Returns true (present), false (404: needs
// upload) or null (the probe itself failed, so nothing can be concluded about the object).
async function alreadyPublished(key) {
  if (!origin) return false;
  try {
    const response = await fetch(`${origin}/${key}`, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
    await response.body?.cancel();
    if (response.status === 404) return false;
    // A 403/429 (bot protection, rate limit) or a 5xx says nothing about the object: never let it
    // masquerade as "missing", or a blocked probe would re-upload the whole set.
    return response.ok ? true : null;
  } catch {
    return null;
  }
}

function putObject({ key, file, type }) {
  const args = [...wranglerArgs, 'r2', 'object', 'put', `${bucket}/${key}`, '--file', file, '--content-type', type, '--cache-control', cacheControl, '--remote'];
  if (dryRun) {
    console.log(`would upload ${key} (${type})`);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const child = spawn(wranglerBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim().split('\n').slice(-3).join(' | ') || `wrangler exited with ${code}`)));
  });
}

async function main({
  manifest = readManifest(),
  directory = storeDir,
  probe = alreadyPublished,
  upload = putObject,
  logger = console,
  setExitCode = code => { process.exitCode = code; },
} = {}) {
  if (!dryRun && !process.env.CLOUDFLARE_API_TOKEN && !process.env.WRANGLER_BIN && !process.env.CI) {
    logger.warn('No CLOUDFLARE_API_TOKEN set: relying on a local `npx wrangler login` session.');
  }
  if (!origin) logger.warn('IMAGE_BASE is not set: every object is uploaded without checking the origin first.');
  const entries = uploadEntries(manifest, directory);
  // --force may bypass the pre-check only when the bytes exist locally. A missing local file can
  // never be uploaded, so the public origin must still prove that its object already exists.
  const pending = force ? entries.filter(entry => entry.file) : [];
  const failures = [];
  let present = 0, unknown = 0, probed = 0;
  // Objects that could not be verified and have no local bytes to upload with. The probe is a HEAD
  // against a CDN that may answer 403/429/5xx or time out; per alreadyPublished() those say nothing
  // about the object, so they are NOT failures — only a real 404 (or a 200 with no local copy to
  // push, which the upload queue cannot act on) is. Screenshot entries live in this bucket by
  // design: their bytes are capture output under screenshots-files/ and are never downloaded into
  // assets/images, so a probe hiccup used to read as "missing mirror file" and fail the whole run.
  const unverified = [];
  const queue = force ? entries.filter(entry => !entry.file) : [...entries];
  await Promise.all(Array.from({ length: probeConcurrency }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      const published = await probe(entry.key);
      if (published === true) present++;
      else if (!entry.file) {
        if (published === false) {
          const failure = `${entry.key}: Missing mirror file for ${entry.local}; the remote object returned 404; run npm run images:sync before uploading`;
          failures.push(failure);
          logger.error(`Upload failed ${failure}`);
        } else {
          unknown++;
          unverified.push(entry.key);
        }
      }
      else {
        if (published === null) unknown++;
        pending.push(entry);
      }
      probed++;
      if (probed % 100 === 0) logger.log(`Checked ${probed}/${entries.length}`);
    }
  }));
  pending.sort((a, b) => a.key.localeCompare(b.key));
  // Every probe failing means the pre-check channel is broken (usually a proxy that Node's fetch
  // does not use), not that the bucket is empty. Re-uploading ~900 objects by accident is worse
  // than stopping, so require --force to make that explicit.
  if (unknown === entries.length && entries.length) {
    logger.error(`Images: every IMAGE_BASE probe failed (${origin} unreachable from this shell). Set NODE_USE_ENV_PROXY=1 if you are behind a proxy, or re-run with --force to upload everything anyway.`);
    setExitCode(1);
    return;
  }
  logger.log(`Images: ${entries.length} mirrored marks, ${present} already on ${origin || 'the origin'}, ${pending.length} to upload to ${bucket} (probe ${probeConcurrency}, upload ${concurrency}${unknown ? `, ${unknown} unverifiable` : ''}${dryRun ? ', dry run' : ''}).`);
  // Unverifiable objects with no local bytes are reported but never fatal: a blocked or throttled
  // probe is a statement about the CDN edge we happened to hit, not about the object. The bytes
  // they reference were published when their report shipped; re-checking is what images:verify is
  // for. Listing them keeps the noise visible without letting it break a daily run.
  if (unverified.length) {
    logger.warn(`Images: ${unverified.length} object(s) could not be verified and have no local bytes; not failing. First few: ${unverified.slice(0, 3).join(', ')}`);
  }
  const total = pending.length;
  let done = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (pending.length) {
      const entry = pending.shift();
      try {
        await upload(entry);
        done++;
        if (done % 25 === 0) logger.log(`Images: ${done}/${total} uploaded`);
      } catch (error) {
        failures.push(`${entry.key}: ${error.message}`);
        logger.error(`Upload failed ${entry.key}: ${error.message}`);
      }
    }
  }));
  logger.log(`Images: ${done} uploaded, ${failures.length} failed.`);
  if (failures.length) setExitCode(1);
}

module.exports = { uploadEntries, alreadyPublished, main, contentType, cacheControl };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
