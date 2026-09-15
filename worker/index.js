import { handleCatalogApi } from './catalog-api.mjs';

// 站长平台的归属验证文件（仓库根的 verification/ 目录，构建时复制到站点根）。
//
// Cloudflare 静态资源的默认 html_handling（auto-trailing-slash）会把 /x.html **307** 到 /x，
// 而百度/必应这类文件验证要求下发的那条 `.html` 地址本身直接返回 200 —— 否则平台会报
// 「无法连接到您网站的服务器」。所以这几个路径交给 Worker 直出，其余请求一律不经过脚本。
//
// 新增平台时：把文件丢进 verification/，并在这里和 wrangler.toml 的 run_worker_first 里各加一条。
const VERIFICATION_FILE = /^\/(baidu_verify_[A-Za-z0-9._-]+)\.html$/;
const CACHED_API = new Set(['/api/v1/sources', '/api/v1/trends', '/api/v1/products']);

// Cache API entries are local to each Cloudflare data center. A versioned key keeps later SQL or
// taxonomy releases from reading an older response while each entry stays fresh for at most 5 min.
export function apiCacheKey(request) {
  const url = new URL(request.url);
  const sources = url.searchParams.get('sources');
  if (sources !== null) {
    url.searchParams.set('sources', [...new Set(sources.split(',').map(value => value.trim()).filter(Boolean))].sort().join(','));
  }
  url.searchParams.sort();
  return new Request(new URL(`/_devtrends_api_cache/v8${url.pathname}${url.search}`, url.origin));
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/v1/')) return cachedCatalogApi(request, env, ctx);
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
