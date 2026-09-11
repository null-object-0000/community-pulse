/**
 * 521xueweihan/HelloGitHub issues = 用户投稿 (开源推荐/开源自荐)
 * 数据源: gh api 列 issues, 按 created_at 过滤昨日
 * 标题带前缀标签 ([开源推荐] [开源自荐] [Open Source] 等), 保留在 title 里
 */
const { execFileSync } = require('child_process');
const { descriptionFromIssue } = require('../issue-description');

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
    // 清洗 body → 简介: 剥离投稿模板字段名（项目地址/项目描述/必写…），取描述字段或第一段正文
    const summary = descriptionFromIssue(iss.body);
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
