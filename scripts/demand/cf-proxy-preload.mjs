/**
 * 让任意抓取脚本走 Cloudflare 出口（不侵入脚本本身）。
 *
 * 用法：
 *   CF_PROXY=https://proxy.snewbie.site node --import ./scripts/demand/cf-proxy-preload.mjs <脚本> [参数...]
 *
 * 原理：proxy.nichangen 这套 Worker 接一个 `x-target-url` 头就把请求转发到目标，出口是 Cloudflare
 * 自己的网段。所以这里替换 globalThis.fetch：把「目标 URL」塞进头、请求发给 Worker。
 *
 * 为什么需要它：
 *   - 本机出口 IP 被 iTunes 限流（403），换代理节点无效（同一个出口 IP）
 *   - GitHub Actions 会排队（实测 queued 20 分钟没分到 runner）
 *   - Cloudflare 出口实测可用、且随时可调，不消耗 CI
 *
 * 注意：
 *   - 只劫持我们自己的抓取脚本；`download`/`fs` 之类不受影响（它们不走 fetch）
 *   - 若 CF_PROXY 未设置，本模块什么都不做（脚本照常直连）
 *   - 上游返回 3xx 时按响应原样交回，不做跟随（与原脚本的 redirect 行为一致由脚本自己决定）
 */
const PROXY = process.env.CF_PROXY;
const TARGET_HEADER = process.env.CF_PROXY_HEADER || 'x-target-url';

if (PROXY) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function fetchViaCloudflare(input, init = {}) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (url.startsWith(PROXY)) return originalFetch(input, init);

    const headers = new Headers(
      init.headers || (input && input.headers) || undefined
    );
    headers.set(TARGET_HEADER, url);
    // 目标站常按 UA 判人；沿用调用方设置的 UA（脚本里已有），没有就补一个默认
    if (!headers.has('user-agent')) {
      headers.set('user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36');
    }
    return originalFetch(PROXY, {
      ...init,
      method: init.method || (input && input.method) || 'GET',
      headers,
    });
  };
  process.stderr.write(`[cf-proxy] 抓取出口 → ${PROXY}\n`);
}
