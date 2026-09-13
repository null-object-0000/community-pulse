const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');
const { t, escapeHtml: e, localPath: lp } = D;
const template = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const siteConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../site.config.json'), 'utf8'));
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
  const sortLabel = locale === 'en' ? 'Sort projects' : '项目排序';
  const sort = `<label class="select-control"><span class="sr-only">${sortLabel}</span><select id="sort-select" aria-label="${sortLabel}"><option value="default">${locale === 'en' ? 'Latest' : '最新发现'}</option><option value="popular">${locale === 'en' ? 'Most starred' : '最多星标 / 投票'}</option></select><svg class="select-control-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></label>`;
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
function trendingContinuation(report, locale) {
  const policy = report?.trendingPolicy;
  const items = policy?.continuedItems || [];
  if (!items.length) return '';
  const en = locale === 'en';
  const total = policy.suppressedCount || items.length;
  const rows = items.map(item => {
    const url = D.safeUrl(item.githubUrl || item.url);
    const today = Number(item.metrics?.today || 0);
    const appearances = item.trendingContinuation?.recentAppearances || 1;
    const meta = [
      today > 0 ? (en ? `+${D.compact(today, locale)} stars today` : `今日 +${D.compact(today, locale)} stars`) : '',
      en ? `seen in ${appearances} recent reports` : `近 ${policy.cooldownDays} 期出现 ${appearances} 次`,
    ].filter(Boolean).join(' · ');
    const content = `<b>${e(D.displayTitle(item, locale))}</b><small>${e(meta)}</small>`;
    return `<li>${url ? `<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${content}<span aria-hidden="true">↗</span></a>` : content}</li>`;
  }).join('');
  const title = en ? 'Still trending' : '持续热门';
  const note = en
    ? `${total} repositories were already featured in the last ${policy.cooldownDays} reports, so they are not repeated in today’s discoveries.`
    : `${total} 个仓库已在最近 ${policy.cooldownDays} 期日报出现，不再作为今日新发现重复展示。`;
  return `<details class="trending-continuation"><summary><span>${D.icon('github')}<b>${title}</b></span><small>${en ? `${items.length} highlights` : `${items.length} 个精选`}⌄</small></summary><p>${e(note)}</p><ul>${rows}</ul></details>`;
}
function commentsSection({ term, locale, kind = 'report' }) {
  const config = siteConfig.comments;
  if (!term || config?.provider !== 'giscus' || !config.repo || !config.repoId || !config.category || !config.categoryId) return '';
  const en = locale === 'en';
  const project = kind === 'project';
  const title = en ? (project ? 'Discuss this project' : 'Discuss this edition') : (project ? '讨论这个项目' : '讨论本期日报');
  const intro = en
    ? (project ? 'Sign in with GitHub to share experience, questions, or useful project updates.' : 'Sign in with GitHub to share a thought, question, or useful follow-up.')
    : (project ? '使用 GitHub 登录，分享使用体验、问题或项目新动态。' : '使用 GitHub 登录，分享你的看法、问题或补充信息。');
  return `<section class="comments-panel" id="comments" data-giscus-comments data-giscus-repo="${e(config.repo)}" data-giscus-repo-id="${e(config.repoId)}" data-giscus-category="${e(config.category)}" data-giscus-category-id="${e(config.categoryId)}" data-giscus-term="${e(term)}" data-giscus-lang="${en ? 'en' : 'zh-CN'}"><div class="comments-heading"><div><p class="eyebrow">DEV TRENDS / COMMUNITY</p><h2>${title}</h2><p>${intro}</p></div><a href="https://github.com/${e(config.repo)}/discussions" target="_blank" rel="noopener noreferrer">${en ? 'Open discussions' : '查看全部讨论'} ↗</a></div><div class="giscus" aria-live="polite"></div><noscript><p>${en ? 'JavaScript is required to load comments.' : '请启用 JavaScript 以加载评论。'}</p></noscript></section>`;
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
    `<div id="feed" class="feed">${items.map((item, index) => D.renderItem(item, locale, { date, index })).join('')}</div>` + empty(locale) + `</section>${trendingContinuation(report, locale)}${commentsSection({ term: `report:${date}`, locale })}</div>${discoverySidebar(items, locale, date, hasMarkdown)}</div>`;
  const canonical = D.origin + lp(route, locale);
  const structured = { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, description, url: canonical, inLanguage: locale,
    ...(date ? { datePublished: date } : {}), mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: items.slice(0, 100).map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: D.displayTitle(item, locale), url: item.projectPath ? D.origin + lp(item.projectPath, locale) : D.safeUrl(item.websiteUrl || item.url) || D.origin })) } };
  return shell({ locale, view: 'report', route, title, description, content, data: { date, report }, structured, bodyAttrs: entry ? 'data-cards-available="1"' : '' });
}
function cardsPage(report, date, locale) {
  const items = D.reportItems(report), title = `${t(locale, 'cardsTitle')} | DevTrends`;
  // Mobile cards are an immersive reader: the global header and a second page heading would both
  // compete with the deck. Keep only two quiet floating controls and retain the full labelling for
  // screen readers.
  const content = `<section class="cards-page" aria-labelledby="cards-title"><h1 class="sr-only" id="cards-title">${t(locale, 'cardsTitle')}</h1><p class="sr-only" id="cards-instruction">${t(locale, 'cardsHint')}</p><a class="cards-close" href="${lp('/', locale)}" aria-label="${t(locale, 'home')}">✕</a><output class="swipe-position" aria-live="polite" aria-atomic="true">${items.length ? `1 / ${items.length}` : '0 / 0'}</output><div class="swipe-stage" tabindex="0" aria-labelledby="cards-title cards-instruction"></div></section>`;
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
module.exports = { shell, heading, commentsSection, reportPage, cardsPage, archivePage, notFoundPage };
