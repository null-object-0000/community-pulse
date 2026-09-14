#!/usr/bin/env node
/**
 * 官网首屏截图（R1 的截图来源）。
 *
 * 用 runner 上预装的 Chrome 无头渲染每个产品的官网首屏，产出 source-raw/screenshots/<日期>.json。
 * 与 site-logos 层分开：那层抓的是 logo 和 og:image（小图，永久镜像），这层是大图（几百 KB），
 * 按保留期镜像。
 *
 * 设计约束（都是实测得出的）：
 *   - 只跑在 GitHub Actions：本机直连境外站基本不通，runner 直连成功率高一个量级。
 *   - 不装 Playwright：runner 预装 Chrome，一行 --headless=new --screenshot 就够。
 *   - 必须装 CJK 字体：runner 镜像只带 fonts-noto-color-emoji，中文站会渲成方框。
 *   - 截图后必须验 DOM 是不是错误页：本机实测截到过 ERR_CONNECTION_CLOSED 当作成功。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { loadItems, OBSERVED_SOURCES, loadGithubRepositories, attachRepositoryFacts } = require('./source_raw_items');
const { candidatePage } = require('./site_logo');

const run = promisify(execFile);
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const SOURCE_ID = 'screenshots';
const TIMEZONE = 'Asia/Shanghai';
const DEFAULT_SOURCE_RAW_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');
const CONFIG = path.join(__dirname, '..', 'config', 'sources.json');
const CHROME = process.env.CHROME_BIN || 'google-chrome';
const VIEWPORT = { width: 1280, height: 800 };
const TIMEOUT_MS = Number(process.env.SCREENSHOT_TIMEOUT_MS || 40000);
const CONCURRENCY = Number(process.env.SCREENSHOT_CONCURRENCY || 6);
// 缩到 webp 后每张约 15KB（实测 36 张 PNG 8.7MB → webp 0.6MB），原图 1280×800 平均 235KB。
const THUMB_WIDTH = Number(process.env.SCREENSHOT_WIDTH || 640);
const THUMB_QUALITY = Number(process.env.SCREENSHOT_QUALITY || 78);

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : '';
}

function beijingDateStr(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseArgs(argv) {
  const date = value(argv, '--date');
  const yesterday = beijingDateStr(new Date(Date.now() - 86400000));
  return {
    date: date || yesterday,
    observedDate: value(argv, '--observed-date'),
    sourceRawRoot: path.resolve(value(argv, '--source-raw-root') || DEFAULT_SOURCE_RAW_ROOT),
    rawRoot: path.resolve(value(argv, '--raw-root') || path.join(VAULT, '知识', '大家都在做什么', 'raw')),
    // `sourceRawRoot` is what the source layer reads; `rawRoot` only feeds the daily-report layer.
    limit: Number(value(argv, '--limit')) || 0,
    dryRun: argv.includes('--dry-run'),
    strict: argv.includes('--strict'),
  };
}

// Chrome writes the PNG itself; the DOM check runs as a second pass so a page that *renders* an
// error (Chrome's own neterror page is a real 200-looking document) is not recorded as success.
async function captureOne(pageUrl, workDir) {
  const name = crypto.createHash('sha256').update(pageUrl).digest('hex').slice(0, 24);
  const shot = path.join(workDir, `${name}.png`);
  const dom = path.join(workDir, `${name}.html`);
  const base = ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--window-size=${VIEWPORT.width},${VIEWPORT.height}`];
  try {
    await run(CHROME, [...base, '--virtual-time-budget=7000', `--screenshot=${shot}`, pageUrl], { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    await run(CHROME, [...base, '--virtual-time-budget=5000', '--dump-dom', pageUrl], { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 })
      .then(({ stdout }) => fs.writeFileSync(dom, stdout))
      .catch(() => {});
  } catch (error) {
    return { status: 'failed', error: String(error.message || error).slice(0, 160) };
  }
  const bytes = fs.existsSync(shot) ? fs.readFileSync(shot) : null;
  if (!bytes || bytes.length < 3000) return { status: 'failed', error: `screenshot too small (${bytes ? bytes.length : 0} B)` };
  const html = fs.existsSync(dom) ? fs.readFileSync(dom, 'utf8') : '';
  if (/ERR_[A-Z_]+|无法访问此网站|This site can't be reached|neterror/i.test(html)) {
    return { status: 'failed', error: 'chrome rendered its own error page (ERR_*)' };
  }
  return {
    status: 'ok',
    screenshot: { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length },
    png: bytes,
  };
}

// The stored artefact is a downscaled webp: 36 full-size PNGs are 8.7 MB per report, the same 36
// thumbnails at 640px are 0.6 MB (6%). Chrome cannot emit webp, and the repo has no image library,
// so the scale step is delegated to whatever the runner has (`cwebp`, else ImageMagick, else the
// original PNG is kept rather than failing the row).
async function toThumb(pngBytes, workDir, name) {
  const src = path.join(workDir, `${name}.png`);
  const dst = path.join(workDir, `${name}.webp`);
  try {
    await run('cwebp', ['-q', String(THUMB_QUALITY), '-resize', String(THUMB_WIDTH), '0', src, '-o', dst], { timeout: 30000 });
    if (fs.existsSync(dst)) return { bytes: fs.readFileSync(dst), extension: 'webp', contentType: 'image/webp' };
  } catch (_) { /* fall through */ }
  try {
    await run('convert', [src, '-resize', String(THUMB_WIDTH), '-quality', String(THUMB_QUALITY), dst], { timeout: 30000 });
    if (fs.existsSync(dst)) return { bytes: fs.readFileSync(dst), extension: 'webp', contentType: 'image/webp' };
  } catch (_) { /* fall through */ }
  return { bytes: pngBytes, extension: 'png', contentType: 'image/png' };
}

function candidatesFor(date, options) {
  const sources = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).sources;
  const repositories = loadGithubRepositories(options.sourceRawRoot, date).repositories;
  const seen = new Map();
  for (const src of sources) {
    let loaded;
    try {
      loaded = loadItems(src, { rawRoot: options.sourceRawRoot, date, observedDate: options.observedDate || date, maxItems: Infinity });
    } catch (_) { continue; }
    for (const item of attachRepositoryFacts(loaded.items, repositories)) {
      const pageUrl = candidatePage(item);
      if (!pageUrl || seen.has(pageUrl)) continue;
      seen.set(pageUrl, {
        sourceId: src.id,
        externalId: String(item.externalId || ''),
        title: String(item.title || ''),
        pageUrl,
      });
    }
  }
  const list = [...seen.values()].sort((a, b) => a.pageUrl.localeCompare(b.pageUrl));
  return options.limit ? list.slice(0, options.limit) : list;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidates = candidatesFor(args.date, args);
  const outDir = path.join(args.sourceRawRoot, SOURCE_ID);
  const file = path.join(outDir, `${args.date}.json`);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const known = new Map((existing?.records || []).map((record) => [record.pageUrl, record]));
  const pending = candidates.filter((candidate) => !known.has(candidate.pageUrl));
  if (args.dryRun) {
    console.log(`[screenshots] ${args.date}: ${candidates.length} candidates (${pending.length} to capture) -> ${file}`);
    fs.mkdirSync(outDir, { recursive: true });
    console.log(JSON.stringify({ targetDate: args.date, dryRun: true, candidateCount: candidates.length, pendingCount: pending.length }, null, 2));
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-shot-'));
  const records = [...(existing?.records || [])];
  console.error(`[screenshots] ${args.date}: ${candidates.length} pages, ${known.size} kept, ${pending.length} to capture`);
  let done = 0;
  const queue = [...pending];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const candidate = queue.shift();
      const result = await captureOne(candidate.pageUrl, workDir);
      done += 1;
      if (done % 10 === 0) console.error(`[screenshots] ${done}/${pending.length}`);
      if (result.status !== 'ok') {
        records.push({ ...candidate, status: 'failed', error: result.error, screenshot: null });
        continue;
      }
      const name = crypto.createHash('sha256').update(candidate.pageUrl).digest('hex').slice(0, 24);
      const thumb = await toThumb(result.png, workDir, name);
      records.push({
        ...candidate,
        status: 'ok',
        error: '',
        screenshot: {
          ...result.screenshot,
          extension: thumb.extension,
          thumbSha256: crypto.createHash('sha256').update(thumb.bytes).digest('hex'),
          thumbByteLength: thumb.bytes.length,
          width: THUMB_WIDTH,
        },
      });
    }
  }));

  records.sort((a, b) => a.pageUrl.localeCompare(b.pageUrl));
  const document = {
    schemaVersion: 1,
    sourceId: SOURCE_ID,
    sourceName: '官网首屏截图',
    targetDate: args.date,
    timezone: TIMEZONE,
    status: records.length ? 'ok' : 'empty',
    complete: !args.limit,
    fetchedAt: new Date().toISOString(),
    itemCount: records.filter((record) => record.status === 'ok').length,
    candidateCount: records.length,
    failureCount: records.filter((record) => record.status === 'failed').length,
    capture: { mode: 'screenshot', viewport: VIEWPORT, chrome: CHROME, thumbWidth: THUMB_WIDTH, thumbQuality: THUMB_QUALITY },
    records,
  };
  // The bytes ride beside the day file, content-addressed: the same thumbnail is stored once even
  // when two rows share a page.
  const thumbnailDir = path.join(args.sourceRawRoot, `${SOURCE_ID}-files`);
  fs.mkdirSync(thumbnailDir, { recursive: true });
  for (const record of records) {
    if (record.status !== 'ok') continue;
    const name = `${record.screenshot.thumbSha256}.${record.screenshot.extension}`;
    const target = path.join(thumbnailDir, name);
    if (!fs.existsSync(target)) {
      const png = path.join(workDir, `${crypto.createHash('sha256').update(record.pageUrl).digest('hex').slice(0, 24)}.png`);
      const thumb = await toThumb(fs.readFileSync(png), workDir, crypto.createHash('sha256').update(record.pageUrl).digest('hex').slice(0, 24));
      fs.writeFileSync(target, thumb.bytes);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(document, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  console.log(`[screenshots] ${args.date}: ${document.itemCount} captured, ${document.failureCount} failed -> ${file}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  if (args.strict && document.failureCount) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => { console.error('FATAL', error.message); process.exit(1); });
}

module.exports = { parseArgs, candidatesFor, captureOne, toThumb, beijingDateStr, VIEWPORT, THUMB_WIDTH };
