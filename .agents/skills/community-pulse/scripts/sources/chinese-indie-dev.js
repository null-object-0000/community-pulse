/**
 * 1c7/chinese-independent-developer 中国独立开发者项目
 * 数据源: GitHub README (gh CLI 已认证)
 * 结构: ### YYYY 年 M 月 D 号添加 分节, 每节:
 *   #### 作者 - [Github](url)
 *   * :状态: [项目名](url)：介绍
 * 状态: :white_check_mark:=已上线 :clock8:=开发中 :x:=已关闭
 */
const { execFileSync } = require('child_process');

const REPO = '1c7/chinese-independent-developer';

function getReadme() {
  try {
    const out = execFileSync('gh', ['api', `repos/${REPO}/readme`, '--jq', '.content'], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024,
    });
    return Buffer.from(out.trim(), 'base64').toString('utf8');
  } catch (e) {
    throw new Error(`gh 读 README 失败: ${e.stderr || e.message}`);
  }
}

// "2026 年 9 月 5 号添加" → "2026-09-05" (北京时间日期, 与 README 一致)
function parseSectionDate(line) {
  const m = line.match(/###\s+(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*号/);
  if (!m) return null;
  return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

// 解析一条项目行: * :white_check_mark: [名称](url)：介绍
function parseItemLine(line, sourceId, author, dateStr) {
  const m = line.match(/^\*\s*:(white_check_mark|clock8|x):\s*\[([^\]]+)\]\(([^)]+)\)\s*[：:]\s*(.*)$/);
  if (!m) return null;
  const [, status, name, url, intro] = m;
  const statusMap = { white_check_mark: '已上线', clock8: '开发中', x: '已关闭' };
  return {
    sourceId,
    title: name,
    url,
    author,
    authorUrl: '',
    publishedAt: dateStr ? `${dateStr}T00:00:00+08:00` : null,
    summary: intro,
    content: intro,
    metrics: {},
    tags: ['indie-dev', statusMap[status] || status],
    externalId: `${dateStr}-${name}-${url}`,
  };
}

async function fetchItems(src, opts = {}) {
  const sourceId = src.id;
  const max = src.max_items || 50;
  const readme = getReadme();
  const lines = readme.split('\n');

  const items = [];
  let currentDate = null;
  let currentAuthor = '';

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    const d = parseSectionDate(t);
    if (d) { currentDate = d; currentAuthor = ''; continue; }

    // 作者行: #### 名称 - [Github](url)
    const authorMatch = t.match(/^####\s+(.+?)\s*-\s*\[Github\]\(([^)]*)\)/);
    if (authorMatch) { currentAuthor = authorMatch[1].trim(); continue; }

    // 项目行
    if (/^\*\s*:/.test(t)) {
      const it = parseItemLine(t, sourceId, currentAuthor, currentDate);
      if (it) items.push(it);
    }
  }

  // 按日期过滤 (昨日)
  if (opts.date) {
    return items.filter(it => it.publishedAt && it.publishedAt.slice(0, 10) === opts.date).slice(0, max);
  }
  return items.slice(0, max);
}

module.exports = { fetchItems };
