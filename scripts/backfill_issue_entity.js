#!/usr/bin/env node
/**
 * 投稿实体识别的历史回填：把 `raw/<date>.json` 与 `raw/<date>.md` 里**只错在链接字段**的行，
 * 改成按现行规则（显式「项目地址 / 开源地址 / 仓库地址」字段优先）算出来的地址。
 *
 * 为什么不直接重跑 collect：`raw/*.json` 里没有记录当时的 Trending 观察日（老文件连 `sourceRaw`
 * 都没有），用今天的 `--observed-date` 重跑会换掉 Trending 那一整段数据；而且今天的规则会顺带
 * 重算历史行的简介与配图 —— 09-17 定下的口径是「历史简介只删残骸、不重算」。所以这里只动
 * `url` / `githubUrl` / `github` 三个字段和 md 的 `🔗` 行，其余字节不动。
 *
 * 边界：
 *   - 只处理 `weekly-issues` / `hellogithub-issues`（投稿源），其它来源一行都不碰；
 *   - `githubUrl` / `github` 只在**原来就有**的时候改写或删除 —— 老 raw 文件本来就没有这两个字段
 *     （仓库事实是 09-13 才进 item 的），凭空加上会带出与本次修复无关的形状变化；
 *   - 找不到对应 source-raw 正文、或 md 里匹配不唯一时跳过并报告，不猜。
 *
 * 用法：
 *   node scripts/backfill_issue_entity.js --dry-run
 *   node scripts/backfill_issue_entity.js --start 2026-01-01 --end 2026-09-03
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  issueProjectLinks, loadGithubRepositories, loadItems,
} = require('../.agents/skills/community-pulse/scripts/source_raw_items.js');
const { itemLinks } = require('../.agents/skills/community-pulse/scripts/collect.js');
const { repositoryKey } = require('../.agents/skills/community-pulse/scripts/github_repo_utils.js');

const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, '知识', '大家都在做什么');
const RAW_DIR = path.join(BASE, 'raw');
const SOURCE_RAW = path.join(BASE, 'source-raw');
const ISSUE_SOURCES = ['weekly-issues', 'hellogithub-issues'];

function parseArgs(argv) {
  const options = { dryRun: false, start: null, end: null, dates: null, includeUrlOnly: false, audit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined ? argv[++index] : inline;
    if (name === '--dry-run') options.dryRun = true;
    else if (name === '--include-url-only') options.includeUrlOnly = true;
    else if (name === '--audit') options.audit = value;
    else if (name === '--start') options.start = value;
    else if (name === '--end') options.end = value;
    else if (name === '--date') (options.dates = options.dates || []).push(value);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

function rawDates(options) {
  const all = fs.readdirSync(RAW_DIR).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, 10)).sort();
  return all.filter((date) => (!options.dates || options.dates.includes(date))
    && (!options.start || date >= options.start) && (!options.end || date <= options.end));
}

/** 当天的投稿正文：externalId → { body, html_url }。 */
function issueBodies(date) {
  const map = new Map();
  for (const sourceId of ISSUE_SOURCES) {
    const file = path.join(SOURCE_RAW, sourceId, `${date}.json`);
    if (!fs.existsSync(file)) continue;
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const record of document.records || []) {
      if (record.pull_request) continue;
      map.set(`${sourceId}|${record.number}`, { body: record.body || '', html_url: record.html_url || '' });
    }
  }
  return map;
}

/** 仓库事实快照（老日期没有这份文件，返回 null）。 */
function repositoryFacts(date) {
  try {
    return loadGithubRepositories(SOURCE_RAW, date).repositories;
  } catch {
    return null;
  }
}

/** 按现行规则重算一行的链接字段；返回 null 表示不需要改。 */
function reidentify(item, issue, repositories) {
  const issueUrl = item.issueUrl || issue.html_url || item.url;
  const links = issueProjectLinks(issue.body, issueUrl);
  const beforeKey = repositoryKey(item.githubUrl || item.github?.url || item.url);
  const afterKey = repositoryKey(links.githubUrl || links.url);
  const next = { ...item, url: links.url };
  // 老 raw 文件本来就没有 githubUrl / github（仓库事实是 09-13 才进 item 的），
  // 只有原来就带这两个字段、并且**仓库身份真的变了**的时候才改写，避免带出无关的形状变化。
  const hadRepoFields = item.githubUrl !== undefined || item.github !== undefined;
  const repoChanged = beforeKey !== afterKey;
  if (hadRepoFields && repoChanged) {
    const facts = links.githubUrl && repositories ? repositories.get(repositoryKey(links.githubUrl)) : null;
    if (links.githubUrl) {
      next.githubUrl = facts?.url || links.githubUrl;
      next.github = facts || { url: next.githubUrl };
    } else {
      delete next.githubUrl;
      delete next.github;
    }
  }
  // 比**最终字段值**，不是比仓库 key：`webc-site/wedb_embed` 已被改名成 `fastalp`，快照里的
  // 事实带着改名后的地址，于是「key 变了」但 `githubUrl` 原样 —— 那种行不该被算成改动。
  const same = next.url === item.url
    && (next.githubUrl || '') === (item.githubUrl || '')
    && JSON.stringify(next.github || null) === JSON.stringify(item.github || null);
  if (same) return null;
  // 两类改动：`repo` 是实体识别（仓库身份变了，或仓库地址被换成快照里的规范地址），
  // `url-only` 是历史行里早期 URL 边界规则的残留（`https://x.com）`、`…/repo）。`）——
  // 机械损坏，但属于另一件事，默认不动，要一起修得显式加 --include-url-only。
  const repoFieldsChanged = (next.githubUrl || '') !== (item.githubUrl || '') || beforeKey !== afterKey;
  return { next, kind: repoFieldsChanged ? 'repo' : 'url-only' };
}

/** 把 md 里这一行的 `🔗` 行换成新的；匹配不唯一时返回 null（不猜）。 */
function replaceLinkLine(markdown, item, next) {
  const lines = markdown.split('\n');
  const wanted = new Set([item.url, item.githubUrl].filter(Boolean));
  const candidates = [];
  let heading = '';
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('### ')) heading = lines[index];
    if (!lines[index].startsWith('🔗 ')) continue;
    const matchesUrl = [...wanted].some((url) => lines[index].includes(url));
    if (matchesUrl && heading.includes(item.title)) candidates.push(index);
  }
  if (candidates.length !== 1) return null;
  const replacement = itemLinks(next).trim();
  const updated = [...lines];
  updated[candidates[0]] = replacement;
  return updated.join('\n');
}

/** 历史影响清单：按「旧地址是什么」分类，方便人工判断这批改动该不该整批落。 */
function classify(entry) {
  const old = entry.before.url || '';
  const before = entry.before.githubUrl || '';
  const after = entry.after.githubUrl || '';
  // 先判「根本不是项目页」的地址，再判仓库子页面 —— 否则 `github.com/user-attachments/...`
  // 会先被 `github.com/<owner>/<repo>/` 那条吃掉。
  if (/^https?:\/\/(?:github\.com\/user-attachments|raw\.githubusercontent\.com|img\.shields\.io|camo\.githubusercontent\.com)/i.test(old)) return 'junk';
  if (/^https?:\/\/(?:apps\.apple\.com|chromewebstore\.google\.com|marketplace\.visualstudio\.com|plugins\.jenkins\.io|crates\.io|www\.npmjs\.com|huggingface\.co|mp\.weixin\.qq\.com|www\.bilibili\.com|zhuanlan\.zhihu\.com|x\.com|twitter\.com|youtu\.be|www\.youtube\.com|t\.me|linux\.do|imgur\.com)/i.test(old)) return 'junk';
  if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\//i.test(old)) return 'subpage';
  if (/\/issues\/\d+/i.test(old)) return 'issue-envelope';
  if (before && after && before !== after) return 'repo-swap';
  if (/^https?:\/\/(?:www\.)?github\.com\//i.test(old)) return 'repo-root';
  return 'website';
}

function auditMarkdown(report) {
  const groups = new Map();
  for (const entry of report.changed) {
    const kind = classify(entry);
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(entry);
  }
  const lines = [
    '# 投稿实体识别的历史影响清单',
    '',
    '> 由 `node scripts/backfill_issue_entity.js --dry-run --include-url-only --audit <本文件>` 生成。',
    '> 只统计 `weekly-issues` / `hellogithub-issues` 两个投稿源，判定依据是现行规则',
    '> （显式「项目地址 / 开源地址 / 仓库地址」字段优先，见 `source_raw_items.issueProjectLinks`）。',
    '',
    `涉及 **${report.changed.length}** 行、**${report.dates.length}** 个日报日；另有 **${report.urlOnlySkipped.length}** 行只错在 URL 形态（尾部标点等）。`,
    '',
    '## 怎么读这份清单',
    '',
    'A / C / D 三类是**地址根本指错了对象**（图片、徽章、商店页、仓库子页面、官网），改成仓库地址',
    '都是明确改善；E 类多是「正文先提到的底座项目 / 组织页」被换成作者自己声明的仓库；',
    'F 类是显式字段与正文链接指向两个不同仓库，按「显式字段优先」处理，需要人工确认一次。',
    '这 434 行的**旧地址**就是它们的旧产品身份，所以落这批改动会同时影响 MySQL 产品库：',
    '旧身份的产品行不会被 upsert 覆盖（导入只有 upsert、没有撤销），需要配套的定向撤销 / 合并。',
    '',
  ];
  const order = ['junk', 'issue-envelope', 'subpage', 'website', 'repo-root', 'repo-swap'];
  const label = {
    junk: 'A. 旧地址是图片 / 徽章 / 商店 / 视频等，根本不是项目页',
    'issue-envelope': 'B. 旧地址是投稿页本身（当时没认出仓库）',
    subpage: 'C. 旧地址是仓库里的子页面（tree / blob / releases）',
    website: 'D. 旧地址是官网，新地址是仓库',
    'repo-root': 'E. 旧地址已是仓库根，只是被换成另一个仓库',
    'repo-swap': 'F. 旧仓库地址被换成另一个仓库（需要人工看）',
  };
  for (const kind of order) {
    const entries = groups.get(kind) || [];
    if (!entries.length) continue;
    lines.push(`## ${label[kind]}（${entries.length} 行）`, '');
    lines.push('| 日报日 | 源 | 编号 | 标题 | 旧 | 新 |', '|---|---|---|---|---|---|');
    for (const entry of entries) {
      const title = String(entry.title || '').replace(/\|/g, '\\|').slice(0, 46);
      lines.push(`| ${entry.date} | ${entry.sourceId} | ${entry.externalId} | ${title} | ${entry.before.url} | ${entry.after.url} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = { version: 'backfill-issue-entity-v1', dryRun: options.dryRun, includeUrlOnly: options.includeUrlOnly, dates: [], changed: [], urlOnlySkipped: [], skipped: [] };  for (const date of rawDates(options)) {
    const jsonPath = path.join(RAW_DIR, `${date}.json`);
    const mdPath = path.join(RAW_DIR, `${date}.md`);
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const bodies = issueBodies(date);
    const repositories = repositoryFacts(date);
    let markdown = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : null;
    const touched = [];
    for (const result of raw.results || []) {
      if (!ISSUE_SOURCES.includes(result.sourceId)) continue;
      for (const item of result.items || []) {
        const issue = bodies.get(`${result.sourceId}|${item.externalId}`);
        if (!issue) { report.skipped.push({ date, sourceId: result.sourceId, externalId: item.externalId, reason: 'no_source_body' }); continue; }
        const outcome = reidentify(item, issue, repositories);
        if (!outcome) continue;
        const { next, kind } = outcome;
        if (kind === 'url-only' && !options.includeUrlOnly) {
          report.urlOnlySkipped.push({ date, sourceId: result.sourceId, externalId: item.externalId, before: item.url, after: next.url });
          continue;
        }
        const entry = {
          date, sourceId: result.sourceId, externalId: item.externalId, title: item.title, kind,
          before: { url: item.url, githubUrl: item.githubUrl || null },
          after: { url: next.url, githubUrl: next.githubUrl || null },
        };
        if (markdown !== null) {
          const updated = replaceLinkLine(markdown, item, next);
          if (updated === null) { report.skipped.push({ ...entry, reason: 'markdown_line_not_unique' }); continue; }
          markdown = updated;
        }
        // 就地改写：先删掉 next 里已经没有的键（仓库身份消失时），再合并。
        for (const key of Object.keys(item)) if (!(key in next)) delete item[key];
        Object.assign(item, next);
        touched.push(entry);
      }
    }
    if (!touched.length) continue;
    report.dates.push(date);
    report.changed.push(...touched);
    if (!options.dryRun) {
      // 与 collect.js 完全一致的序列化：2 空格缩进、结尾没有换行。
      fs.writeFileSync(jsonPath, JSON.stringify(raw, null, 2));
      if (markdown !== null) fs.writeFileSync(mdPath, markdown);
    }
  }
  if (options.audit) {
    fs.writeFileSync(path.resolve(options.audit), auditMarkdown(report));
    console.log(`audit written to ${options.audit}`);
  }
  console.log(JSON.stringify(report, null, 2));
  console.log(`${options.dryRun ? '[dry-run] ' : ''}改了 ${report.changed.length} 行，涉及 ${report.dates.length} 个日报日`);
}

if (require.main === module) main();
module.exports = { parseArgs, rawDates, issueBodies, reidentify, replaceLinkLine, classify, auditMarkdown };
