const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');
const { applyEnhancedMarkdown } = require('./enhanced-report.js');
const R = require('./render-site.js');
const images = require('./image-store.js');
const imageManifest = images.readManifest();
const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, '知识', '大家都在做什么', 'raw');
const finalDir = path.join(root, '知识', '大家都在做什么', 'final');
const outputDir = path.join(root, 'dist');
const dates = fs.readdirSync(sourceDir).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).map(name => name.slice(0, -5)).sort().reverse();
function write(file, content) { const target = path.join(outputDir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); }
function writePage(route, content) { write(path.join(route.replace(/^\//, ''), 'index.html'), content); }
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
for (const name of ['styles.css', 'app.js', 'cards.js', 'shared.js', 'theme.js', 'logo.svg', 'globe.svg', 'source-vibecafe.svg', 'source-github.svg', 'source-hellogithub.svg', 'source-producthunt.svg', 'source-ruanyifeng.png']) fs.copyFileSync(path.join(root, 'web', name), path.join(outputDir, name));
for (const name of ['dd375fa2f04a48819425622556a589bb.txt']) fs.copyFileSync(path.join(root, name), path.join(outputDir, name));
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
const latest = dates[0] || null;
const latestTotal = D.reportItems(reports[0] || { results: [] }).length;
for (const report of reports) {
  write(`data/reports/${report.date}.json`, D.json(report));
  for (const locale of ['zh-CN', 'en']) writePage(D.localPath(`/reports/${report.date}/`, locale), R.reportPage(report, report.date, locale, false, report.hasMarkdown, latest, latestTotal));
}
for (const locale of ['zh-CN', 'en']) {
  writePage(D.localPath('/', locale), R.reportPage(reports[0] || { results: [] }, latest, locale, true, reports[0]?.hasMarkdown, latest, latestTotal));
  writePage(D.localPath('/cards/', locale), R.cardsPage(reports[0] || { results: [] }, latest, locale));
  writePage(D.localPath('/reports/', locale), R.archivePage(reports, locale));
}
write('404.html', R.notFoundPage('zh-CN'));
write('en/404.html', R.notFoundPage('en'));
writePage('/404/', R.notFoundPage('zh-CN'));
writePage('/en/404/', R.notFoundPage('en'));
if (projects.length) require('./projects.js').writeProjects(projects, { write, writePage });
write('data/projects.json', D.json(Object.fromEntries(projects.map(project => [project.key, project.path]))));
write('data/index.json', JSON.stringify({ latest, dates, projectCount: projects.length, generatedAt: new Date().toISOString() }, null, 2));
write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${D.origin}/sitemap.xml\n`);
const pages = [
  ...['/', '/en/', '/reports/', '/en/reports/'].map(route => ({ route, date: latest })),
  ...dates.flatMap(date => ['', '/en'].map(prefix => ({ route: `${prefix}/reports/${date}/`, date }))),
  ...projects.flatMap(project => ['', '/en'].map(prefix => ({ route: prefix + project.path, date: project.lastSeen }))),
];
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(page => `<url><loc>${D.escapeHtml(D.origin + page.route)}</loc>${page.date ? `<lastmod>${page.date}</lastmod>` : ''}</url>`).join('')}</urlset>\n`);
console.log(`Built ${dates.length} reports and ${projects.length} GitHub projects in Chinese and English; latest: ${latest}.`);
