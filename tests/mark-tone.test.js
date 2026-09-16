const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const D = require('../web/shared.js');
const T = require('../scripts/mark-tone.js');
const { readManifest, readTones, collectLightMarks, localizeReport } = require('../scripts/image-store.js');
const { buildProjects, projectPage } = require('../scripts/projects.js');

const storeDir = path.resolve(__dirname, '..', 'assets', 'images');
const mirror = (char, extension = 'png') => `/images/${char.repeat(64)}.${extension}`;
const lightMirror = mirror('a');
const darkMirror = mirror('b');

// ── 合成图片 ─────────────────────────────────────────────────────────────────
// 判定逻辑完全在像素上，用真图当夹具就要往仓库里塞二进制；这里按需造最小合法图。
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function pngFrom(rows, width, { depth, colorType, palette, transparency }) {
  const height = rows.length;
  const raw = Buffer.concat(rows.map(row => Buffer.concat([Buffer.from([0]), row])));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colorType;
  const parts = [Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header)];
  if (palette) parts.push(chunk('PLTE', palette));
  if (transparency) parts.push(chunk('tRNS', transparency));
  parts.push(chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
// RGBA 图标：color(x, y) → [r, g, b, a]。
function rgbaPng(size, color) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(size * 4);
    for (let x = 0; x < size; x += 1) row.set(color(x, y), x * 4);
    rows.push(row);
  }
  return pngFrom(rows, size, { depth: 8, colorType: 6 });
}
// 调色板图标（每个像素一个字节），第 0 号颜色按 tRNS 透明。
function palettePng(size, indexAt) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(size);
    for (let x = 0; x < size; x += 1) row[x] = indexAt(x, y);
    rows.push(row);
  }
  const palette = Buffer.from([0, 0, 0, 255, 255, 238]);
  return pngFrom(rows, size, { depth: 8, colorType: 3, palette, transparency: Buffer.from([0, 255]) });
}
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const directory = entries.map(entry => {
    const item = Buffer.alloc(16);
    item[0] = entry.width === 256 ? 0 : entry.width;
    item[1] = entry.height === 256 ? 0 : entry.height;
    item.writeUInt32LE(entry.bytes.length, 8);
    item.writeUInt32LE(offset, 12);
    offset += entry.bytes.length;
    return item;
  });
  return Buffer.concat([header, ...directory, ...entries.map(entry => entry.bytes)]);
}
// 32 位 BI_RGB 的 DIB（老式 .ico 内容），行自下而上、BGRA，后面跟 1 位 AND 掩码（1 = 透明）。
// 传了 mask 时 alpha 通道写 0，逼真地复现「alpha 全零、只能靠掩码」的历史图标。
function dibIcon(size, color, mask) {
  const stride = size * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const [r, g, b, a] = color(x, y);
    pixels.set([b, g, r, mask ? 0 : a], (size - 1 - y) * stride + x * 4);
  }
  const maskStride = Math.ceil(size / 32) * 4;
  const alpha = Buffer.alloc(maskStride * size);
  if (mask) for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    if (mask(x, y)) alpha[(size - 1 - y) * maskStride + (x >> 3)] |= 1 << (7 - (x % 8));
  }
  return Buffer.concat([header, pixels, alpha]);
}

// ── SVG ──────────────────────────────────────────────────────────────────────
test('an SVG whose only paint is a pale colour counts as a light mark', () => {
  // pacifio/atlas 的形状：透明底、单一 #FFFFEE 的 path，另外一条 fill="none" 的描边。
  const atlas = '<svg viewBox="0 0 24 24" fill="none"><path fill="#FFFFEE" d="M0 0h4v4H0z"/><path fill="none" d="M0 0"/></svg>';
  assert.equal(T.classifySvg(atlas).tone, 'light');
  assert.equal(T.classifySvg('<svg><path fill="rgb(255, 255, 238)" d="M0 0"/></svg>').tone, 'light');
  assert.equal(T.classifySvg('<svg><path style="fill:#fff" d="M0 0"/></svg>').tone, 'light');
  assert.equal(T.classifySvg('<svg><style>.a{fill:#FFFFEE}</style><path class="a" d="M0 0"/></svg>').tone, 'light');
  assert.equal(T.classifySvg('<svg><path fill="white" stroke="#f6f6f6" d="M0 0"/></svg>').tone, 'light');
});

test('an SVG with a paint dark enough to read on white keeps the white plate', () => {
  assert.equal(T.classifySvg('<svg><path fill="#101a30" d="M0 0"/></svg>').tone, 'dark');
  // 浅色主图形 + 深色点缀：白框上本来就看得见，不该换底板。
  assert.equal(T.classifySvg('<svg><path fill="#FFFFEE" d="M0 0"/><path fill="#1d4ed8" d="M2 2"/></svg>').tone, 'dark');
});

test('an SVG is left alone when its colours cannot be resolved or it carries its own plate', () => {
  assert.equal(T.classifySvg('<svg><path fill="currentColor" d="M0 0"/></svg>').tone, 'unknown');
  assert.equal(T.classifySvg('<svg><path fill="url(#g)" d="M0 0"/><linearGradient id="g"><stop stop-color="#fff"/></linearGradient></svg>').tone, 'unknown');
  assert.equal(T.classifySvg('<svg><path fill="none" d="M0 0"/></svg>').tone, 'unknown');
  // 自带整块底板的图标：换白框没有意义，底板会盖住新框。
  assert.equal(T.classifySvg('<svg viewBox="0 0 24 24"><rect width="100%" height="100%" fill="#0b0b0b"/><path fill="#fff" d="M0 0"/></svg>').tone, 'opaque');
  assert.equal(T.classifySvg('<svg viewBox="0 0 24 24"><rect x="0" y="0" width="24" height="24" fill="#101a30"/><path fill="#fff" d="M0 0"/></svg>').tone, 'opaque');
});

// ── PNG ──────────────────────────────────────────────────────────────────────
test('a transparent PNG is judged on the pixels that actually show on white', () => {
  const pale = rgbaPng(8, (x, y) => (x < 4 && y < 4 ? [255, 255, 238, 255] : [0, 0, 0, 0]));
  assert.equal(T.classifyPng(pale).tone, 'light');
  const dark = rgbaPng(8, (x, y) => (x < 4 && y < 4 ? [16, 26, 48, 255] : [0, 0, 0, 0]));
  assert.equal(T.classifyPng(dark).tone, 'dark');
  // 整块不透明的深色底板：换白框没有意义，图片会盖住它。
  assert.equal(T.classifyPng(rgbaPng(8, () => [16, 26, 48, 255])).tone, 'opaque');
  assert.equal(T.classifyPng(rgbaPng(4, () => [0, 0, 0, 0])).tone, 'unknown');
  // 抗锯齿边缘是半透明的：深色但几乎全透明的像素合成到白底上仍是白的，不该算作「看得清」
  // （按原始 RGB 判断的实现会在这里判成深色）。
  const ghost = rgbaPng(8, (x, y) => (x < 4 && y < 4 ? [16, 26, 48, 40] : [0, 0, 0, 0]));
  assert.equal(T.classifyPng(ghost).tone, 'light');
  const soft = rgbaPng(8, (x, y) => (x < 4 && y < 4 ? [255, 255, 238, x === 0 ? 128 : 255] : [0, 0, 0, 0]));
  assert.equal(T.classifyPng(soft).tone, 'light');
});

test('palette PNGs honour their tRNS transparency', () => {
  const icon = palettePng(8, (x, y) => (x < 4 && y < 4 ? 1 : 0));
  const result = T.classifyPng(icon);
  assert.equal(result.tone, 'light');
  assert.ok(result.coverage > 0.1 && result.coverage < 0.4);
  assert.equal(T.classifyPng(palettePng(8, () => 1)).tone, 'opaque');
});

test('a mark that cannot be decoded degrades to unknown instead of throwing', () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(4, 4);
  header[8] = 8;
  header[9] = 6;
  const broken = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', Buffer.from('not-deflate')), chunk('IEND', Buffer.alloc(0)),
  ]);
  const result = T.classifyImage(broken, 'png');
  assert.equal(result.tone, 'unknown');
  assert.ok(result.error);
  assert.equal(T.classifyImage(Buffer.from('RIFF____WEBPVP8 '), 'webp').tone, 'unknown');
});

// ── ICO ───────────────────────────────────────────────────────────────────────
test('ICO entries are read whether they embed a PNG or an old DIB', () => {
  const png = rgbaPng(8, (x, y) => (x < 4 && y < 4 ? [255, 255, 238, 255] : [0, 0, 0, 0]));
  assert.equal(T.classifyIco(ico([{ width: 8, height: 8, bytes: png }])).tone, 'light');
  const pale = dibIcon(8, (x, y) => (x < 4 && y < 4 ? [255, 255, 238, 255] : [0, 0, 0, 0]));
  assert.equal(T.classifyIco(ico([{ width: 8, height: 8, bytes: pale }])).tone, 'light');
  const dark = dibIcon(8, () => [16, 26, 48, 255]);
  assert.equal(T.classifyIco(ico([{ width: 8, height: 8, bytes: dark }])).tone, 'opaque');
  // 目录项里有多张时取最大的那张。
  const small = dibIcon(4, () => [255, 255, 238, 255]);
  assert.equal(T.classifyIco(ico([{ width: 4, height: 4, bytes: small }, { width: 8, height: 8, bytes: pale }])).tone, 'light');
  // 32 位 DIB 的 alpha 通道全零（老图标的写法）时按 AND 掩码算透明：只有左上 2×2 不透明。
  const masked = dibIcon(8, () => [255, 255, 238, 255], (x, y) => !(x < 2 && y < 2));
  const result = T.classifyIco(ico([{ width: 8, height: 8, bytes: masked }]));
  assert.equal(result.tone, 'light');
  assert.ok(result.coverage > 0.04 && result.coverage < 0.1, `coverage ${result.coverage}`);
});

test('mirror paths are recognised in both the bundled and the CDN form', () => {
  assert.equal(T.markImagePath(lightMirror), lightMirror);
  assert.equal(T.markImagePath(`https://img.devtrends.site${lightMirror}`), lightMirror);
  assert.equal(T.markImagePath(`https://img.devtrends.site${lightMirror}?v=2`), '');
  assert.equal(T.markImagePath('https://example.org/logo.png'), '');
  assert.equal(T.markImagePath(''), '');
});

// ── 渲染与构建接线 ────────────────────────────────────────────────────────────
test('a light mark switches the row tile to the dark plate', () => {
  const item = { title: 'Atlas', siteLogo: lightMirror, markTone: 'light' };
  assert.match(D.renderItem(item, 'en'), /class="item-avatar avatar-0 has-logo is-light"/);
  assert.match(D.renderSwipeItem(item, 'en'), /class="swipe-mark avatar-0 has-logo is-light"/);
  // 没有色调标记的行照旧是白框，首字母兜底的行也不带底板类。
  assert.match(D.renderItem({ title: 'Atlas', siteLogo: lightMirror }, 'en'), /class="item-avatar avatar-0 has-logo"/);
  assert.doesNotMatch(D.renderItem({ title: 'No mark' }, 'en'), /is-light/);
  assert.equal(D.markClass({}), '');
});

test('the detail page hero uses the same plate class', () => {
  const item = { title: 'Atlas', githubUrl: 'https://github.com/pacifio/atlas', siteLogo: lightMirror, markTone: 'light', summary: 'Source control for agents' };
  const project = buildProjects([{ date: '2026-09-15', results: [{ sourceId: 'github-trending', sourceName: 'GitHub Trending', items: [item] }] }])[0];
  assert.match(projectPage(project, 'en'), /class="project-mark has-logo is-light"/);
});

test('localizeReport attaches the tone of the mark the row will actually show', () => {
  const remote = 'https://site.test/icon.png';
  const build = lightMarks => {
    const report = { results: [{ items: [{ siteLogo: remote }] }] };
    localizeReport(report, { [remote]: lightMirror }, lightMarks);
    return report.results[0].items[0];
  };
  assert.equal(build(new Set([lightMirror])).markTone, 'light');
  assert.equal(build(new Set([darkMirror])).markTone, undefined);
  // 取值链与渲染一致：logo 优先于 siteLogo。
  const both = { results: [{ items: [{ logo: mirror('c'), siteLogo: remote }] }] };
  localizeReport(both, { [remote]: lightMirror }, new Set([lightMirror]));
  assert.equal(both.results[0].items[0].markTone, undefined);
  // 手工标记过的行重新构建时不会留下上一轮的结论。
  const stale = { results: [{ items: [{ title: 'X', markTone: 'light' }] }] };
  localizeReport(stale, {}, new Set());
  assert.equal(stale.results[0].items[0].markTone, undefined);
});

// ── 提交进仓库的清单 ──────────────────────────────────────────────────────────
const verifier = (name, local) => {
  const file = path.join(storeDir, path.basename(local));
  if (!fs.existsSync(file)) return null;
  const result = T.classifyImage(fs.readFileSync(file), T.extensionOf(name));
  return result.tone === 'light' || (result.tone === 'unknown' && T.MANUAL_LIGHT_MARKS.has(name));
};

test('the committed light-mark list matches a fresh classification of the mirror store', () => {
  const manifest = readManifest();
  const tones = readTones();
  const mirrors = [...new Set(Object.values(manifest).filter(local => typeof local === 'string'))];
  for (const entry of tones.light) {
    assert.ok(mirrors.includes(entry), `${entry} is not in the manifest`);
    assert.equal(T.markImagePath(entry), entry, `${entry} is not a content-addressed mirror path`);
  }
  // 清单里的每条都核对；其余按固定步长抽查 —— 整个套件没必要去解 2000 张图。镜像文件不进 Git，
  // CI 的干净 checkout 里没有字节，只能核对「条目仍指向 manifest」。
  let checked = 0;
  mirrors.forEach((local, index) => {
    const claimed = tones.light.has(local);
    if (!claimed && index % 7 !== 0) return;
    const verdict = verifier(path.basename(local), local);
    if (verdict === null) return;
    checked += 1;
    assert.equal(claimed, verdict, `${path.basename(local)} classified light=${verdict}`);
  });
  assert.ok(checked > 3, 'the mirror store should be readable for at least the claimed marks');
});

test('a mark whose bytes are not in the checkout keeps the committed verdict', () => {
  const missing = mirror('d');
  assert.deepEqual([...collectLightMarks({ 'https://site.test/icon.png': missing }, new Set([missing]))], [missing]);
  // 标志被替换或下线后，条目不再留在清单里。
  assert.equal(collectLightMarks({}, new Set([missing])).size, 0);
});