const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');
const { t, escapeHtml: e, localPath: lp } = D;
const template = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
function shell({ locale, view, route, title, description, content, data = {}, structured = null, noindex = false, bodyAttrs = '' }) {
  const canonical = D.origin + lp(route, locale);
  const active = view === 'report' ? (route === '/' ? 'discover' : 'archive') : view;
  const navigation = [['discover', '/'], ['archive', '/reports/']].map(([key, url]) =>
    `<a href="${lp(url, locale)}"${active === key ? ' aria-current="page"' : ''}>${t(locale, key)}</a>`).join('');
  const values = {
    locale, view, title: e(title), description: e(description), canonical, zhUrl: D.origin + route, enUrl: D.origin + '/en' + route,
    robots: noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large', ogLocale: locale === 'en' ? 'en_US' : 'zh_CN',
    homePath: lp('/', locale), navigation, navLabel: locale === 'en' ? 'Main navigation' : '主导航',
    headerSearch: view === 'report' ? `<label class="search header-search">${D.icon('search')}<span class="sr-only">${t(locale, 'search')}</span><input id="search" type="search" placeholder="${t(locale, 'search')}" autocomplete="off" /><kbd>⌘ K</kbd></label>` : '',
    zhSelected: locale === 'zh-CN' ? 'selected' : '', enSelected: locale === 'en' ? 'selected' : '',
    content, structuredData: structured ? `<script type="application/ld+json">${D.json(structured)}</script>` : '',
    pageData: D.json({ ...data, locale, view, route }), pageScript: `<script src="/${view === 'cards' ? 'cards.js' : 'app.js'}" defer></script>`,
    bodyAttrs: bodyAttrs ? ` ${bodyAttrs}` : '',
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
function categoryOptions(items, locale) {
  return D.categories.map(category => ({ id: category.id, label: locale === 'en' ? category.labelEn : category.labelZh, count: items.filter(item => D.itemCategory(item) === category.id).length, active: false }));
}
// Both the daily feed and the report pages filter by the preset categories; the source directory
// in the sidebar stays informational, so no page filters by data source.
function filters(items, locale) {
  const meta = D.chipFilterMeta(locale);
  const chips = [{ id: 'all', label: meta.all, count: items.length, active: true }, ...categoryOptions(items, locale)];
  const sort = `<select id="sort-select" aria-label="${locale === 'en' ? 'Sort projects' : '项目排序'}"><option value="default">${locale === 'en' ? 'Latest' : '最新发现'}</option><option value="popular">${locale === 'en' ? 'Most starred' : '最多星标 / 投票'}</option></select>`;
  return `<section class="filters" aria-label="${t(locale, 'search')}"><div id="${meta.containerId}" class="chip-filter" aria-label="${e(meta.aria)}">${D.chipFilterHtml(chips, locale)}</div><span class="filters-divider" aria-hidden="true"></span><div class="feed-tools">${sort}</div></section>`;
}
function discoveryHero(items, locale) {
  const en = locale === 'en';
  return `<section class="discovery-hero"><div class="hero-copy"><p class="eyebrow">FROM THE GLOBAL DEVELOPER COMMUNITY</p><h1>${en ? 'Discover what’s next<br>for developers.' : '发现开发者的<br>新东西、新方法、新趋势'}</h1><p class="intro">${en ? 'Find what’s happening across developer communities.<br>Fresh projects, tools, frameworks and ideas. Every day.' : '从全球开发者社区，发现正在发生的变化。<br>每天自动汇总新的项目、工具、框架和技术动态。'}</p><div class="hero-stats"><div><span class="stat-icon">${D.icon('repo')}</span><span><b>${items.length}</b><small>${en ? 'Discoveries today' : '今日新发现'}</small></span></div><div><span class="stat-icon">${D.icon('box')}</span><span><b>${new Set(items.map(i => i.sourceId)).size}</b><small>${en ? 'Community sources' : '数据来源'}</small></span></div></div></div><div class="hero-art" aria-hidden="true"><img src="/globe.svg" alt=""/><span>Build<br>a more open<br>developer world.</span></div></section>`;
}
function discoverySidebar(items, locale, date, hasMarkdown) {
  const en = locale === 'en', sources = new Map();
  for (const item of items) {
    if (!sources.has(item.sourceId)) sources.set(item.sourceId, { item, count: 0 });
    sources.get(item.sourceId).count++;
  }
  return `<aside class="discovery-sidebar"><section class="side-panel"><div class="side-heading"><h2>${en ? 'Data sources' : '数据来源'}</h2></div><div class="source-directory">${[...sources].map(([, { item, count }]) => { const source = D.sourceInfo(item); const name = D.sourceName(item, locale); const content = `<span class="source-badge">${source?.logo ? `<img src="${e(source.logo)}" alt="" loading="lazy" />` : e(name.slice(0, 2))}</span><span><b>${e(name)}</b><small>${en ? `${count} discoveries in this report` : `本期收录 ${count} 个新发现`}</small></span>${source?.url ? '<span class="source-arrow" aria-hidden="true">↗</span>' : ''}`; return source?.url ? `<a class="source-entry" href="${e(source.url)}" target="_blank" rel="noopener noreferrer" aria-label="${e(`${name}${en ? ': visit source website' : '：访问来源网站'}`)}">${content}</a>` : `<div class="source-entry">${content}</div>`; }).join('')}</div></section><section class="daily-card"><span class="daily-icon">↗</span><div><h2>${en ? 'Your daily developer digest' : '每天一份开发者灵感'}</h2><p>${en ? 'Explore today. Find what inspires you.' : '发现新项目，遇见好灵感。'}</p></div><a class="button primary" href="${hasMarkdown ? `/data/markdown/${date}${en ? '.en' : ''}.md` : lp('/reports/', locale)}"${hasMarkdown ? ' download' : ''}>${hasMarkdown ? t(locale, 'download') : t(locale, 'archive')} →</a><small>${en ? 'From the community. Open to everyone.' : '来自开发者社区，向每一位探索者开放。'}</small></section><div class="sidebar-signature"><b>DevTrends</b><p>${t(locale, 'footer')}</p><i>Make a more open developer world.</i></div></aside>`;
}
function empty(locale) {
  return `<div id="empty" class="empty" hidden>${D.icon('search')}<h2 id="empty-title">${t(locale, 'empty')}</h2><p id="empty-hint">${t(locale, 'emptyHint')}</p><button id="clear-filters" type="button">${t(locale, 'clear')}</button></div>`;
}
function cardsEntry(date, total, locale) {
  return `<a class="cards-entry" href="${lp('/cards/', locale)}" data-cards-entry data-date="${e(date)}" data-total="${total}"><span class="cards-entry-icon" aria-hidden="true">${D.icon('box')}</span><span><b>${t(locale, 'cardsTitle')}</b><small>${t(locale, 'cardsIntro')}</small></span><strong data-cards-progress>${t(locale, 'cardsRead', { n: 0, total })}</strong><span class="cards-entry-arrow" aria-hidden="true">→</span></a>`;
}
function reportPage(report, date, locale, home = false, hasMarkdown = false, cardsDate = date, cardsTotal = D.reportItems(report).length) {
  const items = D.reportItems(report), route = home ? '/' : `/reports/${date}/`;
  const title = home ? t(locale, 'homeTitle') : `${t(locale, 'reportTitle', { date })} | DevTrends`;
  const description = home ? t(locale, 'intro') : `${t(locale, 'reportTitle', { date })}. ${t(locale, 'count', { n: items.length })}. ${t(locale, 'intro')}`;
  // The report date lives in the heading: the feed itself is already scoped to that one day,
  // so a separate meta row used to restate it (plus the count and the Markdown download).
  const headingText = t(locale, 'reportHeading', { date: D.dateLabel(date, locale) });
  // The entry advertises today's card flow, so it only belongs on the report it links to;
  // showing it on an archived day would report today's progress next to another day's feed.
  const entry = date === cardsDate ? cardsEntry(cardsDate, cardsTotal, locale) : '';
  const content = `<div class="discovery-layout"><div class="discovery-main">` + (home ? discoveryHero(items, locale) : heading(locale, headingText, t(locale, 'intro'))) + entry + `<section id="discoveries" class="discovery-results">` + filters(items, locale) +
    `<div id="feed" class="feed">${items.map((item, index) => D.renderItem(item, locale, { date, index })).join('')}</div>` + empty(locale) + `</section></div>${discoverySidebar(items, locale, date, hasMarkdown)}</div>`;
  const canonical = D.origin + lp(route, locale);
  const structured = { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, description, url: canonical, inLanguage: locale,
    ...(date ? { datePublished: date } : {}), mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: items.slice(0, 100).map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: D.displayTitle(item, locale), url: item.projectPath ? D.origin + lp(item.projectPath, locale) : D.safeUrl(item.websiteUrl || item.url) || D.origin })) } };
  return shell({ locale, view: 'report', route, title, description, content, data: { date, report }, structured, bodyAttrs: entry ? 'data-cards-available="1"' : '' });
}
function cardsPage(report, date, locale) {
  const items = D.reportItems(report), title = `${t(locale, 'cardsTitle')} | DevTrends`;
  const content = `<section class="cards-page" aria-labelledby="cards-title"><header class="cards-page-heading"><div><p class="eyebrow">DEV TRENDS / DAILY CARDS</p><h1 id="cards-title">${t(locale, 'cardsTitle')}</h1></div><a href="${lp('/', locale)}" aria-label="${t(locale, 'home')}">✕</a></header><p class="cards-instruction" id="cards-instruction">${t(locale, 'cardsHint')}</p><div class="swipe-stage" tabindex="0" aria-labelledby="cards-title cards-instruction"></div><div class="swipe-controls"><button type="button" class="swipe-previous"><span aria-hidden="true">←</span><span>${t(locale, 'previousItem')}</span></button><output class="swipe-position" aria-live="polite" aria-atomic="true">${items.length ? `1 / ${items.length}` : '0 / 0'}</output><button type="button" class="swipe-next"><span>${t(locale, 'nextItem')}</span><span aria-hidden="true">→</span></button></div></section>`;
  return shell({ locale, view: 'cards', route: '/cards/', title, description: t(locale, 'cardsIntro'), content, data: { date, report }, noindex: true });
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
module.exports = { shell, heading, reportPage, cardsPage, archivePage, notFoundPage };
