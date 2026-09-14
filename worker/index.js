import { handleCatalogApi } from './catalog-api.mjs';

// 站长平台的归属验证文件（仓库根的 verification/ 目录，构建时复制到站点根）。
//
// Cloudflare 静态资源的默认 html_handling（auto-trailing-slash）会把 /x.html **307** 到 /x，
// 而百度/必应这类文件验证要求下发的那条 `.html` 地址本身直接返回 200 —— 否则平台会报
// 「无法连接到您网站的服务器」。所以这几个路径交给 Worker 直出，其余请求一律不经过脚本。
//
// 新增平台时：把文件丢进 verification/，并在这里和 wrangler.toml 的 run_worker_first 里各加一条。
const VERIFICATION_FILE = /^\/(baidu_verify_[A-Za-z0-9._-]+)\.html$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/v1/')) return handleCatalogApi(request, env);
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
