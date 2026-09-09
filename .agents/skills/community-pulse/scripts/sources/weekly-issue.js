/**
 * ruanyf/weekly 正刊 (科技爱好者周刊) = 周刊官方推荐
 * 数据源: README 里最新期号 → docs/issue-NNN.md
 * 条目来自正刊各小节 (工具/资源/软件/AI工具/学习资源), 格式:
 *   1、[名称](链接)
 *   简介在下一行  + （[@作者](issue链接) 投稿）可选
 *
 * 发布日: 每周五发布 → 只有「昨日是周五」才抓正刊。
 *   collect.js 传 opts.date (昨日, 北京时间), 本模块判断该日是否周五。
 */
const { execFileSync } = require('child_process');

const REPO = 'ruanyf/weekly';

function ghText(args, timeout = 30000) {
  try {
    return execFileSync('gh', ['api', ...args], { encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`gh api 失败: ${e.stderr || e.message}`);
  }
}

// 从 README 拿最新期号
function latestIssueNumber() {
  const readme = Buffer.from(ghText(['repos/ruanyf/weekly/contents/README.md', '--jq', '.content']).trim(), 'base64').toString('utf8');
  const m = readme.match(/issue-(\d+)\.md/);
  return m ? m[1] : null;
}

// 判断某日期(YYYY-MM-DD, 北京时间)是不是周五
function isFriday(dateStr) {
  const d = new Date(`${dateStr}T12:00:00+08:00`);
  return d.getUTCDay() === 5; // UTC+8 中午对应 UTC 4点, 星期不变
}

// 取简介: 条目行之后, 跳过空行/图片行, 取第一段非空文字 (保留投稿标注, 由调用处提取)
function extractIntro(lines, startIdx) {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^!\[/.test(t)) continue;      // 图片行
    if (/^\d+、/.test(t)) return '';    // 下一条目 → 无简介
    if (t.startsWith('## ')) return ''; // 下个小节 → 无简介
    return t;
  }
  return '';
}

async function fetchItems(src, opts = {}) {
  const max = src.max_items || 30;

  // 发布日判断: 正刊周五发布, 只有昨日是周五才抓
  if (opts.date && !isFriday(opts.date)) {
    return []; // 昨日不是周五 → 没有新周刊
  }

  const num = latestIssueNumber();
  if (!num) throw new Error('无法从 README 确定最新期号');

  const doc = Buffer.from(
    ghText([`repos/ruanyf/weekly/contents/docs/issue-${num}.md`, '--jq', '.content']).trim(),
    'base64'
  ).toString('utf8');
  const lines = doc.split('\n');

  const items = [];
  // 「推荐」小节: 工具/资源/软件/AI 工具/学习资源 (排除文章/科技动态/言论/图片/文摘)
  const SECTION_RE = /^## (工具|资源|软件|AI 工具|学习资源)$/;
  let inSection = false;
  let currentSection = '';

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('## ')) {
      inSection = SECTION_RE.test(t);
      if (inSection) currentSection = t.replace(/^##\s+/, '');
      continue;
    }
    if (!inSection) continue;

    // 条目: 1、[名称](链接)  [同行可能有投稿标注]
    const m = t.match(/^(\d+)、\s*\[([^\]]+)\]\(([^)]+)\)\s*(.*)$/);
    if (!m) continue;
    const [, , name, url, rest] = m;

    // 投稿标注可能在条目行末尾, 也可能在简介里
    let submitter = null;
    let issueUrl = null;
    let restIntro = rest;
    const subMatch = rest.match(/（\[@([^\]]+)\]\(([^)]+)\)\s*投稿）$/);
    if (subMatch) {
      submitter = subMatch[1];
      issueUrl = subMatch[2];
      restIntro = rest.slice(0, subMatch.index).trim();
    }

    // 简介: 优先条目行剩余, 否则下一行
    let intro = restIntro;
    if (!intro) intro = extractIntro(lines, i);
    // 简介里也可能有投稿标注 (简介与标注同行, 如 "介绍。（[@x](issue) 投稿）")
    const subInIntro = intro.match(/（\[@([^\]]+)\]\(([^)]+)\)\s*投稿）$/);
    if (subInIntro) {
      if (!submitter) { submitter = subInIntro[1]; issueUrl = subInIntro[2]; }
      intro = intro.slice(0, subInIntro.index).trim();
    }

    items.push({
      sourceId: src.id,
      title: name,
      url,
      author: submitter || '',
      authorUrl: submitter ? `https://github.com/${submitter}` : '',
      publishedAt: `${opts.date || ''}T00:00:00+08:00`, // 周刊发布日(昨日)
      summary: intro,
      content: intro,
      metrics: {},
      tags: ['ruanyf-weekly', 'official', currentSection],
      section: currentSection,
      externalId: `${num}-${name}-${url}`,
      relatedIssue: issueUrl,
      issue: num,
    });
    if (items.length >= max) break;
  }

  return items;
}

module.exports = { fetchItems };
