/**
 * VibeCafé 作品 (https://vibecafe.ai/products)
 * 抓取方式: HTTP GET + RSC: 1 头 → Next.js RSC flight 流里含结构化 initialProducts JSON
 * 不需要浏览器/chrome_devtools_mcp。
 *
 * 关键:
 * - RSC 流 (RSC: 1 请求) 返回 flight 协议, 产品数据嵌在 `initialProducts` 数组
 *   (干净 JSON, 非 HTML 转义)。
 * - 每个产品有 createdAt (ISO 时间) → 可按"昨日"过滤。
 * - 游标 initialNextCursor 支持分页 (当前只用首页即可覆盖昨日)。
 */
const { execFile } = require('child_process');

const PROXY = process.env.COMMUNITY_PULSE_PROXY || ''; // 空=不走代理(如 Actions runner)
const URL = 'https://vibecafe.ai/products';

function fetchRsc(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const args = [
      '-s', '--max-time', String(Math.floor(timeoutMs / 1000)),
      '-H', 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0',
      '-H', 'RSC: 1',
      '-H', 'Accept: */*',
    ];
    if (PROXY) args.push('-x', PROXY);
    args.push(url);
    execFile('curl', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl 失败: ${err.message}`));
      resolve(stdout);
    });
  });
}

// 从 RSC flight 流中提取 initialProducts 数组 (找 "initialProducts": 后的 [...]，转义感知)
function extractProducts(rsc) {
  const key = '"initialProducts"';
  const idx = rsc.indexOf(key);
  if (idx < 0) throw new Error('RSC 流中未找到 initialProducts');
  const start = rsc.indexOf('[', idx + key.length);
  if (start < 0) throw new Error('initialProducts 后未找到 [');
  // 括号配对 + 引号/转义感知
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < rsc.length; i++) {
    const c = rsc[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error('initialProducts 数组未闭合');
  return JSON.parse(rsc.slice(start, end + 1));
}

// 从产品详情页 RSC 流中提取 GitHub 仓库链接 (体验链接/官网等, 去 utm 参数)
function extractGitHubUrl(rsc) {
  const re = /github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g;
  const found = rsc.match(re);
  if (!found || !found.length) return null;
  const s = found[0].replace(/\?.*$/, ''); // 去查询参数
  return s.startsWith('https://') ? s : `https://${s}`;
}

// $D2026-09-06T11:01:22.190Z → ISO
function parseDate(v) {
  if (!v) return null;
  const s = String(v).replace(/^\$D/, '');
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
}

async function fetchItems(src, opts = {}) {
  const max = src.max_items || 30;
  const rsc = await fetchRsc(URL);
  const products = extractProducts(rsc);
  if (!Array.isArray(products) || products.length === 0) {
    throw new Error('initialProducts 解析为空');
  }

  let items = products.map(p => ({
    sourceId: 'vibecafe',
    title: p.name || '',
    url: p.websiteUrl || `https://vibecafe.ai/products/${p.id}`,
    author: (p.owner && (p.owner.name || p.owner.handle)) || '',
    authorUrl: p.owner && p.owner.handle ? `https://vibecafe.ai/u/${p.owner.handle}` : '',
    publishedAt: parseDate(p.createdAt),
    summary: p.tagline || '',
    content: p.tagline || '',
    metrics: {},
    tags: ['vibecafe', 'product'],
    externalId: p.id,
    image: (p.imageUrls && p.imageUrls[0]) || p.logoUrl || '',
    vibecafeId: p.id,
  }));

  // 采集阶段补充: 如果条目是 GitHub 开源项目 (用户需求), 从产品详情页挖 GitHub 链接
  // 仅当 collect.js 传 enrichGithub 时启用 (Actions 日报默认开; 回溯可关省配额)
  if (opts.enrichGithub) {
    const withGh = [];
    for (const it of items) {
      try {
        const rsc = await fetchRsc(`https://vibecafe.ai/products/${it.vibecafeId}`);
        const ghUrl = extractGitHubUrl(rsc);
        if (ghUrl) it.github = { url: ghUrl };
      } catch (e) {
        // 详情页抓取失败不影响列表
      }
      withGh.push(it);
    }
    items = withGh;
  }

  // 按日期过滤 (日报: 只保留昨日) — 用北京时间而非 UTC
  if (opts.date) {
    const target = opts.date; // YYYY-MM-DD (北京时间)
    items = items.filter(it => {
      if (!it.publishedAt) return false;
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date(it.publishedAt));
      const get = (t) => parts.find(p => p.type === t).value;
      return `${get('year')}-${get('month')}-${get('day')}` === target;
    });
  }

  return items.slice(0, max);
}

module.exports = { fetchItems };
