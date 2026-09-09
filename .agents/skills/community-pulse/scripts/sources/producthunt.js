/**
 * Product Hunt 新品 (官方 GraphQL API v2)
 * 数据源: https://api.producthunt.com/v2/api/graphql
 * 认证: Bearer token (Developer Token 或 OAuth token), 从环境变量 PRODUCT_HUNT_TOKEN 读
 * 支持按日回溯: postedAfter/postedBefore 过滤
 *
 * 注意: PH API 在国内被墙, 需走代理 (本机 7890 / Actions 不走代理则无法访问, 需配 GH 代理或放弃该源在 Actions 跑)
 */
const { execFileSync } = require('child_process');

const PROXY = process.env.COMMUNITY_PULSE_PROXY === undefined
  ? 'http://127.0.0.1:7890'
  : process.env.COMMUNITY_PULSE_PROXY;

const API = 'https://api.producthunt.com/v2/api/graphql';

function ghQL(query) {
  const ph = require('../ph_tokens');
  const tokens = ph.getTokens();
  if (!tokens.length) throw new Error('未设置 PRODUCT_HUNT_TOKEN 环境变量');
  let lastError;
  for (let round = 0; round < tokens.length; round += 1) {
    const token = ph.nextToken();
    if (!token) break;
    const args = ['-s', '--max-time', '30', '-X', 'POST', API,
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Content-Type: application/json',
      '-H', 'Accept: application/json',
      '-d', JSON.stringify({ query })];
    if (PROXY) args.push('-x', PROXY);
    try {
      const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 35000 });
      const d = JSON.parse(out);
      if (d.errors && d.errors.length) {
        const serialized = JSON.stringify(d.errors);
        if (/rate.?limit/i.test(serialized)) {
          ph.markCooldown(token, 900);
          throw new Error('PH_API_RATE_LIMITED: ' + serialized.slice(0, 60));
        }
        throw new Error(`PH API 错误: ${serialized.slice(0, 200)}`);
      }
      return d.data;
    } catch (e) {
      const safe = ph.redact(String(e.message || e), tokens);
      lastError = new Error(safe);
      if (/PH_API_RATE_LIMITED/.test(safe)) continue; // 429 → 换下一个 token
      throw lastError;
    }
  }
  throw lastError;
}

async function fetchItems(src, opts = {}) {
  const max = src.max_items || 15;
  // 日期过滤 (回溯/日报): postedAfter/Based on opts.date (北京时间 → UTC)
  let dateFilter = '';
  if (opts.date) {
    const start = new Date(`${opts.date}T00:00:00+08:00`).toISOString();
    const end = new Date(`${opts.date}T23:59:59+08:00`).toISOString();
    dateFilter = `postedAfter: "${start}", postedBefore: "${end}"`;
  }
  // 日报只消费 Product Hunt 官方精选；全部上线记录保留在 source-raw。
  const query = `{ posts(featured: true, order: RANKING, first: ${max}${dateFilter ? ', ' + dateFilter : ''}) { edges { node { id name tagline url createdAt featuredAt description votesCount commentsCount } } } }`;
  const data = ghQL(query);
  const edges = (data && data.posts && data.posts.edges) || [];

  return edges.map(e => {
    const n = e.node;
    return {
      sourceId: src.id,
      title: n.name || '',
      url: n.url || '',
      author: '', // PH 产品无直接作者字段(需另查)
      authorUrl: '',
      publishedAt: n.createdAt || null,
      summary: n.tagline || '',
      content: n.description || n.tagline || '',
      metrics: { votes: n.votesCount || 0, comments: n.commentsCount || 0 },
      tags: ['producthunt', 'new', 'official-featured'],
      externalId: String(n.id),
    };
  });
}

module.exports = { fetchItems };
