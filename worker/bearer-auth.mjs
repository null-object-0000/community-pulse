/**
 * 临时 DB Worker（`catalog-import.mjs` / `catalog-read.mjs`）的入口令牌校验。
 *
 * 为什么不能直接写 `request.headers.get('authorization') !== `Bearer ${env.IMPORT_TOKEN}``：
 * 令牌没配置时 `env.IMPORT_TOKEN` 是 `undefined`，期望值退化成字面量 `Bearer undefined`，
 * 于是任何带上这个头的人都能通过 —— 一个「未配置」的部署等于没有认证。而
 * `wrangler.mysql-import.toml` / `wrangler.mysql-read.toml` 是提交进仓库的，
 * `workers_dev = true`，一条 `npx wrangler deploy --config …` 就会把「任意 SQL 的写通道」
 * 发布到可预测的 `<worker>.workers.dev` 地址上。所以这里的规则是：
 * 令牌必须存在且足够长，再按定长比较，避免提前返回带来的时序差异。
 *
 * 令牌由调用方生成（`crypto.randomBytes(32).toString('hex')`，64 个字符），
 * 经 `--var IMPORT_TOKEN:<token>` 注入；见 `scripts/catalog/upload-mysql.js` 与 `live-query.js`。
 */
const MIN_TOKEN_LENGTH = 16;

export function authorized(request, expected) {
  if (typeof expected !== 'string' || expected.length < MIN_TOKEN_LENGTH) return false;
  const header = request.headers.get('authorization') || '';
  const want = `Bearer ${expected}`;
  if (header.length !== want.length) return false;
  let diff = 0;
  for (let index = 0; index < want.length; index += 1) {
    diff |= header.charCodeAt(index) ^ want.charCodeAt(index);
  }
  return diff === 0;
}
