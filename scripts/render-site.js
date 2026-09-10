const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');
const { t, escapeHtml: e, localPath: lp } = D;
const template = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
function shell({ locale, view, route, title, description, content, data = {}, structured = null, noindex = false }) {
  const canonical = D.origin + lp(route, locale);
  const active = view === 'report' ? (route === '/' ? 'discover' : 'archive') : view;
  const navigation = [['discover', '/'], ['archive', '/reports/'], ['favorites', '/favorites/']].map(([key, url]) =>
    `<a href="${lp(url, locale)}"${active === key ? ' aria-current="page"' : ''}>${t(locale, key)}</a>`).join('');
  const values = {
    locale, view, title: e(title), description: e(description), canonical, zhUrl: D.origin + route, enUrl: D.origin + '/en' + route,
    robots: noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large', ogLocale: locale === 'en' ? 'en_US' : 'zh_CN',
    homePath: lp('/', locale), navigation, navLabel: locale === 'en' ? 'Main navigation' : '主导航',
    headerSearch: ['report', 'favorites'].includes(view) ? `<label class="search header-search">${D.icon('search')}<span class="sr-only">${t(locale, 'search')}</span><input id="search" type="search" placeholder="${t(locale, 'search')}" autocomplete="off" /><kbd>⌘ K</kbd></label>` : '',
    zhSelected: locale === 'zh-CN' ? 'selected' : '', enSelected: locale === 'en' ? 'selected' : '',
    content, structuredData: structured ? `<script type="application/ld+json">${D.json(structured)}</script>` : '',
    pageData: D.json({ ...data, locale, view, route }),
    ...Object.fromEntries(['skip', 'brandLabel', 'system', 'light', 'dark', 'footer'].map(key => [key, t(locale, key)])),
    languageLabel: t(locale, 'language'), themeLabel: t(locale, 'theme'),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Missing template value: ${key}`);
    return values[key];
  });
}
function heading(locale, title, intro, right = '', eyebrow = 'DEV TRENDS / DAILY DISCOVERIES') {
  return `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${e(title)}</h1>${intro ? `<p class="intro">${e(intro)}</p>` : ''}</div>${right}</div>`;
}
function sourceChips(items, locale) {
  const sources = new Map();
  for (const item of items) {
    if (!sources.has(item.sourceId)) sources.set(item.sourceId, { ...item, count: 0 });
    sources.get(item.sourceId).count++;
  }
  return `<button type="button" class="active" data-source="all" aria-pressed="true">${t(locale, 'all')}<b>${items.length}</b></button>` + [...sources.values()].map(s => `<button type="button" data-source="${e(s.sourceId)}" aria-pressed="false">${e(D.sourceName(s, locale))}<b>${s.count}</b></button>`).join('');
}
function categoryChips(items, locale) {
  const labels = locale === 'en' ? { all: 'All', opensource: 'Open source', tools: 'Dev tools', ai: 'AI', design: 'Design', framework: 'Frameworks', indie: 'Indie makers' } : { all: '全部', opensource: '开源项目', tools: '开发工具', ai: 'AI', design: '设计工具', framework: '开发框架', indie: '独立开发' };
  return ['all', 'opensource', 'tools', 'ai', 'design', 'framework', 'indie'].map(key => { const count = key === 'all' ? items.length : items.filter(item => D.itemCategories(item).includes(key)).length; return `<button type="button" data-category="${key}" class="${key === 'all' ? 'active' : ''}" aria-pressed="${key === 'all'}">${labels[key]}<b>${count}</b></button>`; }).join('');
}
function filters(items, locale, mode = 'source') {
  const chips = mode === 'category' ? `<div id="category-chips" class="source-chips category-chips" aria-label="${locale === 'en' ? 'Categories' : '项目分类'}">${categoryChips(items, locale)}</div>` : mode === 'source' ? `<div id="source-chips" class="source-chips" aria-label="${t(locale, 'source')}">${sourceChips(items, locale)}</div>` : '';
  return `<section class="filters" aria-label="${t(locale, 'search')}">${chips}<div class="feed-tools"><select id="sort-select" aria-label="${locale === 'en' ? 'Sort projects' : '项目排序'}"><option value="default">${locale === 'en' ? 'Latest discoveries' : '最新发现'}</option><option value="popular">${locale === 'en' ? 'Most stars / votes' : '最多星标 / 投票'}</option></select><button type="button" id="view-toggle" aria-pressed="false" aria-label="${locale === 'en' ? 'Card view' : '卡片视图'}">▦</button></div></section>`;
}
function discoveryHero(items, locale) {
  const en = locale === 'en';
  return `<section class="discovery-hero"><div class="hero-copy"><p class="eyebrow">FROM THE GLOBAL DEVELOPER COMMUNITY</p><h1>${en ? 'Discover what’s next<br>for developers.' : '发现开发者的<br>新东西、新方法、新趋势'}</h1><p class="intro">${en ? 'Find what’s happening across developer communities.<br>Fresh projects, tools, frameworks and ideas. Every day.' : '从全球开发者社区，发现正在发生的变化。<br>每天自动汇总新的项目、工具、框架和技术动态。'}</p><div class="hero-stats"><div><span class="stat-icon">${D.icon('repo')}</span><span><b>${items.length}</b><small>${en ? 'Discoveries today' : '今日新发现'}</small></span></div><div><span class="stat-icon">${D.icon('box')}</span><span><b>${new Set(items.map(i => i.sourceId)).size}</b><small>${en ? 'Community sources' : '数据来源'}</small></span></div></div></div><div class="hero-art" aria-hidden="true"><img src="/globe.svg" alt=""/><span>Build<br>a more open<br>developer world.</span></div></section>`;
}
function discoverySidebar(items, locale, route, date, hasMarkdown) {
  const en = locale === 'en', sourceFiltering = route !== '/', sources = new Map();
  for (const item of items) {
    if (!sources.has(item.sourceId)) sources.set(item.sourceId, { item, count: 0 });
    sources.get(item.sourceId).count++;
  }
  return `<aside class="discovery-sidebar"><section class="side-panel"><div class="side-heading"><h2>${en ? 'Data sources' : '数据来源'}</h2>${sourceFiltering ? `<a href="#source-chips">${en ? 'View all' : '查看全部'} →</a>` : ''}</div><div class="source-directory">${[...sources].map(([id, { item, count }], index) => { const content = `<span class="source-badge source-color-${index % 5}">${e(D.sourceName(item, locale).slice(0, 2))}</span><span><b>${e(D.sourceName(item, locale))}</b><small>${en ? `${count} discoveries in this report` : `本期收录 ${count} 个新发现`}</small></span>${sourceFiltering ? '<span class="source-arrow">›</span>' : ''}`; return sourceFiltering ? `<a class="source-entry" href="${lp(route, locale)}?source=${encodeURIComponent(id)}#discoveries">${content}</a>` : `<div class="source-entry">${content}</div>`; }).join('')}</div></section><section class="daily-card"><span class="daily-icon">↗</span><div><h2>${en ? 'Your daily developer digest' : '每天一份开发者灵感'}</h2><p>${en ? 'Explore today. Keep what inspires you.' : '发现新项目，收藏好灵感。'}</p></div><a class="button primary" href="${hasMarkdown ? `/data/markdown/${date}${en ? '.en' : ''}.md` : lp('/reports/', locale)}"${hasMarkdown ? ' download' : ''}>${hasMarkdown ? t(locale, 'download') : t(locale, 'archive')} →</a><small>${en ? 'From the community. Open to everyone.' : '来自开发者社区，向每一位探索者开放。'}</small></section><div class="sidebar-signature"><b>DevTrends</b><p>${t(locale, 'footer')}</p><i>Make a more open developer world.</i></div></aside>`;
}
function empty(locale, favorites = false) {
  return `<div id="empty" class="empty" hidden>${D.icon(favorites ? 'bookmark' : 'search')}<h2 id="empty-title">${t(locale, favorites ? 'emptyFavorites' : 'empty')}</h2><p id="empty-hint">${t(locale, favorites ? 'favoritesHint' : 'emptyHint')}</p><button id="clear-filters" type="button">${t(locale, 'clear')}</button></div>`;
}
function reportPage(report, date, dates, locale, home = false, hasMarkdown = false) {
  const items = D.reportItems(report), route = home ? '/' : `/reports/${date}/`;
  const title = home ? t(locale, 'homeTitle') : `${t(locale, 'reportTitle', { date })} | DevTrends`;
  const description = home ? t(locale, 'intro') : `${t(locale, 'reportTitle', { date })}. ${t(locale, 'count', { n: items.length })}. ${t(locale, 'intro')}`;
  const right = `<div class="date-control"><label for="date-select">${t(locale, 'date')}</label><select id="date-select">${dates.map(d => `<option value="${d}"${date === d ? ' selected' : ''}>${e(D.dateLabel(d, locale))}</option>`).join('')}</select></div>`;
  const reportMeta = home ? '' : `<div class="feed-heading"><span id="report-stat" aria-live="polite">${t(locale, 'count', { n: items.length })} · ${e(D.dateLabel(date, locale))}</span>${hasMarkdown ? `<a href="/data/markdown/${date}${locale === 'en' ? '.en' : ''}.md" download>${t(locale, 'download')} ↓</a>` : ''}</div><div class="report-controls">${right}</div>`;
  const content = `<div class="discovery-layout"><div class="discovery-main">` + (home ? discoveryHero(items, locale) : heading(locale, t(locale, 'slogan'), t(locale, 'intro'))) + `<section id="discoveries" class="discovery-results">` + filters(items, locale, home ? 'category' : 'source') + reportMeta +
    `<div id="feed" class="feed">${items.map((item, index) => D.renderItem(item, locale, { date, index })).join('')}</div>` + empty(locale) + `</section></div>${discoverySidebar(items, locale, route, date, hasMarkdown)}</div>`;
  const canonical = D.origin + lp(route, locale);
  const structured = { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, description, url: canonical, inLanguage: locale,
    ...(date ? { datePublished: date } : {}), mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: items.slice(0, 100).map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: D.displayTitle(item, locale), url: item.projectPath ? D.origin + lp(item.projectPath, locale) : D.safeUrl(item.websiteUrl || item.url) || D.origin })) } };
  return shell({ locale, view: 'report', route, title, description, content, data: { date, report }, structured });
}
function favoritesPage(locale) {
  return shell({ locale, view: 'favorites', route: '/favorites/', title: `${t(locale, 'favorites')} | DevTrends`, description: t(locale, 'favoritesHint'), noindex: true,
    content: heading(locale, t(locale, 'favorites'), t(locale, 'localOnly'), '', 'DEV TRENDS / YOUR COLLECTION') + filters([], locale) + `<div class="feed-heading"><span id="report-stat" aria-live="polite"></span></div><div id="feed" class="feed" hidden></div>` + empty(locale, true) + `<noscript><p>${t(locale, 'favoritesHint')} JavaScript ${locale === 'en' ? 'is required.' : '需要启用。'}</p></noscript>` });
}
function archivePage(reports, locale) {
  const months = new Map();
  for (const report of reports) {
    const month = report.date.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(report);
  }
  const content = heading(locale, t(locale, 'archiveTitle'), t(locale, 'archiveIntro'), '', 'DEV TRENDS / THE ARCHIVE') + [...months.entries()].map(([month, list]) => `<section class="archive-month"><h2>${new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(month + '-01T00:00:00Z'))}</h2><div class="archive-grid">${list.map(report => `<a class="archive-card" href="${lp(`/reports/${report.date}/`, locale)}"><span class="archive-arrow">↗</span><b>${e(D.dateLabel(report.date, locale))}</b><span>${t(locale, 'count', { n: D.reportItems(report).length })}</span></a>`).join('')}</div></section>`).join('');
  return shell({ locale, view: 'archive', route: '/reports/', title: `${t(locale, 'archiveTitle')} | DevTrends`, description: t(locale, 'archiveIntro'), content });
}
function notFoundPage(locale) {
  return shell({ locale, view: 'missing', route: '/404/', title: `${t(locale, 'missing')} | DevTrends`, description: t(locale, 'missingHint'), noindex: true,
    content: heading(locale, t(locale, 'missing'), t(locale, 'missingHint')), data: {},
  }).replace('</main>', `<a class="button primary" href="${lp('/', locale)}">${t(locale, 'home')}</a></main>`);
}
module.exports = { shell, heading, reportPage, favoritesPage, archivePage, notFoundPage };
