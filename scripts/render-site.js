const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../web/shared.js');
const { t, escapeHtml: e, localPath: lp } = D;
const template = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const siteConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../site.config.json'), 'utf8'));
// Every long-lived browser asset URL changes when its bytes change, including daily rebuilds.
const assetVersion = crypto.createHash('sha256').update(Buffer.concat(['theme.js', 'token.css', 'styles.css', 'shared.js', 'app.js', 'cards.js', 'globe.svg', 'logo.svg']
  .map(name => fs.readFileSync(path.join(__dirname, '../web', name))))).digest('hex').slice(0, 16);
function shell({ locale, view, route, title, description, content, data = {}, structured = null, noindex = false, bodyAttrs = '' }) {
  const canonical = D.origin + lp(route, locale);
  const feedUrl = D.origin + lp('/feed.xml', locale);
  const active = view === 'report' ? (route === '/' ? 'discover' : 'archive') : (view === 'trend-cluster' ? 'trends' : view);
  const homePath = lp('/', locale);
  // The chrome lives in web/shared.js so the static shell and the Worker's dynamic product pages
  // cannot drift; index.html only keeps the {{topbar}} / {{footerHtml}} slots.
  const headerSearch = ['report', 'trend-cluster'].includes(view) ? `<label class="search header-search">${D.icon('search')}<span class="sr-only">${t(locale, 'search')}</span><input id="search" type="search" placeholder="${t(locale, 'search')}" autocomplete="off" /><kbd>⌘ K</kbd></label>` : '';
  const values = {
    locale, view, title: e(title), description: e(description), canonical, zhUrl: D.origin + route, enUrl: D.origin + '/en' + route,
    robots: noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large', ogLocale: locale === 'en' ? 'en_US' : 'zh_CN',
    ogImage: D.origin + '/og-image.png', ogImageAlt: locale === 'en' ? 'DevTrends — daily developer discoveries' : 'DevTrends 开发者趋势——大家都在做什么',
    feedUrl, feedTitle: locale === 'en' ? 'DevTrends daily discoveries' : 'DevTrends 开发者趋势日报',
    homePath, topbar: D.topbarHtml({ locale, active, homePath, headerSearch }), footerHtml: D.footerHtml({ locale, homePath }),
    content, structuredData: structured ? `<script type="application/ld+json">${D.json(structured)}</script>` : '',
    pageData: D.json({ ...data, locale, view, route }), pageScript: `<script src="/${view === 'cards' ? 'cards.js' : 'app.js'}?v=${assetVersion}" defer></script>`,
    headPreload: route === '/' ? `<link rel="preload" as="image" href="/globe.svg?v=${assetVersion}" fetchpriority="high" />` : '',
    bodyAttrs: bodyAttrs ? ` ${bodyAttrs}` : '',
    skip: t(locale, 'skip'), assetVersion,
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
function projectSort(locale) {
  const sortLabel = locale === 'en' ? 'Sort projects' : '项目排序';
  const latest = locale === 'en' ? 'Latest' : '最新发现';
  const popular = locale === 'en' ? 'Most starred / voted' : '最多星标 / 投票';
  return `<details class="menu-picker sort-picker" id="sort-picker"><summary aria-label="${sortLabel}"><span data-menu-current>${latest}</span><svg class="menu-caret" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></summary><div class="menu-options" role="menu" aria-label="${sortLabel}"><button type="button" role="menuitemradio" aria-checked="true" data-sort-choice="default" data-menu-label="${latest}"><span>${latest}</span><span class="menu-check" aria-hidden="true">✓</span></button><button type="button" role="menuitemradio" aria-checked="false" data-sort-choice="popular" data-menu-label="${popular}"><span>${popular}</span><span class="menu-check" aria-hidden="true">✓</span></button></div></details>`;
}
// Both the daily feed and the report pages filter by the preset categories; the source directory
// in the sidebar stays informational, so no page filters by data source.
function filters(items, locale) {
  const meta = D.chipFilterMeta(locale);
  const chips = [{ id: 'all', label: meta.all, count: items.length, active: true }, ...categoryOptions(items, locale)];
  return `<section class="filters" aria-label="${t(locale, 'search')}"><div id="${meta.containerId}" class="chip-filter" aria-label="${e(meta.aria)}">${D.chipFilterHtml(chips, locale)}</div><span class="filters-divider" aria-hidden="true"></span><div class="feed-tools">${projectSort(locale)}</div></section>`;
}
function discoveryHero(items, locale) {
  const en = locale === 'en';
  return `<section class="discovery-hero"><div class="hero-copy"><p class="eyebrow">FROM THE GLOBAL DEVELOPER COMMUNITY</p><h1>${en ? 'Discover what’s next<br>for developers.' : '发现开发者的<br>新东西、新方法、新趋势'}</h1><p class="intro">${en ? 'Find what’s happening across developer communities.<br>Fresh projects, tools, frameworks and ideas. Every day.' : '从全球开发者社区，发现正在发生的变化。<br>每天自动汇总新的项目、工具、框架和技术动态。'}</p><div class="hero-stats"><div><span class="stat-icon">${D.icon('repo')}</span><span><b>${items.length}</b><small>${en ? 'Discoveries today' : '今日新发现'}</small></span></div><div><span class="stat-icon">${D.icon('box')}</span><span><b>${new Set(items.map(i => i.sourceId)).size}</b><small>${en ? 'Community sources' : '数据来源'}</small></span></div></div></div><div class="hero-art" aria-hidden="true"><img src="/globe.svg?v=${assetVersion}" fetchpriority="high" width="520" height="400" alt="${en ? 'DevTrends shows what developers are building around the world' : 'DevTrends 收录全球开发者正在做的新东西'}"/><span>Build<br>a more open<br>developer world.</span></div></section>`;
}
function searchableRow(item, locale, date, index) {
  const search = [item.title, item.titleEn, item.title_en, item.author, item.summary, item.summaryZh, item.summary_zh, item.summaryEn, item.summary_en, D.summary(item, locale).text, item.github?.name, ...(item.tags || []), ...(item.github?.topics || [])]
    .filter(Boolean).join(' ').toLocaleLowerCase(locale);
  const score = Number(D.metric(item, ['stars', 'stargazers_count', 'totalStars', 'votes', 'votesCount']) || 0);
  return D.renderItem(item, locale, { date, index }).replace(/^<article /,
    `<article data-category="${e(D.itemCategory(item))}" data-search="${e(search)}" data-score="${Number.isFinite(score) ? score : 0}" `);
}
function discoverySidebar(items, locale, date, hasMarkdown) {
  const en = locale === 'en', sources = new Map();
  for (const item of items) {
    if (!sources.has(item.sourceId)) sources.set(item.sourceId, { item, count: 0 });
    sources.get(item.sourceId).count++;
  }
  return `<aside class="discovery-sidebar"><section class="side-panel"><div class="side-heading"><h2>${en ? 'Data sources' : '数据来源'}</h2></div><div class="source-directory">${[...sources].map(([, { item, count }]) => { const source = D.sourceInfo(item); const name = D.sourceName(item, locale); const content = `<span class="source-badge">${source?.logo ? `<img src="${e(source.logo)}" alt="${e(name)}" loading="lazy" />` : e(name.slice(0, 2))}</span><span><b>${e(name)}</b><small>${en ? `${count} discoveries in this report` : `本期收录 ${count} 个新发现`}</small></span>${source?.url ? '<span class="source-arrow" aria-hidden="true">↗</span>' : ''}`; return source?.url ? `<a class="source-entry" href="${e(source.url)}" target="_blank" rel="noopener noreferrer" aria-label="${e(`${name}${en ? ': visit source website' : '：访问来源网站'}`)}">${content}</a>` : `<div class="source-entry">${content}</div>`; }).join('')}</div></section><section class="daily-card"><span class="daily-icon" aria-hidden="true">${D.icon('arrow')}</span><div><h2>${en ? 'Your daily developer digest' : '每天一份开发者灵感'}</h2><p>${en ? 'Explore today. Find what inspires you.' : '发现新项目，遇见好灵感。'}</p></div><a class="button primary" href="${hasMarkdown ? `/data/markdown/${date}${en ? '.en' : ''}.md` : lp('/reports/', locale)}"${hasMarkdown ? ' download' : ''}>${hasMarkdown ? t(locale, 'download') : t(locale, 'archive')} →</a><small>${en ? 'From the community. Open to everyone.' : '来自开发者社区，向每一位探索者开放。'}</small></section><div class="sidebar-signature"><b>DevTrends</b><p>${t(locale, 'footer')}</p><i>Make a more open developer world.</i></div></aside>`;
}
function empty(locale) {
  return `<div id="empty" class="empty" hidden>${D.icon('search')}<h2 id="empty-title">${t(locale, 'empty')}</h2><p id="empty-hint">${t(locale, 'emptyHint')}</p><button id="clear-filters" type="button">${t(locale, 'clear')}</button></div>`;
}
// Home-page entries to the standalone flows. Both share one implementation so a new flow only has
// to be declared here: `progressKey` marks the entry whose copy carries live progress.
const HOME_ENTRIES = [
  { id: 'cards', route: '/cards/', icon: 'box', title: 'cardsTitle', intro: 'cardsIntro', progressKey: 'data-cards-progress', progressTitle: 'cardsRead' },
  { id: 'trends', route: '/trends/', icon: 'trend', title: 'trendsEntryTitle', intro: 'trendsEntryIntro', link: 'trendsEntryLink' },
];
function homeEntry(entry, date, total, locale) {
  const progress = entry.progressKey
    ? `<strong ${entry.progressKey}>${t(locale, entry.progressTitle, { n: 0, total })}</strong>`
    : (entry.link ? `<strong>${t(locale, entry.link)}</strong>` : '');
  return `<a class="home-entry" href="${lp(entry.route, locale)}" data-home-entry="${entry.id}"`
    + `${date ? ` data-date="${e(date)}"` : ''}${entry.progressKey ? ` data-total="${total}"` : ''}>`
    + `<span class="home-entry-icon" aria-hidden="true">${D.icon(entry.icon)}</span>`
    + `<span><b>${t(locale, entry.title)}</b><small>${t(locale, entry.intro)}</small></span>`
    + `${progress}<span class="home-entry-arrow" aria-hidden="true">→</span></a>`;
}
function homeEntries(date, total, locale, cardsDate, trendsAvailable) {
  return HOME_ENTRIES.filter(entry => {
    if (entry.route === '/cards/') return date === cardsDate;
    if (entry.route === '/trends/') return trendsAvailable;
    return true;
  }).map(entry => homeEntry(entry, date, total, locale)).join('');
}
// Repositories still on Trending are suppressed from the feed but stay worth reading, so the panel
// reuses the feed row instead of a title-only line: same description, mark, tags and project link.
// `report.trendingPolicy.continuedItems` intentionally keeps only identity and today's stars (see
// collect.js), so the display fields come from the project catalog the detail pages are built from.
// `projectIndex` is `Map<owner/repo, project>` from scripts/projects.js; without it a row still
// renders, just as a bare title with the continuation line.
function trendingContinuation(report, date, locale, projectIndex) {
  const policy = report?.trendingPolicy;
  const items = policy?.continuedItems || [];
  if (!items.length) return '';
  const en = locale === 'en';
  const total = policy.suppressedCount || items.length;
  const rows = items.map((item, index) => {
    const project = projectIndex?.get(D.repository(item)?.key)?.item;
    // Only today's stars are today's; everything else is the newest observation of the repository,
    // which is also what its detail page shows.
    const resolved = project
      ? { ...project, metrics: { ...project.metrics, today: Number(item.metrics?.today || 0) }, trendingContinuation: item.trendingContinuation }
      : item;
    return D.renderItem(resolved, locale, { date, index, continuation: true });
  }).join('');
  const title = en ? 'Still trending' : '持续热门';
  const note = en
    ? `${total} repositories were already featured in the last ${policy.cooldownDays} reports, so they are not repeated in today’s discoveries.`
    : `${total} 个仓库已在最近 ${policy.cooldownDays} 期日报出现，不再作为今日新发现重复展示。`;
  return `<details class="trending-continuation"><summary><span>${D.icon('github')}<b>${title}</b></span><small>${en ? `${items.length} highlights` : `${items.length} 个精选`}⌄</small></summary><p>${e(note)}</p><div class="feed">${rows}</div></details>`;
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
function reportPage(report, date, locale, home = false, hasMarkdown = false, cardsDate = date, cardsTotal = D.reportItems(report).length, trendsAvailable = false, projectIndex = null) {
  const items = D.reportItems(report), route = home ? '/' : `/reports/${date}/`;
  const title = home ? t(locale, 'homeTitle') : `${t(locale, 'reportTitle', { date })} | DevTrends`;
  const description = home ? t(locale, 'intro') : `${t(locale, 'reportTitle', { date })}. ${t(locale, 'count', { n: items.length })}. ${t(locale, 'intro')}`;
  // The report date lives in the heading: the feed itself is already scoped to that one day,
  // so a separate meta row used to restate it (plus the count and the Markdown download).
  const headingText = t(locale, 'reportHeading', { date: D.dateLabel(date, locale) });
  // See homeEntries(): the card entry advertises today's card flow and so belongs only on the
  // report it links to; the trends entry is a home-page entry only — adding it to all 255 archived
  // report pages would be the same pollution the card entry was already fixed for.
  const entry = (home || date === cardsDate)
    ? homeEntries(date, cardsTotal, locale, cardsDate, home && trendsAvailable)
    : '';
  const content = `<div class="discovery-layout"><div class="discovery-main">` + (home ? discoveryHero(items, locale) : heading(locale, headingText, t(locale, 'intro'))) + entry + `<section id="discoveries" class="discovery-results">` + filters(items, locale) +
    `<div id="feed" class="feed" data-sort="default">${items.map((item, index) => searchableRow(item, locale, date, index)).join('')}</div>` + empty(locale) + `</section>${trendingContinuation(report, date, locale, projectIndex)}${commentsSection({ term: `report:${date}`, locale })}</div>${discoverySidebar(items, locale, date, hasMarkdown)}</div>`;
  const canonical = D.origin + lp(route, locale);
  const website = D.origin + '/#website', organization = D.origin + '/#organization';
  const page = { '@type': 'CollectionPage', '@id': canonical, name: title, description, url: canonical, inLanguage: locale,
    isPartOf: { '@id': website }, publisher: { '@id': organization }, ...(date ? { datePublished: date, dateModified: date } : {}),
    mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: items.slice(0, 100).map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: D.displayTitle(item, locale), url: item.projectPath ? D.origin + lp(item.projectPath, locale) : D.safeUrl(item.websiteUrl || item.url) || D.origin })) } };
  if (!home) page.breadcrumb = { '@id': canonical + '#breadcrumb' };
  const graph = [page];
  if (home) graph.unshift(
    { '@type': 'WebSite', '@id': website, url: D.origin + '/', name: 'DevTrends', alternateName: ['开发者趋势', 'devtrends.site'], inLanguage: ['zh-CN', 'en'], publisher: { '@id': organization } },
    { '@type': 'Organization', '@id': organization, url: D.origin + '/', name: 'DevTrends', alternateName: '开发者趋势', logo: { '@type': 'ImageObject', url: D.origin + '/logo-512.png', width: 512, height: 512 } },
  ); else graph.push({ '@type': 'BreadcrumbList', '@id': canonical + '#breadcrumb', itemListElement: [
    { '@type': 'ListItem', position: 1, name: t(locale, 'discover'), item: D.origin + lp('/', locale) },
    { '@type': 'ListItem', position: 2, name: headingText, item: canonical },
  ] });
  const structured = { '@context': 'https://schema.org', '@graph': graph };
  // `data-cards-available` marks the one report that has a card page (mobile hides its feed in favour
  // of the card flow); `data-home-entries` marks any page that renders a flow entry.
  const bodyAttrs = [
    entry ? 'data-home-entries="1"' : '',
    date === cardsDate ? 'data-cards-available="1"' : '',
  ].filter(Boolean).join(' ');
  return shell({ locale, view: 'report', route, title, description, content, data: { date, feedMode: 'dom' }, structured, bodyAttrs });
}
function cardsPage(report, date, locale) {
  const items = D.reportItems(report), title = `${t(locale, 'cardsTitle')} | DevTrends`;
  // Mobile cards are an immersive reader: the global header and a second page heading would both
  // compete with the deck. Keep only two quiet floating controls and retain the full labelling for
  // screen readers.
  const content = `<section class="cards-page" aria-labelledby="cards-title"><h1 class="sr-only" id="cards-title">${t(locale, 'cardsTitle')}</h1><p class="sr-only" id="cards-instruction">${t(locale, 'cardsHint')}</p><a class="cards-close" href="${lp('/', locale)}" aria-label="${t(locale, 'home')}">✕</a><output class="swipe-position" aria-live="polite" aria-atomic="true">${items.length ? `1 / ${items.length}` : '0 / 0'}</output><div class="swipe-stage" tabindex="0" aria-labelledby="cards-title cards-instruction"></div></section>`;
  return shell({ locale, view: 'cards', route: '/cards/', title, description: t(locale, 'cardsIntro'), content, data: { date, report }, noindex: true });
}
function archivePage(reports, locale, commentCounts = {}) {
  const months = new Map();
  for (const report of reports) {
    const month = report.date.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(report);
  }
  const weekdays = locale === 'en' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const latestMonth = months.keys().next().value;
  const content = heading(locale, t(locale, 'archiveTitle'), t(locale, 'archiveIntro'), '', 'DEV TRENDS / THE ARCHIVE') + [...months.entries()].map(([month, list]) => {
    const [year, monthNumber] = month.split('-').map(Number);
    const first = new Date(Date.UTC(year, monthNumber - 1, 1));
    const monthLabel = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(first);
    const reportByDate = new Map(list.map(report => [report.date, report]));
    const leading = (first.getUTCDay() + 6) % 7;
    const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const days = month === latestMonth ? Math.max(...list.map(report => Number(report.date.slice(-2)))) : daysInMonth;
    const cells = Array.from({ length: leading }, () => '<span class="archive-day is-outside" aria-hidden="true"></span>');
    for (let day = 1; day <= days; day++) {
      const date = `${month}-${String(day).padStart(2, '0')}`;
      const report = reportByDate.get(date);
      const dateLabel = D.dateLabel(date, locale);
      const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()) ? ' is-weekend' : '';
      if (!report) {
        cells.push(`<span class="archive-day is-empty${weekend}" role="gridcell" aria-label="${e(dateLabel)}"><span class="archive-day-number">${day}</span></span>`);
        continue;
      }
      const items = D.reportItems(report);
      const comments = Math.max(0, Number(commentCounts[`report:${date}`]) || 0);
      const sources = new Set(items.map(item => item.sourceId).filter(Boolean)).size;
      const projectsLabel = locale === 'en' ? `${items.length} ${items.length === 1 ? 'project' : 'projects'}` : `${items.length} 个项目`;
      const sourcesLabel = locale === 'en' ? `${sources} ${sources === 1 ? 'source' : 'sources'}` : `${sources} 个来源`;
      const commentsLabel = locale === 'en' ? `${comments} ${comments === 1 ? 'comment' : 'comments'}` : `${comments} 条评论`;
      const spokenLabel = [dateLabel, projectsLabel, sourcesLabel, commentsLabel].join(locale === 'en' ? ', ' : '，');
      cells.push(`<a class="archive-day has-report${weekend}${comments ? ' has-comments' : ''}" role="gridcell" href="${lp(`/reports/${date}/`, locale)}" aria-label="${e(spokenLabel)}"><span class="archive-day-heading"><b class="archive-day-number">${day}</b><b class="archive-day-full">${e(dateLabel)}</b><span aria-hidden="true">↗</span></span><span class="archive-day-meta"><span class="archive-project-count">${D.icon('box')}${e(projectsLabel)}</span><span class="archive-source-count">${D.icon('source')}${e(sourcesLabel)}</span><span class="archive-comment-count">${D.icon('comment')}${e(commentsLabel)}</span></span></a>`);
    }
    while (cells.length % 7) cells.push('<span class="archive-day is-outside" aria-hidden="true"></span>');
    return `<section class="archive-month"><h2>${e(monthLabel)}</h2><div class="archive-calendar" role="grid" aria-label="${e(monthLabel)}"><div class="archive-weekdays" role="row">${weekdays.map((day, index) => `<span role="columnheader"${index > 4 ? ' class="is-weekend"' : ''}>${e(day)}</span>`).join('')}</div>${cells.join('')}</div></section>`;
  }).join('');
  const route = '/reports/', canonical = D.origin + lp(route, locale), title = `${t(locale, 'archiveTitle')} | DevTrends`;
  const structured = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'CollectionPage', '@id': canonical, url: canonical, name: title, description: t(locale, 'archiveIntro'), inLanguage: locale, isPartOf: { '@id': D.origin + '/#website' }, breadcrumb: { '@id': canonical + '#breadcrumb' },
      mainEntity: { '@type': 'ItemList', numberOfItems: reports.length, itemListElement: reports.slice(0, 100).map((report, index) => ({ '@type': 'ListItem', position: index + 1, name: t(locale, 'reportTitle', { date: report.date }), url: D.origin + lp(`/reports/${report.date}/`, locale) })) } },
    { '@type': 'BreadcrumbList', '@id': canonical + '#breadcrumb', itemListElement: [
      { '@type': 'ListItem', position: 1, name: t(locale, 'discover'), item: D.origin + lp('/', locale) },
      { '@type': 'ListItem', position: 2, name: t(locale, 'archiveTitle'), item: canonical },
    ] },
  ] };
  return shell({ locale, view: 'archive', route, title, description: t(locale, 'archiveIntro'), content, structured });
}
function trendsPage(model, locale) {
  const route = '/trends/', canonical = D.origin + lp(route, locale), en = locale === 'en';
  const title = `${t(locale, 'trendsTitle')} | DevTrends`;
  const dateRange = value => `${D.dateLabel(value.start, locale)} – ${D.dateLabel(value.end, locale)}`;
  const facetKinds = {
    useCases: en ? 'USE CASE' : '业务场景',
    agentRoles: en ? 'AGENT ECOSYSTEM' : 'AGENT 生态',
    languages: en ? 'PROGRAMMING LANGUAGE' : '编程语言',
  };
  // A sub-topic card states what it belongs to, and a top-level card lists the sub-topics that were
  // published this period — only clusters the model actually emitted, so no link can 404.
  const subTopicsOf = cluster => model.clusters.filter(candidate =>
    candidate.type === cluster.type && D.facetParent(cluster.type, candidate.id) === cluster.id);
  const subTopicLinks = clusters => clusters.map(cluster =>
    `<a href="${e(lp(cluster.path, locale))}">${e(D.facetLabel(cluster.type, cluster.id, locale))}<em>${Number(cluster.recentCount) || 0}</em></a>`).join('');
  const card = cluster => {
    const label = D.facetLabel(cluster.type, cluster.id, locale);
    const parent = D.facetParent(cluster.type, cluster.id);
    const kind = `${facetKinds[cluster.type] || cluster.type}${parent ? ` · ${t(locale, 'trendsSubTopicOf', { parent: D.facetLabel(cluster.type, parent, locale) })}` : ''}`;
    const clusterHref = lp(cluster.path, locale);
    const change = cluster.isNew
      ? `<strong class="trend-change is-new">${t(locale, 'trendsNew')}</strong>`
      : `<strong class="trend-change${cluster.growthPercent < 0 ? ' is-down' : ''}">${cluster.growthPercent >= 0 ? '+' : ''}${cluster.growthPercent}%</strong>`;
    const examples = cluster.examples.map(example => {
      const name = en ? example.titleEn : example.titleZh;
      const href = example.internal ? lp(example.url, locale) : example.url;
      return `<li><a href="${e(href)}"${example.internal ? '' : ' target="_blank" rel="noopener noreferrer"'}>${e(name)}<span aria-hidden="true">↗</span></a><time datetime="${example.date}">${e(D.dateLabel(example.date, locale))}</time></li>`;
    }).join('');
    const weekly = cluster.weekly || [];
    const peak = Math.max(1, ...weekly.map(point => point.count));
    const bars = weekly.map((point, index) => {
      const label = `${D.dateLabel(point.start, locale)} – ${D.dateLabel(point.end, locale)}: ${t(locale, 'trendsProjects', { n: point.count })}`;
      const height = point.count ? Math.max(8, Math.round(point.count / peak * 100)) : 3;
      return `<span class="trend-bar" data-trend-week="${index}" title="${e(label)}" aria-label="${e(label)}"><i style="height:${height}%"></i></span>`;
    }).join('');
    const starts = [4, 8, 12].map(weeks => `${weeks}:${weekly[Math.max(0, weekly.length - weeks)]?.start || model.recent.start}`).join(';');
    const spark = `<div class="trend-spark" aria-label="${t(locale, 'trendsWeekly')}"><div class="trend-spark-heading"><span>${t(locale, 'trendsWeekly')}</span></div><div class="trend-bars">${bars}</div><div class="trend-axis"><time class="trend-axis-start" data-trend-starts="${e(starts)}">${e(D.dateLabel(weekly[0]?.start || model.recent.start, locale))}</time><time>${e(D.dateLabel(model.latest, locale))}</time></div></div>`;
    const children = subTopicsOf(cluster);
    const subtopics = children.length
      ? `<p class="trend-subtopics"><span>${t(locale, 'trendsSubTopics')}</span>${subTopicLinks(children)}</p>`
      : '';
    return `<article class="trend-card${parent ? ' is-subtopic' : ''}"><header><div><span class="trend-kind">${e(kind)}</span><h2><a href="${e(clusterHref)}">${e(label)}</a></h2></div>${change}</header><div class="trend-metrics"><b><a href="${e(clusterHref)}">${e(t(locale, 'trendsProjects', { n: cluster.recentCount }))} →</a></b><span>${e(t(locale, 'trendsSources', { n: cluster.sourceCount }))}</span><span>${t(locale, 'trendsBaseline')} ${cluster.baselineCount}</span></div>${spark}${subtopics}<h3>${t(locale, 'trendsExamples')}</h3><ul>${examples}</ul></article>`;
  };
  const facets = [
    ['useCases', 'trendsUseCases'],
    ['agentRoles', 'trendsAgentRoles'],
    ['languages', 'trendsLanguages'],
  ];
  const facetTabs = facets.map(([id, key], index) => `<button type="button" role="tab" id="trend-tab-${id}" aria-controls="trend-panel-${id}" aria-selected="${index === 0}" data-trend-facet="${id}">${t(locale, key)}</button>`).join('');
  const facetPicker = `<div class="trend-facets"><span>${t(locale, 'trendsDimension')}</span><div role="tablist" aria-label="${t(locale, 'trendsDimension')}">${facetTabs}</div></div>`;
  // The source list itself comes from MySQL so newly registered sources appear without changing
  // this template. The control is a select-sized trigger that sits in the same row as the lens and
  // period pickers, and it opens a checklist because first-seen dates are recomputed for any
  // combination of sources. Keep it hidden until the API is available: the static report-derived
  // model remains a readable fallback during migration or outage.
  const sourcePicker = `<div class="trend-source-select" data-trend-source-filter data-locale="${locale}"${model.sources?.length ? '' : ' hidden'}>
    <span id="trend-source-label">${t(locale, 'trendsDataSource')}</span>
    <button type="button" class="trend-select-button" data-source-toggle aria-expanded="false" aria-controls="trend-source-panel" aria-labelledby="trend-source-label trend-source-value"><span id="trend-source-value" data-source-value>${en ? 'All sources' : '全部来源'}</span><svg class="trend-select-caret" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>
    <div class="trend-select-panel" id="trend-source-panel" data-source-panel hidden>
      <div class="trend-select-actions"><button type="button" data-source-all>${en ? 'Select all' : '全选'}</button><button type="button" data-source-none>${en ? 'Clear' : '清空'}</button></div>
      <div class="trend-source-options" data-source-options role="group" aria-label="${t(locale, 'trendsDataSource')}"></div>
      <p data-source-status aria-live="polite"></p>
    </div>
  </div>`;
  const grids = facets.map(([id]) => {
    const cards = model.clusters.filter(cluster => cluster.type === id).map(card).join('');
    // A lens whose source data does not cover the comparison window states that instead of showing
    // numbers it cannot support. The language lens is the current case: its snapshot layer starts
    // 2026-09-01, so every earlier day contributes nothing and the growth rate is an artefact.
    const notice = model.languages && !model.languages.complete && id === 'languages'
      ? `<p class="trend-empty trend-notice">${e(t(locale, 'trendsLangUnavailable', {
        eligible: model.languages.baseline.eligible,
        covered: model.languages.baseline.covered,
        label: t(locale, 'trendsBaseline'),
      }))}</p>`
      : '';
    const body = notice || cards || `<p class="trend-empty">${t(locale, 'trendsEmpty')}</p>`;
    return `<section class="trend-grid" id="trend-panel-${id}" role="tabpanel" aria-labelledby="trend-tab-${id}" data-trend-facet-panel="${id}"${id === 'useCases' ? '' : ' hidden'}>${body}</section>`;
  }).join('');
  const summary = `<div class="trend-window"><div><span>${t(locale, 'trendsWindow')}</span><b data-trend-current-window>${e(dateRange(model.recent))}</b></div><div><span>${t(locale, 'trendsBaseline')}</span><b data-trend-baseline-window>${e(dateRange(model.baseline))}</b></div><p data-trend-coverage>${en ? `A cluster appears after at least ${model.thresholds.minProjects} new projects from ${model.thresholds.minSources} sources, with a daily rate up ${model.thresholds.minGrowthPercent}% or newly emerging.` : `至少 ${model.thresholds.minProjects} 个新项目、覆盖 ${model.thresholds.minSources} 个来源，且日均出现速度提升 ${model.thresholds.minGrowthPercent}%（或为新主题）后才展示。`}</p></div>`;
  const periods = [4, 8, 12].map(weeks => `<button type="button" data-trend-weeks="${weeks}" aria-pressed="${weeks === 12}">${t(locale, `trends${weeks}Weeks`)}</button>`).join('');
  const periodPicker = `<div class="trend-period"><span>${t(locale, 'trendsPeriod')}</span><div role="group" aria-label="${t(locale, 'trendsPeriod')}">${periods}</div></div>`;
  const controls = `<div class="trend-controls">${facetPicker}<div class="trend-controls-tail">${periodPicker}${sourcePicker}</div></div>`;
  const content = heading(locale, t(locale, 'trendsTitle'), t(locale, 'trendsIntro'), '', 'DEV TRENDS / SIGNALS') + controls + summary + grids;
  const structured = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'CollectionPage', '@id': canonical, url: canonical, name: title, description: t(locale, 'trendsIntro'), inLanguage: locale, isPartOf: { '@id': D.origin + '/#website' }, mainEntity: { '@type': 'ItemList', numberOfItems: model.clusters.length, itemListElement: model.clusters.map((cluster, index) => ({ '@type': 'ListItem', position: index + 1, name: D.facetPathLabel(cluster.type, cluster.id, locale) })) } },
  ] };
  // The browser only needs the source directory for personalized queries. The cards are already
  // server-rendered, so embedding every category's recent product rows here bloats the HTML.
  return shell({ locale, view: 'trends', route, title, description: t(locale, 'trendsIntro'), content,
    data: { trends: { sources: model.sources, latest: model.latest } }, structured });
}
function trendClusterPage(model, cluster, locale) {
  const en = locale === 'en', route = cluster.path, canonical = D.origin + lp(route, locale);
  const label = D.facetLabel(cluster.type, cluster.id, locale);
  // Sub-topics read as "内容创作 › 小说创作" wherever there is room, and the parent is a real link
  // whenever it was published this period, so the pair is browsable in both directions.
  const labelPath = D.facetPathLabel(cluster.type, cluster.id, locale);
  const parentId = D.facetParent(cluster.type, cluster.id);
  const parentCluster = parentId ? model.clusters.find(candidate => candidate.type === cluster.type && candidate.id === parentId) : null;
  const parentLabel = parentId ? D.facetLabel(cluster.type, parentId, locale) : '';
  const childClusters = model.clusters.filter(candidate => candidate.type === cluster.type && D.facetParent(cluster.type, candidate.id) === cluster.id);
  const kind = cluster.type === 'agentRoles' ? (en ? 'Agent ecosystem' : 'Agent 生态') : cluster.type === 'languages' ? (en ? 'Programming language' : '编程语言') : (en ? 'Use case' : '业务场景');
  const items = cluster.projects || [];
  const range = `${D.dateLabel(model.recent.start, locale)} – ${D.dateLabel(model.recent.end, locale)}`;
  const count = t(locale, 'trendsProjects', { n: items.length });
  const intro = en ? `${count} first discovered during ${range}, deduplicated across ${cluster.sourceCount} sources.` : `${range} 内首次发现的 ${count}，已跨 ${cluster.sourceCount} 个来源去重。`;
  const title = `${kind} · ${labelPath} | DevTrends`;
  const breadcrumb = `<nav class="breadcrumb" aria-label="${en ? 'Breadcrumb' : '面包屑导航'}"><a href="${lp('/trends/', locale)}">${t(locale, 'trendsTitle')}</a>${parentId ? `<span>/</span>${parentCluster ? `<a href="${e(lp(parentCluster.path, locale))}">${e(parentLabel)}</a>` : `<span>${e(parentLabel)}</span>`}` : ''}<span>/</span><span>${e(label)}</span></nav>`;
  const subtopicBlock = childClusters.length
    ? `<p class="trend-subtopics trend-subtopics-page"><span>${t(locale, 'trendsSubTopics')}</span>${childClusters.map(child => `<a href="${e(lp(child.path, locale))}">${e(D.facetLabel(child.type, child.id, locale))}<em>${Number(child.recentCount) || 0}</em></a>`).join('')}</p>`
    : '';
  const tagLegend = `<div class="tag-legend" aria-label="${en ? 'Tag sources' : '标签来源'}"><span><i class="tag-key-devtrends">${t(locale, 'tagDevTrends')}</i>${t(locale, 'tagDevTrendsTitle')}</span><span><i class="tag-key-source">${t(locale, 'tagSource')}</i>${t(locale, 'tagSourceTitle')}</span></div>`;
  const tools = `<section class="filters trend-cluster-tools" aria-label="${t(locale, 'search')}"><div><b id="cluster-count">${e(count)}</b><span id="cluster-sources">${e(t(locale, 'trendsSources', { n: cluster.sourceCount }))}</span></div><div class="feed-tools">${projectSort(locale)}</div></section>`;
  // The same page also browses every project the archive ever classified into this cluster: a lazy
  // library file backs the wider ranges, while the default "recent" list stays server-rendered so the
  // page works without JavaScript and Search still sees the current trend without a huge payload.
  const ranges = cluster.ranges || {};
  const recentRange = ranges.recent || { start: model.recent.start, end: model.recent.end, count: items.length, sources: cluster.sourceCount };
  const rangeKeys = [['recent', 'trendsRangeRecent'], ['4w', 'trendsRange4Weeks'], ['12w', 'trendsRange12Weeks']];
  const rangeButtons = rangeKeys.map(([id, key]) => {
    const spec = ranges[id];
    const number = spec ? spec.count : (id === 'recent' ? items.length : 0);
    return `<button type="button" data-range="${id}" aria-pressed="${id === 'recent'}"><span>${t(locale, key)}</span><em>${number}</em></button>`;
  }).join('');
  // The stats line doubles as the entry hook to the full category archive, so it opens on the
  // all-time summary and only describes the active window after a switch.
  const widestRange = ranges['12w'];
  const libraryStats = e(widestRange
    ? t(locale, 'trendsRangeSpan', { n: widestRange.count, start: D.dateLabel(widestRange.start, locale), end: D.dateLabel(widestRange.end, locale) })
    : t(locale, 'trendsRangeSpan', { n: recentRange.count, start: D.dateLabel(recentRange.start, locale), end: D.dateLabel(recentRange.end, locale) }));
  const rangeControl = `<section class="cluster-range" aria-label="${t(locale, 'trendsRange')}"><span>${t(locale, 'trendsRange')}</span><div class="cluster-range-buttons" role="group" aria-label="${t(locale, 'trendsRange')}" data-cluster-range>${rangeButtons}</div><p class="cluster-range-stats" id="cluster-range-stats" aria-live="polite">${libraryStats}</p></section>`;
  const loadMore = `<button type="button" id="load-more" class="load-more" hidden>${e(t(locale, 'trendsLoadMore', { n: 0 }))}</button>`;
  const content = breadcrumb + heading(locale, `${kind} · ${labelPath}`, intro, '', 'DEV TRENDS / CATEGORY') + subtopicBlock + rangeControl + tagLegend + `<section class="discovery-results trend-cluster-list">${tools}<div id="feed" class="feed">${items.map((item, index) => D.renderItem(item, locale, { date: item.trendDate || model.latest, index, showDate: true })).join('')}</div>${loadMore}${empty(locale)}</section>`;
  // A published sub-topic adds its parent to the breadcrumb trail, which is also how the page states
  // where it sits without spending a heading on it.
  const crumbs = [
    { '@type': 'ListItem', position: 1, name: t(locale, 'trendsTitle'), item: D.origin + lp('/trends/', locale) },
    ...(parentId ? [{ '@type': 'ListItem', position: 2, name: parentLabel, item: parentCluster ? D.origin + lp(parentCluster.path, locale) : canonical }] : []),
    { '@type': 'ListItem', position: parentId ? 3 : 2, name: label, item: canonical },
  ];
  const structured = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'CollectionPage', '@id': canonical, url: canonical, name: title, description: intro, inLanguage: locale, isPartOf: { '@id': D.origin + '/#website' }, breadcrumb: { '@id': canonical + '#breadcrumb' }, mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: D.displayTitle(item, locale), url: item.projectPath ? D.origin + lp(item.projectPath, locale) : D.safeUrl(item.websiteUrl || item.url) || canonical })) } },
    { '@type': 'BreadcrumbList', '@id': canonical + '#breadcrumb', itemListElement: crumbs },
  ] };
  const report = { date: model.latest, results: [{ sourceId: 'trend-cluster', items }] };
  return shell({ locale, view: 'trend-cluster', route, title, description: intro, content, data: { date: model.latest, report, trendCluster: { type: cluster.type, id: cluster.id, dataPath: cluster.dataPath, ranges } }, structured });
}
function notFoundPage(locale) {
  return shell({ locale, view: 'missing', route: '/404/', title: `${t(locale, 'missing')} | DevTrends`, description: t(locale, 'missingHint'), noindex: true,
    content: heading(locale, t(locale, 'missing'), t(locale, 'missingHint')), data: {},
  }).replace('</main>', `<a class="button primary" href="${lp('/', locale)}">${t(locale, 'home')}</a></main>`);
}
module.exports = { shell, heading, commentsSection, reportPage, cardsPage, archivePage, trendsPage, trendClusterPage, notFoundPage };
