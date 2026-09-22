/**
 * V2EX 热门主题 (官方公开 API)
 * 注意: 本机网络直连被墙；且 Node fetch 走本机代理(undici)对 v2ex 会 ETIMEDOUT，
 *       但 curl 走代理可通 → 本模块用 curl 子进程抓取。
 */
const { execFile } = require('child_process');

function curlJson(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-s', '--max-time', String(Math.floor(timeoutMs / 1000)), '-x', 'http://127.0.0.1:7890', url],
      { encoding: 'utf8' },
      (err, stdout) => {
        if (err) return reject(new Error(`curl 失败: ${err.message}`));
        try { resolve(JSON.parse(stdout)); }
        catch (e) { reject(new Error(`JSON 解析失败: ${stdout.slice(0, 100)}`)); }
      });
  });
}

async function fetchItems(src) {
  const max = src.max_items || 20;

  const topics = await curlJson('https://www.v2ex.com/api/topics/hot.json');

  return topics.slice(0, max).map(t => ({
    sourceId: 'v2ex',
    title: t.title || '',
    url: `https://www.v2ex.com/t/${t.id}`,
    author: (t.member && t.member.username) || '',
    authorUrl: t.member ? `https://www.v2ex.com/member/${t.member.username}` : '',
    publishedAt: t.created ? new Date(t.created * 1000).toISOString() : null,
    summary: '',
    content: (t.content || '').replace(/<[^>]+>/g, '').slice(0, 500),
    metrics: { replies: t.replies || 0 },
    tags: ['v2ex', t.node && t.node.name ? t.node.name : ''],
    externalId: String(t.id),
  }));
}

module.exports = { fetchItems };
