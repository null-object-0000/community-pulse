/**
 * Hacker News 热榜 (官方公开 API, 无需认证)
 * 取 topstories 前 N 条，补充标题/链接/分数/评论数/作者
 */
const BASE = 'https://hacker-news.firebaseio.com/v0';

async function fetchItems(src) {
  const max = src.max_items || 20;

  const topRes = await fetch(`${BASE}/topstories.json`);
  if (!topRes.ok) throw new Error(`topstories HTTP ${topRes.status}`);
  const ids = (await topRes.json()).slice(0, max);

  // 并发取详情
  const items = await Promise.all(
    ids.map(async (id) => {
      const r = await fetch(`${BASE}/item/${id}.json`);
      if (!r.ok) return null;
      const d = await r.json();
      if (!d || d.type !== 'story' || d.deleted) return null;
      return {
        sourceId: 'hackernews',
        title: d.title || '',
        url: d.url || `https://news.ycombinator.com/item?id=${id}`,
        author: d.by || '',
        authorUrl: d.by ? `https://news.ycombinator.com/user?id=${d.by}` : '',
        publishedAt: d.time ? new Date(d.time * 1000).toISOString() : null,
        summary: '',
        content: (d.text || '').replace(/<[^>]+>/g, '').slice(0, 500),
        metrics: { points: d.score || 0, comments: d.descendants || 0 },
        tags: ['hackernews'],
        externalId: String(id),
      };
    })
  );

  return items.filter(Boolean);
}

module.exports = { fetchItems };
