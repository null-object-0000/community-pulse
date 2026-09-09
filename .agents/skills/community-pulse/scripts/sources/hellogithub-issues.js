/**
 * 521xueweihan/HelloGitHub issues = 用户投稿 (开源推荐/开源自荐)
 * 数据源: gh api 列 issues, 按 created_at 过滤昨日
 * 标题带前缀标签 ([开源推荐] [开源自荐] [Open Source] 等), 保留在 title 里
 */
const { execFileSync } = require('child_process');

const REPO = '521xueweihan/HelloGitHub';

function ghJson(args, timeout = 30000) {
  try {
    const out = execFileSync('gh', ['api', ...args], { encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024 });
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`gh api 失败: ${e.stderr || e.message}`);
  }
}

// 北京时间日期字符串 YYYY-MM-DD
function beijingDate(iso) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function fetchItems(src, opts = {}) {
  const max = src.max_items || 30;
  // 回溯历史日期: since 参数 + --paginate 自动翻页 (per_page=100 只够最近)
  let url = `repos/${REPO}/issues?state=all&per_page=100&sort=created&direction=asc`;
  if (opts.date) {
    const d = new Date(`${opts.date}T00:00:00+08:00`);
    d.setDate(d.getDate() - 7);
    url += `&since=${d.toISOString()}`;
  } else {
    url = `repos/${REPO}/issues?state=all&per_page=100&sort=created&direction=desc`;
  }
  const issues = ghJson([url, '--paginate']);

  let items = issues.map(iss => {
    const urlMatch = iss.body ? iss.body.match(/https?:\/\/[^\s)\]]+/g) : null;
    const url = urlMatch ? urlMatch[0] : `https://github.com/${REPO}/issues/${iss.number}`;
    // 清洗 body → 纯文本简介: 去 markdown 语法/链接/标题符号, 取第一段完整文字 (不截断)
    const clean = (iss.body || '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[*_`>#-]/g, '')
      .replace(/https?:\/\/[^\s)\]]+/g, '')
      .replace(/\s+/g, ' ').trim();
    const segs = clean.split(/\n+/).map(s => s.trim()).filter(s => s.length > 15);
    const summary = segs.length ? segs[0] : clean;
    return {
      sourceId: src.id,
      title: iss.title || '',
      url,
      author: iss.user ? iss.user.login : '',
      authorUrl: iss.user ? `https://github.com/${iss.user.login}` : '',
      publishedAt: iss.created_at || null,
      summary,
      content: iss.body || '',
      metrics: { comments: iss.comments || 0 },
      tags: ['hellogithub', 'submission'],
      externalId: String(iss.number),
      issueUrl: `https://github.com/${REPO}/issues/${iss.number}`,
    };
  });

  if (opts.date) {
    items = items.filter(it => it.publishedAt && beijingDate(it.publishedAt) === opts.date);
  }
  return items.slice(0, max);
}

module.exports = { fetchItems };
