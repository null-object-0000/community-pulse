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
function filters(items, locale) {
  return `<section class="filters" aria-label="${t(locale, 'search')}"><label class="search">${D.icon('search')}<span class="sr-only">${t(locale, 'search')}</span><input id="search" type="search" placeholder="${t(locale, 'search')}" autocomplete="off" /></label><div id="source-chips" class="source-chips" aria-label="${t(locale, 'source')}">${sourceChips(items, locale)}</div></section>`;
}
function empty(locale, favorites = false) {
  return `<div id="empty" class="empty" hidden>${D.icon(favorites ? 'bookmark' : 'search')}<h2 id="empty-title">${t(locale, favorites ? 'emptyFavorites' : 'empty')}</h2><p id="empty-hint">${t(locale, favorites ? 'favoritesHint' : 'emptyHint')}</p><button id="clear-filters" type="button">${t(locale, 'clear')}</button></div>`;
}
function reportPage(report, date, dates, locale, home = false, hasMarkdown = false) {
  const items = D.reportItems(report), route = home ? '/' : `/reports/${date}/`;
  const title = home ? t(locale, 'homeTitle') : `${t(locale, 'reportTitle', { date })} | DevTrends`;
  const description = home ? t(locale, 'intro') : `${t(locale, 'reportTitle', { date })}. ${t(locale, 'count', { n: items.length })}. ${t(locale, 'intro')}`;
  const right = `<div class="date-control"><label for="date-select">${t(locale, 'date')}</label><select id="date-select">${dates.map(d => `<option value="${d}"${date === d ? ' selected' : ''}>${e(D.dateLabel(d, locale))}</option>`).join('')}</select></div>`;
  const content = heading(locale, t(locale, 'slogan'), t(locale, 'intro'), right) + filters(items, locale) +
    `<div class="feed-heading"><span id="report-stat" aria-live="polite">${t(locale, 'count', { n: items.length })} · ${e(D.dateLabel(date, locale))}</span>${hasMarkdown ? `<a href="/data/markdown/${date}${locale === 'en' ? '.en' : ''}.md" download>${t(locale, 'download')} ↓</a>` : ''}</div>` +
    `<div id="feed" class="feed">${items.map((item, index) => D.renderItem(item, locale, { date, index })).join('')}</div>` + empty(locale);
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
