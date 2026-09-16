const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../web/shared.js');
const { classifyImage, extensionOf, markImagePath, MANUAL_LIGHT_MARKS } = require('./mark-tone.js');

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
const tonesPath = path.join(storeDir, 'tones.json');
const configPath = path.resolve(__dirname, '../site.config.json');
const readManifest = () => fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
// 浅色标志清单（见 scripts/mark-tone.js）：和 manifest 一样提交进仓库，键是内容寻址的镜像路径，
// 所以同一份 checkout 在仓库内镜像模式和外置 CDN 模式下都查得到。默认值缓存，构建期每条日报都
// 要查一次。
let tonesCache = null;
function readTones() {
  if (!tonesCache) {
    let document = null;
    try { document = JSON.parse(fs.readFileSync(tonesPath, 'utf8')); } catch { document = null; }
    tonesCache = { light: new Set(Array.isArray(document?.light) ? document.light.filter(entry => D.localImage(entry)) : []) };
  }
  return tonesCache;
}
// 逐个判定本地有字节的标志，产出新的浅色清单。本地没有字节的沿用上一次的结论：镜像文件不在 Git
// 里（见 .gitignore），CI 的干净 checkout 只有提交进仓库的这份清单，重新下载之前判定不了。
function collectLightMarks(manifest, previous = new Set()) {
  const light = new Set();
  for (const local of new Set(Object.values(manifest))) {
    if (!D.localImage(local)) continue;
    const name = path.basename(local);
    const file = path.join(storeDir, name);
    const manual = MANUAL_LIGHT_MARKS.has(name);
    if (!fs.existsSync(file)) {
      if (previous.has(local)) light.add(local);
      continue;
    }
    const result = classifyImage(fs.readFileSync(file), extensionOf(name));
    // 手工兜底只补「解不出来」的那些（WebP 之类）；能解出来的以判定为准。
    if (result.tone === 'light' || (result.tone === 'unknown' && manual)) light.add(local);
  }
  return light;
}
function writeTones(manifest) {
  const light = collectLightMarks(manifest, readTones().light);
  const keys = [...light].sort();
  fs.writeFileSync(`${tonesPath}.tmp`, `${JSON.stringify({ schemaVersion: 1, light: keys }, null, 2)}\n`);
  fs.renameSync(`${tonesPath}.tmp`, tonesPath);
  tonesCache = { light };
  return keys;
}
// `site.config.json` carries the committed mirror origin so the Workers Builds trigger needs no
// extra configuration; `IMAGE_BASE` still overrides it (an empty `IMAGE_BASE=` forces the bundled
// mode, which is what the tests and local preview use).
const configImageBase = () => {
  try { return String(JSON.parse(fs.readFileSync(configPath, 'utf8')).imageBase || ''); } catch { return ''; }
};
// Mirrors live either in this site's bundle (`/images/<sha256>.<ext>`, the default) or on an
// external CDN origin. The manifest stays relative either way, so one checkout builds both modes
// and `npm run images:upload` can put the same files on the origin without rewriting the mappings.
const imageOrigin = () => (process.env.IMAGE_BASE ?? configImageBase()).trim().replace(/\/+$/, '');
const mirrorUrl = value => {
  const origin = imageOrigin();
  return origin && typeof value === 'string' && value.startsWith('/images/') ? origin + value : value;
};
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
  // The website's og:image is a gallery visual, not a mark — but it is captured by our own logo
  // pass and stays in the same size class as a siteLogo (median 151 KB vs ~10 KB for an icon), so
  // it is mirrored like a mark. Mirroring only inside the retention window would silently drop the
  // third gallery tier, because the default window is zero.
  if (item.ogImage && D.safeUrl(item.ogImage.url)) urls.push(item.ogImage.url);
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

// Our own screenshot bytes live beside their day file, addressed by content hash, so they are
// copied rather than downloaded.
const SCREENSHOT_PREFIX = 'screenshots-files/';
function screenshotFilesDir() {
  return path.join(path.dirname(rawDir), 'source-raw', 'screenshots-files');
}
function localScreenshotPath(value) {
  return typeof value === 'string' && value.startsWith(SCREENSHOT_PREFIX) ? value : '';
}

function localizeUrl(value, manifest) {
  // Our own screenshot layer stores bytes on disk beside its day file (`screenshots-files/<name>`);
  // there is nothing to download, so it is copied into the mirror store as-is. Materializing here
  // (not only during sync) is what keeps a plain `npm run build` working on a fresh checkout that
  // ran the capture but not `images:sync`.
  const local = localScreenshotPath(value);
  if (local) {
    const mirror = materializeScreenshot(value, storeDir);
    if (mirror) {
      manifest[value] = mirror;
      return mirrorUrl(mirror);
    }
    // The screenshot bytes never enter Git (they are capture output), so a checkout that did not
    // run the capture has no local copy. With an external IMAGE_BASE the day's upload已经把它们
    // 放到了 CDN 上的同一内容寻址路径，sync 时写下的 manifest 条目就是权威来源 —— 信任它，
    // 而不是让构建失败（Cloudflare 的构建正是这种情况）。
    if (imageOrigin() && Object.hasOwn(manifest, value)) return mirrorUrl(manifest[value]);
    throw new Error(`Missing screenshot ${path.basename(local)}; re-run capture_screenshots_raw.js`);
  }
  // A URL is buildable when it is mapped to a managed file or when its source CDN is
  // trusted for direct hotlinking (older reports). Anything else must be synced first.
  if (D.safeUrl(value) && !Object.hasOwn(manifest, value) && !D.hotlinkable(value)) {
    throw new Error('Image has not been synced; run npm run images:sync before building');
  }
  return mirrorUrl(D.localImage(value, manifest));
}

function localizeReport(report, manifest, lightMarks = readTones().light) {
  for (const source of report.results || []) for (const item of source.items || []) {
    for (const field of fields) if (item[field]) {
      item[field] = localizeUrl(item[field], manifest);
    }
    for (const field of listFields) if (Array.isArray(item[field])) {
      // An unsynced URL throws before this point, so filtering only drops known-bad images.
      item[field] = item[field].map(url => localizeUrl(url, manifest)).filter(Boolean);
    }
    // Our own screenshots are a list like `images`; the website's og:image is a single object.
    if (Array.isArray(item.screenshots)) {
      item.screenshots = item.screenshots.map(url => localizeUrl(url, manifest)).filter(Boolean);
    }
    if (item.ogImage && item.ogImage.url) {
      try {
        item.ogImage = { ...item.ogImage, url: localizeUrl(item.ogImage.url, manifest) };
      } catch (_) {
        // An og:image that was never mirrored (outside the retention window) must not break the
        // build: the gallery simply keeps the source's own media and our screenshot.
        item.ogImage = null;
      }
    }
    // A mark that is itself a pale, transparent drawing disappears on the white tile the rows use;
    // the tone travels with the row so the browser can swap in the dark plate (see styles.css).
    // Same precedence chain as the renderer — `D.itemMark` is the single copy of it.
    delete item.markTone;
    const mark = D.itemMark(item);
    if (mark && lightMarks.has(markImagePath(mark))) item.markTone = 'light';
  }
  return report;
}

function copyImages(outputDir, manifest) {
  // With an external IMAGE_BASE the bundle carries no image bytes: the CDN serves the very same
  // content-addressed paths, so `/images/<name>` in the markup is resolved by the origin instead.
  const external = Boolean(imageOrigin());
  const targetDir = path.join(outputDir, 'images');
  if (!external) fs.mkdirSync(targetDir, { recursive: true });
  for (const local of new Set(Object.values(manifest))) {
    if (!local) continue;
    if (!D.localImage(local)) throw new Error(`Invalid image manifest path: ${local}`);
    if (external) continue;
    const source = path.join(storeDir, path.basename(local));
    // After the mirrors leave Git a build without IMAGE_BASE cannot produce a working page, so fail
    // loudly instead of shipping markup that points at files nobody serves.
    if (!fs.existsSync(source)) throw new Error(`Missing mirror ${path.basename(local)}: set IMAGE_BASE to a deployed origin or run npm run images:sync`);
    fs.copyFileSync(source, path.join(targetDir, path.basename(local)));
  }
}

// Our own screenshots arrive as local paths (`screenshots-files/<sha>.<ext>`), not URLs to
// download. They still have to become ordinary mirrors: only then do prune, upload, verify and
// copyImages treat them like every other image, and only then does the markup get a `/images/<name>`
// that the CDN can serve. The bytes are copied into the same store directory (still gitignored).
function screenshotUrls(dates, reportDir = rawDir) {
  const urls = new Set();
  for (const date of dates) {
    const file = path.join(reportDir, `${date}.json`);
    if (!fs.existsSync(file)) continue;
    let report;
    try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
    for (const item of D.reportItems(report)) {
      for (const value of Array.isArray(item.screenshots) ? item.screenshots : []) {
        if (localScreenshotPath(value)) urls.add(value);
      }
    }
  }
  return urls;
}

// Copy a capture-layer file into the mirror store, keeping the content-addressed name. An entry
// already in the store is returned as-is: the capture file may be long gone by then (it is
// gitignored and lives only on the machine that took the screenshot).
function materializeScreenshot(value, store, filesDir = screenshotFilesDir()) {
  const name = path.basename(localScreenshotPath(value));
  const target = path.join(store, name);
  if (fs.existsSync(target)) return `/images/${name}`;
  const source = path.join(filesDir, name);
  if (!fs.existsSync(source)) return '';
  fs.copyFileSync(source, target);
  return `/images/${name}`;
}

async function syncImages() {
  fs.mkdirSync(storeDir, { recursive: true });
  const dates = reportDates();
  const days = retentionDays();
  const retained = reportUrls(dates);
  const window = dates.slice(0, days);
  if (window.length) for (const url of reportUrls(window, { screenshots: true })) retained.add(url);
  // Our screenshots are already on disk, so they are kept unconditionally: without them in
  // `retained` the next prune would drop them from the manifest and the gallery would silently lose
  // its middle tier.
  // Two sources keep the screenshot tier alive: the day files still reference it, and the manifest
  // already carries a mirror entry whose bytes live on the CDN. Without the second one a checkout
  // that never ran the capture would prune every screenshot entry away.
  const localScreenshots = screenshotUrls(dates);
  for (const url of localScreenshots) retained.add(url);
  const existingManifest = readManifest();
  for (const [url, local] of Object.entries(existingManifest)) {
    if (localScreenshotPath(url) && local) retained.add(url);
  }
  const { kept: manifest, removed } = pruneManifest(existingManifest, retained);
  for (const url of localScreenshots) {
    if (D.localImage(manifest[url])) continue;
    const mirror = materializeScreenshot(url, storeDir);
    if (mirror) manifest[url] = mirror;
  }
  // Screenshot entries are never downloaded: their bytes are capture output, not a remote object.
  // A fresh checkout has the manifest entry (committed) but not the bytes (gitignored), so putting
  // them in the download queue would fail and null the entry out — silently deleting the middle
  // tier from every future report. Only entries whose local copy is genuinely absent are re-fetched,
  // and a screenshot that already has a mirror entry is left exactly as the capture left it.
  const pending = [...retained].filter(url => {
    if (localScreenshotPath(url)) return !D.localImage(manifest[url]);
    return !D.localImage(manifest[url]) || !fs.existsSync(path.join(storeDir, path.basename(manifest[url])));
  });
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
    if (['manifest.json', 'tones.json'].includes(name) || keptFiles.has(name)) continue;
    fs.rmSync(path.join(storeDir, name));
    pruned++;
  }
  // The tone list is rebuilt after the files settle, so an entry can never point at a file that was
  // just pruned and a mark whose bytes arrived today is classified in the same run.
  const light = writeTones(manifest);
  console.log(`Images: ${retained.size} mirrored URLs (marks from ${dates.length} reports, screenshots from ${window.length}), ${done} downloaded, ${failed} unavailable, ${removed.length} manifest entries and ${pruned} files pruned; ${light.length} light marks.`);
}

module.exports = { readManifest, readTones, writeTones, collectLightMarks, localizeReport, copyImages, downloadImage, imageExtension, imageOrigin, mirrorUrl, pruneManifest, reportDates, reportUrls, itemUrls, retentionDays, localScreenshotPath, screenshotFilesDir, screenshotUrls, materializeScreenshot };
if (require.main === module) syncImages().catch(error => { console.error(error); process.exitCode = 1; });
