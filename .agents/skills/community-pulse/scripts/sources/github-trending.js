/**
 * GitHub Trending (https://github.com/trending?since=daily)
 * 官方趋势页解析。since: daily(默认) / weekly / monthly
 * 每条: repo 名 + 描述 + 语言 + 今日/本周/本月 star 数
 *
 * 注: 本机直连 github.com/trending 超时, 走代理; Actions runner 直连可达。
 *     daily_filter=false: 趋势是"当前热榜", 不是按日发布, 不按日期过滤。
 */
const { execFileSync } = require('child_process');

const PROXY = process.env.COMMUNITY_PULSE_PROXY === undefined
  ? 'http://127.0.0.1:7890'
  : process.env.COMMUNITY_PULSE_PROXY;

function fetchTrending(since, spoken) {
  const args = ['-s', '--max-time', '25', '-H', 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0'];
  if (PROXY) args.push('-x', PROXY);
  let url = `https://github.com/trending?since=${since}`;
  if (spoken) url += `&spoken_language_code=${spoken}`; // 口语语言筛选 (如 zh=中文圈)
  args.push(url);
  try {
    return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 30000 });
  } catch (e) {
    throw new Error(`curl trending 失败: ${e.message}`);
  }
}

async function fetchItems(src, opts = {}) {
  const max = src.max_items || 15;
  const since = src.since || 'daily';
  const spoken = src.spoken_language_code || '';
  const html = fetchTrending(since, spoken);
  const rows = html.split('class="Box-row"').slice(1); // 第一段是分割残留

  const items = [];
  for (const block of rows) {
    // repo 名: <h2...><a href="/owner/repo">name</a></h2>
    const nameM = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!nameM) continue;
    const fullName = nameM[1].trim();
    // 显示名: 去 HTML 标签 + 合并换行/空白 (HTML 里 repo 名可能被拆行)
    const displayName = nameM[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    // 描述: <p class="col-9 ...">...</p>
    const descM = block.match(/<p[^>]*class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const desc = descM ? descM[1].replace(/<[^>]+>/g, '').trim() : '';

    // 语言
    const langM = block.match(/<span itemprop="programmingLanguage">([^<]+)<\/span>/);
    const lang = langM ? langM[1].trim() : '';

    // 今日新增 star: "1,485 stars today"
    const todayM = block.match(/([\d,]+)\s*stars?\s*today/);
    const today = todayM ? todayM[1].replace(/,/g, '') : '';
    const todayNum = today ? parseInt(today, 10) : 0;

    // 总 star + forks: 纯文本序列 "... lang  <stars>  <forks>  Built by <today> stars today"
    // 先去 HTML tag 再取数字, 避免 tag 里的 class/aria 数字混入
    let stars = 0, forks = 0;
    const builtIdx = block.search(/Built by/);
    if (builtIdx > 0) {
      const headHtml = block.slice(0, builtIdx);
      const headText = headHtml.replace(/<[^>]+>/g, ' ');
      const nums = [...headText.matchAll(/([\d,]+)/g)].map(m => m[1].replace(/,/g, ''));
      if (nums.length >= 2) {
        stars = parseInt(nums[nums.length - 2], 10) || 0;  // 倒数第二 = 总star
        forks = parseInt(nums[nums.length - 1], 10) || 0;  // 倒数第一 = forks
      } else if (nums.length === 1) {
        stars = parseInt(nums[0], 10) || 0;
      }
    }

    items.push({
      sourceId: src.id,
      title: displayName,
      url: `https://github.com/${fullName}`,
      author: fullName.split('/')[0] || '',
      authorUrl: `https://github.com/${fullName.split('/')[0]}`,
      publishedAt: null, // 趋势热榜无发布时间
      summary: desc,
      content: desc,
      metrics: { stars, today: todayNum, forks, lang },
      tags: ['github-trending', since, lang || ''],
      externalId: `${since}-${fullName}`,
    });
    if (items.length >= max) break;
  }
  return items;
}

module.exports = { fetchItems };
