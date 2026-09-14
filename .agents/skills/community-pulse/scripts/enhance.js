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

async function callLlm(prompt) {
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
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
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
    titleEn: clampEnglish(titleEn),
    summaryZh: clampChinese(summaryZh),
    summaryEn: clampEnglish(summaryEn),
    primaryCategory,
    taxonomy,
  };
}

async function localize(item) {
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
      const translated = parseJsonResponse(await callLlm(prompt));
      return validateLocalization({
        titleEn: needsEnglishTitle ? translated.titleEn : item.title,
        summaryZh: translated.summaryZh,
        summaryEn: sourceIsChinese ? translated.summaryEn : sourceDescription,
        primaryCategory: translated.primaryCategory,
        taxonomy: translated.taxonomy,
      }, item);
    } catch (error) {
      lastError = error;
      console.error(`  ${item.title.slice(0, 30)} 尝试${attempt}: ${error.message}`);
    }
  }
  throw new Error(`${item.title}: 双语增强失败（${lastError?.message || '未知错误'}）`);
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
  for (let index = 0; index < pending.length; index += concurrency) {
    const batch = pending.slice(index, index + concurrency);
    const results = await Promise.allSettled(batch.map(localize));
    const failures = [];
    results.forEach((result, resultIndex) => {
      const item = batch[resultIndex];
      if (result.status === 'rejected') {
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
  if (!dry) {
    if (localizedByIndex.size !== items.length) {
      throw new Error(`双语增强不完整：${localizedByIndex.size}/${items.length}`);
    }
    fs.renameSync(checkpointFile, outFile);
  }
  console.error(`完成: ${localizedByIndex.size} 条双语增强`);
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
};
