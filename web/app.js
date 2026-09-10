const state = {
  index: null, report: null, markdown: '', source: 'all', query: '',
  view: 'report', date: null,
  style: document.documentElement.dataset.style || 'github',
  locale: location.pathname === '/en' || location.pathname.startsWith('/en/') ? 'en' : 'zh-CN',
};

const ids = [
  'date-select', 'source-select', 'style-select', 'search', 'section-date',
  'report-stat', 'source-chips', 'feed', 'markdown-view', 'empty', 'page-title',
  'empty-title', 'empty-hint', 'github-source-menu', 'github-source-label', 'github-source-value',
  'github-source-title', 'github-source-filter', 'github-source-list', 'language-select', 'page-kicker',
];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const messages = {
  'zh-CN': {
    all: '全部', favorites: '我的收藏', reports: '日报日期', pageTitle: '大家都在做什么',
    kicker: 'DEV TRENDS · 开发者趋势', search: '搜索项目、作者或标签', selectReport: '选择日报或收藏',
    filterSource: '筛选来源', switchStyle: '切换展示风格', switchLanguage: '切换语言',
    sourceLabel: '数据源:', chooseSource: '选择数据来源', closeMenu: '关闭菜单', noDescription: '暂无简介',
    otherFavorites: '其他收藏', emptyFavorites: '还没有收藏项目。', noMatchingFavorites: '还没有符合条件的收藏',
    noResults: '没有找到相关项目', favoritesHint: '在 GitHub Trending 风格中点击“收藏”，项目就会保存在这个浏览器里。',
    resultsHint: '换一个关键词或来源试试。', localFavoritesUnavailable: '浏览器本地收藏不可用',
    unavailableReport: '日报暂时没有加载出来', cannotRead: (date) => `无法读取 ${date} 日报`,
    noMarkdown: (date) => `# 大家都在做什么 · ${date}\n\n当天暂无 Markdown 日报。`, count: (n) => `${n} 条`,
    saved: '已收藏', save: '收藏', removeFavorite: '取消收藏', originPage: '投稿页', viewOrigin: '查看来源页面',
    website: '官网', externalProject: '外部项目', repository: 'GitHub 仓库', vibeWork: 'VibeCafé 作品',
    productLaunch: '产品发布', communityPost: '社区投稿', editorialPick: '编辑推荐',
  },
  en: {
    all: 'All', favorites: 'Favorites', reports: 'Daily reports', pageTitle: 'What developers are building',
    kicker: 'DEV TRENDS · DEVELOPER TRENDS', search: 'Search projects, authors, or tags', selectReport: 'Select a report or favorites',
    filterSource: 'Filter sources', switchStyle: 'Switch display style', switchLanguage: 'Switch language',
    sourceLabel: 'Source:', chooseSource: 'Choose a source', closeMenu: 'Close menu', noDescription: 'No description yet',
    otherFavorites: 'Other favorites', emptyFavorites: 'No saved projects yet.', noMatchingFavorites: 'No matching favorites',
    noResults: 'No matching projects', favoritesHint: 'Choose “Save” in the GitHub Trending view to keep a project in this browser.',
    resultsHint: 'Try another keyword or source.', localFavoritesUnavailable: 'Browser favorites are unavailable',
    unavailableReport: 'The daily report could not be loaded', cannotRead: (date) => `Could not load the ${date} report`,
    noMarkdown: (date) => `# What developers are building · ${date}\n\nNo Markdown report is available for this day.`, count: (n) => `${n} items`,
    saved: 'Saved', save: 'Save', removeFavorite: 'Remove favorite', originPage: 'Source', viewOrigin: 'View source page',
    website: 'Website', externalProject: 'External project', repository: 'GitHub repository', vibeWork: 'VibeCafé project',
    productLaunch: 'Product launch', communityPost: 'Community submission', editorialPick: 'Editor’s pick',
  },
};
const t = (key, ...args) => {
  const value = messages[state.locale][key];
  return typeof value === 'function' ? value(...args) : value;
};
const sourceNamesEn = {
  vibecafe: 'VibeCafé Projects', 'chinese-indie-dev': 'Chinese Indie Developers',
  'weekly-issues': 'Ruan Yifeng Weekly Submissions', 'weekly-issue': 'Ruan Yifeng Weekly Picks',
  'hellogithub-issues': 'HelloGitHub Submissions', 'hellogithub-issue': 'HelloGitHub Monthly Picks',
  'github-trending': 'GitHub Trending', 'github-trending-cn': 'GitHub Trending China', producthunt: 'Product Hunt',
};
const localizedSourceName = (source) => state.locale === 'en' ? (sourceNamesEn[source.sourceId] || source.sourceName) : source.sourceName;
const itemSummary = (item) => state.locale === 'en'
  ? (item.summaryEn || item.summary_en || item.github?.description || item.content || item.tagline || item.description || item.summary || t('noDescription'))
  : (item.summary || item.tagline || item.content || t('noDescription'));
const sourceMarks = {
  vibecafe: 'V', 'chinese-indie-dev': '中', 'weekly-issues': '阮',
  'weekly-issue': '周', 'hellogithub-issues': 'H', 'hellogithub-issue': '月',
  'github-trending': 'GH', 'github-trending-cn': 'CN', producthunt: 'P',
};
const sourceFavicons = {
  vibecafe: 'https://vibecafe.ai/favicon.svg',
  producthunt: 'https://ph-static.imgix.net/ph-favicon-brand-500.svg',
  'weekly-issues': 'https://github.com/favicon.ico',
  'weekly-issue': 'https://github.com/favicon.ico',
  'hellogithub-issues': 'https://github.com/favicon.ico',
  'hellogithub-issue': 'https://hellogithub.com/favicon.ico',
  'chinese-indie-dev': 'https://github.com/favicon.ico',
  'github-trending': 'https://github.com/favicon.ico',
  'github-trending-cn': 'https://github.com/favicon.ico',
};
const siteOrigin = 'https://devtrends.site';
const favoritesKey = 'devtrends-favorites-v1';
const outboundUtm = {
  source: 'devtrends',
  medium: 'referral',
  campaign: 'daily_report',
};

const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[char]));

const compact = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return new Intl.NumberFormat(state.locale, {
    notation: number >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 1,
  }).format(number);
};

const starIcon = (decorative = false) => '<svg ' + (decorative ? 'aria-hidden="true"' : 'aria-label="star" role="img"') + ' data-component="Octicon" height="16" viewBox="0 0 16 16" version="1.1" width="16" class="octicon octicon-star"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z"></path></svg>';
const forkIcon = '<svg aria-label="fork" role="img" data-component="Octicon" height="16" viewBox="0 0 16 16" version="1.1" width="16" class="octicon octicon-repo-forked"><path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"></path></svg>';

function readMetric(item, names) {
  for (const name of names) {
    const value = item.metrics?.[name] ?? item.github?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function itemLinks(item) {
  const candidates = [
    [t('website'), item.websiteUrl || (!item.url?.includes('github.com') && item.sourceId !== 'producthunt' ? item.url : '')],
    ['GitHub', item.githubUrl || item.github?.url || (item.url?.includes('github.com') ? item.url : '')],
    ['VibeCafé', item.vibecafeUrl],
    ['Product Hunt', item.productHuntUrl || (item.sourceId === 'producthunt' ? item.url : '')],
    [t('originPage'), item.issueUrl],
  ];
  const seen = new Set();
  return candidates.filter(([, url]) => url && !seen.has(url) && seen.add(url));
}

function outboundContent(item, date) {
  const identity = item?.externalId || item?.vibecafeId || item?.title || 'item';
  return `${date || 'favorites'}_${item?.sourceId || 'unknown'}_${identity}`.slice(0, 160);
}

function trackedOutboundUrl(value, item, date) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol)) return value;
    if (hostname === 'devtrends.site' || hostname.endsWith('.devtrends.site')) return value;
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) return value;

    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => key.toLowerCase().startsWith('utm_'))) return value;
    if (keys.some((key) => /(^|[-_])(signature|sig|token|expires?)($|[-_])/i.test(key))) return value;

    url.searchParams.set('utm_source', outboundUtm.source);
    url.searchParams.set('utm_medium', outboundUtm.medium);
    url.searchParams.set('utm_campaign', outboundUtm.campaign);
    url.searchParams.set('utm_content', outboundContent(item, date));
    return url.toString();
  } catch {
    return value;
  }
}

function internalViewUrl(pathname) {
  const localizedPath = state.locale === 'en' ? `/en${pathname === '/' ? '/' : pathname}` : pathname;
  const url = new URL(localizedPath, location.origin);
  const style = new URL(location.href).searchParams.get('style');
  if (style) url.searchParams.set('style', style);
  return url.pathname + url.search;
}

function displayTitle(item) {
  const title = String(item.title || (state.locale === 'en' ? 'Untitled project' : '未命名项目'));
  if (item.sourceId !== 'weekly-issues') return title;
  return title
    .replace(/^\s*(?:(?:【[^】]*(?:自荐|推荐|投稿)[^】]*】|〖[^〗]*(?:自荐|推荐|投稿)[^〗]*〗|\[[^\]]*(?:自荐|推荐|投稿)[^\]]*\]|［[^］]*(?:自荐|推荐|投稿)[^］]*］)\s*[:：—-]?\s*)+/u, '')
    .replace(/^\s*(?:项目|网站|开源|工具|软件)?\s*(?:自荐|推荐|投稿)\s*[:：—-]\s*/u, '')
    .trim() || title;
}

function submissionUrl(item) {
  if (item.issueUrl) return item.issueUrl;
  if (item.relatedIssue) return item.relatedIssue;
  if (item.vibecafeUrl) return item.vibecafeUrl;
  if (item.productHuntUrl) return item.productHuntUrl;
  if (item.sourceId === 'producthunt') return item.url || '';
  if (item.sourceId === 'hellogithub-issue' && item.issue) return 'https://hellogithub.com/periodical/volume/' + encodeURIComponent(item.issue);
  if (item.sourceId === 'weekly-issue' && item.issue) return 'https://github.com/ruanyf/weekly/blob/master/docs/issue-' + encodeURIComponent(item.issue) + '.md';
  if (item.authorUrl) return item.authorUrl;
  if (item.sourceId === 'chinese-indie-dev') return 'https://github.com/1c7/chinese-independent-developer';
  return item.url || '';
}

function submissionEntry(item) {
  const url = submissionUrl(item);
  if (!url) return '';
  const favicon = sourceFavicons[item.sourceId];
  const avatar = favicon
    ? '<img src="' + escapeHtml(favicon) + '" width="20" height="20" alt="" loading="lazy" referrerpolicy="no-referrer" />'
    : '<span aria-hidden="true">' + escapeHtml(sourceMarks[item.sourceId] || '•') + '</span>';
  return '<span class="submission-entry">' + t('originPage') + ' <a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer" title="' + t('viewOrigin') + '" aria-label="' + t('viewOrigin') + ': ' + escapeHtml(displayTitle(item)) + '">' + avatar + '</a></span>';
}

function githubRepositoryUrl(item) {
  const direct = item.githubUrl || item.github?.url;
  if (direct) return direct;
  for (const candidate of [item.url, item.websiteUrl]) {
    try {
      const url = new URL(candidate);
      const parts = url.pathname.split('/').filter(Boolean);
      if (url.hostname.toLowerCase() === 'github.com' && parts.length === 2) return candidate;
    } catch {}
  }
  return '';
}

function favoriteId(item) {
  const identity = githubRepositoryUrl(item) || item.websiteUrl || item.url ||
    `${item.sourceId || 'item'}:${item.externalId || item.title || 'untitled'}`;
  return String(identity).replace(/#.*$/, '').replace(/\/$/, '');
}

function analyticsItemId(item) {
  return String(item.externalId || item.vibecafeId || favoriteId(item) || item.title || 'item').slice(0, 160);
}

function trackOutboundClick(link) {
  if (typeof window.gtag !== 'function') return;
  try {
    const url = new URL(link.href, location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin === location.origin) return;
    const item = link.closest('.feed-item');
    window.gtag('event', 'outbound_project_click', {
      link_url: url.toString(),
      link_domain: url.hostname,
      link_text: (link.textContent || link.getAttribute('aria-label') || '').trim().slice(0, 100),
      report_date: state.date || 'favorites',
      source_id: item?.dataset.sourceId || '',
      item_id: item?.dataset.itemId || '',
    });
  } catch {}
}

function readFavorites() {
  try {
    const stored = JSON.parse(localStorage.getItem(favoritesKey) || '[]');
    return Array.isArray(stored) ? stored.filter((entry) => entry?.id && entry?.item) : [];
  } catch {
    return [];
  }
}

function writeFavorites(favorites) {
  try {
    localStorage.setItem(favoritesKey, JSON.stringify(favorites));
    return true;
  } catch {
    return false;
  }
}

function favoritesReport() {
  const groups = new Map();
  for (const favorite of readFavorites()) {
    const item = { ...favorite.item, favoriteId: favorite.id, savedAt: favorite.savedAt };
    const sourceId = item.sourceId || 'favorites';
    if (!groups.has(sourceId)) groups.set(sourceId, { sourceId, sourceName: item.sourceName || t('otherFavorites'), items: [] });
    groups.get(sourceId).items.push(item);
  }
  return { date: null, presentation: { summarySource: 'local-favorites' }, results: [...groups.values()] };
}

function favoritesMarkdown(items) {
  if (!items.length) return `# ${t('favorites')}\n\n${t('emptyFavorites')}`;
  return `# ${t('favorites')}\n\n` + items.map((item) => {
    const url = githubRepositoryUrl(item) || item.websiteUrl || item.url || '#';
    const title = String(item.title || (state.locale === 'en' ? 'Untitled project' : '未命名项目')).replace(/[\[\]]/g, '\\$&');
    return `## [${title}](${url})\n\n> ${item.summary || t('noDescription')}\n\n${localizedSourceName(item) || ''}`;
  }).join('\n\n');
}

function reportMarkdown(report, date) {
  if (state.locale !== 'en') return state.markdown;
  const sections = (report.results || []).filter((source) => source.items?.length).map((source) => {
    const items = source.items.map((item) => {
      const url = githubRepositoryUrl(item) || item.websiteUrl || item.url || '#';
      const title = String(displayTitle(item)).replace(/[\[\]]/g, '\\$&');
      const summary = itemSummary(item);
      return `### [${title}](${url})\n\n> ${summary}`;
    }).join('\n\n');
    return `## ${localizedSourceName(source)} (${source.items.length})\n\n${items}`;
  }).join('\n\n');
  return `# ${t('pageTitle')} · ${date}\n\n${sections}`;
}

function renderDateOptions(selected) {
  const favoriteCount = readFavorites().length;
  const dates = (state.index?.dates || []).map((date) => '<option value="' + date + '">' + date + '</option>').join('');
  els['date-select'].innerHTML = '<option value="favorites">★ ' + t('favorites') + ' (' + favoriteCount + ')</option><optgroup label="' + t('reports') + '">' + dates + '</optgroup>';
  els['date-select'].value = selected;
}

function itemTypeIcon(item) {
  const sourceId = item.sourceId || '';
  const githubUrl = githubRepositoryUrl(item);
  let label = t('externalProject');
  let kind = 'link';
  let path = '<path d="M7.775 3.275a.75.75 0 0 0-1.06-1.06l-3.5 3.5a3.25 3.25 0 0 0 4.596 4.596l1-1a.75.75 0 0 0-1.06-1.06l-1 1a1.75 1.75 0 1 1-2.476-2.476l3.5-3.5Z"/><path d="M8.25 7.75a.75.75 0 0 0 0 1.06 1.75 1.75 0 0 1 2.475 2.475l-3.5 3.5a.75.75 0 0 0 1.06 1.06l3.5-3.5A3.25 3.25 0 0 0 7.19 7.75a.75.75 0 0 0 1.06 0Z"/>';

  if (githubUrl) {
    label = t('repository');
    kind = 'repository';
    path = '<path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/>';
  } else if (sourceId === 'vibecafe') {
    return '<span class="item-type-icon item-type-vibecafe" role="img" aria-label="' + t('vibeWork') + '" title="' + t('vibeWork') + '"><img src="https://vibecafe.ai/favicon.svg" width="16" height="16" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>';
  } else if (['producthunt', 'chinese-indie-dev'].includes(sourceId)) {
    label = t('productLaunch');
    kind = 'product';
    path = '<path d="M8 1 14 4.25v7.5L8 15l-6-3.25v-7.5L8 1Zm0 1.7L4.15 4.78 8 6.86l3.85-2.08L8 2.7ZM3.5 6.04v4.82l3.75 2.03V8.07L3.5 6.04Zm9 0L8.75 8.07v4.82l3.75-2.03V6.04Z"/>';
  } else if (['weekly-issues', 'hellogithub-issues'].includes(sourceId)) {
    label = t('communityPost');
    kind = 'community';
    path = '<path d="M1.75 2A1.75 1.75 0 0 0 0 3.75v7.5C0 12.216.784 13 1.75 13H4v2.25a.75.75 0 0 0 1.28.53L8.06 13h6.19A1.75 1.75 0 0 0 16 11.25v-7.5A1.75 1.75 0 0 0 14.25 2H1.75ZM1.5 3.75a.25.25 0 0 1 .25-.25h12.5a.25.25 0 0 1 .25.25v7.5a.25.25 0 0 1-.25.25H7.75a.75.75 0 0 0-.53.22L5.5 13.44V12.25a.75.75 0 0 0-.75-.75h-3a.25.25 0 0 1-.25-.25v-7.5Z"/>';
  } else if (['weekly-issue', 'hellogithub-issue'].includes(sourceId)) {
    label = t('editorialPick');
    kind = 'editorial';
    path = '<path d="M3.75 1A1.75 1.75 0 0 0 2 2.75v11.5a.75.75 0 0 0 1.14.64L8 12.03l4.86 2.86a.75.75 0 0 0 1.14-.64V2.75A1.75 1.75 0 0 0 12.25 1h-8.5Zm-.25 1.75a.25.25 0 0 1 .25-.25h8.5a.25.25 0 0 1 .25.25v10.19l-4.12-2.42a.75.75 0 0 0-.76 0L3.5 12.94V2.75Z"/>';
  }

  return '<span class="item-type-icon item-type-' + kind + '" role="img" aria-label="' + label + '" title="' + label + '"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">' + path + '</svg></span>';
}

function allItems() {
  return (state.report?.results || []).flatMap((source) =>
    (source.items || []).map((item) => ({ ...item, sourceName: localizedSourceName(source) })),
  );
}

function sources() {
  return (state.report?.results || []).filter((source) => source.items?.length).map((source) => ({
    id: source.sourceId, name: localizedSourceName(source), count: source.items.length,
    mark: sourceMarks[source.sourceId] || '•',
  }));
}

function filteredItems() {
  const query = state.query.trim().toLocaleLowerCase(state.locale);
  return allItems().filter((item) => {
    if (state.source !== 'all' && item.sourceId !== state.source) return false;
    if (!query) return true;
    return [item.title, item.summary, item.content, item.author, ...(item.tags || [])]
      .filter(Boolean).join(' ').toLocaleLowerCase('zh-CN').includes(query);
  });
}

const checkIcon = '<svg aria-hidden="true" class="octicon octicon-check select-menu-item-icon" width="16" height="16" viewBox="0 0 16 16"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';

function renderSourceMenuItem(source) {
  const selected = state.source === source.id;
  return '<button type="button" class="select-menu-item' + (selected ? ' selected' : '') + '" role="menuitemradio" data-source="' + escapeHtml(source.id) + '" aria-checked="' + selected + '">' + checkIcon +
    '<span class="select-menu-item-text">' + escapeHtml(source.name) + '</span></button>';
}

function renderSourceControls() {
  const list = sources();
  const total = list.reduce((sum, source) => sum + source.count, 0);
  const options = [{ id: 'all', name: t('all'), count: total, mark: '◎' }, ...list];
  const selectOptions = options.map((source) => '<option value="' + escapeHtml(source.id) + '">' + escapeHtml(source.name) + ' (' + source.count + ')</option>').join('');
  els['source-select'].innerHTML = selectOptions;
  els['source-select'].value = state.source;
  const menuList = els['github-source-list'];
  if (menuList) {
    const current = options.find((source) => source.id === state.source) || options[0];
    els['github-source-value'].textContent = current.name;
    menuList.innerHTML = options.map(renderSourceMenuItem).join('');
    if (els['github-source-filter']) els['github-source-filter'].value = '';
  }
  els['source-chips'].innerHTML = options.map((source) =>
    '<button data-source="' + escapeHtml(source.id) + '" class="' + (state.source === source.id ? 'active' : '') +
    '" aria-pressed="' + (state.source === source.id) + '"><span>' + escapeHtml(source.name) +
    '</span><b>' + source.count + '</b></button>',
  ).join('');
  els['source-chips'].querySelectorAll('[data-source]').forEach((button) => {
    button.addEventListener('click', () => selectSource(button.dataset.source));
  });
}

function selectSource(source) {
  state.source = source;
  renderSourceControls();
  renderFeed();
}

function renderItem(item, index, favoriteIds) {
  const stars = readMetric(item, ['stars', 'stargazers_count', 'totalStars']);
  const forks = readMetric(item, ['forks', 'forks_count']);
  const today = readMetric(item, ['today', 'starsToday', 'todayStars']);
  const votes = readMetric(item, ['votes', 'votesCount']);
  const comments = readMetric(item, ['comments', 'commentsCount']);
  const language = item.github?.language || readMetric(item, ['language', 'lang']);
  const links = itemLinks(item);
  const primary = links[0]?.[1] || item.url || '#';
  const trackedPrimary = trackedOutboundUrl(primary, item, state.date);
  const repositoryUrl = githubRepositoryUrl(item);
  const githubTitleUrl = repositoryUrl || primary;
  const trackedGithubTitleUrl = trackedOutboundUrl(githubTitleUrl, item, state.date);
  const originUrl = submissionUrl(item);
  const githubTitle = displayTitle(item);
  const saved = favoriteIds.has(favoriteId(item));
  const summary = itemSummary(item);
  const tags = (item.tags || []).filter((tag) => !['product', 'vibecafe'].includes(tag)).slice(0, 3);
  const visual = item.image
    ? '<img class="item-visual" src="' + escapeHtml(item.image) + '" data-fallback="' + escapeHtml(sourceMarks[item.sourceId] || '•') + '" alt="" loading="lazy" referrerpolicy="no-referrer" />'
    : '<div class="item-visual item-fallback" aria-hidden="true">' + escapeHtml(sourceMarks[item.sourceId] || '•') + '</div>';
  const metrics = [
    language ? '<span><i class="language-dot"></i>' + escapeHtml(language) + '</span>' : '',
    stars !== null ? '<span>' + starIcon() + compact(stars) + '</span>' : '',
    forks !== null ? '<span>' + forkIcon + compact(forks) + '</span>' : '',
    votes !== null ? '<span>▲ ' + compact(votes) + '</span>' : '',
    comments !== null ? '<span>◌ ' + compact(comments) + '</span>' : '',
  ].filter(Boolean).join('');
  const source = escapeHtml(item.sourceName) + (item.author ? '<span>by ' + escapeHtml(item.author) + '</span>' : '');
  const linkHtml = links.map(([label, url]) =>
    '<a class="item-link' + (label === 'GitHub' ? ' item-link-github' : '') + (url === githubTitleUrl ? ' item-link-title-target' : '') + (url === originUrl ? ' item-link-origin' : '') + '" href="' + escapeHtml(trackedOutboundUrl(url, item, state.date)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + ' ↗</a>',
  ).join('');
  const tagHtml = tags.map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join('');
  const todayHtml = today !== null ? '<b>' + starIcon(true) + compact(today) + ' stars today</b>' : '';
  const titleDefault = '<a class="title-link-default" href="' + escapeHtml(trackedPrimary) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(item.title) + '</a>';
  const titleGithub = '<a class="title-link-github" href="' + escapeHtml(trackedGithubTitleUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(githubTitle) + '</a>';
  return '<article class="feed-item" data-source-id="' + escapeHtml(item.sourceId || '') + '" data-item-id="' + escapeHtml(analyticsItemId(item)) + '">' + visual +
    '<div class="item-content"><div class="item-source">' + source + '</div><h2>' + itemTypeIcon(item) +
    titleDefault + titleGithub + '</h2><p class="summary">' + escapeHtml(summary) + '</p><div class="item-meta"><div class="metrics">' +
    metrics + tagHtml + submissionEntry(item) + '</div><div class="links">' + linkHtml + '</div></div></div>' +
    '<div class="github-item-actions"><button type="button" class="favorite-button' + (saved ? ' active' : '') + '" data-favorite-id="' + escapeHtml(favoriteId(item)) + '" aria-pressed="' + saved + '" aria-label="' + (saved ? t('removeFavorite') : t('save')) + ' ' + escapeHtml(githubTitle) + '">' + starIcon(true) + (saved ? t('saved') : t('save')) + '</button>' + (repositoryUrl ? todayHtml : '') + '</div>' +
    '<div class="ph-item-actions"><span>◌<b>' + (compact(comments) || '—') + '</b></span><a href="' +
    escapeHtml(trackedPrimary) + '" target="_blank" rel="noopener noreferrer">△<b>' + (compact(votes) || '—') +
    '</b></a></div><span class="item-number">' + String(index + 1).padStart(2, '0') + '</span></article>';
}

function inlineMarkdown(value) {
  let output = escapeHtml(value);
  output = output.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  output = output.replace(new RegExp(String.fromCharCode(96) + '([^' + String.fromCharCode(96) + ']+)' + String.fromCharCode(96), 'g'), '<code>$1</code>');
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  output = output.replace(/(^|[^\*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return output;
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let inList = false;
  const closeList = () => {
    if (inList) html.push('</ul>');
    inList = false;
  };
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const list = line.match(/^\s*[-*]\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push('<h' + level + '>' + inlineMarkdown(heading[2]) + '</h' + level + '>');
    } else if (/^>\s?/.test(line)) {
      closeList();
      html.push('<blockquote>' + inlineMarkdown(line.replace(/^>\s?/, '')) + '</blockquote>');
    } else if (list) {
      if (!inList) html.push('<ul>');
      inList = true;
      html.push('<li>' + inlineMarkdown(list[1]) + '</li>');
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      html.push('<p>' + inlineMarkdown(line) + '</p>');
    }
  }
  closeList();
  return html.join('');
}

function renderFeed() {
  const markdownMode = state.style === 'markdown';
  els.feed.hidden = markdownMode;
  els['markdown-view'].hidden = !markdownMode;
  els.empty.hidden = true;
  if (markdownMode) {
    els['markdown-view'].innerHTML = renderMarkdown(state.markdown);
    els['report-stat'].textContent = 'Markdown';
    return;
  }
  const items = filteredItems();
  els['empty-title'].textContent = state.view === 'favorites' ? t('noMatchingFavorites') : t('noResults');
  els['empty-hint'].textContent = state.view === 'favorites' ? t('favoritesHint') : t('resultsHint');
  const favoriteIds = new Set(readFavorites().map((favorite) => favorite.id));
  const itemsByFavoriteId = new Map(items.map((item) => [favoriteId(item), item]));
  els.feed.innerHTML = items.map((item, index) => renderItem(item, index, favoriteIds)).join('');
  els.feed.querySelectorAll('[data-favorite-id]').forEach((button) => {
    button.addEventListener('click', () => toggleFavorite(itemsByFavoriteId.get(button.dataset.favoriteId)));
  });
  els.feed.querySelectorAll('img.item-visual').forEach((image) => {
    image.addEventListener('error', () => {
      const fallback = document.createElement('div');
      fallback.className = 'item-visual item-fallback';
      fallback.textContent = image.dataset.fallback || '•';
      image.replaceWith(fallback);
    }, { once: true });
  });
  els.feed.hidden = items.length === 0;
  els.empty.hidden = items.length !== 0;
  els['report-stat'].textContent = t('count', items.length);
}

function toggleFavorite(item) {
  if (!item) return;
  const id = favoriteId(item);
  const favorites = readFavorites();
  const existingIndex = favorites.findIndex((favorite) => favorite.id === id);
  if (existingIndex >= 0) {
    favorites.splice(existingIndex, 1);
  } else {
    const snapshot = JSON.parse(JSON.stringify({ ...item, content: '', reportDate: state.date }));
    favorites.unshift({ id, savedAt: new Date().toISOString(), item: snapshot });
  }
  if (!writeFavorites(favorites)) {
    els['report-stat'].textContent = t('localFavoritesUnavailable');
    return;
  }
  renderDateOptions(state.view === 'favorites' ? 'favorites' : state.date);
  if (state.view === 'favorites') {
    loadFavorites(false);
  } else {
    renderFeed();
  }
}

function updateMetadata(date, itemCount, favorites = false) {
  const prefix = state.locale === 'en' ? '/en' : '';
  const reportPath = location.pathname.match(/^\/(?:en\/)?reports\/\d{4}-\d{2}-\d{2}\/$/) ? location.pathname : null;
  const canonicalUrl = favorites ? siteOrigin + prefix + '/favorites/' : siteOrigin + (reportPath || prefix + '/');
  const isHomepage = !favorites && canonicalUrl === siteOrigin + prefix + '/';
  const english = state.locale === 'en';
  const title = favorites ? (english ? 'Favorites | DevTrends' : '我的收藏｜DevTrends') : (isHomepage
    ? (english ? 'DevTrends | What developers are building' : 'DevTrends 开发者趋势｜大家都在做什么')
    : (english ? `${date} Developer Trends Report | DevTrends` : `${date} 开发者趋势日报｜DevTrends`));
  const description = favorites ? (english ? 'DevTrends projects saved in this browser.' : '保存在当前浏览器中的 DevTrends 项目收藏。') : (isHomepage
    ? (english ? 'Daily discoveries from GitHub Trending, VibeCafé, Product Hunt, and independent developer communities.' : '每日聚合 GitHub Trending、VibeCafé、Product Hunt 与中文独立开发者社区的新项目、新产品和开源趋势。')
    : (english ? `${date} developer trends report with ${itemCount} projects from GitHub Trending, VibeCafé, Product Hunt, and developer communities.` : `${date} 开发者趋势日报，共收录 ${itemCount} 条来自 GitHub Trending、VibeCafé、Product Hunt 和中文开发者社区的动态。`));
  document.title = title;
  document.querySelector('link[rel="canonical"]').href = canonicalUrl;
  document.querySelector('meta[name="robots"]').content = favorites ? 'noindex, nofollow' : 'index, follow, max-image-preview:large';
  document.querySelector('meta[name="description"]').content = description;
  document.querySelector('meta[property="og:title"]').content = title;
  document.querySelector('meta[property="og:description"]').content = description;
  document.querySelector('meta[property="og:url"]').content = canonicalUrl;
  document.querySelector('meta[property="og:locale"]').content = english ? 'en_US' : 'zh_CN';
  document.querySelector('meta[name="twitter:title"]').content = title;
  document.querySelector('meta[name="twitter:description"]').content = description;
  const route = canonicalUrl.replace(siteOrigin, '').replace(/^\/en(?=\/)/, '');
  document.querySelector('link[hreflang="zh-CN"]').href = siteOrigin + route;
  document.querySelector('link[hreflang="en"]').href = siteOrigin + '/en' + route;
  document.querySelector('link[hreflang="x-default"]').href = siteOrigin + route;
}

function applyLocale() {
  document.documentElement.lang = state.locale;
  els['language-select'].value = state.locale;
  els.search.placeholder = t('search');
  els['page-kicker'].textContent = t('kicker');
  els['github-source-label'].textContent = t('sourceLabel');
  els['github-source-title'].textContent = t('chooseSource');
  els['github-source-filter'].placeholder = t('filterSource');
  els['github-source-filter'].setAttribute('aria-label', t('filterSource'));
  els['source-chips'].setAttribute('aria-label', t('filterSource'));
  document.querySelector('.brand').setAttribute('aria-label', state.locale === 'en' ? 'DevTrends home' : 'DevTrends 开发者趋势首页');
  document.querySelector('.brand').href = state.locale === 'en' ? '/en/' : '/';
  els['date-select'].setAttribute('aria-label', t('selectReport'));
  els['source-select'].setAttribute('aria-label', t('filterSource'));
  els['style-select'].setAttribute('aria-label', t('switchStyle'));
  els['language-select'].setAttribute('aria-label', t('switchLanguage'));
  document.querySelector('.close-button').setAttribute('aria-label', t('closeMenu'));
}

function loadFavorites(updateUrl = true) {
  state.view = 'favorites';
  state.date = null;
  state.report = favoritesReport();
  state.source = 'all';
  const items = allItems();
  state.markdown = favoritesMarkdown(items);
  renderDateOptions('favorites');
  els['page-title'].textContent = t('favorites');
  els['section-date'].textContent = t('favorites');
  if (updateUrl) {
    history.replaceState({}, '', internalViewUrl('/favorites/'));
  }
  renderSourceControls();
  renderFeed();
  updateMetadata(null, items.length, true);
}

function applyStyle(style) {
  state.style = style;
  document.documentElement.dataset.style = style;
  localStorage.setItem('pulse-style', style);
  els['style-select'].value = style;
  const url = new URL(location.href);
  url.searchParams.set('style', style);
  history.replaceState({}, '', url);
  renderFeed();
}

async function loadReport(date, updateUrl = true) {
  els.feed.innerHTML = '<div class="loading-card"></div><div class="loading-card"></div><div class="loading-card"></div>';
  els['markdown-view'].hidden = true;
  const [reportResponse, markdownResponse] = await Promise.all([
    fetch('/data/reports/' + date + '.json'),
    fetch('/data/markdown/' + date + '.md'),
  ]);
  if (!reportResponse.ok) throw new Error(t('cannotRead', date));
  state.report = await reportResponse.json();
  state.markdown = markdownResponse.ok ? await markdownResponse.text() : t('noMarkdown', date);
  state.markdown = reportMarkdown(state.report, date);
  state.view = 'report';
  state.date = date;
  state.source = 'all';
  renderDateOptions(date);
  els['page-title'].textContent = t('pageTitle');
  els['section-date'].textContent = date;
  if (updateUrl) {
    history.replaceState({}, '', internalViewUrl('/reports/' + date + '/'));
  }
  renderSourceControls();
  renderFeed();
  updateMetadata(date, allItems().length);
}

function bindInputs() {
  els['date-select'].addEventListener('change', () => {
    if (els['date-select'].value === 'favorites') loadFavorites();
    else loadReport(els['date-select'].value);
  });
  els['source-select'].addEventListener('change', () => selectSource(els['source-select'].value));
  els['style-select'].addEventListener('change', () => applyStyle(els['style-select'].value));
  els['language-select'].addEventListener('change', () => {
    const nextLocale = els['language-select'].value;
    const path = location.pathname.replace(/^\/en(?=\/|$)/, '') || '/';
    const targetPath = nextLocale === 'en' ? `/en${path === '/' ? '/' : path}` : path;
    location.assign(targetPath + location.search + location.hash);
  });
  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    renderFeed();
  });

  // GitHub-style source select-menu (details/summary)
  const menu = els['github-source-menu'];
  const menuList = els['github-source-list'];
  if (menu && menuList) {
    menuList.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-source]');
      if (!button) return;
      selectSource(button.dataset.source);
      menu.removeAttribute('open');
    });
    const filter = els['github-source-filter'];
    if (filter) {
      filter.addEventListener('input', () => {
        const query = filter.value.trim().toLocaleLowerCase(state.locale);
        menuList.querySelectorAll('.select-menu-item').forEach((item) => {
          const match = !query || (item.querySelector('.select-menu-item-text')?.textContent || '').toLocaleLowerCase('zh-CN').includes(query);
          item.hidden = !match;
        });
      });
      filter.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          const visible = menuList.querySelector('.select-menu-item:not([hidden])');
          if (visible) selectSource(visible.dataset.source);
          menu.removeAttribute('open');
        }
      });
    }
    menu.querySelectorAll('.close-button').forEach((button) => {
      button.addEventListener('click', () => menu.removeAttribute('open'));
    });
    document.addEventListener('click', (event) => {
      if (menu.open && !menu.contains(event.target)) menu.removeAttribute('open');
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.open) menu.removeAttribute('open');
    });
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    if (link) trackOutboundClick(link);
  }, { passive: true });
}

async function init() {
  try {
    applyLocale();
    state.index = await fetch('/data/index.json').then((response) => response.json());
    renderDateOptions(state.index.latest);
    els['style-select'].value = state.style;
    bindInputs();
    if (/^\/(?:en\/)?favorites\/?$/.test(location.pathname)) {
      loadFavorites(false);
      return;
    }
    const pathDate = location.pathname.match(/^\/(?:en\/)?reports\/(\d{4}-\d{2}-\d{2})\/?$/)?.[1];
    const requested = pathDate || new URL(location.href).searchParams.get('date');
    await loadReport(state.index.dates.includes(requested) ? requested : state.index.latest, false);
  } catch (error) {
    els.feed.innerHTML = '<div class="error"><h2>' + t('unavailableReport') + '</h2><p>' + escapeHtml(error.message) + '</p></div>';
  }
}

init();
