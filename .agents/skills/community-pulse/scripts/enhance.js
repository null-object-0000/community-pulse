#!/usr/bin/env node
/** Generate a Chinese delivery report plus hidden bilingual site metadata. */
const fs = require('fs');
const crypto = require('crypto');
const D = require('../../../../web/shared.js');

const BASE = process.env.COMMUNITY_PULSE_LLM_BASE || 'http://127.0.0.1:18640/v1';
const MODEL = process.env.COMMUNITY_PULSE_LLM_MODEL || 'flowlet-flash';
const KEY = process.env.COMMUNITY_PULSE_LLM_KEY || process.env.HERMES_CUSTOM_127_0_0_1_18640_API_KEY || '';
const MAX_ZH_LEN = 100;
const MAX_EN_LEN = 240;
const PROMPT_VERSION = 'enhance-localize-v3';
// flowlet-pro 是推理模型：reasoning_content 与正文共享 max_tokens 预算。
// 预算过小时思考会吃满额度，导致 content 为空、finish_reason=length。
const MAX_TOKENS = parseInt(process.env.COMMUNITY_PULSE_LLM_MAX_TOKENS || '32000', 10);

function hasChinese(value) {
  return /[\u3400-\u9fff]/u.test(String(value || ''));
}

function plainDescription(value) {
  return String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ').trim();
}

function translationInput(value, max = 900) {
  const clean = plainDescription(value);
  if (clean.length <= max) return clean;
  const prefix = clean.slice(0, max);
  const boundary = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('.'), prefix.lastIndexOf('；'), prefix.lastIndexOf(';'));
  return (boundary >= Math.floor(max * 0.6) ? prefix.slice(0, boundary + 1) : prefix).trim();
}

function sourceHash(item) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([item.heading, item.title, item.desc, item.section]))
    .digest('hex');
}

function clamp(value, max, punctuation) {
  const clean = String(value || '').replace(/^(?:摘要|翻译|summary|translation)\s*[：:]\s*/i, '').trim();
  if (clean.length <= max) return clean;
  const prefix = clean.slice(0, max);
  const boundary = Math.max(...punctuation.map(mark => prefix.lastIndexOf(mark)));
  return boundary >= Math.floor(max * 0.4) ? prefix.slice(0, boundary + 1) : `${prefix.slice(0, max - 1).trimEnd()}…`;
}

function clampChinese(value) {
  return clamp(value, MAX_ZH_LEN, ['。', '！', '；', '？']);
}

function clampEnglish(value) {
  return clamp(value, MAX_EN_LEN, ['.', '!', '?', ';']);
}

function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function rateLimitDelayMs(attempt, retryAfter = 0, random = Math.random) {
  const exponential = Math.min(30_000, 750 * (2 ** Math.max(0, attempt - 1)));
  return Math.max(retryAfter, exponential) + Math.floor(random() * 750);
}

async function callLlm(prompt, options = {}) {
  options.onRequest?.();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      max_tokens: MAX_TOKENS,
    }),
  });
  if (!res.ok) {
    const error = new Error(`LLM HTTP ${res.status}`);
    error.status = res.status;
    error.retryAfterMs = retryAfterMs(res.headers.get('retry-after'));
    throw error;
  }
  const data = await res.json();
  const content = String(data.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('返回空');
  return content;
}

function parseJsonResponse(content) {
  const clean = String(content).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('返回内容不含 JSON 对象');
  return JSON.parse(clean.slice(start, end + 1));
}

function validateLocalization(value, item) {
  const titleEn = hasChinese(item.title) ? String(value.titleEn || '').trim() : item.title.trim();
  const sourceDescription = translationInput(item.desc);
  let summaryZh = String(value.summaryZh || '').trim();
  let summaryEn = String(value.summaryEn || '').trim();
  const chineseCount = (text) => (String(text).match(/[\u3400-\u9fff]/gu) || []).length;
  const sourceHasLatinBrand = /[A-Za-z]{2}/.test(item.title);
  if (sourceDescription) {
    if (!hasChinese(summaryZh)) throw new Error('summaryZh 缺少中文译文');
    if (!/[A-Za-z]{3}/.test(summaryEn) || chineseCount(summaryEn) > 8) throw new Error('summaryEn 不是英文译文');
    if (hasChinese(sourceDescription) && sourceDescription.length <= MAX_ZH_LEN) summaryZh = sourceDescription;
    if (!hasChinese(sourceDescription) && sourceDescription.length <= MAX_EN_LEN) summaryEn = sourceDescription;
  } else {
    summaryZh = '';
    summaryEn = '';
  }
  if (hasChinese(item.title) && (!/[A-Za-z]{2}/.test(titleEn)
    || (!sourceHasLatinBrand && hasChinese(titleEn)) || chineseCount(titleEn) > 6)) {
    throw new Error('titleEn 不是英文标题');
  }
  const primaryCategory = String(value.primaryCategory || '').trim();
  if (!D.isCategoryId(primaryCategory)) throw new Error(`primaryCategory 不在预设分类中：${primaryCategory || '空'}`);
  if (!value.taxonomy || typeof value.taxonomy !== 'object') throw new Error('taxonomy 缺失');
  const facetLimits = { useCases: 2, agentRoles: 2, productForms: 2, platforms: 3, integrations: 5 };
  for (const [name, allowed] of Object.entries(D.taxonomyFacets)) {
    const selected = value.taxonomy[name];
    const allowedIds = new Set(allowed.map(([id]) => id));
    if (!Array.isArray(selected) || selected.length > facetLimits[name] || selected.some(id => !allowedIds.has(id))) throw new Error(`taxonomy.${name} 含无效或过多标签`);
  }
  const taxonomy = D.normalizeTaxonomy(value.taxonomy);
  if (!taxonomy.useCases.length) throw new Error('taxonomy.useCases 至少需要一个受控业务场景');
  return {
    schemaVersion: 3,
    sourceHash: sourceHash(item),
    // 产品库身份：消费端（scripts/enhanced-report.js）按它匹配，不再按「标题 + 作者」。
    // 由调用方从原始 JSON 按「来源分区 + 顺序」挂到 item 上（见 productIdsForItems）；
    // 老 .work 断点里的记录没有这个字段，续跑时由 normalizeRecords 补上。
    ...(item.productId ? { productId: item.productId } : {}),
    // 加工版本：同一份结果由哪个提示词版本、哪个模型产出 —— 换模型/改提示词后要能分辨。
    promptVersion: PROMPT_VERSION,
    model: MODEL,
    titleEn: clampEnglish(titleEn),
    summaryZh: clampChinese(summaryZh),
    summaryEn: clampEnglish(summaryEn),
    primaryCategory,
    taxonomy,
  };
}

async function localize(item, options = {}) {
  const productHunt = /^Product Hunt\b/i.test(item.section || '');
  const sourceNote = productHunt
    ? '这段简介优先来自 Product Hunt 产品主页。概括产品本身，不要把某次发布更新误当成整体定位。'
    : '准确保留项目的用途、关键功能和有区分度的信息。';
  const sourceDescription = plainDescription(item.desc);
  const sourceIsChinese = hasChinese(sourceDescription);
  const needsEnglishTitle = hasChinese(item.title);
  const requested = sourceIsChinese
    ? `${needsEnglishTitle ? '"titleEn":"英文标题",' : ''}"summaryZh":"中文摘要","summaryEn":"英文摘要","primaryCategory":"分类ID","taxonomy":{"useCases":["ID"],"agentRoles":["ID"],"productForms":["ID"],"platforms":["ID"],"integrations":["ID"]}`
    : `${needsEnglishTitle ? '"titleEn":"英文标题",' : ''}"summaryZh":"中文摘要","primaryCategory":"分类ID","taxonomy":{"useCases":["ID"],"agentRoles":["ID"],"productForms":["ID"],"platforms":["ID"],"integrations":["ID"]}`;
  const direction = sourceIsChinese
    ? `把描述翻译并归纳为不超过 ${MAX_EN_LEN} 个字符的自然英文摘要。`
    : `把描述翻译并归纳为不超过 ${MAX_ZH_LEN} 个字符的简洁中文摘要。`;
  const titleRule = needsEnglishTitle
    ? '同时生成自然、简洁的英文标题；保留已有英文品牌名、仓库名、型号和人名，翻译中文说明部分。'
    : '';
  const categoryRules = D.categories.map(category => `- ${category.id}: ${category.description}`).join('\n');
  // Sub-topics are spelled out with their parent so the model picks the narrowest id instead of
  // emitting both levels (which `normalizeTaxonomy` would collapse anyway, but silently).
  const facetRules = Object.entries(D.taxonomyFacets).map(([name, values]) => `${name}: ${values.map(([id, zh]) => {
    const parent = D.facetParent(name, id);
    return `${id}（${zh}${parent ? `，${D.facetLabel(name, parent, 'zh-CN')}的二级主题` : ''}）`;
  }).join('、')}`).join('\n');
  const prompt = `为 DevTrends 翻译并归类一条内容。${sourceNote}${direction}${titleRule}
从下面的固定分类中选择一个最能描述项目主要用途和目标用户的分类。必须只选一个。按产品解决的问题归类，不按来源、开源状态或作者身份归类；AI、React、自托管等只是实现或次要功能时，不要据此归类；确实无法判断才选 other。
${categoryRules}
再从以下受控分面中选择标签，只能使用列出的 ID：
${facetRules}
useCases 表示项目解决的业务场景，必须选 1–2 个；标注了二级主题的必须先看二级主题，命中就只写那个最细的 ID，不要再写它的上级（例如小说创作只写 novel-writing，不要同时写 content-creation）；agentRoles 只在项目属于 Agent 生态时选 0–2 个，并区分垂直 Agent、能力扩展、管理编排、可观测性、评测安全和运行时；productForms 选 0–2 个；platforms 选 0–3 个；integrations 选 0–5 个。编程语言不是运行平台，不要把 Python、TypeScript 等填进 platforms。没有可靠证据的可选分面返回空数组。
描述来自社区投稿，可能混着投稿模板的字段名（「项目地址」「项目标题」「项目描述」「必写」「类别」等）、空字段占位（「No response」「暂无」「待补充」）、残缺标签（「官网有演示：」）或 markdown 链接语法。摘要只写项目本身：不要出现这些字段名、占位符、模板残句和链接语法。
不添加原文没有的信息，不输出宣传套话或解释。只输出严格 JSON：{${requested}}

标题：${item.title}
描述：${sourceDescription}`;

  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const translated = parseJsonResponse(await callLlm(prompt, options));
      let localized;
      try {
        localized = validateLocalization({
          titleEn: needsEnglishTitle ? translated.titleEn : item.title,
          summaryZh: translated.summaryZh,
          summaryEn: sourceIsChinese ? translated.summaryEn : sourceDescription,
          primaryCategory: translated.primaryCategory,
          taxonomy: translated.taxonomy,
        }, item);
      } catch (error) {
        // 校验层拒绝是**条目本身的属性**：模型读完这段描述仍给不出受控业务场景
        // （典型是「标题 lost、正文 good」这类垃圾投稿），重试 5 次也不会变好。
        // 标成 itemLevel 交给调用方决定 —— 跳过这一条，而不是让它卡死整期。
        // 与它相对的是 callLlm 的 HTTP/网络错误：那是系统性故障，必须整批失败。
        error.itemLevel = true;
        throw error;
      }
      return localized;
    } catch (error) {
      lastError = error;
      console.error(`  ${item.title.slice(0, 30)} 尝试${attempt}: ${error.message}`);
      // 条目级失败（校验层拒绝）：重试不会变好，立刻停手交给调用方跳过。
      if (error.itemLevel) break;
      if (error.status === 429 && attempt < 5) {
        const delay = rateLimitDelayMs(attempt, error.retryAfterMs, options.random);
        await (options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(delay);
      }
    }
  }
  // **标记必须转递**：这里另抛一个新 Error，如果丢掉 `itemLevel`，调用方就会把
  // 一条垃圾投稿误判成系统性故障、整期中止 —— 那正是这个函数要修的问题本身。
  const fatal = new Error(`${item.title}: 双语增强失败（${lastError?.message || '未知错误'}）`);
  if (lastError?.itemLevel) fatal.itemLevel = true;
  throw fatal;
}

function decodeMetadataComment(line) {
  const encoded = String(line).match(/^<!-- devtrends-i18n:([A-Za-z0-9+/=]+) -->$/)?.[1];
  if (!encoded) return null;
  try { return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); } catch (_) { return null; }
}

function cachedLocalizations(markdown) {
  const cached = new Map();
  for (const line of String(markdown || '').split('\n')) {
    const localized = decodeMetadataComment(line);
    if (localized?.sourceHash) cached.set(localized.sourceHash, localized);
  }
  return cached;
}

function extractItems(md) {
  const lines = md.split('\n');
  const items = [];
  let section = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('## ')) section = line.replace(/^##\s+/, '').replace(/（\d+\s*条）\s*$/, '');
    if (!line.startsWith('### ')) continue;
    const heading = line.slice(4);
    const authorAt = heading.lastIndexOf(' 👤 ');
    const title = authorAt >= 0 ? heading.slice(0, authorAt) : heading;
    const desc = lines[index + 1]?.startsWith('> ') ? lines[index + 1].slice(2) : '';
    items.push({ idx: index, heading, title, desc, section });
  }
  return items;
}

/**
 * markdown 条目 → 原始 JSON 条目的 productId，按「来源分区 + 出现顺序」对齐。
 *
 * **不按标题匹配**：`renderMarkdown` 是按 `results → source → items` 的顺序渲染的，所以某个
 * 分区里第 k 个 `### ` 就是该来源的第 k 条 —— 标题被清理过、两条同名、作者为空都不会错位。
 * 标题匹配那套（旧的消费端实现）在这三种情况下会静默丢摘要或串行。
 */
function productIdsForItems(items, report) {
  const bySection = new Map();
  for (const result of report?.results || []) {
    if (!result.items?.length) continue;
    bySection.set(result.sourceName, result.items);
  }
  const cursor = new Map();
  const ids = new Map();
  for (const item of items) {
    const index = cursor.get(item.section) || 0;
    cursor.set(item.section, index + 1);
    const productId = bySection.get(item.section)?.[index]?.productId;
    if (productId) ids.set(item.idx, productId);
  }
  return ids;
}

/** 续跑恢复出来的老记录没有 productId / 加工版本：按当前对齐结果补齐，避免为此重跑 LLM。 */
function normalizeRecords(items, localizedByIndex, productIds) {
  for (const item of items) {
    const localized = localizedByIndex.get(item.idx);
    if (!localized) continue;
    if (!localized.productId && productIds.get(item.idx)) localized.productId = productIds.get(item.idx);
    if (!localized.promptVersion) localized.promptVersion = PROMPT_VERSION;
    if (!localized.model) localized.model = MODEL;
  }
}

function metadataComment(localized) {
  return `<!-- devtrends-i18n:${Buffer.from(JSON.stringify(localized)).toString('base64')} -->`;
}

function renderLocalizedMarkdown(md, items, localizedByIndex) {
  const lines = md.split('\n');
  const output = [];
  const itemsByIndex = new Map(items.map(item => [item.idx, item]));
  for (let index = 0; index < lines.length; index += 1) {
    const item = itemsByIndex.get(index);
    const localized = item && localizedByIndex.get(index);
    if (!localized) {
      output.push(lines[index]);
      continue;
    }
    output.push(lines[index]);
    if (item.desc) {
      index += 1;
      output.push(`> ${localized.summaryZh}`);
    }
    output.push(metadataComment(localized));
  }
  return output.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
  const inFile = getArg('--md');
  const outFile = getArg('--out');
  const dry = args.includes('--dry-run');
  if (!inFile || !outFile) throw new Error('用法: node enhance.js --md in.md --out out.md [--dry-run]');

  const markdown = fs.readFileSync(inFile, 'utf8');
  const items = extractItems(markdown);
  // 原始 JSON 默认按同目录同名推断（raw/<date>.md → raw/<date>.json）；缺了不报错，
  // 只是这一期没有 productId，消费端会退回标题匹配。
  const jsonFile = getArg('--json') || inFile.replace(/\.md$/, '.json');
  let productIds = new Map();
  if (fs.existsSync(jsonFile)) {
    productIds = productIdsForItems(items, JSON.parse(fs.readFileSync(jsonFile, 'utf8')));
    for (const item of items) if (productIds.has(item.idx)) item.productId = productIds.get(item.idx);
    console.error(`产品身份: ${productIds.size}/${items.length} 条对齐到 productId（来源 ${jsonFile}）`);
  } else {
    console.error(`⚠️  没有原始 JSON（${jsonFile}）：本期增强结果不带 productId，消费端只能按标题匹配`);
  }
  const localizedByIndex = new Map();
  const checkpointFile = `${outFile}.work`;
  const cached = fs.existsSync(checkpointFile)
    ? cachedLocalizations(fs.readFileSync(checkpointFile, 'utf8'))
    : new Map();
  for (const item of items) {
    const localized = cached.get(sourceHash(item));
    if (localized && localized.schemaVersion >= 3 && D.isCategoryId(localized.primaryCategory) && D.normalizeTaxonomy(localized.taxonomy).useCases.length) localizedByIndex.set(item.idx, localized);
  }
  const concurrency = parseInt(process.env.ENHANCE_CONCURRENCY || '5', 10);
  const pending = items.filter(item => !localizedByIndex.has(item.idx));
  console.error(`共 ${items.length} 条，已恢复 ${localizedByIndex.size} 条，待生成 ${pending.length} 条中英双语内容...`);
  /** 条目级失败：模型读完这段描述仍给不出受控业务场景（垃圾投稿居多）。跳过，不卡死整期。 */
  const skipped = new Map();
  for (let index = 0; index < pending.length; index += concurrency) {
    const batch = pending.slice(index, index + concurrency);
    const results = await Promise.allSettled(batch.map(localize));
    const failures = [];
    results.forEach((result, resultIndex) => {
      const item = batch[resultIndex];
      if (result.status === 'rejected') {
        // **区分两种失败**：条目自身分类不了（跳过，本期少这一条的中文）
        // 与系统性故障（LLM 网关/网络/限流打满 —— 必须整批停下来，绝不静默产出一期残缺日报）。
        if (result.reason?.itemLevel) {
          skipped.set(item.idx, String(result.reason.message || '未知原因'));
          console.error(`[跳过] ${item.title.slice(0, 30)}：${result.reason.message}`);
          return;
        }
        failures.push(result.reason);
        return;
      }
      const localized = result.value;
      localizedByIndex.set(item.idx, localized);
      console.error(`[中英双语] ${item.title.slice(0, 30)} (${localized.summaryZh.length}/${localized.summaryEn.length}字)`);
    });
    if (!dry) fs.writeFileSync(checkpointFile, renderLocalizedMarkdown(markdown, items, localizedByIndex));
    if (failures.length) throw failures[0];
  }
  normalizeRecords(items, localizedByIndex, productIds);
  if (!dry) {
    if (localizedByIndex.size + skipped.size !== items.length) {
      throw new Error(`双语增强不完整：${localizedByIndex.size}+${skipped.size}/${items.length}`);
    }
    if (skipped.size) {
      // 跳过的条目在日报里保持原文（无中文摘要），所以必须显式报出来 —— 静默少几条
      // 比整期失败更难发现。数量异常多通常说明提示词或分类表出了问题，不只是投稿质量差。
      console.error(`⚠️  ${skipped.size} 条因无法归类被跳过（保留原文）：`);
      for (const [idx, reason] of skipped) {
        const item = items.find(entry => entry.idx === idx);
        console.error(`    - ${item ? item.title.slice(0, 40) : `#${idx}`}：${reason}`);
      }
    }
    // 摘要为空本身不算错（源描述缺失时 validateLocalization 会主动清空，宁可留空也不让模型编），
    // 但「源描述非空却产出空摘要」一律是 bug —— 校验只查条数查不到它，历史上 13 条 Show HN
    // 空摘要就是这样静默通过了整条流水线。这里把它变成硬失败。
    const hollow = items.filter((item) => {
      if (skipped.has(item.idx)) return false; // 跳过的条目本来就没有摘要，不是「源描述非空却产出空摘要」
      if (!translationInput(item.desc)) return false;
      const localized = localizedByIndex.get(item.idx);
      return !localized || !String(localized.summaryZh || '').trim() || !String(localized.summaryEn || '').trim();
    });
    if (hollow.length) {
      throw new Error(`摘要缺失：${hollow.length} 条源描述非空却产出空摘要（${hollow.slice(0, 3).map((item) => item.title.slice(0, 24)).join(' / ')}）`);
    }
    fs.renameSync(checkpointFile, outFile);
  }
  const emptySummaries = items.filter((item) => {
    const localized = localizedByIndex.get(item.idx);
    return localized && !String(localized.summaryZh || '').trim();
  }).length;
  console.error(`完成: ${localizedByIndex.size} 条双语增强${emptySummaries ? `（其中 ${emptySummaries} 条因源描述缺失而留空）` : ''}`);
}

if (require.main === module) {
  main().catch(error => { console.error('FATAL', error.message); process.exit(1); });
}

module.exports = {
  hasChinese,
  plainDescription,
  translationInput,
  sourceHash,
  clampChinese,
  clampEnglish,
  parseJsonResponse,
  validateLocalization,
  localize,
  extractItems,
  metadataComment,
  decodeMetadataComment,
  cachedLocalizations,
  renderLocalizedMarkdown,
  productIdsForItems,
  normalizeRecords,
  PROMPT_VERSION,
  retryAfterMs,
  rateLimitDelayMs,
};
