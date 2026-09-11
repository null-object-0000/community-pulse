/**
 * ruanyf/weekly issues = 用户投稿 (自荐/推荐/文章投稿)
 * 数据源: gh api 列 issues, 按 created_at 过滤昨日
 * 标题带前缀标签 (【开源自荐】【工具自荐】〖独立工具推荐〗投稿: 等), 保留在 title 里
 */
const { execFileSync } = require('child_process');
const { descriptionFromIssue } = require('../issue-description');

const REPO = 'ruanyf/weekly';

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
  }
  // --paginate 让 gh 自动翻所有页
  const issues = ghJson([url, '--paginate']);

  let items = issues.map(iss => {
    // 提取正文里的第一个链接作为候选 url (自荐通常有官网/GitHub)
    const urlMatch = iss.body ? iss.body.match(/https?:\/\/[^\s)\]]+/g) : null;
    const url = urlMatch ? urlMatch[0] : `https://github.com/${REPO}/issues/${iss.number}`;
    // 清洗 body → 简介: 剥离投稿模板字段名（项目地址/项目描述…），取描述字段或第一段正文
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
      tags: ['ruanyf-weekly', 'submission'],
      externalId: String(iss.number),
      issueUrl: `https://github.com/${REPO}/issues/${iss.number}`,
    };
  });

  // 按北京时间昨日过滤
  if (opts.date) {
    items = items.filter(it => it.publishedAt && beijingDate(it.publishedAt) === opts.date);
  }
  return items.slice(0, max);
}

module.exports = { fetchItems };
