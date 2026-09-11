/**
 * Pure, offline logic for the website-logo fallback layer.
 *
 * A row that carries no product mark (VibeCafé `logo`, Product Hunt `thumbnail`) borrows the
 * logo its official website declares. `capture_site_logos_raw.js` performs the requests and
 * stores the evidence; this module only decides
 *
 *   - which page a row should look at (`candidatePage`), and
 *   - which declared icon is that site's mark (`parseIconCandidates` / `pickIcon`).
 *
 * It performs no I/O, so the capture script, the offline backfill and the site tests all share
 * exactly one definition of "the website's logo".
 */

// Hosts whose icon describes the platform the row merely lives on rather than the product itself.
// Aggregating a GitHub repository row would stamp github.com's mark on every entry, an app-store
// row would all render Apple's or Google's mark, and a WeChat article would render WeChat's — in
// each case the initials of the project's own name say more than a repeated platform logo, so these
// pages are not treated as an official website at all.
const PLATFORM_HOSTS = [
  // Our own sources and the code hosts / badge services they link.
  'github.com',
  'gist.github.com',
  'githubusercontent.com',
  'githubassets.com',
  'gitlab.com',
  'bitbucket.org',
  'gitee.com',
  'codeberg.org',
  'sourceforge.net',
  'shields.io',
  'badgen.net',
  'badge.fury.io',
  'producthunt.com',
  'vibecafe.ai',
  'news.ycombinator.com',
  'v2ex.com',
  'ruanyifeng.com',
  'hellogithub.com',
  // App stores and download portals.
  'apps.apple.com',
  'itunes.apple.com',
  'testflight.apple.com',
  'play.google.com',
  'apps.microsoft.com',
  'microsoftedge.microsoft.com',
  'chromewebstore.google.com',
  'chrome.google.com',
  'addons.mozilla.org',
  'store.steampowered.com',
  'steamcommunity.com',
  'itch.io',
  'f-droid.org',
  'appgallery.huawei.com',
  // Article, video and social platforms, plus search engines.
  'mp.weixin.qq.com',
  'weixin.qq.com',
  'zhihu.com',
  'weibo.com',
  'xiaohongshu.com',
  'bilibili.com',
  'douyin.com',
  'juejin.cn',
  'jianshu.com',
  'csdn.net',
  'sspai.com',
  'youtube.com',
  'youtu.be',
  'x.com',
  'twitter.com',
  'medium.com',
  'substack.com',
  'reddit.com',
  'notion.so',
  'notion.site',
  'yuque.com',
  't.me',
  'discord.gg',
  'google.com',
  'bing.com',
  'baidu.com',
];

// A link to a file is not a website: README badges and raw screenshots are common submitted URLs.
const FILE_PATH = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|pdf|zip|tar|gz|dmg|exe|apk)$/i;

// Only utm-style tracking is stripped: the rest of the query may be load-bearing on a small site.
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$)/i;

const LINK_TAG = /<link\b[^>]*>/gi;
const BASE_TAG = /<base\b[^>]*>/i;
const LD_JSON_BLOCK = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const BRAND_TYPES = /^(organization|website|webpage|brand|corporation|localbusiness|softwareapplication|product)$/i;

function normalizePageUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  let url;
  try { url = new URL(trimmed); } catch (_) { return ''; }
  if (!/^https?:$/.test(url.protocol)) return '';
  const host = url.hostname.toLowerCase();
  if (PLATFORM_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) return '';
  if (FILE_PATH.test(url.pathname)) return '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  return url.href;
}

function resolveUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let url;
  try { url = new URL(value.trim(), base); } catch (_) { return ''; }
  // A data:/blob:/javascript: icon can never be mirrored, so it is not a candidate at all.
  return /^https?:$/.test(url.protocol) ? url.href : '';
}

// The row's official website, in the order the site itself links it: the item's own website
// field, then the repository homepage, then the row's primary URL. Platform pages are skipped so
// a later candidate can still win (a submission that links GitHub but declares a homepage).
function candidatePage(item) {
  for (const value of [item?.websiteUrl, item?.github?.homepage, item?.url]) {
    const page = normalizePageUrl(value);
    if (page) return page;
  }
  return '';
}

function readAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(ATTRIBUTE)) attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  return attributes;
}

function relTokens(rel) {
  return String(rel || '').toLowerCase().split(/\s+/).filter(Boolean);
}

function linkKind(tokens) {
  if (tokens.includes('apple-touch-icon') || tokens.includes('apple-touch-icon-precomposed')) return 'apple-touch-icon';
  if (tokens.includes('mask-icon')) return 'mask-icon';
  if (tokens.includes('icon')) return 'icon';
  return '';
}

// "180x180 32x32" -> 180. "any" (SVG) beats every raster size because it scales cleanly.
function iconSize(sizes) {
  let best = 0;
  for (const token of String(sizes || '').toLowerCase().split(/[\s,]+/)) {
    if (!token) continue;
    if (token === 'any') return 1024;
    const match = token.match(/^(\d+)x(\d+)$/);
    if (match) best = Math.max(best, Math.min(Number(match[1]), Number(match[2])));
  }
  return best;
}

// Lower is better. A square brand tile (apple-touch-icon) reads best at 48px, so it leads; the
// implicit /favicon.ico is last because it is the browser default rather than a declared mark.
function iconPriority(kind, { size = 0, svg = false } = {}) {
  if (kind === 'apple-touch-icon') return 1;
  if (kind === 'mask-icon') return 6;
  if (kind === 'json-ld-logo') return 5;
  if (size >= 96) return 2;
  if (svg) return 3;
  return 4;
}

function* walkJson(value) {
  const stack = [value];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) { stack.push(...node); continue; }
    if (!node || typeof node !== 'object') continue;
    yield node;
    stack.push(...Object.values(node));
  }
}

function typeList(type) {
  return (Array.isArray(type) ? type : [type]).map((entry) => String(entry || '').split('/').pop());
}

// schema.org declares the brand logo explicitly. It only ever runs when no <link rel="icon"> was
// found, and `logo` alone is accepted: `image` on those nodes is routinely a screenshot.
function jsonLdLogos(html, base) {
  const urls = [];
  for (const block of String(html).matchAll(LD_JSON_BLOCK)) {
    let data;
    try { data = JSON.parse(block[1].trim()); } catch (_) { continue; }
    for (const node of walkJson(data)) {
      if (!node.logo) continue;
      if (!typeList(node['@type']).some((type) => BRAND_TYPES.test(type))) continue;
      for (const value of [].concat(node.logo)) {
        const url = resolveUrl(typeof value === 'string' ? value : value?.url || value?.contentUrl, base);
        if (url) urls.push(url);
      }
    }
  }
  return urls;
}

function parseIconCandidates(html, pageUrl) {
  const page = normalizePageUrl(pageUrl) || String(pageUrl || '');
  const htmlText = String(html || '');
  const baseTag = htmlText.match(BASE_TAG)?.[0];
  const base = (baseTag && resolveUrl(readAttributes(baseTag).href, page)) || page;
  const candidates = [];
  for (const tag of htmlText.matchAll(LINK_TAG)) {
    const attributes = readAttributes(tag[0]);
    const kind = linkKind(relTokens(attributes.rel));
    if (!kind) continue;
    const url = resolveUrl(attributes.href, base);
    if (!url) continue;
    const size = iconSize(attributes.sizes);
    const svg = /image\/svg\+xml/i.test(attributes.type || '') || /\.svg(?:$|[?#])/i.test(url);
    candidates.push({ url, kind, sizes: attributes.sizes || '', size, type: attributes.type || '', priority: iconPriority(kind, { size, svg }) });
  }
  for (const url of jsonLdLogos(htmlText, base)) candidates.push({ url, kind: 'json-ld-logo', sizes: '', size: 0, type: '', priority: iconPriority('json-ld-logo') });
  // The same icon is often declared twice (shortcut + apple-touch); sorting first keeps the copy
  // with the best rank, because a duplicate only changes how the icon is described.
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates.sort((a, b) => a.priority - b.priority || b.size - a.size)) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    unique.push(candidate);
  }
  return unique;
}

function pickIcon(candidates) {
  return (Array.isArray(candidates) ? candidates : [])[0] || null;
}

// The browser default, tried only after every declared icon failed to download.
function faviconUrl(pageUrl) {
  const page = normalizePageUrl(pageUrl) || String(pageUrl || '');
  return resolveUrl('/favicon.ico', page);
}

// Byte sniffing only: an icon URL that answers with an HTML error page is not a logo. Kept in
// step with scripts/image-store.js (imageExtension) and pinned by tests/site-logo.test.js.
function imageKind(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.length < 4) throw new Error('unsupported image bytes');
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (/^GIF8[79]a/.test(buffer.toString('ascii', 0, 6))) return 'gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(buffer.toString('ascii', 8, 12))) return 'avif';
  if (buffer.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'ico';
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text) && !/<!DOCTYPE|<!ENTITY/i.test(text)) return 'svg';
  throw new Error('unsupported image bytes');
}

module.exports = {
  PLATFORM_HOSTS,
  normalizePageUrl,
  candidatePage,
  parseIconCandidates,
  pickIcon,
  faviconUrl,
  iconSize,
  imageKind,
};
