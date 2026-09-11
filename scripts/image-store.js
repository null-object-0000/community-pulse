const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../web/shared.js');

const fields = ['image', 'logo', 'icon', 'siteLogo'];
// Screenshot galleries: `images` holds every image a source published for a product.
const listFields = ['images'];
// A product mark identifies a row and stays small (VibeCafé logos average ~46 KB, website icons
// ~10 KB), so every report's marks are mirrored. Screenshots are hundreds of KB each: they are
// hotlinked from the source CDN (D.hotlinkable) unless IMAGES_RETENTION_DAYS asks for the newest
// N reports to be mirrored end to end. `siteLogo` is the website-logo fallback: still a product
// mark, still small, still mirrored.
const markFields = ['logo', 'icon', 'siteLogo'];
// Product Hunt marks are the exception: the legacy 日报 rows carry full launch images (up to
// 9 MB, often animated GIFs) that only ever render as a 48px avatar, and ph-files.imgix.net is
// already a trusted hotlink origin for PH screenshot galleries. Mirroring them cost ~230 MB and
// ~3,900 files while their galleries were hotlinked all along, so the mark list never downloads
// them. (An explicit IMAGES_RETENTION_DAYS window still mirrors whole reports end to end.)
const hotlinkMarkOrigins = new Set(['ph-files.imgix.net']);
const isMirroredMark = value => {
  const url = D.safeUrl(value);
  return Boolean(url) && !hotlinkMarkOrigins.has(new URL(url).hostname.toLowerCase());
};
const storeDir = path.resolve(__dirname, '../assets/images');
const rawDir = path.resolve(__dirname, '../知识/大家都在做什么/raw');
const manifestPath = path.join(storeDir, 'manifest.json');
const readManifest = () => fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
const isReportFile = name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name);
const retentionDays = () => {
  const raw = process.env.IMAGES_RETENTION_DAYS;
  if (raw === undefined || raw === '') return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 0;
};
const reportDates = () => fs.readdirSync(rawDir).filter(isReportFile).map(name => name.slice(0, -5)).sort().reverse();
// Marks always; screenshots only inside the retention window.
function itemUrls(item, { screenshots = false } = {}) {
  const urls = [];
  for (const field of markFields) if (isMirroredMark(item[field])) urls.push(item[field]);
  if (!screenshots) return urls;
  for (const field of fields) if (D.safeUrl(item[field])) urls.push(item[field]);
  for (const field of listFields) for (const url of Array.isArray(item[field]) ? item[field] : []) if (D.safeUrl(url)) urls.push(url);
  return urls;
}
function reportUrls(dates, options) {
  const urls = new Set();
  for (const date of dates) {
    const report = JSON.parse(fs.readFileSync(path.join(rawDir, `${date}.json`), 'utf8'));
    for (const item of D.reportItems(report)) for (const url of itemUrls(item, options)) urls.add(url);
  }
  return urls;
}
// Rebuild the manifest around the retained URLs only, and report which files became orphaned.
function pruneManifest(manifest, retained) {
  const kept = {}, keptFiles = new Set(), removed = [];
  for (const [url, local] of Object.entries(manifest)) {
    if (!retained.has(url)) { removed.push(url); continue; }
    kept[url] = local;
    if (local) keptFiles.add(path.basename(local));
  }
  return { kept, keptFiles, removed };
}

// Detect formats from bytes, never trust an upstream filename or HTML response.
function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(bytes.toString('ascii', 8, 12))) return 'avif';
  if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'ico';
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text) && !/<!DOCTYPE|<!ENTITY/i.test(text)) return 'svg';
  throw new Error('Unsupported or invalid image');
}

async function downloadImage(url, fetcher = fetch) {
  if (!D.safeUrl(url)) throw new Error('Invalid image URL');
  // Website icons come from arbitrary hosts, some of which answer an empty 403 to unknown agents.
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; devtrends-image-sync/1; +https://devtrends.site)', Accept: 'image/*,*/*;q=0.8' },
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  const limit = 10 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Image exceeds 10 MiB'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Image exceeds 10 MiB');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  return { bytes, extension: imageExtension(bytes) };
}

function localizeUrl(value, manifest) {
  // A URL is buildable when it is mapped to a managed file or when its source CDN is
  // trusted for direct hotlinking (older reports). Anything else must be synced first.
  if (D.safeUrl(value) && !Object.hasOwn(manifest, value) && !D.hotlinkable(value)) {
    throw new Error('Image has not been synced; run npm run images:sync before building');
  }
  return D.localImage(value, manifest);
}

function localizeReport(report, manifest) {
  for (const source of report.results || []) for (const item of source.items || []) {
    for (const field of fields) if (item[field]) {
      item[field] = localizeUrl(item[field], manifest);
    }
    for (const field of listFields) if (Array.isArray(item[field])) {
      // An unsynced URL throws before this point, so filtering only drops known-bad images.
      item[field] = item[field].map(url => localizeUrl(url, manifest)).filter(Boolean);
    }
  }
  return report;
}

function copyImages(outputDir, manifest) {
  const targetDir = path.join(outputDir, 'images');
  fs.mkdirSync(targetDir, { recursive: true });
  for (const local of new Set(Object.values(manifest))) {
    if (!local) continue;
    if (!D.localImage(local)) throw new Error(`Invalid image manifest path: ${local}`);
    fs.copyFileSync(path.join(storeDir, path.basename(local)), path.join(targetDir, path.basename(local)));
  }
}

async function syncImages() {
  fs.mkdirSync(storeDir, { recursive: true });
  const dates = reportDates();
  const days = retentionDays();
  const retained = reportUrls(dates);
  const window = dates.slice(0, days);
  if (window.length) for (const url of reportUrls(window, { screenshots: true })) retained.add(url);
  const { kept: manifest, removed } = pruneManifest(readManifest(), retained);
  const pending = [...retained].filter(url => !D.localImage(manifest[url]) || !fs.existsSync(path.join(storeDir, path.basename(manifest[url]))));
  let done = 0, failed = 0;
  const save = () => {
    fs.writeFileSync(manifestPath + '.tmp', JSON.stringify(Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n');
    fs.renameSync(manifestPath + '.tmp', manifestPath);
  };
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (pending.length) {
      const url = pending.shift();
      try {
        const { bytes, extension } = await downloadImage(url);
        const name = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${extension}`;
        const target = path.join(storeDir, name);
        fs.writeFileSync(target + '.tmp', bytes); fs.renameSync(target + '.tmp', target);
        manifest[url] = `/images/${name}`;
        done++;
      } catch (error) {
        manifest[url] = null; failed++;
        console.warn(`Image unavailable: ${url}: ${error.message}`);
      }
      save();
      if ((done + failed) % 50 === 0) console.log(`Images: ${done} downloaded, ${failed} unavailable, ${pending.length} queued`);
    }
  }));
  save();
  // Retention is enforced after a successful pass so a partial download never deletes a
  // file the retained reports still need.
  const { keptFiles } = pruneManifest(manifest, retained);
  let pruned = 0;
  for (const name of fs.readdirSync(storeDir)) {
    if (name === 'manifest.json' || keptFiles.has(name)) continue;
    fs.rmSync(path.join(storeDir, name));
    pruned++;
  }
  console.log(`Images: ${retained.size} mirrored URLs (marks from ${dates.length} reports, screenshots from ${window.length}), ${done} downloaded, ${failed} unavailable, ${removed.length} manifest entries and ${pruned} files pruned.`);
}

module.exports = { readManifest, localizeReport, copyImages, downloadImage, imageExtension, pruneManifest, reportDates, reportUrls, itemUrls, retentionDays };
if (require.main === module) syncImages().catch(error => { console.error(error); process.exitCode = 1; });
