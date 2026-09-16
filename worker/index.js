import { handleCatalogApi, queryProductDetail } from './catalog-api.mjs';
import { openMysql } from './mysql-db.mjs';
import { renderProductPage } from './project-page.mjs';
import { CATALOG_VERSION } from './catalog-version.mjs';

// 站长平台的归属验证文件（仓库根的 verification/ 目录，构建时复制到站点根）。
//
// Cloudflare 静态资源的默认 html_handling（auto-trailing-slash）会把 /x.html **307** 到 /x，
// 而百度/必应这类文件验证要求下发的那条 `.html` 地址本身直接返回 200 —— 否则平台会报
// 「无法连接到您网站的服务器」。所以这几个路径交给 Worker 直出，其余请求一律不经过脚本。
//
// 新增平台时：把文件丢进 verification/，并在这里和 wrangler.toml 的 run_worker_first 里各加一条。
const VERIFICATION_FILE = /^\/(baidu_verify_[A-Za-z0-9._-]+)\.html$/;
const CACHED_API = new Set(['/api/v1/sources', '/api/v1/trends', '/api/v1/products']);
const PRODUCT_ROUTE = /^\/(?:en\/)?(?:projects\/[a-z0-9_.-]+\/[a-z0-9_.-]+|products\/prd_[a-f0-9]{24})\/?$/i;
const PRODUCT_RENDERER_VERSION = '20260916-layout';

// Cache API entries are local to each Cloudflare data center. A versioned key keeps later SQL or
// taxonomy releases from reading an older response while each entry stays fresh for at most 5 min.
export function apiCacheKey(request) {
  const url = new URL(request.url);
  const sources = url.searchParams.get('sources');
  if (sources !== null) {
    url.searchParams.set('sources', [...new Set(sources.split(',').map(value => value.trim()).filter(Boolean))].sort().join(','));
  }
  url.searchParams.sort();
  return new Request(new URL(`/_devtrends_api_cache/v9${url.pathname}${url.search}`, url.origin));
}

export async function cachedCatalogApi(request, env, ctx, handler = handleCatalogApi) {
  if (request.method !== 'GET' || !CACHED_API.has(new URL(request.url).pathname) || typeof caches === 'undefined') {
    return handler(request, env, ctx);
  }
  const cache = caches.default;
  const key = apiCacheKey(request);
  try {
    const hit = await cache.match(key);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('x-devtrends-cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers });
    }
  } catch (_) {
    // A cache failure is never a catalog outage: the database path remains authoritative.
  }
  const response = await handler(request, env, ctx);
  if (response.status === 200) {
    const put = cache.put(key, response.clone()).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  const headers = new Headers(response.headers);
  headers.set('x-devtrends-cache', 'MISS');
  return new Response(response.body, { status: response.status, headers });
}

export function canonicalProductRoute(pathname) {
  const route = pathname.replace(/^\/en(?=\/)/, '').replace(/\/?$/, '/').toLowerCase();
  return PRODUCT_ROUTE.test(pathname) ? route : '';
}

export async function dynamicProductPage(request, env, ctx) {
  const url = new URL(request.url);
  const route = canonicalProductRoute(url.pathname);
  if (request.method !== 'GET' || !route) return null;
  const locale = url.pathname.startsWith('/en/') ? 'en' : 'zh-CN';
  const cache = typeof caches === 'undefined' ? null : caches.default;
  const cacheKey = new Request(new URL(`/_devtrends_product_cache/${CATALOG_VERSION}/${PRODUCT_RENDERER_VERSION}${url.pathname}`, url.origin));
  try {
    const hit = cache && await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('x-devtrends-cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers });
    }
  } catch (_) {}
  if (!env.HYPERDRIVE_READ) return new Response('Catalog database unavailable', { status: 503 });
  const opened = await openMysql(env.HYPERDRIVE_READ);
  try {
    const model = await queryProductDetail(opened.db, route);
    if (!model) {
      const missing = await env.ASSETS.fetch(new Request(new URL(locale === 'en' ? '/en/404/' : '/404/', url), request));
      return new Response(missing.body, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' } });
    }
    const response = new Response(renderProductPage(model, locale), { headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
      'x-devtrends-cache': 'MISS',
      'x-devtrends-catalog-version': CATALOG_VERSION,
    } });
    const put = cache?.put(cacheKey, response.clone()).catch(() => {});
    if (put && ctx?.waitUntil) ctx.waitUntil(put);
    else if (put) await put;
    return response;
  } finally {
    const close = opened.close();
    if (ctx?.waitUntil) ctx.waitUntil(close);
    else await close;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/v1/')) return cachedCatalogApi(request, env, ctx);
    if (PRODUCT_ROUTE.test(url.pathname)) return dynamicProductPage(request, env, ctx);
    const match = url.pathname.match(VERIFICATION_FILE);
    if (!match) return env.ASSETS.fetch(request);
    // html_handling 会把无扩展名的同名路径映射回这个 .html 文件，那一侧是正常的 200。
    const asset = await env.ASSETS.fetch(new Request(new URL(`/${match[1]}`, url), request));
    if (asset.status !== 200) return env.ASSETS.fetch(request);
    return new Response(asset.body, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // 验证文件按文件名取一次就固定，别让边缘缓存把中途的错误结果留下来。
        'cache-control': 'no-store',
      },
    });
  },
};
