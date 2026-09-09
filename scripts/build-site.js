const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, '知识', '大家都在做什么', 'raw');
const webDir = path.join(root, 'web');
const outputDir = path.join(root, 'dist');
const reportsDir = path.join(outputDir, 'data', 'reports');
const markdownDir = path.join(outputDir, 'data', 'markdown');
const finalDir = path.join(root, '知识', '大家都在做什么', 'final');
const siteOrigin = 'https://devtrends.site';

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const escapeXml = (value = '') => escapeHtml(value);

function reportItems(report) {
  return (report.results || []).flatMap((source) =>
    (source.items || []).map((item) => ({ ...item, sourceName: source.sourceName })),
  );
}

function itemUrl(item) {
  return item.websiteUrl || item.githubUrl || item.github?.url || item.url || siteOrigin;
}

function renderSeoItem(item) {
  const url = escapeHtml(itemUrl(item));
  const title = escapeHtml(item.title || '未命名项目');
  const summary = escapeHtml(item.summary || item.tagline || item.content || '暂无简介');
  const source = escapeHtml(item.sourceName || item.sourceId || '社区动态');
  const author = item.author ? `<span>by ${escapeHtml(item.author)}</span>` : '';
  const stars = item.github?.stars ?? item.metrics?.stars;
  const forks = item.github?.forks ?? item.metrics?.forks;
  const today = item.metrics?.today;
  const votes = item.metrics?.votes;
  const comments = item.metrics?.comments;
  const language = item.github?.language || item.metrics?.lang;
  const metrics = [
    language ? `<span><i class="language-dot"></i>${escapeHtml(language)}</span>` : '',
    stars !== undefined ? `<span>☆ ${escapeHtml(stars)}</span>` : '',
    forks !== undefined ? `<span>⑂ ${escapeHtml(forks)}</span>` : '',
    votes !== undefined ? `<span>▲ ${escapeHtml(votes)}</span>` : '',
    comments !== undefined ? `<span>◌ ${escapeHtml(comments)}</span>` : '',
  ].filter(Boolean).join('');
  const visual = item.image
    ? `<img class="item-visual" src="${escapeHtml(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<div class="item-visual item-fallback" aria-hidden="true">${escapeHtml((item.sourceId || '•').slice(0, 2))}</div>`;

  return `<article class="feed-item">${visual}<div class="item-content"><div class="item-source">${source}${author}</div><h2><span class="repo-icon">▣</span><a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a></h2><p class="summary">${summary}</p><div class="item-meta"><div class="metrics">${metrics}</div><div class="links"><a href="${url}" target="_blank" rel="noopener noreferrer">查看 ↗</a></div></div></div><div class="github-item-actions"><a href="${url}" target="_blank" rel="noopener noreferrer">☆&nbsp; Star</a>${today !== undefined ? `<b>☆ ${escapeHtml(today)} stars today</b>` : ''}</div><div class="ph-item-actions"><span>◌<b>${escapeHtml(comments ?? '—')}</b></span><a href="${url}" target="_blank" rel="noopener noreferrer">△<b>${escapeHtml(votes ?? '—')}</b></a></div></article>`;
}

function renderPage(template, report, date, canonicalUrl) {
  const items = reportItems(report);
  const sourceNames = (report.results || []).filter((source) => source.items?.length).map((source) => source.sourceName);
  const isHomepage = canonicalUrl === `${siteOrigin}/`;
  const title = isHomepage ? 'DevTrends 开发者趋势｜大家都在做什么' : `${date} 开发者趋势日报｜DevTrends`;
  const description = isHomepage
    ? '每日聚合 GitHub Trending、VibeCafé、Product Hunt 与中文独立开发者社区的新项目、新产品和开源趋势。'
    : `${date} 开发者趋势日报，共收录 ${items.length} 条动态，来自 ${sourceNames.slice(0, 4).join('、')}等社区。`;
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    description,
    url: canonicalUrl,
    inLanguage: 'zh-CN',
    datePublished: date,
    publisher: {
      '@type': 'Organization',
      name: 'DevTrends 开发者趋势',
      url: siteOrigin,
      logo: `${siteOrigin}/logo.svg`,
    },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: items.length,
      itemListElement: items.slice(0, 100).map((item, index) => ({
        '@type': 'ListItem', position: index + 1, name: item.title, url: itemUrl(item),
      })),
    },
  };

  return template
    .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escapeHtml(description)}" />`)
    .replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${canonicalUrl}" />`)
    .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${escapeHtml(title)}" />`)
    .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${escapeHtml(description)}" />`)
    .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${canonicalUrl}" />`)
    .replace(/<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${escapeHtml(title)}" />`)
    .replace(/<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${escapeHtml(description)}" />`)
    .replace('</head>', `    <script type="application/ld+json">${JSON.stringify(structuredData).replace(/</g, '\\u003c')}</script>\n  </head>`)
    .replace('<div id="feed" class="feed" aria-live="polite"></div>', `<div id="feed" class="feed" aria-live="polite">${items.map(renderSeoItem).join('')}</div>`)
    .replace('<b id="section-date"></b>', `<b id="section-date">${date}</b>`)
    .replace('<span id="report-stat" aria-live="polite"></span>', `<span id="report-stat" aria-live="polite">${items.length} 条</span>`);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(reportsDir, { recursive: true });
fs.mkdirSync(markdownDir, { recursive: true });

for (const name of ['styles.css', 'app.js', 'logo.svg']) {
  fs.copyFileSync(path.join(webDir, name), path.join(outputDir, name));
}

const htmlTemplate = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');

const dates = fs.readdirSync(sourceDir)
  .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
  .map((name) => name.slice(0, -5))
  .sort()
  .reverse();

for (const date of dates) {
  const reportPath = path.join(sourceDir, `${date}.json`);
  fs.copyFileSync(reportPath, path.join(reportsDir, `${date}.json`));
  const enhancedMarkdown = path.join(finalDir, `${date}.md`);
  const rawMarkdown = path.join(sourceDir, `${date}.md`);
  const markdownSource = fs.existsSync(enhancedMarkdown) ? enhancedMarkdown : rawMarkdown;
  if (fs.existsSync(markdownSource)) {
    fs.copyFileSync(markdownSource, path.join(markdownDir, `${date}.md`));
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const pageDir = path.join(outputDir, 'reports', date);
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, 'index.html'), renderPage(htmlTemplate, report, date, `${siteOrigin}/reports/${date}/`));
}

const latest = dates[0] || null;
if (latest) {
  const latestReport = JSON.parse(fs.readFileSync(path.join(sourceDir, `${latest}.json`), 'utf8'));
  fs.writeFileSync(path.join(outputDir, 'index.html'), renderPage(htmlTemplate, latestReport, latest, `${siteOrigin}/`));
} else {
  fs.writeFileSync(path.join(outputDir, 'index.html'), htmlTemplate);
}

fs.writeFileSync(
  path.join(outputDir, 'data', 'index.json'),
  `${JSON.stringify({ latest, dates, generatedAt: new Date().toISOString() }, null, 2)}\n`,
);

fs.writeFileSync(path.join(outputDir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${siteOrigin}/sitemap.xml\n`);
const sitemapUrls = [
  `<url><loc>${siteOrigin}/</loc>${latest ? `<lastmod>${latest}</lastmod>` : ''}</url>`,
  ...dates.map((date) => `<url><loc>${siteOrigin}/reports/${date}/</loc><lastmod>${date}</lastmod></url>`),
];
fs.writeFileSync(path.join(outputDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapUrls.join('')}</urlset>\n`);

console.log(`Built ${dates.length} reports${latest ? `; latest is ${latest}` : ''}.`);
