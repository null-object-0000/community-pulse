const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../web/shared.js');

const fields = ['image', 'logo', 'icon'];
const storeDir = path.resolve(__dirname, '../assets/images');
const manifestPath = path.join(storeDir, 'manifest.json');
const readManifest = () => fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};

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
  const response = await fetcher(url, { signal: AbortSignal.timeout(20000) });
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

function localizeReport(report, manifest) {
  for (const source of report.results || []) for (const item of source.items || []) {
    for (const field of fields) if (item[field]) {
      if (D.safeUrl(item[field]) && !Object.hasOwn(manifest, item[field])) {
        throw new Error('Image has not been synced; run npm run images:sync before building');
      }
      item[field] = D.localImage(item[field], manifest);
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
  const manifest = readManifest(), urls = new Set();
  const rawDir = path.resolve(__dirname, '../知识/大家都在做什么/raw');
  for (const file of fs.readdirSync(rawDir).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))) {
    for (const item of D.reportItems(JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8')))) {
      for (const field of fields) if (D.safeUrl(item[field])) urls.add(item[field]);
    }
  }
  const pending = [...urls].filter(url => !D.localImage(manifest[url]) || !fs.existsSync(path.join(storeDir, path.basename(manifest[url]))));
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
  console.log(`Images: ${urls.size} URLs, ${done} downloaded, ${failed} unavailable (will retry next sync).`);
}

module.exports = { readManifest, localizeReport, copyImages, downloadImage, imageExtension };
if (require.main === module) syncImages().catch(error => { console.error(error); process.exitCode = 1; });
