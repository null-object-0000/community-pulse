const D = require('../web/shared.js');

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

function applyEnhancedMarkdown(report, markdown, date) {
  const enhanced = JSON.parse(JSON.stringify(report));
  const sections = parseEnhancedMarkdown(markdown);
  let enhancedCount = 0;
  let totalCount = 0;

  for (const source of enhanced.results || []) {
    if (!source.items?.length) continue;
    const entries = sections.get(source.sourceName) || [];
    source.items.forEach((item) => {
      totalCount += 1;
      const expectedHeading = `${item.title}${item.author ? ` 👤 ${item.author}` : ''}`;
      const normalizedHeading = value => String(value || '').trim().replace(/\s+/g, ' ');
      const entry = entries.find((candidate) => normalizedHeading(candidate.heading) === normalizedHeading(expectedHeading) && !candidate.used);
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
  };
  return enhanced;
}

module.exports = { applyEnhancedMarkdown };
