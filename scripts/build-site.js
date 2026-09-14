const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');
const { applyEnhancedMarkdown } = require('./enhanced-report.js');
const { buildTrends, buildEntityIndex, buildClusterLibrary } = require('./trends.js');
const R = require('./render-site.js');
const images = require('./image-store.js');
const imageManifest = images.readManifest();
const root = path.resolve(__dirname, '..');
const siteConfig = JSON.parse(fs.readFileSync(path.join(root, 'site.config.json'), 'utf8'));
const sourceDir = path.join(root, '知识', '大家都在做什么', 'raw');
const finalDir = path.join(root, '知识', '大家都在做什么', 'final');
const outputDir = path.join(root, 'dist');
const commentCountsPath = path.join(root, 'data', 'comment-counts.json');
const commentCounts = fs.existsSync(commentCountsPath) ? JSON.parse(fs.readFileSync(commentCountsPath, 'utf8')).counts || {} : {};
const dates = fs.readdirSync(sourceDir).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).map(name => name.slice(0, -5)).sort().reverse();
function write(file, content) { const target = path.join(outputDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); }
function writePage(route, content) { write(path.join(route.replace(/^\//, ''), 'index.html'), content); }
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
const staticFiles = ['token.css', 'styles.css', 'app.js', 'cards.js', 'shared.js', 'theme.js', 'logo.svg', 'logo-512.png', 'og-image.png', 'globe.svg', 'source-vibecafe.svg', 'source-github.svg', 'source-hellogithub.svg', 'source-producthunt.svg', 'source-ruanyifeng.png', 'source-hackernews.svg', 'source-v2ex.png'];
if (!/^[a-f0-9]{8,128}$/i.test(siteConfig.indexNowKey || '')) throw new Error('site.config.json indexNowKey must contain 8-128 hexadecimal characters');
staticFiles.push(`${siteConfig.indexNowKey}.txt`);
for (const name of staticFiles) fs.copyFileSync(path.join(root, 'web', name), path.join(outputDir, name));
// 站长平台的归属验证文件（百度 / Google / 必应等下发）统一放在仓库根的 verification/，原样复制到站点根。
// 加新平台只需要把文件丢进那个目录：这里整目录复制，不需要改代码，也不会再漏掉某一行的复制规则。
const verificationDir = path.join(root, 'verification');
for (const name of fs.readdirSync(verificationDir)) fs.copyFileSync(path.join(verificationDir, name), path.join(outputDir, name));
const reports = dates.map(date => {
  const raw = JSON.parse(fs.readFileSync(path.join(sourceDir, `${date}.json`), 'utf8'));
  const finalPath = path.join(finalDir, `${date}.md`), rawMarkdown = path.join(sourceDir, `${date}.md`);
  const finalExists = fs.existsSync(finalPath);
  const report = finalExists ? applyEnhancedMarkdown(raw, fs.readFileSync(finalPath, 'utf8'), date) : { ...raw, presentation: { summarySource: 'raw', enhancedItemCount: 0, totalItemCount: D.reportItems(raw).length } };
  images.localizeReport(report, imageManifest);
  report.date = date;
  const markdownPath = finalExists ? finalPath : rawMarkdown;
  report.hasMarkdown = fs.existsSync(markdownPath);
  if (report.hasMarkdown) write(`data/markdown/${date}.md`, fs.readFileSync(markdownPath, 'utf8'));
  const englishMarkdown = `# ${D.t('en', 'slogan')} · ${date}\n\n` + D.reportItems(report).map(item => `## ${D.displayTitle(item, 'en')}\n\n${D.summary(item, 'en').text}\n\n${D.safeUrl(item.githubUrl || item.websiteUrl || item.url)}\n`).join('\n');
  if (report.hasMarkdown) write(`data/markdown/${date}.en.md`, englishMarkdown);
  return report;
});
images.copyImages(outputDir, imageManifest);
// The sandboxing header rule only matters while this site serves the mirrored files itself.
if (!images.imageOrigin()) write('_headers', '/images/*\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n  Content-Security-Policy: sandbox; default-src \'none\'; style-src \'unsafe-inline\'\n');
// Project catalog is built before rendering so report links point only to generated pages.
const projects = require('./projects.js').buildProjects(reports);
// The trending-continuation panel renders feed rows, so it needs the same project snapshots the
// detail pages use: the report's own `continuedItems` only keep identity and today's stars.
const projectIndex = new Map(projects.map(project => [project.key, project]));
const latest = dates[0] || null;
const latestTotal = D.reportItems(reports[0] || { results: [] }).length;
// The entity index is shared by the trend model and the per-category libraries so both see the
// same first-seen dates, deduplication keys, and "richer observation" item replacements.
const entities = latest ? buildEntityIndex(reports) : new Map();
const trends = latest ? buildTrends(reports, latest, { entities }) : { schemaVersion: 1, latest: null, recent: {}, baseline: {}, thresholds: { minProjects: 3, minSources: 2, minGrowthPercent: 25 }, clusters: [] };
const catalogClusters = trends.catalogClusters || trends.clusters;
for (const cluster of catalogClusters) {
  if (!cluster.dataPath) continue;
  write(cluster.dataPath.replace(/^\//, ''), D.json(buildClusterLibrary(entities, cluster, latest)));
}
for (const report of reports) {
  write(`data/reports/${report.date}.json`, D.json(report));
  for (const locale of ['zh-CN', 'en']) writePage(D.localPath(`/reports/${report.date}/`, locale), R.reportPage(report, report.date, locale, false, report.hasMarkdown, latest, latestTotal, Boolean(trends.latest), projectIndex));
}
for (const locale of ['zh-CN', 'en']) {
  writePage(D.localPath('/', locale), R.reportPage(reports[0] || { results: [] }, latest, locale, true, reports[0]?.hasMarkdown, latest, latestTotal, Boolean(trends.latest), projectIndex));
  writePage(D.localPath('/cards/', locale), R.cardsPage(reports[0] || { results: [] }, latest, locale));
  writePage(D.localPath('/trends/', locale), R.trendsPage(trends, locale));
  writePage(D.localPath('/reports/', locale), R.archivePage(reports, locale, commentCounts));
  const catalogModel = { ...trends, clusters: catalogClusters };
  for (const cluster of catalogClusters) writePage(D.localPath(cluster.path, locale), R.trendClusterPage(catalogModel, cluster, locale));
}
write('404.html', R.notFoundPage('zh-CN'));
write('en/404.html', R.notFoundPage('en'));
writePage('/404/', R.notFoundPage('zh-CN'));
writePage('/en/404/', R.notFoundPage('en'));
if (projects.length) require('./projects.js').writeProjects(projects, { write, writePage });
write('data/projects.json', D.json(Object.fromEntries(projects.map(project => [project.key, project.path]))));
write('data/trends.json', D.json(trends));
write('data/index.json', JSON.stringify({ latest, dates, projectCount: projects.length, trendCount: trends.clusters.length, categoryCount: catalogClusters.length, generatedAt: new Date().toISOString() }, null, 2));
write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${D.origin}/sitemap.xml\nSitemap: ${D.origin}/sitemap-baidu.xml\n`);
function feedXml(locale) {
  const en = locale === 'en', feedPath = D.localPath('/feed.xml', locale), homePath = D.localPath('/', locale);
  const channelTitle = en ? 'DevTrends — Daily Developer Discoveries' : 'DevTrends 开发者趋势日报';
  const channelDescription = en ? 'Daily discoveries from developer communities, independent makers, and open source.' : '每天发现开发者社区的新项目、新产品与开源趋势。';
  const entries = reports.slice(0, 30).map(report => {
    const url = D.origin + D.localPath(`/reports/${report.date}/`, locale);
    const items = D.reportItems(report);
    const description = en ? `${items.length} developer projects, products, and open-source discoveries.` : `本期收录 ${items.length} 个开发者项目、产品与开源新发现。`;
    const capturedAt = new Date(report.generatedAt || `${report.date}T00:00:00+08:00`);
    const publishedAt = Number.isNaN(capturedAt.valueOf()) ? new Date(`${report.date}T00:00:00+08:00`) : capturedAt;
    return `<item><title>${D.escapeHtml(D.t(locale, 'reportTitle', { date: report.date }))}</title><link>${D.escapeHtml(url)}</link><guid isPermaLink="true">${D.escapeHtml(url)}</guid><pubDate>${publishedAt.toUTCString()}</pubDate><description>${D.escapeHtml(description)}</description></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${D.escapeHtml(channelTitle)}</title><link>${D.escapeHtml(D.origin + homePath)}</link><description>${D.escapeHtml(channelDescription)}</description><language>${locale}</language><atom:link href="${D.escapeHtml(D.origin + feedPath)}" rel="self" type="application/rss+xml"/>${entries}</channel></rss>\n`;
}
write('feed.xml', feedXml('zh-CN'));
write('en/feed.xml', feedXml('en'));
const pagePairs = [
  { route: '/', date: latest }, { route: '/trends/', date: latest }, { route: '/reports/', date: latest },
  ...catalogClusters.map(cluster => ({ route: cluster.path, date: latest })),
  ...dates.map(date => ({ route: `/reports/${date}/`, date })),
  ...projects.map(project => ({ route: project.path, date: project.lastSeen })),
];
const alternates = route => [
  ['zh-CN', D.origin + D.localPath(route, 'zh-CN')],
  ['en', D.origin + D.localPath(route, 'en')],
  ['x-default', D.origin + D.localPath(route, 'zh-CN')],
].map(([language, href]) => `<xhtml:link rel="alternate" hreflang="${language}" href="${D.escapeHtml(href)}"/>`).join('');
const sitemapUrls = pagePairs.flatMap(page => ['zh-CN', 'en'].map(locale => {
  const url = D.origin + D.localPath(page.route, locale);
  return `<url><loc>${D.escapeHtml(url)}</loc>${alternates(page.route)}${page.date ? `<lastmod>${page.date}</lastmod>` : ''}</url>`;
}));
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${sitemapUrls.join('')}</urlset>\n`);
const baiduUrls = pagePairs.map(page => {
  const url = D.origin + D.localPath(page.route, 'zh-CN');
  return `<url><loc>${D.escapeHtml(url)}</loc>${page.date ? `<lastmod>${page.date}</lastmod>` : ''}</url>`;
});
write('sitemap-baidu.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${baiduUrls.join('')}</urlset>\n`);
console.log(`Built ${dates.length} reports and ${projects.length} GitHub projects in Chinese and English; latest: ${latest}.`);
