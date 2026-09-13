const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');
const { t, escapeHtml: e, localPath: lp } = D;
const template = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const siteConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../site.config.json'), 'utf8'));
const assetVersion = '20260913-menu-pickers-2';
function shell({ locale, view, route, title, description, content, data = {}, structured = null, noindex = false, bodyAttrs = '' }) {
  const canonical = D.origin + lp(route, locale);
  const feedUrl = D.origin + lp('/feed.xml', locale);
  const active = view === 'report' ? (route === '/' ? 'discover' : 'archive') : (view === 'trend-cluster' ? 'trends' : view);
  const navigation = [['discover', '/'], ['trends', '/trends/'], ['archive', '/reports/']].map(([key, url]) =>
    `<a href="${lp(url, locale)}"${active === key ? ' aria-current="page"' : ''}>${t(locale, key)}</a>`).join('');
  const values = {
    locale, view, title: e(title), description: e(description), canonical, zhUrl: D.origin + route, enUrl: D.origin + '/en' + route,
    robots: noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large', ogLocale: locale === 'en' ? 'en_US' : 'zh_CN',
    ogImage: D.origin + '/og-image.png', ogImageAlt: locale === 'en' ? 'DevTrends — daily developer discoveries' : 'DevTrends 开发者趋势——大家都在做什么',
    feedUrl, feedTitle: locale === 'en' ? 'DevTrends daily discoveries' : 'DevTrends 开发者趋势日报',
    homePath: lp('/', locale), navigation, navLabel: locale === 'en' ? 'Main navigation' : '主导航',
    headerSearch: ['report', 'trend-cluster'].includes(view) ? `<label class="search header-search">${D.icon('search')}<span class="sr-only">${t(locale, 'search')}</span><input id="search" type="search" placeholder="${t(locale, 'search')}" autocomplete="off" /><kbd>⌘ K</kbd></label>` : '',
    zhSelected: locale === 'zh-CN' ? 'selected' : '', enSelected: locale === 'en' ? 'selected' : '',
    zhChecked: locale === 'zh-CN' ? 'true' : 'false', enChecked: locale === 'en' ? 'true' : 'false',
    currentLanguage: locale === 'en' ? 'English' : '简体中文',
    content, structuredData: structured ? `<script type="application/ld+json">${D.json(structured)}</script>` : '',
    pageData: D.json({ ...data, locale, view, route }), pageScript: `<script src="/${view === 'cards' ? 'cards.js' : 'app.js'}?v=${assetVersion}" defer></script>`,
    bodyAttrs: bodyAttrs ? ` ${bodyAttrs}` : '',
    ...Object.fromEntries(['skip', 'brandLabel', 'system', 'light', 'dark', 'footer', 'neutralAccent', 'blueAccent', 'forestAccent', 'violetAccent'].map(key => [key, t(locale, key)])),
    languageLabel: t(locale, 'language'), themeLabel: t(locale, 'theme'), accentLabel: t(locale, 'accentTheme'), assetVersion,
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
  return `<section class="discovery-hero"><div class="hero-copy"><p class="eyebrow">FROM THE GLOBAL DEVELOPER COMMUNITY</p><h1>${en ? 'Discover what’s next<br>for developers.' : '发现开发者的<br>新东西、新方法、新趋势'}</h1><p class="intro">${en ? 'Find what’s happening across developer communities.<br>Fresh projects, tools, frameworks and ideas. Every day.' : '从全球开发者社区，发现正在发生的变化。<br>每天自动汇总新的项目、工具、框架和技术动态。'}</p><div class="hero-stats"><div><span class="stat-icon">${D.icon('repo')}</span><span><b>${items.length}</b><small>${en ? 'Discoveries today' : '今日新发现'}</small></span></div><div><span class="stat-icon">${D.icon('box')}</span><span><b>${new Set(items.map(i => i.sourceId)).size}</b><small>${en ? 'Community sources' : '数据来源'}</small></span></div></div></div><div class="hero-art" aria-hidden="true"><img src="/globe.svg?v=${assetVersion}" alt="${en ? 'DevTrends shows what developers are building around the world' : 'DevTrends 收录全球开发者正在做的新东西'}"/><span>Build<br>a more open<br>developer world.</span></div></section>`;
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
  const card = cluster => {
    const label = D.facetLabel(cluster.type, cluster.id, locale);
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
    return `<article class="trend-card"><header><div><span class="trend-kind">${facetKinds[cluster.type] || e(cluster.type)}</span><h2><a href="${e(clusterHref)}">${e(label)}</a></h2></div>${change}</header><div class="trend-metrics"><b><a href="${e(clusterHref)}">${e(t(locale, 'trendsProjects', { n: cluster.recentCount }))} →</a></b><span>${e(t(locale, 'trendsSources', { n: cluster.sourceCount }))}</span><span>${t(locale, 'trendsBaseline')} ${cluster.baselineCount}</span></div>${spark}<h3>${t(locale, 'trendsExamples')}</h3><ul>${examples}</ul></article>`;
  };
  const facets = [
    ['useCases', 'trendsUseCases'],
    ['agentRoles', 'trendsAgentRoles'],
    ['languages', 'trendsLanguages'],
  ];
  const facetTabs = facets.map(([id, key], index) => `<button type="button" role="tab" id="trend-tab-${id}" aria-controls="trend-panel-${id}" aria-selected="${index === 0}" data-trend-facet="${id}">${t(locale, key)}</button>`).join('');
  const facetPicker = `<div class="trend-facets"><span>${t(locale, 'trendsDimension')}</span><div role="tablist" aria-label="${t(locale, 'trendsDimension')}">${facetTabs}</div></div>`;
  const grids = facets.map(([id]) => {
    const cards = model.clusters.filter(cluster => cluster.type === id).map(card).join('');
    return `<section class="trend-grid" id="trend-panel-${id}" role="tabpanel" aria-labelledby="trend-tab-${id}" data-trend-facet-panel="${id}"${id === 'useCases' ? '' : ' hidden'}>${cards || `<p class="trend-empty">${t(locale, 'trendsEmpty')}</p>`}</section>`;
  }).join('');
  const summary = `<div class="trend-window"><div><span>${t(locale, 'trendsWindow')}</span><b>${e(dateRange(model.recent))}</b></div><div><span>${t(locale, 'trendsBaseline')}</span><b>${e(dateRange(model.baseline))}</b></div><p>${en ? `A cluster appears after at least ${model.thresholds.minProjects} new projects from ${model.thresholds.minSources} sources, with a daily rate up ${model.thresholds.minGrowthPercent}% or newly emerging.` : `至少 ${model.thresholds.minProjects} 个新项目、覆盖 ${model.thresholds.minSources} 个来源，且日均出现速度提升 ${model.thresholds.minGrowthPercent}%（或为新主题）后才展示。`}</p></div>`;
  const periods = [4, 8, 12].map(weeks => `<button type="button" data-trend-weeks="${weeks}" aria-pressed="${weeks === 12}">${t(locale, `trends${weeks}Weeks`)}</button>`).join('');
  const periodPicker = `<div class="trend-period"><span>${t(locale, 'trendsPeriod')}</span><div role="group" aria-label="${t(locale, 'trendsPeriod')}">${periods}</div></div>`;
  const controls = `<div class="trend-controls">${facetPicker}${periodPicker}</div>`;
  const content = heading(locale, t(locale, 'trendsTitle'), t(locale, 'trendsIntro'), '', 'DEV TRENDS / SIGNALS') + controls + summary + grids;
  const structured = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'CollectionPage', '@id': canonical, url: canonical, name: title, description: t(locale, 'trendsIntro'), inLanguage: locale, isPartOf: { '@id': D.origin + '/#website' }, mainEntity: { '@type': 'ItemList', numberOfItems: model.clusters.length, itemListElement: model.clusters.map((cluster, index) => ({ '@type': 'ListItem', position: index + 1, name: D.facetLabel(cluster.type, cluster.id, locale) })) } },
  ] };
  return shell({ locale, view: 'trends', route, title, description: t(locale, 'trendsIntro'), content, data: { trends: model }, structured });
}
function trendClusterPage(model, cluster, locale) {
  const en = locale === 'en', route = cluster.path, canonical = D.origin + lp(route, locale);
  const label = D.facetLabel(cluster.type, cluster.id, locale);
  const kind = cluster.type === 'agentRoles' ? (en ? 'Agent ecosystem' : 'Agent 生态') : cluster.type === 'languages' ? (en ? 'Programming language' : '编程语言') : (en ? 'Use case' : '业务场景');
  const items = cluster.projects || [];
  const range = `${D.dateLabel(model.recent.start, locale)} – ${D.dateLabel(model.recent.end, locale)}`;
  const count = t(locale, 'trendsProjects', { n: items.length });
  const intro = en ? `${count} first discovered during ${range}, deduplicated across ${cluster.sourceCount} sources.` : `${range} 内首次发现的 ${count}，已跨 ${cluster.sourceCount} 个来源去重。`;
  const title = `${kind} · ${label} | DevTrends`;
  const breadcrumb = `<nav class="breadcrumb" aria-label="${en ? 'Breadcrumb' : '面包屑导航'}"><a href="${lp('/trends/', locale)}">${t(locale, 'trendsTitle')}</a><span>/</span><span>${e(label)}</span></nav>`;
  const tagLegend = `<div class="tag-legend" aria-label="${en ? 'Tag sources' : '标签来源'}"><span><i class="tag-key-devtrends">${t(locale, 'tagDevTrends')}</i>${t(locale, 'tagDevTrendsTitle')}</span><span><i class="tag-key-source">${t(locale, 'tagSource')}</i>${t(locale, 'tagSourceTitle')}</span></div>`;
  const tools = `<section class="filters trend-cluster-tools" aria-label="${t(locale, 'search')}"><div><b>${e(count)}</b><span>${e(t(locale, 'trendsSources', { n: cluster.sourceCount }))}</span></div><div class="feed-tools">${projectSort(locale)}</div></section>`;
  const content = breadcrumb + heading(locale, `${kind} · ${label}`, intro, '', 'DEV TRENDS / CATEGORY') + tagLegend + `<section class="discovery-results trend-cluster-list">${tools}<div id="feed" class="feed">${items.map((item, index) => D.renderItem(item, locale, { date: item.trendDate || model.latest, index, showDate: true })).join('')}</div>${empty(locale)}</section>`;
  const structured = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'CollectionPage', '@id': canonical, url: canonical, name: title, description: intro, inLanguage: locale, isPartOf: { '@id': D.origin + '/#website' }, breadcrumb: { '@id': canonical + '#breadcrumb' }, mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: D.displayTitle(item, locale), url: item.projectPath ? D.origin + lp(item.projectPath, locale) : D.safeUrl(item.websiteUrl || item.url) || canonical })) } },
    { '@type': 'BreadcrumbList', '@id': canonical + '#breadcrumb', itemListElement: [
      { '@type': 'ListItem', position: 1, name: t(locale, 'trendsTitle'), item: D.origin + lp('/trends/', locale) },
      { '@type': 'ListItem', position: 2, name: label, item: canonical },
    ] },
  ] };
  const report = { date: model.latest, results: [{ sourceId: 'trend-cluster', items }] };
  return shell({ locale, view: 'trend-cluster', route, title, description: intro, content, data: { date: model.latest, report, trendCluster: { type: cluster.type, id: cluster.id } }, structured });
}
function notFoundPage(locale) {
  return shell({ locale, view: 'missing', route: '/404/', title: `${t(locale, 'missing')} | DevTrends`, description: t(locale, 'missingHint'), noindex: true,
    content: heading(locale, t(locale, 'missing'), t(locale, 'missingHint')), data: {},
  }).replace('</main>', `<a class="button primary" href="${lp('/', locale)}">${t(locale, 'home')}</a></main>`);
}
module.exports = { shell, heading, commentsSection, reportPage, cardsPage, archivePage, trendsPage, trendClusterPage, notFoundPage };
