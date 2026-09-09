/**
 * 521xueweihan/HelloGitHub 月刊正刊 (《HelloGitHub》第 N 期)
 * 数据源: content/HelloGitHubNN.md (数字最大=最新, 但 docs 列表字母序会错, 用数字排序)
 * 条目结构 (按语言分类):
 *   ### C 项目 / ### Go 项目 ...
 *   N、[名称](https://hellogithub.com/periodical/statistics/click?target=<真实URL>)：介绍
 *   可选: 来自 [@分享者](https://hellogithub.com/user/xxx) 的分享
 *
 * 月刊 (每月 28 号更新) → daily_filter=false 不按日过滤
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

function ghText(args, timeout = 30000) {
  try {
    return execFileSync('gh', ['api', ...args], { encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`gh api 失败: ${e.stderr || e.message}`);
  }
}

// 找最新期号: content 目录 HelloGitHubNN.md, 按数字取最大
function latestIssueNumber() {
  const files = ghJson([`repos/${REPO}/contents/content`]);
  const nums = files
    .map(f => f.name.match(/^HelloGitHub(\d+)\.md$/))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10));
  if (!nums.length) throw new Error('content 目录没有期刊物');
  return String(Math.max(...nums));
}

async function fetchItems(src, opts = {}) {
  const max = src.max_items || 30;

  // 发布日判断: 月刊每月 28 号发布 → 只有昨日是 28 号才抓
  if (opts.date) {
    const day = parseInt(opts.date.slice(8, 10), 10);
    if (day !== 28) return [];
  }

  const num = latestIssueNumber();

  const doc = Buffer.from(
    ghText([`repos/${REPO}/contents/content/HelloGitHub${num}.md`, '--jq', '.content']).trim(),
    'base64'
  ).toString('utf8');
  const lines = doc.split('\n');

  const items = [];
  let currentLang = '';
  const titleMatch = lines[0] && lines[0].match(/^#\s+(.+)$/);
  const issueTitle = titleMatch ? titleMatch[1] : `《HelloGitHub》第${num}期`;

  for (const line of lines) {
    const t = line.trim();
    // 语言分类节: ### C 项目 / ### Go 项目 / ### 其它 ...
    const langMatch = t.match(/^###\s+(.+?项目|其它.*)$/);
    if (langMatch) { currentLang = langMatch[1].replace(/项目$/, '').trim(); continue; }
    if (!currentLang) continue;

    // 条目: N、[名称](链接)：介绍
    const m = t.match(/^\d+、\s*\[([^\]]+)\]\(([^)]+)\)\s*[：:]\s*(.*)$/);
    if (!m) continue;
    const [, name, rawUrl, introFull] = m;

    // 链接: hellogithub.com/periodical/statistics/click?target=<真实URL>
    let url = rawUrl;
    const targetMatch = rawUrl.match(/[?&]target=([^&]+)/);
    if (targetMatch) url = decodeURIComponent(targetMatch[1]);

    // 介绍末尾: 来自 [@分享者](hellogithub.com/user/xxx) 的分享
    let intro = introFull;
    let submitter = null;
    const shareMatch = introFull.match(/来自\s*\[@([^\]]+)\]\([^)]*\)\s*的分享$/);
    if (shareMatch) {
      submitter = shareMatch[1];
      intro = introFull.slice(0, shareMatch.index).trim();
    }

    items.push({
      sourceId: src.id,
      title: name,
      url,
      author: submitter || '',
      authorUrl: '',
      publishedAt: null, // 月刊, 无单条日期
      summary: intro,
      content: intro,
      metrics: {},
      tags: ['hellogithub', 'official', currentLang],
      lang: currentLang,
      externalId: `${num}-${name}-${url}`,
      relatedShare: submitter, // 分享者 (对应投稿人)
      issue: num,
    });
    if (items.length >= max) break;
  }

  return items;
}

module.exports = { fetchItems };
