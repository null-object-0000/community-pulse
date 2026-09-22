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
 *   - `productId` 同理只在**原来就有**的时候改写（已发布日报 2026-09-20 起带这个字段）：地址变了
 *     身份就变了，不同步改写会让 `check:report-identity` 门禁判「日报行与产品库漂移」，而产品库
 *     那一行正是按新身份导入的。写成「有就对齐」而不是「地址变了才对齐」，是为了让脚本可重复跑：
 *     第一次修地址、第二次补身份，两次都收敛到同一个结果（`revoke-products.js` 的撤销计划也才能
 *     在重跑后复现）；
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
const { identityFor, productId } = require('./catalog/identity.js');

const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, '知识', '大家都在做什么');
const RAW_DIR = path.join(BASE, 'raw');
const FINAL_DIR = path.join(BASE, 'final');
const SOURCE_RAW = path.join(BASE, 'source-raw');
const ISSUE_SOURCES = ['weekly-issues', 'hellogithub-issues'];

// 布尔开关必须单独判，**不能**跟着取下一个 argv：否则 `--dry-run --plan x` 会把 `--plan`
// 当成 `--dry-run` 的值吃掉，然后报「unknown argument: x」（这个 bug 真出现过一次）。
const BOOLEAN_FLAGS = new Set(['--dry-run', '--include-url-only']);

function parseArgs(argv) {
  const options = { dryRun: false, start: null, end: null, dates: null, includeUrlOnly: false, audit: null, plan: null, categories: null };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    if (BOOLEAN_FLAGS.has(name)) {
      if (name === '--dry-run') options.dryRun = true;
      else options.includeUrlOnly = true;
      continue;
    }
    const value = inline === undefined ? argv[++index] : inline;
    if (name === '--audit') options.audit = value;
    else if (name === '--plan') options.plan = value;
    else if (name === '--categories') options.categories = new Set(value.split(',').map((item) => item.trim()).filter(Boolean));
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
  // 地址（或仓库身份）变了，product_id 就会变。已发布日报 2026-09-20 起自带 `productId`，
  // 不同步改写会与导入链算出的身份漂移，`check:report-identity` 直接退出码 1。
  if (item.productId) {
    const nextProductId = productId(identityFor(next));
    if (nextProductId !== item.productId) next.productId = nextProductId;
  }
  // 比**最终字段值**，不是比仓库 key：`webc-site/wedb_embed` 已被改名成 `fastalp`，快照里的
  // 事实带着改名后的地址，于是「key 变了」但 `githubUrl` 原样 —— 那种行不该被算成改动。
  const same = next.url === item.url
    && (next.githubUrl || '') === (item.githubUrl || '')
    && (next.productId || '') === (item.productId || '')
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

/**
 * 同日 `final/<date>.md` 的增强记录按 `productId` 匹配（`scripts/enhanced-report.js`），
 * 所以地址修好、身份变了之后，final 里那条记录也要跟着换 key —— 否则那一行的 LLM 摘要、
 * 英文标题与分类整条掉回 raw，`presentation.summarySource` 从 `llm-final` 变成 `mixed`。
 *
 * 只改 base64 里的 `productId` 一个字段，其余字节（含 `sourceHash`）原样：这是同一条投稿的
 * 同一次增强结果，换的只是它的身份键。返回 `{ markdown, replaced }`。
 */
function replaceFinalProductId(markdown, oldId, newId) {
  let replaced = 0;
  const lines = String(markdown).split('\n').map((line) => {
    const encoded = line.match(/^<!-- devtrends-i18n:([A-Za-z0-9+/=]+) -->$/)?.[1];
    if (!encoded) return line;
    let localized;
    try {
      localized = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch {
      return line;
    }
    if (!localized || localized.productId !== oldId) return line;
    replaced += 1;
    // 展开式保持键序（`productId` 本来就在原位），所以除这一个值外 base64 解回来逐字相同。
    return `<!-- devtrends-i18n:${Buffer.from(JSON.stringify({ ...localized, productId: newId })).toString('base64')} -->`;
  });
  return { markdown: lines.join('\n'), replaced };
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
  const report = { version: 'backfill-issue-entity-v1', dryRun: options.dryRun, includeUrlOnly: options.includeUrlOnly, categories: options.categories ? [...options.categories] : null, dates: [], changed: [], urlOnlySkipped: [], filteredOut: [], finalPatched: [], finalMissing: [], skipped: [] };
  for (const date of rawDates(options)) {
    const jsonPath = path.join(RAW_DIR, `${date}.json`);
    const mdPath = path.join(RAW_DIR, `${date}.md`);
    const finalPath = path.join(FINAL_DIR, `${date}.md`);
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const bodies = issueBodies(date);
    const repositories = repositoryFacts(date);
    let markdown = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : null;
    let finalMarkdown = fs.existsSync(finalPath) ? fs.readFileSync(finalPath, 'utf8') : null;
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
          // 旧 / 新产品身份：撤销旧行、核对新行都要用，算法与导入链同一条（identity.js）。
          oldProductId: productId(identityFor(item)),
          newProductId: productId(identityFor(next)),
          before: { url: item.url, githubUrl: item.githubUrl || null, productId: item.productId || null },
          after: { url: next.url, githubUrl: next.githubUrl || null, productId: next.productId || null },
        };
        entry.category = classify(entry);
        if (options.categories && !options.categories.has(entry.category)) {
          report.filteredOut.push({ date, externalId: item.externalId, category: entry.category });
          continue;
        }
        if (markdown !== null) {
          const updated = replaceLinkLine(markdown, item, next);
          if (updated === null) { report.skipped.push({ ...entry, reason: 'markdown_line_not_unique' }); continue; }
          markdown = updated;
        }
        // 身份变了就把同日 final 的匹配键一起换掉，否则这一行的 LLM 增强会掉回 raw。
        if (finalMarkdown !== null && entry.before.productId && entry.before.productId !== entry.after.productId) {
          const patched = replaceFinalProductId(finalMarkdown, entry.before.productId, entry.after.productId);
          if (patched.replaced) {
            finalMarkdown = patched.markdown;
            report.finalPatched.push({ date, externalId: item.externalId, from: entry.before.productId, to: entry.after.productId, records: patched.replaced });
          } else {
            // final 里没有这条记录：那一行本来就没拿到 LLM 增强，只记一笔，不算失败。
            report.finalMissing.push({ date, externalId: item.externalId, productId: entry.before.productId });
          }
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
      if (finalMarkdown !== null) fs.writeFileSync(finalPath, finalMarkdown);
    }
  }
  if (options.plan) {
    fs.writeFileSync(path.resolve(options.plan), `${JSON.stringify({
      version: 'issue-entity-plan-v1', generatedAt: new Date().toISOString(), includeUrlOnly: options.includeUrlOnly,
      entries: report.changed.map((entry) => ({ ...entry, reason: entry.kind === 'repo' ? 'identity-repair' : 'url-shape' })),
    }, null, 2)}\n`);
    console.log(`plan written to ${options.plan}`);
  }
  if (options.audit) {
    fs.writeFileSync(path.resolve(options.audit), auditMarkdown(report));
    console.log(`audit written to ${options.audit}`);
  }
  console.log(JSON.stringify(report, null, 2));
  console.log(`${options.dryRun ? '[dry-run] ' : ''}改了 ${report.changed.length} 行，涉及 ${report.dates.length} 个日报日`);
}

if (require.main === module) main();
module.exports = { parseArgs, rawDates, issueBodies, reidentify, replaceLinkLine, replaceFinalProductId, classify, auditMarkdown };
