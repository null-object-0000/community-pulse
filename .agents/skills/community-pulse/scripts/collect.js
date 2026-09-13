#!/usr/bin/env node
/**
 * community-pulse: 从已校验的 source-raw 聚合「大家都在做什么」动态
 * 用法:
 *   node collect.js                          # 每个 enabled 源读取最新本地日文件
 *   node collect.js --date 2026-09-06        # 读取该日的按日来源文件
 *   node collect.js --date 2026-09-07 --observed-date 2026-09-08
 *                                            # Trending 读取实际观察日快照
 *   node collect.js --source producthunt     # 只处理指定源
 *   node collect.js --out file.json          # 输出到文件
 *   node collect.js --summary                # 输出人类可读摘要（配 --date 用于日报）
 */
const fs = require('fs');
const path = require('path');
const { loadItems, loadGithubRepositories, attachGithubRepositories } = require('./source_raw_items');
const { repositoryKey } = require('./github_repo_utils');

const ROOT = __dirname;
const CONFIG = path.join(ROOT, '..', 'config', 'sources.json');
const DEFAULT_REPORT_HISTORY_ROOT = path.resolve(ROOT, '..', '..', '..', '..', '知识', '大家都在做什么', 'raw');
const TRENDING_SOURCES = new Set(['github-trending', 'github-trending-cn']);
const TRENDING_COOLDOWN_DAYS = 3;
const TRENDING_CONTINUATION_LIMIT = 3;

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

// 北京时间 (Asia/Shanghai, UTC+8) 日期字符串 YYYY-MM-DD，不依赖机器时区
function beijingDateStr(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// 北京时间"昨天"的日期字符串
function yesterdayStr() {
  return beijingDateStr(new Date(Date.now() - 86400000));
}

function inDate(iso, dateStr) {
  if (!iso) return false;
  return beijingDateStr(new Date(iso)) === dateStr;
}

// 归一化 URL (去尾部标点/查询参数, 用于跨源匹配)
function normUrl(u) {
  if (!u) return '';
  return u
    .replace(/[),。.\s）】\]]+$/, '')   // 去尾部标点(含中文)
    .replace(/[#?].*$/, '')             // 去查询参数
    .replace(/\/+$/, '')                // 去尾部斜杠
    .toLowerCase();
}

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function itemIdentity(item) {
  const repo = repositoryKey(item.githubUrl || item.github?.url || item.url);
  if (repo) return `github:${repo}`;
  return `item:${(item.author || '').toLowerCase()}|${normUrl(item.url)}`;
}

function recentReports(reportRoot, reportDate, days = TRENDING_COOLDOWN_DAYS) {
  if (!reportDate) return [];
  const reports = [];
  for (let offset = 1; offset <= days; offset += 1) {
    const file = path.join(reportRoot, `${shiftDate(reportDate, -offset)}.json`);
    if (!fs.existsSync(file)) continue;
    reports.push(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return reports;
}

function trendingKeys(report) {
  const keys = new Set();
  for (const result of report?.results || []) {
    if (!TRENDING_SOURCES.has(result.sourceId)) continue;
    for (const item of result.items || []) keys.add(itemIdentity(item));
  }
  return keys;
}

// GitHub's daily Trending page is a rolling window, so a repository commonly
// stays on the list for several days. Keep the source snapshots untouched and
// make the published feed novel: suppress projects shown in the last N reports,
// merge today's global/Chinese overlap by canonical owner/repo, then truncate.
function applyTrendingPolicy(results, options = {}) {
  const cooldownDays = options.cooldownDays ?? TRENDING_COOLDOWN_DAYS;
  const continuationLimit = options.continuationLimit ?? TRENDING_CONTINUATION_LIMIT;
  const historyReports = options.historyReports || [];
  const historyKeys = historyReports.map(trendingKeys);
  const recentlyPublished = new Set(historyKeys.flatMap(keys => [...keys]));
  const current = new Map();
  const continued = [];
  let suppressedCount = 0;

  for (const result of results) {
    if (!TRENDING_SOURCES.has(result.sourceId)) continue;
    const fresh = [];
    let sourceSuppressedCount = 0;
    for (const item of result.items || []) {
      const key = itemIdentity(item);
      const existing = current.get(key);
      if (existing) {
        const names = new Set(existing.item.__mergedSources || [existing.sourceName]);
        names.add(result.sourceName);
        existing.item.__mergedSources = [...names];
        existing.item.__mergedCount = names.size;
        continue;
      }

      const entry = { item, sourceName: result.sourceName };
      current.set(key, entry);
      if (recentlyPublished.has(key)) {
        const recentAppearances = historyKeys.filter(keys => keys.has(key)).length;
        item.trendingContinuation = {
          cooldownDays,
          recentAppearances,
        };
        continued.push(item);
        suppressedCount += 1;
        sourceSuppressedCount += 1;
      } else {
        fresh.push(item);
      }
    }

    const sourceMax = options.maxItemsBySource?.get(result.sourceId) ?? fresh.length;
    result.items = fresh.slice(0, sourceMax);
    // A global row below its display cap must not reserve the repository key:
    // if the same project ranks highly on the Chinese list, that list may still
    // publish it. Kept rows retain global-list priority.
    for (const item of fresh.slice(sourceMax)) {
      const key = itemIdentity(item);
      if (current.get(key)?.item === item) current.delete(key);
    }
    if (result.sourceRaw) {
      result.sourceRaw.novelItemCount = fresh.length;
      result.sourceRaw.suppressedRecentCount = sourceSuppressedCount;
      result.sourceRaw.outputItemCount = result.items.length;
    }
  }

  const continuedItems = continued
    .sort((a, b) => Number(b.metrics?.today || 0) - Number(a.metrics?.today || 0))
    .slice(0, continuationLimit)
    // This compact report section does not render logos, screenshots or the
    // full repository snapshot. Keeping only display fields avoids duplicating
    // large metadata and leaking unsynchronised image URLs into site JSON.
    .map(item => ({
      sourceId: item.sourceId,
      title: item.title,
      url: item.url,
      githubUrl: item.githubUrl,
      metrics: { today: Number(item.metrics?.today || 0) },
      trendingContinuation: item.trendingContinuation,
      ...(item.__mergedSources ? { __mergedSources: item.__mergedSources } : {}),
    }));
  return {
    cooldownDays,
    suppressedCount,
    continuedItems,
  };
}

// GitHub 仓库信息 → 一行小字 (⭐ 1.2k · 🍴 45 · Python · MIT · 创建于 2024-03 · 3天前更新)
function ghBadge(g) {
  const parts = [];
  // Zero is meaningful: it tells the reader that the repository snapshot was
  // loaded successfully and the metric is actually zero, rather than missing.
  if (g.stars != null) parts.push(`⭐ ${fmtK(g.stars)}`);
  if (g.forks != null) parts.push(`🍴 ${fmtK(g.forks)}`);
  if (g.language) parts.push(g.language);
  if (g.license) parts.push(g.license);
  if (g.createdAt) parts.push(`📅 ${g.createdAt.slice(0, 10)} 创建`);
  if (g.updatedAt) parts.push(`🔄 ${g.updatedAt.slice(0, 10)} 更新`);
  return parts.join(' · ');
}

function linkLabel(url, it, preferredLabel = '') {
  if (preferredLabel) return preferredLabel;
  let hostname = '';
  try { hostname = new URL(url).hostname.toLowerCase(); } catch (_) { /* keep generic label */ }
  if (hostname === 'github.com' || hostname.endsWith('.github.com')) return 'GitHub';
  if (hostname === 'vibecafe.ai' || hostname.endsWith('.vibecafe.ai')) return 'VibeCafé';
  if (hostname === 'producthunt.com' || hostname.endsWith('.producthunt.com')) return 'Product Hunt';
  if (/\b(?:article|blog|news)\b/i.test(url) || /(?:文章|博客|周刊|月刊)/.test(it.title || '')) return '原文';
  return '官网';
}

function itemLinks(it) {
  const links = [];
  const seen = new Set();
  const add = (url, preferredLabel = '') => {
    if (!url) return;
    const cleanUrl = String(url).replace(/[),。.）\s]+$/, '');
    const key = normUrl(cleanUrl);
    if (!key || seen.has(key)) return;
    seen.add(key);
    links.push(`[${linkLabel(cleanUrl, it, preferredLabel)}](${cleanUrl})`);
  };
  add(it.url);
  add(it.websiteUrl, '官网');
  add(it.githubUrl, 'GitHub');
  add(it.vibecafeUrl, 'VibeCafé');
  add(it.issueUrl, '投稿页');
  add(it.relatedIssue, '投稿页');
  return links.length ? `\n\n🔗 ${links.join(' · ')}` : '';
}

// 只渲染 source-raw 中已经存在的源站指标，不联网补数。
function sourceMetricBadge(it) {
  const metrics = it.metrics || {};
  if ((it.tags || []).includes('github-trending')) {
    const parts = [];
    if (!it.github && metrics.stars > 0) parts.push(`⭐ ${fmtK(metrics.stars)}`);
    if (metrics.today > 0) parts.push(`今日 +${fmtK(metrics.today)}`);
    if (!it.github && metrics.forks > 0) parts.push(`🍴 ${fmtK(metrics.forks)}`);
    if (!it.github && metrics.lang) parts.push(metrics.lang);
    return parts.join(' · ');
  }
  if (it.sourceId === 'producthunt') {
    const parts = [];
    if (metrics.votes > 0) parts.push(`▲ ${fmtK(metrics.votes)}`);
    if (metrics.comments > 0) parts.push(`💬 ${fmtK(metrics.comments)}`);
    return parts.join(' · ');
  }
  return '';
}

// 数字 → k 缩写: 1234 → 1.2k, 12000 → 12k
function fmtK(n) {
  if (n == null || isNaN(n)) return '0';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// 去重: GitHub 项目优先按规范化 owner/repo，其余按作者+URL；
// 保留创建时间最新，并为跨源条目标注全部来源。
function dedupe(results) {
  // 展平所有条目并分组
  const groups = new Map(); // key = sourceId|canonical item identity -> items[]
  const items = [];
  for (const r of results) {
    for (const it of r.items) {
      items.push({ ...it, __source: r.sourceId, __sourceName: r.sourceName });
      const key = `${r.sourceId}|${itemIdentity(it)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
  }

  // A: 源内去重 (同 sourceId+作者+URL, 保留最新)
  const keep = new Set(); // 保留的 externalId+sourceId
  const removed = new Set(); // sourceId|externalId of removed
  const dupLog = [];
  for (const [key, list] of groups) {
    if (list.length <= 1) { keep.add(`${list[0].sourceId}|${list[0].externalId}`); continue; }
    // 按 publishedAt 降序, 保留最新
    const sorted = [...list].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
    keep.add(`${sorted[0].sourceId}|${sorted[0].externalId}`);
    for (const it of sorted.slice(1)) {
      removed.add(`${it.sourceId}|${it.externalId}`); // 源内重复的移除
      dupLog.push(`[源内去重] ${it.sourceId} ${it.author}: ${(it.title || '').slice(0, 30)} (保留 ${sorted[0].publishedAt})`);
    }
  }

  // B: 跨源聚合 (不同 sourceId 的同一项目，保留最新并标注来源)
  const crossGroups = new Map(); // key = canonical item identity -> items[]
  for (const it of items) {
    const key = itemIdentity(it);
    if (!crossGroups.has(key)) crossGroups.set(key, []);
    crossGroups.get(key).push(it);
  }
  for (const [key, list] of crossGroups) {
    const sources = new Set(list.map(it => it.__source));
    if (sources.size <= 1) continue;
    // 保留最新 (跨源)
    const sorted = [...list].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
    const keeper = sorted[0];
    const srcNames = [...new Set(list.map(it => it.__sourceName))];
    for (const it of sorted.slice(1)) {
      // 被并入的条目: 从 removed 集合中移除 (仅当它原本要保留)
      removed.add(`${it.__source}|${it.externalId}`);
      dupLog.push(`[跨源聚合] ${it.author}: ${(it.title || '').slice(0, 30)} (并入 ${keeper.__sourceName}, 来源: ${srcNames.join('+')})`);
    }
    // 标记 keeper 的来源 (按 sourceId+externalId 查找原 results 里的对象)
    const keepId = `${keeper.__source}|${keeper.externalId}`;
    for (const r of results) {
      for (const it of r.items) {
        if (`${r.sourceId}|${it.externalId}` === keepId) {
          it.__mergedSources = srcNames;
          it.__mergedCount = list.length;
        }
      }
    }
  }

  // 重建 results (去掉被去重的)
  const newResults = results.map(r => ({
    ...r,
    items: r.items.filter(it => !removed.has(`${r.sourceId}|${it.externalId}`)),
  }));

  // 打印日志
  for (const l of dupLog) console.error(l);
  return newResults;
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const only = getArg('--source');
  const onlyList = only ? only.split(',').map(s => s.trim()).filter(Boolean) : null;
  const outFile = getArg('--out');
  const jsonOut = getArg('--json-out'); // 与 --markdown 同时输出 JSON (一次抓取, 双产物)
  const dateFilter = getArg('--date') || (args.includes('--yesterday') ? yesterdayStr() : null);
  const observedDate = getArg('--observed-date');
  const rawRoot = getArg('--source-raw-root');
  const reportHistoryRoot = path.resolve(getArg('--report-history-root') || DEFAULT_REPORT_HISTORY_ROOT);
  const summary = args.includes('--summary');
  const markdown = args.includes('--markdown');
  const strict = args.includes('--strict');
  const requireGithubRepositories = args.includes('--require-github-repositories');
  const enrichGithub = args.includes('--enrich-github') || process.env.ENRICH_GITHUB === '1';
  if (enrichGithub) {
    throw new Error('--enrich-github 会二次访问网络，已从 source-raw 单一真值链路禁用');
  }

  const cfg = loadConfig();
  const sources = cfg.sources.filter(s => s.enabled && (!onlyList || onlyList.includes(s.id)));

  const results = [];
  for (const src of sources) {
    try {
      // Trending must be filtered for novelty before max_items is applied, or
      // repeated top rows leave holes while unseen lower-ranked rows are lost.
      const loaded = loadItems(src, {
        date: dateFilter,
        observedDate,
        rawRoot,
        maxItems: TRENDING_SOURCES.has(src.id) && dateFilter ? Infinity : undefined,
      });
      let items = loaded.items;
      if (dateFilter && src.daily_filter !== false) {
        items = items.filter(it => inDate(it.publishedAt, dateFilter));
      }
      results.push({ sourceId: src.id, sourceName: src.name, sourceRaw: loaded.sourceRaw, items });
      console.error(`[ok] ${src.id}: ${items.length} items from source-raw/${src.id}/${loaded.sourceRaw.targetDate}.json`);
    } catch (e) {
      results.push({ sourceId: src.id, sourceName: src.name, items: [], error: String(e && e.message || e) });
      console.error(`[fail] ${src.id}: ${e.message}`);
    }
  }

  let githubRepositoryError = null;
  if (dateFilter) {
    try {
      const snapshot = loadGithubRepositories(rawRoot, dateFilter);
      attachGithubRepositories(results, snapshot.repositories);
      console.error(`[ok] github-repositories: ${snapshot.repositories.size} repositories from source-raw/github-repositories/${dateFilter}.json`);
    } catch (error) {
      githubRepositoryError = error;
      console.error(`[fail] github-repositories: ${error.message}`);
    }
  }

  if (strict) {
    const failures = results.filter((result) => result.error);
    if (failures.length || (requireGithubRepositories && githubRepositoryError)) {
      const messages = failures.map((item) => `${item.sourceId}: ${item.error}`);
      if (requireGithubRepositories && githubRepositoryError) messages.push(`github-repositories: ${githubRepositoryError.message}`);
      throw new Error(`source-raw input failed: ${messages.join('; ')}`);
    }
  }

  const maxItemsBySource = new Map(sources.map(source => [source.id, source.max_items || Infinity]));
  const trendingPolicy = dateFilter
    ? applyTrendingPolicy(results, {
      historyReports: recentReports(reportHistoryRoot, dateFilter),
      maxItemsBySource,
    })
    : null;
  if (trendingPolicy) {
    console.error(`[trending novelty] ${trendingPolicy.suppressedCount} recent repositories suppressed; ${trendingPolicy.continuedItems.length} kept as continuation highlights`);
  }

  // 去重: 源内重复(保留最新) + 跨源聚合(保留最新, 标注来源)
  const deduped = dedupe(results);
  // 替换 results 引用 (后续 markdown/json 输出用 deduped)
  results.splice(0, results.length, ...deduped);

  if (markdown) {
    // Markdown 格式产物 (发 .md 文件用)
    const dateLabel = dateFilter || '最新';
    const lines = [`# 📰 大家都在做什么 · ${dateLabel}`, ''];
    for (const r of results) {
      if (r.error) { lines.push(`## ${r.sourceName} ❌ 抓取失败`, '', r.error, ''); continue; }
      if (!r.items.length) continue; // 0 条不显示 (如非发布日的周刊/月刊)
      lines.push(`## ${r.sourceName}（${r.items.length} 条）`, '');
      for (const it of r.items) {
        const author = it.author ? ` 👤 ${it.author}` : '';
        // 跨源聚合标注: 放描述区下方另起一行, 不进标题
        const mergedTag = it.__mergedSources && it.__mergedSources.length > 1
          ? `\n\n📌 同时收录于：${it.__mergedSources.join('、')}`
          : '';
        // 标题统一使用纯文字；所有链接在内容下方单独展示。
        const title = it.title;
        const desc = it.summary ? `\n> ${it.summary}` : '';
        // GitHub 仓库信息: 独立段落 (不带 > 引用, 与描述分开; 仅当条目是 GitHub 开源项目且有补全数据)
        const ghBadgeStr = [it.github ? ghBadge(it.github) : '', sourceMetricBadge(it)].filter(Boolean).join(' · ');
        const ghLine = ghBadgeStr ? `\n\n${ghBadgeStr}` : '';
        const linkLine = itemLinks(it);
        lines.push(`### ${title}${author}${desc}${ghLine}${linkLine}${mergedTag}`, '');
        lines.push('');
      }
    }
    if (trendingPolicy?.continuedItems.length) {
      lines.push(`## GitHub Trending·持续热门（${trendingPolicy.continuedItems.length} 条）`, '', `> 这些项目已在最近 ${trendingPolicy.cooldownDays} 期日报出现，本期不重复展开。`, '');
      for (const it of trendingPolicy.continuedItems) {
        const today = Number(it.metrics?.today || 0);
        const metric = today > 0 ? ` · 今日 +${fmtK(today)} stars` : '';
        const appearances = it.trendingContinuation?.recentAppearances || 1;
        lines.push(`- [${it.title}](${it.githubUrl || it.url}) · 近 ${trendingPolicy.cooldownDays} 期出现 ${appearances} 次${metric}`);
      }
      lines.push('');
    }
    const text = lines.join('\n');
    if (outFile) {
      fs.writeFileSync(outFile, text);
      console.log(`written to ${outFile}`);
    } else {
      process.stdout.write(text);
    }
    // 一次抓取同时输出 JSON (供存档/回溯/分析)
    if (jsonOut) {
      const generatedAt = new Date().toISOString();
      const out = { generatedAt, fetchedAt: generatedAt, inputMode: 'source-raw', date: dateFilter || null, observedDate: observedDate || null, results, ...(trendingPolicy ? { trendingPolicy } : {}) };
      fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2));
      console.log(`written to ${jsonOut}`);
    }
  } else if (summary) {
    // 可读摘要 (cron 用, stdout 直接投递飞书)
    const dateLabel = dateFilter || '最新';
    console.log(`📰 大家都在做什么 · ${dateLabel}`);
    for (const r of results) {
      if (r.error) { console.log(`\n【${r.sourceName}】❌ 抓取失败: ${r.error}`); continue; }
      console.log(`\n【${r.sourceName}】${r.items.length} 条`);
      for (const it of r.items.slice(0, 5)) {
        const m = it.metrics || {};
        const score = Object.values(m).filter(v => v).join(' / ');
        console.log(`- ${it.title}${score ? `  (${score})` : ''}\n  ${it.url}`);
      }
      if (r.items.length > 5) console.log(`  … 还有 ${r.items.length - 5} 条`);
    }
  } else {
    const generatedAt = new Date().toISOString();
    const out = { generatedAt, fetchedAt: generatedAt, inputMode: 'source-raw', date: dateFilter || null, observedDate: observedDate || null, results, ...(trendingPolicy ? { trendingPolicy } : {}) };
    const text = JSON.stringify(out, null, 2);
    if (outFile) {
      fs.writeFileSync(outFile, text);
      console.log(`written to ${outFile}`);
    } else {
      process.stdout.write(text);
    }
  }
}

if (require.main === module) main().catch(e => { console.error('FATAL', e); process.exit(1); });

module.exports = {
  applyTrendingPolicy,
  dedupe,
  itemIdentity,
  recentReports,
  shiftDate,
  trendingKeys,
};
