/**
 * Product Hunt API token 轮换共享模块
 *
 * 支持多应用 token 轮询(round-robin),分摊每个应用每 15 分钟
 * 6250 complexity points 的 GraphQL 配额:
 *   PRODUCT_HUNT_TOKEN        (兼容旧配置, 作为第 1 个)
 *   PRODUCT_HUNT_TOKEN_2..N   (可选, 按顺序轮询)
 *
 * 调度策略:
 *   - 平时所有 token 轮流使用(nextToken 返回下一个), 配额均匀分摊
 *   - 某 token 遇 429 时 markCooldown() 把它冷却一段时间, 期间不再被选中
 *   - 冷却到期自动恢复参与轮询
 *
 * 用法:
 *   const ph = require('./ph_tokens');
 *   const token = ph.nextToken();          // 拿下一个可用 token
 *   ... 请求 ...
 *   ph.markCooldown(token, 900);           // 429 时标记冷却
 *   const safe = ph.redact(msg, ph.getTokens());
 */
const TOKEN_ENV_NAMES = (() => {
  const names = ['PRODUCT_HUNT_TOKEN'];
  for (let i = 2; i <= 20; i += 1) names.push(`PRODUCT_HUNT_TOKEN_${i}`);
  return names;
})();

const DEFAULT_COOLDOWN_SECONDS = 900; // Product Hunt 官方配额窗口为 15 分钟

function getTokens() {
  const seen = new Set();
  const tokens = [];
  for (const name of TOKEN_ENV_NAMES) {
    const value = (process.env[name] || '').trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      tokens.push(value);
    }
  }
  return tokens;
}

// --- round-robin 调度 ---
let cursor = 0;
const cooldown = new Map(); // token -> 冷却截止时间(ms)

function nextToken() {
  const tokens = getTokens();
  if (!tokens.length) return null;
  const now = Date.now();
  const available = tokens.filter(t => !cooldown.has(t) || cooldown.get(t) <= now);
  if (!available.length) return null; // 全部冷却中
  const tok = available[cursor % available.length];
  cursor = (cursor + 1) % available.length;
  return tok;
}

function markCooldown(token, seconds = DEFAULT_COOLDOWN_SECONDS) {
  cooldown.set(token, Date.now() + seconds * 1000);
}

function resetCooldowns() {
  cooldown.clear();
}

function cooldownStatus() {
  const now = Date.now();
  const out = {};
  for (const t of getTokens()) {
    const until = cooldown.get(t);
    out[t.slice(0, 6) + '…'] = until && until > now ? Math.ceil((until - now) / 1000) + 's' : 'ok';
  }
  return out;
}

function redact(message, tokens) {
  let safe = String(message || '');
  for (const token of tokens) {
    safe = safe.split(token).join('[REDACTED]');
  }
  return safe;
}

module.exports = { getTokens, nextToken, markCooldown, resetCooldowns, cooldownStatus, redact, TOKEN_ENV_NAMES };
