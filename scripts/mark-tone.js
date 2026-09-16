const zlib = require('node:zlib');

// ─ 产品标志的明暗判定 ────────────────────────────────────────────────────────────
//
// 站内每一枚产品标志都画在白色方框里（`web/styles.css` 的 `.item-avatar` / `.swipe-mark` /
// `.project-mark`）：平台自带的标志通常带自己的底板或者本身就是深色，白框没问题；但官网图标
// 经常是一枚**透明底的浅色图形**（pacifio/atlas 的 `#FFFFEE` 就是），画在白框上等于消失。
// CSS 读不到图片自己的像素，所以这个判断只能在拿到字节的地方做一次：`npm run images:sync`
// 下载完标志后逐个判定，结果写进 `assets/images/tones.json`（提交进仓库、按内容寻址），构建时
// 由 `scripts/image-store.js` 挂到 `item.markTone` 上，渲染时加一个 `is-light` 类换成深色底板。
//
// 判定只回答一个问题：**这枚标志画在白框上还剩多少对比？** 拿不准就返回 `unknown` 保持白框
// （解不了的格式、写不清颜色的 SVG），能判的按下面的门槛判 —— 门槛偏向「换底板」这一侧，因为
// 深色底板对一枚发虚的标志只可能更清楚，而漏判就是用户看到的那个空白框。
//
//   light    白框上几乎看不出形状 → 需要深色底板
//   dark     白框上已经看得清（或者深浅都有）→ 保持白框
//   opaque   不透明的底板铺满画布 → 换白框没有意义，图片会盖住它
//   unknown  判不了：格式解不了（WebP/AVIF/GIF）、颜色写成了 currentColor 或渐变引用，
//            或者整张图全透明
//
// 判据不是「平均亮度」，而是**白框上到底有多少像素看得清**：把每个像素按透明度合成到白底上，
// 再问它和白底的对比够不够（相对亮度 ≤ VISIBLE_LUMINANCE 相当于对比 ≥ 2:1）。看得清的部分
// 不到 VISIBLE_SHARE 就算浅色标志。平均亮度会把「浅灰图形 + 一小块深色」判成浅色，而这枚标志
// 在白框上其实是看得见的；反过来 2:1 这个门槛对「整体浅灰、但形状很大」的标志正好落在该换
// 底板的一侧——深色底板只会让它更清楚，不会更差。
const VISIBLE_LUMINANCE = 0.46;
const VISIBLE_SHARE = 0.02;
const OPAQUE_COVERAGE = 0.9;

// WebP 没有不引依赖就能用的解码器（VP8/VP8L 的熵编码不是 deflate），这几枚已知的浅色标志只能
// 手工兜底。键是镜像文件名里的内容哈希，值是什么；`images:sync` 把它们并进 tones.json，仍然按
// 「manifest 里还有这个文件」裁剪，所以标志被替换或下线之后条目会自己消失。
//
// 这份名单是拿 Pillow 按**同一个判据**独立复算出来的（Node 解不了 WebP，Pillow 能），不是眼看：
// 全量 232 枚 WebP 里只有这两枚在把像素合成到白底后「看得清的部分」不到 2%。反面教材是这条路径
// 上的第一版名单——它来自已经废弃的「平均亮度 + 没有深色像素」判据，结果把「浅灰图形 + 一个深色
// 字母」的三枚（文件夹 U、彩色点阵、蓝色云朵描边）也收了进来，而它们在白框上本来就看得清。
const MANUAL_LIGHT_MARKS = new Map([
  ['769cdb89c07a75c23353e7f95ac013abd180230437179edc5065b33447cfb76d.webp', 'VibeCafé 黄绿色螺旋，白底上几乎只是浅黄'],
  ['88c13f182cf13805c9a67ffa477ad0046e0b726d4cd3022a51ec968fe3aa9747.webp', 'VibeCafé 浅绿色电池，白底上只剩一道深色描边'],
]);

const MIRROR_PATH = /^\/images\/[a-f0-9]{64}\.(png|jpg|gif|webp|avif|ico|svg)$/;
// 镜像地址（仓库内 `/images/<sha>` 或 CDN 上的同一路径）→ 查色调清单用的规范键。
function markImagePath(value) {
  if (typeof value !== 'string') return '';
  if (MIRROR_PATH.test(value)) return value;
  try {
    const url = new URL(value);
    // A query or hash makes it a different resource — same rule as `D.managedImage`.
    return !url.search && !url.hash && MIRROR_PATH.test(url.pathname) ? url.pathname : '';
  } catch { return ''; }
}

// WCAG 相对亮度：一枚标志能不能在白底上看出来，直接由它决定。
function relativeLuminance(r, g, b) {
  const channel = value => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// ─ 判定 ──────────────────────────────────────────────────────────────────────
// 逐像素累计，不存整张图：判定只需要「画了多少」和「看得清多少」这两个比例。
const createStats = () => ({ total: 0, alphaSum: 0, weightSum: 0, visibleWeight: 0, luminanceSum: 0 });
function addSample(stats, r, g, b, alpha) {
  stats.total += 1;
  if (alpha <= 0) return;
  // 半透明像素在页面上的实际颜色，是它和白框混合之后的结果——抗锯齿的边缘因此不会被当成
  // 深色像素（否则一枚浅色标志会因为几个边缘像素被误判成深色）。
  const overWhite = value => value * alpha + 255 * (1 - alpha);
  const luminance = relativeLuminance(overWhite(r), overWhite(g), overWhite(b));
  stats.alphaSum += alpha;
  stats.weightSum += alpha;
  stats.luminanceSum += alpha * luminance;
  if (luminance <= VISIBLE_LUMINANCE) stats.visibleWeight += alpha;
}
function decide(stats) {
  const coverage = stats.total ? stats.alphaSum / stats.total : 0;
  const luminance = stats.weightSum ? stats.luminanceSum / stats.weightSum : 0;
  const visibleShare = stats.weightSum ? stats.visibleWeight / stats.weightSum : 0;
  if (coverage < 0.02) return { tone: 'unknown', coverage, luminance, visibleShare };
  if (coverage >= OPAQUE_COVERAGE) return { tone: 'opaque', coverage, luminance, visibleShare };
  return { tone: visibleShare < VISIBLE_SHARE ? 'light' : 'dark', coverage, luminance, visibleShare };
}
const UNKNOWN = { tone: 'unknown', coverage: 0, luminance: 0, visibleShare: 0 };

// ── 颜色 ──────────────────────────────────────────────────────────────────────
// 只认标志里真正会出现的写法：十六进制、rgb()/rgba()、少量具名色。其余（渐变引用、
// currentColor、hsl()）返回 `undefined` 表示「解不出来」，由调用方退回 unknown。
const NAMED_COLORS = {
  transparent: [0, 0, 0, 0],
  white: [255, 255, 255, 1], black: [0, 0, 0, 1],
  ivory: [255, 255, 240, 1], snow: [255, 250, 250, 1], whitesmoke: [245, 245, 245, 1],
  ghostwhite: [248, 248, 255, 1], floralwhite: [255, 250, 240, 1], seashell: [255, 245, 238, 1],
};
function parseColor(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === 'none') return null;
  if (Object.hasOwn(NAMED_COLORS, text)) {
    const [r, g, b, a] = NAMED_COLORS[text];
    return { r, g, b, a };
  }
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const digits = hex[1];
    const expand = part => parseInt(part.length === 1 ? part + part : part, 16);
    if ([3, 4].includes(digits.length)) {
      return { r: expand(digits[0]), g: expand(digits[1]), b: expand(digits[2]), a: digits.length === 4 ? expand(digits[3]) / 255 : 1 };
    }
    if ([6, 8].includes(digits.length)) {
      return {
        r: expand(digits.slice(0, 2)), g: expand(digits.slice(2, 4)), b: expand(digits.slice(4, 6)),
        a: digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1,
      };
    }
    return undefined;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(part => (
      part.endsWith('%') ? Math.round(Number.parseFloat(part) * 2.55) : Number.parseFloat(part)
    ));
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return undefined;
    const alpha = parts.length > 3 && !Number.isNaN(parts[3]) ? Math.max(0, Math.min(1, parts[3])) : 1;
    return { r: parts[0], g: parts[1], b: parts[2], a: alpha };
  }
  return undefined;
}

// ─ SVG ───────────────────────────────────────────────────────────────────────
// 不渲染，只读颜色：每种 paint 的亮度都按「合成到白底」换算，没有任何一种在白框上看得清才算
// 浅色。SVG 里每种 paint 通常都覆盖一块真实面积，所以「有一种深色 paint」就等于「白框上看得
// 见」，不需要再按面积加权。
function classifySvg(source) {
  const text = String(source).replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  // 铺满画布的不透明底板（`<rect width="100%" height="100%">` 或盖住 viewBox 的矩形）= 图片
  // 自带背景，换白框没有意义：底板会整块盖住新框。
  if (hasFullCanvasPlate(text)) return { tone: 'opaque', coverage: 1, luminance: 0, visibleShare: 0 };
  const paints = collectSvgPaints(text);
  if (!paints.length) return UNKNOWN;
  // `undefined` = 颜色解不出来（渐变 / currentColor / hsl）。
  if (paints.some(paint => paint === undefined)) return UNKNOWN;
  const colors = paints.filter(Boolean).filter(color => color.a >= 0.5);
  if (!colors.length) return UNKNOWN;
  const luminances = colors.map(color => relativeLuminance(color.r, color.g, color.b));
  const luminance = luminances.reduce((sum, value) => sum + value, 0) / luminances.length;
  const visibleShare = luminances.filter(value => value <= VISIBLE_LUMINANCE).length / luminances.length;
  return { tone: visibleShare < VISIBLE_SHARE ? 'light' : 'dark', coverage: 1, luminance, visibleShare };
}

function hasFullCanvasPlate(text) {
  const viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(text);
  const [, , boxWidth, boxHeight] = viewBox ? viewBox[1].split(/[\s,]+/).map(Number) : [];
  for (const tag of text.match(/<rect\b[^>]*>/gi) || []) {
    const read = name => {
      const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag);
      if (!match) return null;
      if (match[1].trim().endsWith('%')) return Number.parseFloat(match[1]) >= 99 ? 'full' : null;
      const value = Number.parseFloat(match[1]);
      return Number.isNaN(value) ? null : value;
    };
    const width = read('width'), height = read('height');
    if (width === 'full' && height === 'full') return true;
    if (typeof width !== 'number' || typeof height !== 'number') continue;
    // `<rect>` 没有 viewBox 可比时，按它自己的坐标系判断它是不是整张画布。
    const x = read('x'), y = read('y');
    if (x === 'full' || y === 'full') continue;
    const originX = typeof x === 'number' ? x : 0, originY = typeof y === 'number' ? y : 0;
    const totalWidth = Number.isFinite(boxWidth) ? boxWidth : width + originX;
    const totalHeight = Number.isFinite(boxHeight) ? boxHeight : height + originY;
    if (originX <= totalWidth * 0.02 && originY <= totalHeight * 0.02
      && width >= totalWidth * 0.98 && height >= totalHeight * 0.98) return true;
  }
  return false;
}

// 逐个图形收集 paint：`fill` / `stroke` / `stop-color` 的属性写法、`style=""` 内联写法，以及
// `<style>` 里按类名写的声明都算。`fill="none"`（只是「不填」）不构成颜色。`<style>` 里的声明
// 单独扫，所以先把它从属性扫描的文本里摘掉，避免同一条声明被读两遍。
function collectSvgPaints(text) {
  const paints = [];
  const push = value => { if (value !== null) paints.push(value); };
  const ignore = value => /^(none|inherit|unset|initial)$/i.test(String(value).trim());
  const blocks = text.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
  const attribute = /(?:fill|stroke|stop-color)\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s;"'{}>),]+))/gi;
  for (const match of text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').match(attribute) || []) {
    const value = /[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s;"'{}>),]+))/.exec(match).slice(1).find(part => part !== undefined);
    if (!ignore(value)) push(parseColor(value));
  }
  for (const block of blocks) {
    const body = block.replace(/^<style[^>]*>/i, '').replace(/<\/style>$/i, '');
    for (const declaration of body.match(/(?:fill|stroke|stop-color)\s*:[^;}]+/gi) || []) {
      const value = declaration.split(':').slice(1).join(':').trim();
      if (!ignore(value)) push(parseColor(value));
    }
  }
  return paints;
}

// ─ PNG ───────────────────────────────────────────────────────────────────────
// 自己解：仓库不引图片依赖，而判定只需要每个像素的颜色和透明度。只支持非隔行的 8 位
// 真彩/灰度/含 alpha，以及 1/2/4/8 位的灰度与调色板图（图标的事实标准），其余退回 unknown。
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function classifyPng(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return UNKNOWN;
  let offset = 8, header = null, palette = null, transparency = null;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] };
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!header || !idat.length || header.interlace !== 0) return UNKNOWN;
  const { width, height, depth, colorType } = header;
  const channels = PNG_CHANNELS[colorType];
  const supported = (colorType === 0 || colorType === 3) ? [1, 2, 4, 8].includes(depth) : [2, 4, 6].includes(colorType) && depth === 8;
  if (!channels || !supported || !width || !height) return UNKNOWN;
  if (colorType === 3 && !palette) return UNKNOWN;
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.floor(bitsPerPixel / 8));
  const previous = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  const stats = createStats();
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // 大图按行抽样，判定不看每个像素；行内逐像素读，因为分布本身就是标志本身。
  const rowStep = Math.max(1, Math.ceil((width * height) / 200000));
  for (let y = 0, cursor = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    if (cursor + stride > raw.length) return UNKNOWN;
    raw.copy(line, 0, cursor, cursor + stride);
    cursor += stride;
    unfilter(line, previous, filter, bpp);
    if (y % rowStep === 0) readPngRow(line, stats, { width, depth, colorType, channels, palette, transparency });
    line.copy(previous);
  }
  return decide(stats);
}

// PNG 的行过滤器：5 种类型都是「对左/上/左上做差」，逐字节还原。
function unfilter(line, previous, filter, bpp) {
  for (let index = 0; index < line.length; index += 1) {
    const left = index >= bpp ? line[index - bpp] : 0;
    const up = previous[index];
    const upLeft = index >= bpp ? previous[index - bpp] : 0;
    if (filter === 1) line[index] = (line[index] + left) & 0xff;
    else if (filter === 2) line[index] = (line[index] + up) & 0xff;
    else if (filter === 3) line[index] = (line[index] + ((left + up) >> 1)) & 0xff;
    else if (filter === 4) {
      const p = left + up - upLeft;
      const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
      line[index] = (line[index] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff;
    }
  }
}

// 位深小于 8 的灰度/调色板图一个字节里塞多个像素，按 MSB 优先取第 index 个样本。
function sampleAt(line, index, depth) {
  if (depth === 8) return line[index];
  const at = Math.floor((index * depth) / 8);
  return (line[at] >> (8 - depth - ((index * depth) % 8))) & ((1 << depth) - 1);
}

function readPngRow(line, stats, { width, depth, colorType, channels, palette, transparency }) {
  for (let x = 0; x < width; x += 1) {
    if (colorType === 3) {
      const index = sampleAt(line, x, depth);
      const at = index * 3;
      if (at + 2 >= palette.length) { addSample(stats, 0, 0, 0, 0); continue; }
      const alpha = transparency && index < transparency.length ? transparency[index] / 255 : 1;
      addSample(stats, palette[at], palette[at + 1], palette[at + 2], alpha);
    } else if (colorType === 0 || colorType === 4) {
      const value = depth === 8 ? line[x] : Math.round((sampleAt(line, x, depth) / ((1 << depth) - 1)) * 255);
      addSample(stats, value, value, value, colorType === 4 ? line[width + x] / 255 : 1);
    } else {
      const at = x * channels;
      addSample(stats, line[at], line[at + 1], line[at + 2], colorType === 6 ? line[at + 3] / 255 : 1);
    }
  }
}

// ── ICO ───────────────────────────────────────────────────────────────────────
// 目录项里挑最大的那张：内嵌 PNG 直接交给 PNG 解码；老式 DIB（BI_RGB 的 32/24 位）自己读。
// 32 位图 alpha 通道全零是历史写法，这时按 AND 掩码算透明。
function classifyIco(bytes) {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return UNKNOWN;
  const count = bytes.readUInt16LE(4);
  let best = null;
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    if (at + 16 > bytes.length) break;
    const width = bytes[at] || 256, height = bytes[at + 1] || 256;
    const size = bytes.readUInt32LE(at + 8), offset = bytes.readUInt32LE(at + 12);
    if (offset + size > bytes.length) continue;
    if (!best || width * height > best.width * best.height) best = { width, height, size, offset };
  }
  if (!best) return UNKNOWN;
  const image = bytes.subarray(best.offset, best.offset + best.size);
  if (image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return classifyPng(image);
  return classifyDib(image, best.width, best.height);
}

function classifyDib(image, width, height) {
  if (image.length < 40) return UNKNOWN;
  const headerSize = image.readUInt32LE(0);
  const bitCount = image.readUInt16LE(14);
  const compression = image.readUInt32LE(16);
  if (compression !== 0 || ![24, 32].includes(bitCount)) return UNKNOWN;
  const pixelBytes = bitCount / 8;
  const stride = Math.ceil((width * pixelBytes) / 4) * 4;
  const pixelsAt = headerSize;
  if (pixelsAt + stride * height > image.length) return UNKNOWN;
  const maskAt = pixelsAt + stride * height;
  const maskStride = Math.ceil(width / 32) * 4;
  const masked = (x, y) => {
    const at = maskAt + (height - 1 - y) * maskStride + (x >> 3);
    return at < image.length && ((image[at] >> (7 - (x % 8))) & 1) === 1;
  };
  // 先按真彩 + alpha 读一遍；32 位图若一个非零 alpha 都没有，就整张改用 AND 掩码。
  const stats = createStats();
  let anyAlpha = false;
  for (let y = 0; y < height; y += 1) {
    const row = pixelsAt + (height - 1 - y) * stride;
    for (let x = 0; x < width; x += 1) {
      const at = row + x * pixelBytes;
      const alpha = bitCount === 32 ? image[at + 3] / 255 : 1;
      if (alpha > 0) anyAlpha = true;
      addSample(stats, image[at + 2], image[at + 1], image[at], alpha);
    }
  }
  if (bitCount === 32 && !anyAlpha) {
    const maskStats = createStats();
    for (let y = 0; y < height; y += 1) {
      const row = pixelsAt + (height - 1 - y) * stride;
      for (let x = 0; x < width; x += 1) {
        const at = row + x * pixelBytes;
        addSample(maskStats, image[at + 2], image[at + 1], image[at], masked(x, y) ? 0 : 1);
      }
    }
    return decide(maskStats);
  }
  return decide(stats);
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
// 判定失败绝不能让同步中断：解不了的图（截断的 PNG、没见过的编码）一律当 unknown，保持白框。
function classifyImage(bytes, extension) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const ext = String(extension || '').toLowerCase();
  try {
    if (ext === 'png') return classifyPng(bytes);
    if (ext === 'ico') return classifyIco(bytes);
    if (ext === 'svg') return classifySvg(bytes.toString('utf8'));
  } catch (error) {
    return { ...UNKNOWN, error: String(error?.message || error) };
  }
  return UNKNOWN;
}

function extensionOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return match ? match[1].toLowerCase() : '';
}

// 命令行入口：`node scripts/mark-tone.js <文件…>` 打印每枚标志的判定，用来核对或手工排查。
if (require.main === module) {
  const fs = require('node:fs');
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node scripts/mark-tone.js <image file> [...]');
    process.exitCode = 1;
  }
  for (const file of files) {
    try {
      const result = classifyImage(fs.readFileSync(file), extensionOf(file));
      const note = result.error ? ` error=${result.error}` : '';
      console.log(`${result.tone.padEnd(8)} coverage=${result.coverage.toFixed(2)} luminance=${result.luminance.toFixed(2)} visible=${result.visibleShare.toFixed(3)}${note}  ${file}`);
    } catch (error) {
      console.log(`error    ${file}: ${error.message}`);
    }
  }
}

module.exports = {
  VISIBLE_LUMINANCE, VISIBLE_SHARE, OPAQUE_COVERAGE, MANUAL_LIGHT_MARKS,
  classifyImage, classifySvg, classifyPng, classifyIco, markImagePath, extensionOf, relativeLuminance,
};