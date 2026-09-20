const D = require('../web/shared.js');
const { identityFor, productId } = require('./catalog/identity.js');

function parseEnhancedMarkdown(markdown) {
  const sections = new Map();
  let currentSection = null;
  let currentItem = null;

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      currentSection = line.slice(3).replace(/（\d+\s*条）\s*$/, '').trim();
      sections.set(currentSection, []);
      currentItem = null;
      continue;
    }
    if (!currentSection) continue;
    if (line.startsWith('### ')) {
      currentItem = { heading: line.slice(4).trim(), summary: null, localized: null, used: false };
      sections.get(currentSection).push(currentItem);
      continue;
    }
    if (currentItem && line.startsWith('> ')) {
      currentItem.summary = line.slice(2).trim();
      continue;
    }
    if (currentItem && line.startsWith('<!-- devtrends-i18n:')) {
      const encoded = line.match(/^<!-- devtrends-i18n:([A-Za-z0-9+/=]+) -->$/)?.[1];
      if (!encoded) continue;
      try {
        currentItem.localized = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      } catch (_) {
        currentItem.localized = null;
      }
    }
  }
  return sections;
}

/** 报告行的产品库身份：新日报直接带 `productId`，历史日报按同一条实现现算。 */
function itemProductId(item) {
  if (item?.productId) return item.productId;
  try {
    return productId(identityFor(item));
  } catch (_) {
    return '';
  }
}

/**
 * 把 final 的增强结果并进日报。
 *
 * **匹配口径：productId 优先，标题只作历史回退。**
 *
 * 2026-09-18 之前这里只按 `标题 + 👤 作者` 在同一个来源分区里找，三种情况会静默出错：
 * ① 两条同名（find 只能靠顺序兜，顺序一变就串行）；② 标题在 raw 与 final 之间被清理过
 * （09-18 的投稿标签清理就改过标题）→ 匹配不到，整条退回 raw 摘要；③ 来源显示名改了 →
 * 整个分区的摘要全丢，而且 `presentation.summarySource` 只会显示 mixed，看不出少了什么。
 *
 * 现在 final 的 `devtrends-i18n` 记录里带 `productId`（`enhance.js` 从原始 JSON 按
 * 「来源分区 + 顺序」对齐写入），匹配不再依赖任何展示文本。仓库里 14 份 09-18 之前的历史 final
 * 没有这个字段，所以保留标题回退 —— 但只在 `productId` 缺席时走。
 */
function applyEnhancedMarkdown(report, markdown, date) {
  const enhanced = JSON.parse(JSON.stringify(report));
  const sections = parseEnhancedMarkdown(markdown);
  let enhancedCount = 0;
  let totalCount = 0;
  let matchedByProductId = 0;
  let matchedByHeading = 0;

  const normalizedHeading = value => String(value || '').trim().replace(/\s+/g, ' ');

  for (const source of enhanced.results || []) {
    if (!source.items?.length) continue;
    const entries = sections.get(source.sourceName) || [];
    const byProductId = new Map();
    for (const entry of entries) {
      const id = entry.localized?.productId;
      if (id && !byProductId.has(id)) byProductId.set(id, entry);
    }
    source.items.forEach((item) => {
      totalCount += 1;
      const id = itemProductId(item);
      let entry = id ? byProductId.get(id) : null;
      if (entry && !entry.used) matchedByProductId += 1;
      if (!entry) {
        // 历史 final 没有 productId：退回标题匹配，且必须还没被别的行用掉。
        const expectedHeading = `${item.title}${item.author ? ` 👤 ${item.author}` : ''}`;
        entry = entries.find((candidate) => !candidate.localized?.productId
          && normalizedHeading(candidate.heading) === normalizedHeading(expectedHeading) && !candidate.used);
        if (entry) matchedByHeading += 1;
      }
      // A final entry with no quote can still be complete when the source itself had no summary:
      // localization metadata such as category/title proves the item was processed, and retaining an
      // empty source description is more honest than inventing copy at build time.
      const hasFinalSummary = entry?.summary !== null && entry?.summary !== undefined;
      const processedEmptySource = Boolean(entry?.localized) && !String(item.summary || '').trim();
      if (entry && (hasFinalSummary || processedEmptySource)) {
        if (hasFinalSummary) item.summary = entry.summary;
        item.summaryZh = entry.localized?.summaryZh || (hasFinalSummary ? entry.summary : item.summary);
        if (entry.localized?.summaryEn) item.summaryEn = entry.localized.summaryEn;
        if (entry.localized?.titleEn) item.titleEn = entry.localized.titleEn;
        if (D.isCategoryId(entry.localized?.primaryCategory)) item.primaryCategory = entry.localized.primaryCategory;
        const taxonomy = D.normalizeTaxonomy(entry.localized?.taxonomy);
        if (D.taxonomyHasValues(taxonomy)) item.taxonomy = taxonomy;
        item.summarySource = 'llm-final';
        entry.used = true;
        enhancedCount += 1;
      } else {
        item.summarySource = 'raw';
      }
    });
  }

  enhanced.presentation = {
    summarySource: enhancedCount === totalCount ? 'llm-final' : (enhancedCount ? 'mixed' : 'raw'),
    enhancedItemCount: enhancedCount,
    totalItemCount: totalCount,
    finalDate: date,
    // 匹配口径的可见性：productId 命中多少、退回标题多少 —— 后者长期应当趋近 0。
    matchedByProductId,
    matchedByHeading,
  };
  return enhanced;
}

module.exports = { applyEnhancedMarkdown, itemProductId, parseEnhancedMarkdown };
