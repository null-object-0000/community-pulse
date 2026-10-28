const D = require('../web/shared.js');

// Raw Markdown stays in observation order for enhance.js's positional identity mapping.
// Fold only the finished document/download; all headings and i18n records survive.
function foldAuthorMarkdown(markdown, report, locale = 'zh-CN') {
  if (!report?.authorPolicy || markdown.includes('<!-- devtrends-author-fold -->')) return markdown;
  const sections = markdown.split(/(?=^## )/m);
  let changed = false;
  const output = sections.map(section => {
    const header = section.match(/^## (.+?)(?:（\d+\s*条）)?\s*\n/);
    if (!header) return section;
    const source = report.results.find(result => result.sourceName === header[1]);
    if (!source) return section;
    const chunks = section.split(/(?=^### )/m), intro = chunks.shift();
    const byHeading = new Map();
    for (const item of source.items || []) {
      const heading = `${item.title}${item.author ? ` 👤 ${item.author}` : ''}`;
      if (!byHeading.has(heading)) byHeading.set(heading, []);
      byHeading.get(heading).push(item);
    }
    const rows = chunks.map(block => {
      const heading = block.split('\n')[0].slice(4).trim();
      return { ...(byHeading.get(heading)?.shift() || {}), block };
    });
    const entries = D.authorEntries(rows);
    const fold = (entry, rows, overflow) => {
      if (!rows.length) return '';
      changed = true;
      return `\n<details class="author-fold">\n<summary>${D.escapeHtml(D.authorFoldLabel(entry.item, rows.length, locale, overflow))}</summary>\n\n${rows.map(row => row.block).join('')}</details>\n\n`;
    };
    return intro + entries.map(entry => entry.item.block + fold(entry, entry.related, false) + fold(entry, entry.overflow, true)).join('');
  }).join('');
  return changed ? `<!-- devtrends-author-fold -->\n${output}` : markdown;
}
function englishReportMarkdown(report, date) {
  const draw = (item, level = 2) => `${'#'.repeat(level)} ${D.displayTitle(item, 'en')}\n\n${D.summary(item, 'en').text}\n\n${D.safeUrl(item.githubUrl || item.websiteUrl || item.url)}\n\n`;
  const fold = (entry, rows, overflow) => rows.length ? `<details>\n<summary>${D.escapeHtml(D.authorFoldLabel(entry.item, rows.length, 'en', overflow))}</summary>\n\n${rows.map(item => draw(item, 3)).join('')}</details>\n\n` : '';
  return `# ${D.t('en', 'slogan')} · ${date}\n\n` + D.authorEntries(D.reportItems(report)).map(entry => draw(entry.item) + fold(entry, entry.related, false) + fold(entry, entry.overflow, true)).join('');
}
module.exports = { foldAuthorMarkdown, englishReportMarkdown };
