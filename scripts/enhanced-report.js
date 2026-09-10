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
      currentItem = { heading: line.slice(4).trim(), summary: null, used: false };
      sections.get(currentSection).push(currentItem);
      continue;
    }
    if (currentItem && line.startsWith('> ')) {
      currentItem.summary = line.slice(2).trim();
      currentItem = null;
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
      const entry = entries.find((candidate) => candidate.heading === expectedHeading && !candidate.used);
      if (entry?.summary !== null && entry?.summary !== undefined) {
        item.summary = entry.summary;
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
