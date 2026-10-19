#!/usr/bin/env node
/**
 * devtrends.site 自建服务器的 Node 入口（阿里云 ECS 上的容器）。
 *
 * 设计原则：**不复制任何渲染逻辑**。
 * 这里直接调用 `worker/index.js` 的默认 fetch 处理器 —— 与生产环境的 Cloudflare Worker
 * 逐字同一份代码，只补上它依赖的两个运行时绑定：
 *
 *   env.ASSETS           从 dist/ 读静态文件（含 _headers 的缓存规则、目录索引、404-page 回退）
 *   env.HYPERDRIVE_READ  从环境变量读 MySQL 连接参数（Hyperdrive 在自建环境里的等价物）
 *
 * 为什么不重写渲染：worker 代码对运行时的依赖只有 ASSETS / HYPERDRIVE / caches 三处，
 * 而 `caches` 在 Node 里本就不存在，代码自身有 `typeof caches === 'undefined'` 分支
 * （见 worker/index.js 的注释）。于是缓存自动退化成「每次查库」—— 以本站的量级
 * （真人约 30 会话/天，且数据库在同一个 VPC）完全够用，还省掉一层缓存键失效的坑。
 *
 * 启动方式：`node deploy/server.mjs`；配置全部走环境变量（见 deploy/.env.example）。
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(process.env.SITE_ROOT || join(HERE, '..', 'dist'));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
// 这份文件里没有正文、也没有正文以外的语义：404 页在两处用到（worker 与静态回退）。
const NOT_FOUND_PAGE = join(ROOT, '404.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|xml|manifest\+json)|image\/svg)/;

/**
 * `dist/_headers` 是构建产物（Netlify/Cloudflare 语法：一行路径 + 缩进的 `Header: value`），
 * 缓存策略以它为准 —— 这样自建环境与 Cloudflare 上的行为不会各说各话。
 */
let headerRules = [];
async function loadHeaderRules() {
  try {
    const text = await readFile(join(ROOT, '_headers'), 'utf8');
    const rules = [];
    let current = null;
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      if (!/^\s/.test(raw)) {
        current = { pattern: raw.trim(), headers: {} };
        rules.push(current);
        continue;
      }
      if (!current) continue;
      const colon = raw.indexOf(':');
      if (colon > 0) current.headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
    }
    headerRules = rules;
  } catch {
    headerRules = [];
  }
}

function headersFor(pathname) {
  const out = {};
  for (const rule of headerRules) {
    const hit = rule.pattern.endsWith('/*')
      ? pathname.startsWith(rule.pattern.slice(0, -1))
      : pathname === rule.pattern;
    if (hit) Object.assign(out, rule.headers);
  }
  return out;
}

/** URL 路径 → dist/ 里的真实文件。顺序对齐 Cloudflare 静态资源：目录索引优先于同名 `.html`。 */
async function resolveAsset(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = normalize(decoded).replace(/^[/\\]+/, '');
  if (rel.split(/[/\\]/).includes('..')) return null;
  const base = resolve(ROOT, rel);
  if (base !== ROOT && !base.startsWith(ROOT + sep)) return null;
  const candidates = decoded.endsWith('/')
    ? [join(base, 'index.html')]
    : [base, `${base}.html`, join(base, 'index.html')];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return { file: candidate, size: info.size, mtime: info.mtime };
    } catch {
      // 试下一个候选
    }
  }
  return null;
}

function textResponse(body, status, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...extra },
  });
}

async function notFoundResponse() {
  try {
    return textResponse(await readFile(NOT_FOUND_PAGE), 404, { 'cache-control': 'public, max-age=60' });
  } catch {
    return textResponse('404 Not Found', 404);
  }
}

/** worker 的 `env.ASSETS.fetch` —— 静态文件那一侧。 */
async function assetsFetch(request) {
  const url = new URL(request.url);
  const pathname = url.pathname || '/';
  const asset = await resolveAsset(pathname);
  if (!asset) return notFoundResponse();
  const type = MIME[extname(asset.file)] || 'application/octet-stream';
  const headers = {
    'content-type': type,
    'etag': `W/"${asset.size.toString(16)}-${Math.floor(asset.mtimeMs).toString(16)}"`,
    'last-modified': asset.mtime.toUTCString(),
    ...headersFor(pathname),
  };
  const inm = request.headers.get('if-none-match');
  if (inm && inm.split(',').some(value => value.trim() === headers.etag)) {
    return new Response(null, { status: 304, headers });
  }
  // 压缩统一在外面那道 `needsGzip` 里做（静态与 worker 渲染的 HTML 走同一条路径），这里只负责
  // 把文件作为流交出去，不在内存里缓冲整页。
  return new Response(Readable.toWeb(createReadStream(asset.file)), { status: 200, headers });
}

/** Hyperdrive 的等价物：连接参数直接来自环境变量。缺配置时返回 null（worker 会答 503）。 */
function dbBinding() {
  const { DB_HOST, DB_USER, DB_NAME } = process.env;
  if (!DB_HOST || !DB_USER || !DB_NAME) return null;
  return {
    host: DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: DB_NAME,
  };
}

const STATIC_ENV = { ASSETS: { fetch: assetsFetch } };
const ctx = { waitUntil: promise => { if (promise && typeof promise.catch === 'function') promise.catch(() => {}); } };

/**
 * 过渡期的反代：数据库只读账号还没到位时，动态路径（详情页与只读 API）转给现有的 Cloudflare
 * Worker —— 它那边有 Hyperdrive，渲染逻辑与本站逐字同源，所以内容完全一致。
 *
 * 一旦 `DB_*` 配齐，本地渲染自动接管（同一个 worker.fetch，只是 env 里多了 HYPERDRIVE_READ），
 * 不需要改这里。把 `UPSTREAM_ORIGIN` 留空即彻底关掉这条退路。
 */
const UPSTREAM_ORIGIN = (process.env.UPSTREAM_ORIGIN || '').replace(/\/+$/, '');
const DYNAMIC_PATH = /^\/(?:en\/)?(?:api\/v1\/|projects\/|products\/)/i;
// 上游首字节实测 0.3~1.2 秒，给 8 秒足够宽松；再加一次重试 —— 国内出口到 Cloudflare 会间歇性
// ETIMEDOUT（实测撞到一次，用户看到的就是 502），重试一次能把大多数抖动挡在用户之外。
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 8000);

async function proxyToUpstream(request, url) {
  const target = new URL(url.pathname + url.search, UPSTREAM_ORIGIN);
  const init = {
    method: request.method,
    headers: {
      accept: request.headers.get('accept') || '*/*',
      'user-agent': request.headers.get('user-agent') || 'devtrends-site',
    },
    redirect: 'manual',
  };
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const upstream = await fetch(target, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      const headers = { ...Object.fromEntries(upstream.headers), 'x-devtrends-upstream': 'cloudflare-worker' };
      // ⚠ 必须摘掉这两个头：undici 的 fetch 会把上游的压缩体**自动解压**，却不一定把
      // `content-encoding` 摘干净。原样转发会让客户端再解一次压 —— 实测报
      // `incorrect header check` 并让请求崩掉；浏览器全都带 accept-encoding，等于每个产品页都坏。
      // 拿到的是明文，就按明文转发，需要压缩时由外层 `needsGzip` 统一重压。
      delete headers['content-encoding'];
      delete headers['content-length'];
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (error) {
      lastError = error;
      if (attempt === 1) console.warn(`[site] 上游第 1 次失败（${error?.cause?.code || error.name}），重试一次`);
    }
  }
  console.error('[site] upstream proxy failed:', lastError);
  return textResponse('上游暂时不可用', 502);
}

async function handle(request) {
  const url = new URL(request.url);
  // 容器健康检查：不落在 worker 的路由表里，所以在这里先答掉。
  if (url.pathname === '/healthz') return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  const binding = dbBinding();
  if (UPSTREAM_ORIGIN && !binding && DYNAMIC_PATH.test(url.pathname)) return proxyToUpstream(request, url);
  // HEAD 先按 GET 走一遍再丢掉 body：HTTP 语义要求 HEAD 与 GET 的头部/状态一致，而 worker 里
  // 详情页对「非 GET」直接 `return null`（见 worker/index.js 的 dynamicProductPage），原样透传
  // 会把 null 丢给上层 —— 实测 `curl -I /products/…` 因此报 500。
  const inner = request.method === 'HEAD' ? new Request(request, { method: 'GET' }) : request;
  const response = await worker.fetch(inner, { ...STATIC_ENV, HYPERDRIVE_READ: binding }, ctx);
  // worker 对「不属于自己的路径」返回 null，在 Cloudflare 上由静态资源兜住；自建环境里手动兜，
  // 与 run_worker_first 的语义一致：worker 不处理就交给静态资源，找不到就是站点自己的 404 页。
  return response || assetsFetch(request);
}

function needsGzip(request, response) {
  if (request.method === 'HEAD' || !response.body) return false;
  if (response.headers.has('content-encoding')) return false;
  const type = response.headers.get('content-type') || '';
  const accept = request.headers.get('accept-encoding') || '';
  return /\bgzip\b/.test(accept) && COMPRESSIBLE.test(type);
}

const server = createServer(async (req, res) => {
  let request;
  try {
    const host = req.headers.host || 'localhost';
    request = new Request(new URL(req.url, `http://${host}`), { method: req.method, headers: req.headers });
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }
  try {
    let response = await handle(request);
    if (req.method === 'HEAD') {
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end();
      return;
    }
    if (needsGzip(request, response)) {
      const headers = Object.fromEntries(response.headers);
      headers['content-encoding'] = 'gzip';
      delete headers['content-length'];
      res.writeHead(response.status, headers);
      Readable.fromWeb(response.body).pipe(createGzip()).pipe(res);
      return;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch (error) {
    console.error('[site] request failed:', error);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('500 Internal Server Error');
  }
});

await loadHeaderRules();
const binding = dbBinding();
server.listen(PORT, HOST, () => {
  console.log(`[site] listening on http://${HOST}:${PORT}`);
  console.log(`[site] dist root: ${ROOT}  |  缓存规则 ${headerRules.length} 条`);
  console.log(binding
    ? `[site] 数据库: ${binding.user}@${binding.host}:${binding.port}/${binding.database}（详情页已启用）`
    : '[site] 数据库: 未配置 → 静态页面正常，/products/* 与 /api/v1/* 会返回 503');
});
