/* Shared by the static builder and browser: one content model and one renderer. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DevTrends = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const origin = 'https://devtrends.site';
  const favoritesKey = 'devtrends-favorites-v1';
  const messages = {
    'zh-CN': {
      discover: '今日发现', archive: '历史日报', favorites: '我的收藏', slogan: '大家都在做什么',
      intro: '每天发现开发者社区的新项目、新产品与开源趋势。', all: '全部来源', search: '搜索项目、作者或标签',
      language: '语言', theme: '外观', system: '跟随系统', light: '浅色', dark: '深色', date: '日报日期',
      count: '{n} 个项目', sources: '{n} 个来源', save: '收藏', saved: '已收藏', remove: '取消收藏',
      website: '官网', repository: 'GitHub 仓库', source: '来源', details: '项目详情', original: '原文',
      noSummary: '暂无项目介绍。', empty: '没有找到相关项目', emptyHint: '换一个关键词或来源试试。',
      clear: '清除筛选', emptyFavorites: '把感兴趣的项目留在这里', favoritesHint: '点击项目旁的收藏按钮，保存在当前浏览器中。',
      unavailable: '内容暂时无法加载', retry: '重新加载', storageError: '浏览器无法保存收藏，请检查存储设置。',
      archiveIntro: '沿着日期，回看开发者们的创造。', readReport: '阅读日报', download: '下载 Markdown',
      about: '项目介绍', facts: '仓库信息', timeline: '收录记录', related: '相关项目',
      firstSeen: '首次收录', lastSeen: '最近收录', appearances: '收录天数', days: '{n} 天',
      owner: '所有者', programmingLanguage: '主要语言', license: '许可证', stars: 'Stars', forks: 'Forks',
      todayStars: '今日新增 {n} Stars', snapshot: '仓库数据快照 · {date}', archived: '仓库已归档',
      timelineHint: '以下日期为 DevTrends 收录日期，指标来自当时的数据快照。', viewSource: '查看来源',
      brandLabel: '开发者趋势', footer: '从社区出发，发现值得关注的创造。', skip: '跳转到内容',
      noReports: '暂无日报', missing: '页面不存在', missingHint: '这个地址没有对应的项目或日报。', home: '返回今日发现',
      summaryNote: '介绍整理自已收录的社区资料。', projectIntro: '{name} 的项目介绍、GitHub 仓库信息与社区收录记录。',
      unknownSource: '开发者社区', localOnly: '收藏仅保存在当前浏览器', reportTitle: '{date} 开发者趋势日报',
      archiveTitle: '历史日报', homeTitle: 'DevTrends 开发者趋势｜大家都在做什么', translationNote: '暂无此语言译文，以下保留原文。',
    },
    en: {
      discover: 'Discover', archive: 'Archive', favorites: 'Favorites', slogan: 'What developers are building',
      intro: 'Daily discoveries from developer communities, independent makers, and open source.', all: 'All sources', search: 'Search projects, authors, or tags',
      language: 'Language', theme: 'Appearance', system: 'System', light: 'Light', dark: 'Dark', date: 'Report date',
      count: '{n} projects', sources: '{n} sources', save: 'Save', saved: 'Saved', remove: 'Remove favorite',
      website: 'Website', repository: 'GitHub repository', source: 'Source', details: 'Project details', original: 'Original',
      noSummary: 'No project description yet.', empty: 'No matching projects', emptyHint: 'Try another keyword or source.',
      clear: 'Clear filters', emptyFavorites: 'Keep your next discovery here', favoritesHint: 'Save a project to keep it in this browser.',
      unavailable: 'Content could not be loaded', retry: 'Try again', storageError: 'This browser could not save favorites. Check its storage settings.',
      archiveIntro: 'Explore what developers have been building, day by day.', readReport: 'Read report', download: 'Download Markdown',
      about: 'About the project', facts: 'Repository details', timeline: 'Discovery history', related: 'Related projects',
      firstSeen: 'First discovered', lastSeen: 'Last discovered', appearances: 'Days featured', days: '{n} days',
      owner: 'Owner', programmingLanguage: 'Primary language', license: 'License', stars: 'Stars', forks: 'Forks',
      todayStars: '+{n} stars today', snapshot: 'Repository snapshot · {date}', archived: 'Archived repository',
      timelineHint: 'Dates refer to DevTrends reports. Metrics reflect the snapshot collected at the time.', viewSource: 'View source',
      brandLabel: 'Developer trends', footer: 'Discover what’s worth following, straight from the community.', skip: 'Skip to content',
      noReports: 'No reports yet', missing: 'Page not found', missingHint: 'There is no project or report at this address.', home: 'Back to Discover',
      summaryNote: 'Descriptions are drawn from collected community sources.', projectIntro: 'Explore {name}, its GitHub repository, and its discovery history across developer communities.',
      unknownSource: 'Developer community', localOnly: 'Favorites stay in this browser', reportTitle: '{date} Developer Trends Report',
      archiveTitle: 'Report archive', homeTitle: 'DevTrends | What developers are building', translationNote: 'A translation is not available yet. The original text is shown below.',
    },
  };
  const sourceLabels = {
    vibecafe: ['VibeCafé', 'VibeCafé'], 'chinese-indie-dev': ['中文独立开发者', 'Chinese Indie Developers'],
    'weekly-issues': ['阮一峰周刊投稿', 'Ruan Yifeng Weekly Submissions'], 'weekly-issue': ['阮一峰周刊精选', 'Ruan Yifeng Weekly Picks'],
    'hellogithub-issues': ['HelloGitHub 投稿', 'HelloGitHub Submissions'], 'hellogithub-issue': ['HelloGitHub 月刊', 'HelloGitHub Monthly Picks'],
    'github-trending': ['GitHub Trending', 'GitHub Trending'], 'github-trending-cn': ['GitHub 中文趋势', 'GitHub Trending China'],
    producthunt: ['Product Hunt', 'Product Hunt'],
  };
  const t = (locale, key, args = {}) => String(messages[locale]?.[key] ?? messages['zh-CN'][key] ?? key)
    .replace(/\{(\w+)\}/g, (_, name) => args[name] ?? '');
  const escapeHtml = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
  const localPath = (route, locale) => (locale === 'en' ? '/en' : '') + route;
  const sourceName = (item, locale) => sourceLabels[item.sourceId]?.[locale === 'en' ? 1 : 0] || item.sourceName || t(locale, 'unknownSource');
  function safeUrl(value) {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
  }
  // Accept repository roots only. Issue/blob/profile URLs must not create false projects.
  function repository(item) {
    for (const candidate of [item.githubUrl, item.github?.url, item.url, item.websiteUrl]) {
      try {
        const url = new URL(candidate);
        if (!['https:', 'http:'].includes(url.protocol) || !['github.com', 'www.github.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) continue;
        const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
        if (parts.length !== 2) continue;
        const owner = parts[0], repo = parts[1].replace(/\.git$/i, '');
        if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(owner) || !/^[a-z\d_.-]{1,100}$/i.test(repo) || /^\.+$/.test(repo)) continue;
        if (['features', 'topics', 'collections', 'settings', 'marketplace', 'orgs', 'users', 'search', 'sponsors', 'login', 'signup', 'apps', 'enterprise', 'organizations'].includes(owner.toLowerCase())) continue;
        const key = `${owner}/${repo}`.toLowerCase();
        return { key, owner, name: repo, fullName: `${owner}/${repo}`, url: `https://github.com/${key}`, path: `/projects/${key}/` };
      } catch {}
    }
    return null;
  }
  function favoriteId(item) {
    return repository(item)?.url || String(item.websiteUrl || item.url || `${item.sourceId || 'item'}:${item.externalId || item.title || 'untitled'}`).replace(/#.*$/, '').replace(/\/$/, '');
  }
  function summary(item, locale) {
    const explicit = locale === 'en' ? item.summaryEn || item.summary_en : item.summaryZh || item.summary_zh;
    if (explicit) return { text: explicit, original: false, lang: locale };
    const candidates = locale === 'en'
      ? [item.github?.description, item.tagline, item.description, item.summary, item.content]
      : [item.summary, item.tagline, item.github?.description, item.description, item.content];
    const available = candidates.filter(value => typeof value === 'string' && value.trim());
    const matches = value => locale === 'en' ? !/[\u3400-\u9fff]/u.test(value) : /[\u3400-\u9fff]/u.test(value);
    const text = locale === 'zh-CN' ? available[0] : (available.find(matches) || available[0]);
    return { text: text || t(locale, 'noSummary'), original: Boolean(text && !matches(text)), lang: text && /[\u3400-\u9fff]/u.test(text) ? 'zh-CN' : 'en' };
  }
  function displayTitle(item, locale = 'zh-CN') {
    const localized = locale === 'en' ? item.titleEn || item.title_en : item.titleZh || item.title_zh;
    return String(localized || item.title || repository(item)?.fullName || 'Untitled')
      .replace(/^\s*[【\[][^】\]]*(?:自荐|推荐|投稿)[^】\]]*[】\]]\s*[:：—-]?\s*/u, '')
      .replace(/^\s*(?:项目|网站|开源|工具|软件)?\s*(?:自荐|推荐|投稿)\s*[:：—-]\s*/u, '').trim();
  }
  const reportItems = report => (report?.results || []).flatMap(source => (source.items || []).map(item => ({ ...item, sourceId: item.sourceId || source.sourceId, sourceName: source.sourceName })));
  function metric(item, names) {
    for (const name of names) { const value = item.github?.[name] ?? item.metrics?.[name]; if (value !== null && value !== undefined && value !== '') return value; }
    return null;
  }
  const compact = (value, locale) => Number.isFinite(Number(value)) ? new Intl.NumberFormat(locale, { notation: Number(value) >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(Number(value)) : '';
  function itemCategories(item) {
    const repo = repository(item);
    const text = [item.title, item.titleEn, item.summary, item.summaryZh, item.summaryEn, item.github?.description, ...(item.tags || []), ...(item.github?.topics || [])].filter(Boolean).join(' ').toLowerCase();
    const categories = [];
    if (repo) categories.push('opensource');
    if (/\b(ai|llm|gpt|agent|model|machine-learning)\b|人工智能|大模型/i.test(text)) categories.push('ai');
    if (/\b(design|image|video|ui|ux|creative|canvas)\b|设计|图像|视频|画布/i.test(text)) categories.push('design');
    if (/\b(framework|sdk|library|runtime|react|vue|next\.?js|node\.?js)\b|框架|组件库/i.test(text)) categories.push('framework');
    if (/\b(cli|editor|tool|ide|browser|desktop|developer)\b|工具|编辑器|开发/i.test(text)) categories.push('tools');
    if (/indie|vibecafe|producthunt/.test(String(item.sourceId || '').toLowerCase())) categories.push('indie');
    return [...new Set(categories)];
  }
  const dateLabel = (date, locale) => /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)) : '';
  function trackedUrl(value, item, date) {
    const safe = safeUrl(value);
    if (!safe) return '';
    const url = new URL(safe);
    if (/(^|\.)(github\.com|devtrends\.site)$/.test(url.hostname) || [...url.searchParams.keys()].some(k => /^utm_/i.test(k) || /(^|[-_])(signature|sig|token|expires?)($|[-_])/i.test(k))) return safe;
    url.searchParams.set('utm_source', 'devtrends'); url.searchParams.set('utm_medium', 'referral'); url.searchParams.set('utm_campaign', 'daily_report');
    url.searchParams.set('utm_content', `${date || 'project'}_${item.sourceId || 'unknown'}_${item.externalId || item.title || 'item'}`.slice(0, 160));
    return url.href;
  }
  function itemLinks(item) {
    const repo = repository(item);
    const website = safeUrl(item.websiteUrl || item.github?.homepage || (!repo ? item.url : ''));
    const source = safeUrl(item.issueUrl || item.relatedIssue || item.vibecafeUrl || item.productHuntUrl || item.url);
    const seen = new Set();
    return [['repository', repo?.url], ['website', website], ['source', source]]
      .filter(([, url]) => url && !seen.has(url) && seen.add(url));
  }
  const icon = (name) => {
    const paths = {
      bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>', arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
      search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
      repo: '<path d="M5 4h14v16H7a2 2 0 0 1-2-2V4Zm0 12h14M9 7h6"/>',
      github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7.4A5.8 5.8 0 0 0 19.3 3 5.4 5.4 0 0 0 19.1 0S17.9-.4 15 1.5a14 14 0 0 0-6 0C6.1-.4 4.9 0 4.9 0a5.4 5.4 0 0 0-.2 3A5.8 5.8 0 0 0 3.2 7c0 5.8 3.5 7 6.8 7.4A4.8 4.8 0 0 0 9 18v4M9 19c-3 .9-3-1.5-4.2-2"/>',
      box: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9"/>',
      star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
    };
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.box}</svg>`;
  };
  function favoriteButton(item, locale, saved = false) {
    return `<button type="button" class="favorite-button${saved ? ' active' : ''}" data-favorite-id="${escapeHtml(favoriteId(item))}" aria-pressed="${saved}" aria-label="${escapeHtml(t(locale, saved ? 'remove' : 'save') + ' ' + displayTitle(item, locale))}">${icon('bookmark')}<span>${t(locale, saved ? 'saved' : 'save')}</span></button>`;
  }
  function shortDate(value, locale) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? new Date(`${value}T00:00:00Z`) : new Date(value || '');
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  }
  function sourceMark(item) {
    const name = sourceName(item, 'en');
    if (/github/i.test(name)) return icon('github');
    const known = { producthunt: 'P', vibecafe: 'V', hackernews: 'Y', reddit: 'R', devto: 'D', indiehackers: 'IH' };
    return escapeHtml(known[String(item.sourceId || '').toLowerCase()] || name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'D');
  }
  function renderItem(item, locale, { date = '', saved = false, index = 0 } = {}) {
    const repo = repository(item), projectPath = item.projectPath;
    const links = itemLinks(item), primary = safeUrl(item.websiteUrl || item.url) || repo?.url;
    const titleUrl = projectPath ? localPath(projectPath, locale) : trackedUrl(repo?.url || primary, item, date);
    const s = summary(item, locale);
    const language = metric(item, ['language', 'lang']);
    const stars = metric(item, ['stars', 'stargazers_count', 'totalStars']);
    const votes = metric(item, ['votes', 'votesCount']);
    const tags = [...new Set([...(item.github?.topics || []), ...(item.tags || [])])].filter(tag => !['product', 'vibecafe', 'daily', 'new', 'official-featured', 'submission', 'github-trending'].includes(tag)).slice(0, 3);
    const imageUrl = safeUrl(item.image || item.logo || item.icon);
    const title = displayTitle(item, locale);
    const score = stars !== null ? stars : votes;
    const scoreIcon = stars !== null ? icon('star') : (votes !== null ? '<span aria-hidden="true">▲</span>' : '');
    const published = shortDate(item.publishedAt || item.reportDate || date, locale);
    const sourceUrl = itemLinks(item).find(([label]) => label === 'source')?.[1];
    return `<article class="feed-item" data-source-id="${escapeHtml(item.sourceId)}" data-item-id="${escapeHtml(item.externalId || favoriteId(item))}">
      <span class="item-number" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
      <span class="item-avatar avatar-${index % 5}" aria-hidden="true">${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" loading="lazy" />` : escapeHtml((repo?.name || title).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2))}</span>
      <div class="item-primary"><h2>${titleUrl ? `<a href="${escapeHtml(titleUrl)}"${projectPath ? '' : ' target="_blank" rel="noopener noreferrer"'}>${escapeHtml(title)}</a>` : escapeHtml(title)}</h2><p class="summary" lang="${s.lang}">${escapeHtml(s.text)}</p>${s.original ? `<span class="original-label">${t(locale, 'original')}</span>` : ''}</div>
      <div class="item-tags">${language ? `<span class="tag">${escapeHtml(language)}</span>` : ''}${tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="item-source"><span class="source-mini source-mini-${escapeHtml(String(item.sourceId || '').toLowerCase())}" aria-hidden="true">${sourceMark(item)}</span>${sourceUrl ? `<a href="${escapeHtml(trackedUrl(sourceUrl, item, date))}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceName(item, locale))}</a>` : `<span>${escapeHtml(sourceName(item, locale))}</span>`}</div>
      <div class="item-score">${score !== null ? `${scoreIcon}<span>${compact(score, locale)}</span>` : '<span>—</span>'}</div>
      <time class="item-date" datetime="${escapeHtml((item.publishedAt || date || '').slice(0, 10))}">${escapeHtml(published)}</time>
      <div class="item-actions">${favoriteButton(item, locale, saved)}</div></article>`;
  }
  return { origin, favoritesKey, messages, t, escapeHtml, json, localPath, sourceName, safeUrl, repository, favoriteId, summary, displayTitle, reportItems, itemCategories, metric, compact, dateLabel, trackedUrl, itemLinks, icon, favoriteButton, renderItem };
});
