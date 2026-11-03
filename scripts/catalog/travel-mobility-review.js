#!/usr/bin/env node
/**
 * travel-mobility 分类的**离线复核 + 中文覆盖**：把分类快照里需要复核的条目做成
 * `enrich-travel.js --run` 能吃的队列，再把模型结果落成构建层叠加文件。
 *
 * 为什么是「队列 + 叠加」而不是直接写库：本机连不上 RDS（见 enrich-travel.js 顶部的两跳说明），
 * 写库要另走受审通道；而这次要交付的是站点分类页。分类库是发布时的投影，所以把
 * 复核结论存成 `data/catalog/travel-mobility-overlay.json`，由 `build-site-snapshot.js`
 * 在聚合时应用：规则先挡掉明确的模板误判，模型再逐条判「是不是旅行/出行」，保留的条目
 * 顺手补 `titleZh` / `summaryZh`。模型调用本身**完全复用** `enrich-travel.js --run`
 * （同一个 localize、同一套输入哈希与续跑），这里只负责准备输入和消费输出。
 *
 * 用法：
 *   node scripts/catalog/travel-mobility-review.js --queue \
 *     --out .scratch/travel-queue-2026-11-01.json
 *   node scripts/catalog/enrich-travel.js --run \
 *     --in .scratch/travel-queue-2026-11-01.json \
 *     --out .scratch/travel-progress.json --flush 50 --concurrency 5
 *   node scripts/catalog/travel-mobility-review.js --apply \
 *     --queue .scratch/travel-queue-2026-11-01.json \
 *     --results .scratch/travel-progress.json \
 *     --out data/catalog/travel-mobility-overlay.json
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../../web/shared.js');
const { plainDescription } = require('../../.agents/skills/community-pulse/scripts/enhance.js');

const ROOT = path.resolve(__dirname, '..', '..');
const SNAPSHOT = path.join(ROOT, 'data', 'catalog', 'site-snapshot');
const CATEGORY = path.join(SNAPSHOT, 'categories', 'use-cases', 'travel-mobility.json');
const SOURCE_RAW = path.join(ROOT, '知识', '大家都在做什么', 'source-raw');
const TERM = 'travel-mobility';

function parseArgs(argv) {
  const options = { queue: false, apply: false, gaps: false, in: null, out: null, results: null, category: CATEGORY };
  const booleans = new Set(['--queue', '--apply', '--gaps']);
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined && !booleans.has(name) ? argv[++index] : inline;
    if (name === '--queue') options.queue = true;
    else if (name === '--apply') options.apply = true;
    else if (name === '--gaps') options.gaps = true;
    else if (name === '--in') options.in = path.resolve(value);
    else if (name === '--out') options.out = path.resolve(value);
    else if (name === '--results') options.results = path.resolve(value);
    else if (name === '--category') options.category = path.resolve(value);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

function readCategory(file) {
  if (!fs.existsSync(file)) throw new Error(`找不到分类快照：${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hasText(value) {
  return Boolean(String(value || '').trim());
}

/** 与 build-site-snapshot.js 共用的内容指纹：标题/摘要变了，旧的复核结论就不该继续套用。 */
function contentHash(item) {
  return crypto.createHash('sha256')
    .update(`${String(item.title || '')}\u0000${String(item.summary || '')}`)
    .digest('hex').slice(0, 16);
}

/**
 * 规则能**高置信**直接判掉的只有两类：
 *   · 视频模板名（Hotel Lobby / Raindance / Danse …）—— 命中时无论 title 还是正文都不算旅行；
 *   · 工程/商业术语（time travel、crypto Travel Rule、tour diary、office trip）。
 * 其余「规则说不是」的条目仍交给模型复核：规则是确定性的粗筛，不是最终裁决 ——
 * 例如机场休息室、Schengen short-stay、国际宠物托运，正文里不一定出现旅行词。
 */
function ruleDrop(item) {
  const text = [item.title, item.titleZh, item.titleEn, item.summary, item.summaryZh, item.summaryEn, item.content, item.description, ...(item.tags || [])]
    .filter(Boolean).join(' ').toLowerCase();
  const video = /hotel[ -]?lobby|raindance|\b(?:alors on )?danse\b|bulin ?47|rumpelstiltskin|burning bridges|zombie ai|fireline|\bmigos\b/;
  if (video.test(text)) return 'video-template-name';
  if (/\balps\b/.test(text) && /\b(?:ai video|video generator|video template|特效|模板|短视频)\b/.test(text)) return 'video-template-name';
  if (/\btime[ -]?travel(?:l?ing|l?er|l?ed)?\b|\btravel(?:l?ing|l?er|l?ed)? (?:through|back in) time\b/.test(text)) return 'engineering-phrase:time-travel';
  if (/\btravel rule\b/.test(text)) return 'engineering-phrase:travel-rule';
  if (/\btour diary\b|\boffice trip\b/.test(text)) return 'incidental-phrase';
  return null;
}


function offsetDate(date, days) {
  if (!date) return null;
  const value = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(value.getTime())) return null;
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * 取源记录里的正文。快照只保留 summary；Show HN 的 summary 为空、V2EX 的 summary 只有截图和
 * 一条链接（`translationInput` 剥掉后为空）。这两种情况都只能回源：按 sourceId + externalId
 * 从 source-raw 的当天文件取 `content` / `storyText`，再交给 enrich-travel 的标题兜底。
 */
function sourceContent(item) {
  const sourceId = String(item.sourceId || '');
  const externalId = String(item.externalId || '');
  if (!sourceId || !externalId) return '';
  const dir = path.join(SOURCE_RAW, sourceId);
  if (!fs.existsSync(dir)) return '';
  const dates = [item.trendDate, offsetDate(item.trendDate, -1), offsetDate(item.trendDate, 1)].filter(Boolean);
  for (const date of dates) {
    const file = path.join(dir, `${date}.json`);
    if (!fs.existsSync(file)) continue;
    let document;
    try {
      document = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const records = document.records || document.items || [];
    const record = records.find((candidate) => [candidate.objectID, candidate.externalId, candidate.topicId, candidate.id]
      .some((value) => String(value || '') === externalId));
    if (!record) continue;
    const candidates = [record.content, record.storyText, record.body, record.text, record.description]
      .map((value) => String(value || '').trim()).filter(Boolean);
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0] || '';
  }
  return '';
}

function buildQueue(options) {
  const category = readCategory(options.category);
  const entries = [];
  const keptWithoutCall = [];
  const droppedByRule = [];
  for (const item of category.projects || []) {
    const rule = D.travelMobility(item);
    const reason = ruleDrop(item);
    if (reason) {
      droppedByRule.push({ productId: item.productId, title: item.title, reason, contentHash: contentHash(item) });
      continue;
    }
    const missingTitle = !hasText(item.titleZh);
    const missingSummary = !hasText(item.summaryZh);
    if (options.gaps) {
      // 增量补跑只碰缺口：已有中英标题 + 描述的条目一条都不该进队列，否则会把全分类重跑一遍。
      if (!missingTitle && !missingSummary) {
        keptWithoutCall.push({ productId: item.productId, title: item.title, reason: 'zh-complete' });
        continue;
      }
    } else if (rule.relevant && hasText(item.summaryZh) && hasText(item.titleZh)) {
      // 规则确认为旅行、且已有中文的条目不用再花模型调用；其余（规则否 / 缺中文）都交给模型。
      keptWithoutCall.push({ productId: item.productId, title: item.title, reason: 'rule+zh' });
      continue;
    }
    const summary = String(item.summary || '');
    const content = sourceContent(item).slice(0, 8000);
    // localize() 只吃 desc；summary 是截图/链接时 translationInput 会剥成空，所以这里如实记下
    // 证据来自哪一层，run 阶段再决定是否用标题兜底（validateLocalization 看的是传入的 desc）。
    const evidence = plainDescription(summary) ? 'summary' : plainDescription(content) ? 'content' : 'title';
    entries.push({
      productId: item.productId,
      title: String(item.title || ''),
      desc: summary,
      content,
      evidence,
      missingTitle,
      missingSummary,
      sourceName: String(item.sourceName || ''),
      sourceId: String(item.sourceId || ''),
      url: String(item.url || item.websiteUrl || ''),
      trendDate: String(item.trendDate || ''),
      ruleTaxonomy: (item.taxonomy || {}).useCases || [],
      ruleRelevant: rule.relevant,
      ruleReason: rule.reason,
      gate: 'pass',
    });
  }
  const queue = {
    schemaVersion: 1,
    term: TERM,
    latest: category.latest,
    generatedAt: new Date().toISOString(),
    fetched: (category.projects || []).length,
    gapsOnly: Boolean(options.gaps),
    keptWithoutCall,
    droppedByRule,
    entries,
  };
  fs.writeFileSync(options.out, `${JSON.stringify(queue, null, 2)}\n`);
  const evidence = entries.reduce((counts, entry) => ({ ...counts, [entry.evidence]: (counts[entry.evidence] || 0) + 1 }), {});
  console.log(`[queue] ${queue.fetched} 条：直接保留 ${keptWithoutCall.length}，规则移出 ${droppedByRule.length}，待模型 ${entries.length}`
    + `（证据 ${JSON.stringify(evidence)}）→ ${options.out}`);
}

function buildOverlay(options) {
  const queue = JSON.parse(fs.readFileSync(options.in, 'utf8'));
  const results = JSON.parse(fs.readFileSync(options.results, 'utf8'));
  const byId = new Map();
  for (const result of results.results || []) if (result && result.productId) byId.set(result.productId, result);
  const drops = {};
  const translations = {};
  const groups = new Map();
  const unresolved = [];
  let ruleDropCount = (queue.droppedByRule || []).length;
  for (const drop of queue.droppedByRule || []) {
    drops[drop.productId] = { reason: drop.reason, contentHash: drop.contentHash, title: drop.title };
    groups.set(drop.reason, (groups.get(drop.reason) || 0) + 1);
  }
  for (const entry of queue.entries || []) {
    const result = byId.get(entry.productId);
    if (!result || !result.localized) {
      // 复核没跑出可用结果：规则也不认为它是旅行 → 按规则结论移出；规则认为是旅行则保留，
      // 不因为一次模型失败就把真条目删掉（覆盖率会留下一个小缺口，如实记录）。
      if (entry.ruleRelevant === false) {
        const reason = `review-failed:${result ? 'invalid-output' : 'no-result'}`;
        drops[entry.productId] = { reason, contentHash: contentHash({ title: entry.title, summary: entry.desc }), title: entry.title };
        groups.set(reason, (groups.get(reason) || 0) + 1);
        ruleDropCount += 1;
      } else {
        unresolved.push({ productId: entry.productId, title: entry.title, reason: result ? 'failed' : 'no-result' });
      }
      continue;
    }
    const useCases = result.localized.taxonomy?.useCases || [];
    if (!useCases.includes(TERM)) {
      const reason = `llm:${useCases.join('+') || 'no-use-case'}`;
      drops[entry.productId] = { reason, contentHash: contentHash({ title: entry.title, summary: entry.desc }), title: entry.title };
      groups.set(reason, (groups.get(reason) || 0) + 1);
      continue;
    }
    const titleZh = String(result.localized.titleZh || '').trim();
    const summaryZh = String(result.localized.summaryZh || '').trim();
    if (titleZh || summaryZh) translations[entry.productId] = { titleZh, summaryZh };
  }
  const overlay = {
    schemaVersion: 1,
    term: TERM,
    latest: queue.latest,
    generatedAt: new Date().toISOString(),
    note: '构建层叠加：drops 在 contentHash 一致时把条目移出 travel-mobility；translations 只在库/快照缺中文时补齐。DB 补跑并激活后可删除本文件。',
    drops,
    translations,
    review: {
      fetched: queue.fetched,
      keptWithoutCall: (queue.keptWithoutCall || []).length,
      ruleDrops: ruleDropCount,
      reviewed: (queue.entries || []).length,
      modelDrops: Object.keys(drops).length - ruleDropCount,
      keptByModel: Object.keys(translations).length,
      unresolved: unresolved.length,
      groups: Object.fromEntries([...groups.entries()].sort((a, b) => b[1] - a[1])),
    },
    unresolved,
  };
  fs.writeFileSync(options.out, `${JSON.stringify(overlay, null, 2)}\n`);
  const kept = (queue.fetched || 0) - Object.keys(drops).length;
  console.log(`[apply] 复核 ${overlay.review.reviewed} 条：移出 ${Object.keys(drops).length}（规则 ${overlay.review.ruleDrops} + 模型 ${overlay.review.modelDrops}），补中文 ${Object.keys(translations).length}，未解决 ${unresolved.length}`);
  console.log(`[apply] 预计分类成员：${queue.fetched} → ${kept} → ${options.out}`);
  if (unresolved.length) console.log('[apply] 未解决条目（未移出、也未补中文；重跑 enrich-travel 会续跑）：', unresolved.slice(0, 10));
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  if (options.queue === options.apply) throw new Error('需要 --queue 或 --apply 之一');
  if (!options.out) throw new Error('需要 --out');
  if (options.queue) buildQueue(options);
  else {
    if (!options.in) throw new Error('--apply 需要 --in（队列文件）');
    if (!options.results) throw new Error('--apply 需要 --results（enrich-travel --run 的输出）');
    buildOverlay(options);
  }
}

module.exports = { parseArgs, buildQueue, buildOverlay, ruleDrop, contentHash };
