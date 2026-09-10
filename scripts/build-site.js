const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, '知识', '大家都在做什么', 'raw');
const webDir = path.join(root, 'web');
const outputDir = path.join(root, 'dist');
const reportsDir = path.join(outputDir, 'data', 'reports');
const markdownDir = path.join(outputDir, 'data', 'markdown');
const finalDir = path.join(root, '知识', '大家都在做什么', 'final');
const siteOrigin = 'https://devtrends.site';
const outboundUtm = {
  source: 'devtrends',
  medium: 'referral',
  campaign: 'daily_report',
};
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
const sourceNamesEn = {
  vibecafe: 'VibeCafé Projects', 'chinese-indie-dev': 'Chinese Indie Developers',
  'weekly-issues': 'Ruan Yifeng Weekly Submissions', 'weekly-issue': 'Ruan Yifeng Weekly Picks',
  'hellogithub-issues': 'HelloGitHub Submissions', 'hellogithub-issue': 'HelloGitHub Monthly Picks',
  'github-trending': 'GitHub Trending', 'github-trending-cn': 'GitHub Trending China', producthunt: 'Product Hunt',
};

function localizedTemplate(template, locale) {
  if (locale !== 'en') return template;
  const replacements = [
    ['<html lang="zh-CN"', '<html lang="en"'],
    ['content="zh_CN"', 'content="en_US"'],
    ['aria-label="DevTrends 开发者趋势首页"', 'aria-label="DevTrends home"'],
    ['<a class="brand" href="/"', '<a class="brand" href="/en/"'],
    ['placeholder="搜索项目、作者或标签"', 'placeholder="Search projects, authors, or tags"'],
    ['选择日报或收藏', 'Select a report or favorites'],
    ['筛选来源', 'Filter sources'],
    ['切换展示风格', 'Switch display style'],
    ['切换语言', 'Switch language'],
    ['<p id="page-kicker">DEV TRENDS · 开发者趋势</p>', '<p id="page-kicker">DEV TRENDS · DEVELOPER TRENDS</p>'],
    ['<h1 id="page-title">大家都在做什么</h1>', '<h1 id="page-title">What developers are building</h1>'],
    ['aria-label="筛选数据来源"', 'aria-label="Filter data sources"'],
    ['<span id="github-source-label">数据源:</span>', '<span id="github-source-label">Source:</span>'],
    ['<span class="text-bold" id="github-source-value">全部</span>', '<span class="text-bold" id="github-source-value">All</span>'],
    ['<span class="select-menu-title" id="github-source-title">选择数据来源</span>', '<span class="select-menu-title" id="github-source-title">Choose a source</span>'],
    ['aria-label="关闭菜单"', 'aria-label="Close menu"'],
    ['<h2 id="empty-title">没有找到相关项目</h2>', '<h2 id="empty-title">No matching projects</h2>'],
    ['<p id="empty-hint">换一个关键词或来源试试。</p>', '<p id="empty-hint">Try another keyword or source.</p>'],
  ];
  return replacements.reduce((html, [from, to]) => html.replaceAll(from, to), template);
}

function localizedSourceName(source, locale) {
  return locale === 'en' ? (sourceNamesEn[source.sourceId] || source.sourceName) : source.sourceName;
}

function itemSummary(item, locale) {
  return locale === 'en'
    ? (item.summaryEn || item.summary_en || item.github?.description || item.content || item.tagline || item.description || item.summary || 'No description yet')
    : (item.summary || item.tagline || item.content || '暂无简介');
}

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const escapeXml = (value = '') => escapeHtml(value);
const starIcon = (decorative = false) => `<svg ${decorative ? 'aria-hidden="true"' : 'aria-label="star" role="img"'} data-component="Octicon" height="16" viewBox="0 0 16 16" version="1.1" width="16" class="octicon octicon-star"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z"></path></svg>`;
const forkIcon = '<svg aria-label="fork" role="img" data-component="Octicon" height="16" viewBox="0 0 16 16" version="1.1" width="16" class="octicon octicon-repo-forked"><path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"></path></svg>';

function reportItems(report) {
  return (report.results || []).flatMap((source) =>
    (source.items || []).map((item) => ({ ...item, sourceName: source.sourceName })),
  );
}

function parseEnhancedMarkdown(markdown) {
  const sections = new Map();
  let currentSection = null;
  let currentItem = null;

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      currentSection = line.slice(3).replace(/（\d+\s*条）\s*$/, '').trim();
      sections.set(currentSection, []);
      currentItem = null;
      continue;
    }
    if (!currentSection) continue;
    if (line.startsWith('### ')) {
      currentItem = { heading: line.slice(4).trim(), summary: null, used: false };
      sections.get(currentSection).push(currentItem);
      continue;
    }
    if (currentItem && line.startsWith('> ')) {
      currentItem.summary = line.slice(2).trim();
      currentItem = null;
    }
  }
  return sections;
}

function applyEnhancedMarkdown(report, markdown, date) {
  const enhanced = JSON.parse(JSON.stringify(report));
  const sections = parseEnhancedMarkdown(markdown);
  let enhancedCount = 0;
  let totalCount = 0;

  for (const source of enhanced.results || []) {
    if (!source.items?.length) continue;
    const entries = sections.get(source.sourceName) || [];
    source.items.forEach((item) => {
      totalCount += 1;
      const expectedHeading = `${item.title}${item.author ? ` 👤 ${item.author}` : ''}`;
      const entry = entries.find((candidate) => candidate.heading === expectedHeading && !candidate.used);
      if (entry?.summary !== null && entry?.summary !== undefined) {
        item.summary = entry.summary;
        item.summarySource = 'llm-final';
        entry.used = true;
        enhancedCount += 1;
      } else {
        item.summarySource = 'raw';
      }
    });
  }

  enhanced.presentation = {
    summarySource: enhancedCount === totalCount ? 'llm-final' : (enhancedCount ? 'mixed' : 'raw'),
    enhancedItemCount: enhancedCount,
    totalItemCount: totalCount,
    finalDate: date,
  };
  return enhanced;
}

function itemUrl(item) {
  return item.websiteUrl || item.githubUrl || item.github?.url || item.url || siteOrigin;
}

function outboundContent(item, date) {
  const identity = item?.externalId || item?.vibecafeId || item?.title || 'item';
  return `${date || 'latest'}_${item?.sourceId || 'unknown'}_${identity}`.slice(0, 160);
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

function displayTitle(item) {
  const title = String(item.title || '未命名项目');
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
  if (item.sourceId === 'hellogithub-issue' && item.issue) return `https://hellogithub.com/periodical/volume/${encodeURIComponent(item.issue)}`;
  if (item.sourceId === 'weekly-issue' && item.issue) return `https://github.com/ruanyf/weekly/blob/master/docs/issue-${encodeURIComponent(item.issue)}.md`;
  if (item.authorUrl) return item.authorUrl;
  if (item.sourceId === 'chinese-indie-dev') return 'https://github.com/1c7/chinese-independent-developer';
  return item.url || '';
}

function submissionEntry(item, locale = 'zh-CN') {
  const originUrl = submissionUrl(item);
  if (!originUrl) return '';
  const favicon = sourceFavicons[item.sourceId];
  const avatar = favicon
    ? `<img src="${escapeHtml(favicon)}" width="20" height="20" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<span aria-hidden="true">${escapeHtml(sourceMarks[item.sourceId] || '•')}</span>`;
  const label = locale === 'en' ? 'Source' : '投稿页';
  const title = locale === 'en' ? 'View source page' : '查看来源页面';
  return `<span class="submission-entry">${label} <a href="${escapeHtml(originUrl)}" target="_blank" rel="noopener noreferrer" title="${title}" aria-label="${title}: ${escapeHtml(displayTitle(item))}">${avatar}</a></span>`;
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

function itemTypeIcon(item, locale = 'zh-CN') {
  const sourceId = item.sourceId || '';
  const githubUrl = githubRepositoryUrl(item);
  let label = locale === 'en' ? 'External project' : '外部项目';
  let kind = 'link';
  let pathData = '<path d="M7.775 3.275a.75.75 0 0 0-1.06-1.06l-3.5 3.5a3.25 3.25 0 0 0 4.596 4.596l1-1a.75.75 0 0 0-1.06-1.06l-1 1a1.75 1.75 0 1 1-2.476-2.476l3.5-3.5Z"/><path d="M8.25 7.75a.75.75 0 0 0 0 1.06 1.75 1.75 0 0 1 2.475 2.475l-3.5 3.5a.75.75 0 0 0 1.06 1.06l3.5-3.5A3.25 3.25 0 0 0 7.19 7.75a.75.75 0 0 0 1.06 0Z"/>';

  if (githubUrl) {
    label = locale === 'en' ? 'GitHub repository' : 'GitHub 仓库';
    kind = 'repository';
    pathData = '<path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/>';
  } else if (sourceId === 'vibecafe') {
    const vibeLabel = locale === 'en' ? 'VibeCafé project' : 'VibeCafé 作品';
    return `<span class="item-type-icon item-type-vibecafe" role="img" aria-label="${vibeLabel}" title="${vibeLabel}"><img src="https://vibecafe.ai/favicon.svg" width="16" height="16" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>`;
  } else if (['producthunt', 'chinese-indie-dev'].includes(sourceId)) {
    label = locale === 'en' ? 'Product launch' : '产品发布';
    kind = 'product';
    pathData = '<path d="M8 1 14 4.25v7.5L8 15l-6-3.25v-7.5L8 1Zm0 1.7L4.15 4.78 8 6.86l3.85-2.08L8 2.7ZM3.5 6.04v4.82l3.75 2.03V8.07L3.5 6.04Zm9 0L8.75 8.07v4.82l3.75-2.03V6.04Z"/>';
  } else if (['weekly-issues', 'hellogithub-issues'].includes(sourceId)) {
    label = locale === 'en' ? 'Community submission' : '社区投稿';
    kind = 'community';
    pathData = '<path d="M1.75 2A1.75 1.75 0 0 0 0 3.75v7.5C0 12.216.784 13 1.75 13H4v2.25a.75.75 0 0 0 1.28.53L8.06 13h6.19A1.75 1.75 0 0 0 16 11.25v-7.5A1.75 1.75 0 0 0 14.25 2H1.75ZM1.5 3.75a.25.25 0 0 1 .25-.25h12.5a.25.25 0 0 1 .25.25v7.5a.25.25 0 0 1-.25.25H7.75a.75.75 0 0 0-.53.22L5.5 13.44V12.25a.75.75 0 0 0-.75-.75h-3a.25.25 0 0 1-.25-.25v-7.5Z"/>';
  } else if (['weekly-issue', 'hellogithub-issue'].includes(sourceId)) {
    label = locale === 'en' ? 'Editor’s pick' : '编辑推荐';
    kind = 'editorial';
    pathData = '<path d="M3.75 1A1.75 1.75 0 0 0 2 2.75v11.5a.75.75 0 0 0 1.14.64L8 12.03l4.86 2.86a.75.75 0 0 0 1.14-.64V2.75A1.75 1.75 0 0 0 12.25 1h-8.5Zm-.25 1.75a.25.25 0 0 1 .25-.25h8.5a.25.25 0 0 1 .25.25v10.19l-4.12-2.42a.75.75 0 0 0-.76 0L3.5 12.94V2.75Z"/>';
  }

  return `<span class="item-type-icon item-type-${kind}" role="img" aria-label="${label}" title="${label}"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">${pathData}</svg></span>`;
}

function renderSeoItem(item, date, locale = 'zh-CN') {
  const primaryUrl = itemUrl(item);
  const url = escapeHtml(trackedOutboundUrl(primaryUrl, item, date));
  const repositoryUrl = githubRepositoryUrl(item);
  const titleUrl = escapeHtml(trackedOutboundUrl(repositoryUrl || primaryUrl, item, date));
  const title = escapeHtml(displayTitle(item));
  const summary = escapeHtml(itemSummary(item, locale));
  const source = escapeHtml(localizedSourceName(item, locale) || item.sourceId || (locale === 'en' ? 'Community update' : '社区动态'));
  const author = item.author ? `<span>by ${escapeHtml(item.author)}</span>` : '';
  const stars = item.github?.stars ?? item.metrics?.stars;
  const forks = item.github?.forks ?? item.metrics?.forks;
  const today = item.metrics?.today;
  const votes = item.metrics?.votes;
  const comments = item.metrics?.comments;
  const language = item.github?.language || item.metrics?.lang;
  const metrics = [
    language ? `<span><i class="language-dot"></i>${escapeHtml(language)}</span>` : '',
    stars !== undefined ? `<span>${starIcon()}${escapeHtml(stars)}</span>` : '',
    forks !== undefined ? `<span>${forkIcon}${escapeHtml(forks)}</span>` : '',
    votes !== undefined ? `<span>▲ ${escapeHtml(votes)}</span>` : '',
    comments !== undefined ? `<span>◌ ${escapeHtml(comments)}</span>` : '',
  ].filter(Boolean).join('') + submissionEntry(item, locale);
  const visual = item.image
    ? `<img class="item-visual" src="${escapeHtml(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<div class="item-visual item-fallback" aria-hidden="true">${escapeHtml((item.sourceId || '•').slice(0, 2))}</div>`;

  const secondaryLink = repositoryUrl && itemUrl(item) !== repositoryUrl
    ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${locale === 'en' ? 'Website' : '官网'} ↗</a>`
    : '';
  const save = locale === 'en' ? 'Save' : '收藏';
  return `<article class="feed-item">${visual}<div class="item-content"><div class="item-source">${source}${author}</div><h2>${itemTypeIcon(item, locale)}<a class="title-link-github" href="${titleUrl}" target="_blank" rel="noopener noreferrer">${title}</a><a class="title-link-default" href="${url}" target="_blank" rel="noopener noreferrer">${title}</a></h2><p class="summary">${summary}</p><div class="item-meta"><div class="metrics">${metrics}</div><div class="links">${secondaryLink}</div></div></div><div class="github-item-actions"><button type="button" class="favorite-button" data-favorite-id="${escapeHtml(favoriteId(item))}" aria-pressed="false" aria-label="${save} ${title}">${starIcon(true)}${save}</button>${repositoryUrl && today !== undefined ? `<b>${starIcon(true)}${escapeHtml(today)} stars today</b>` : ''}</div><div class="ph-item-actions"><span>◌<b>${escapeHtml(comments ?? '—')}</b></span><a href="${url}" target="_blank" rel="noopener noreferrer">△<b>${escapeHtml(votes ?? '—')}</b></a></div></article>`;
}

function renderFavoritesPage(template, locale = 'zh-CN') {
  const english = locale === 'en';
  const title = english ? 'Favorites | DevTrends' : '我的收藏｜DevTrends';
  const description = english ? 'DevTrends projects saved in this browser.' : '保存在当前浏览器中的 DevTrends 项目收藏。';
  const canonicalUrl = `${siteOrigin}${english ? '/en' : ''}/favorites/`;
  const alternateUrl = `${siteOrigin}${english ? '' : '/en'}/favorites/`;
  return localizedTemplate(template, locale)
    .replace(/<title>.*?<\/title>/, `<title>${title}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${description}" />`)
    .replace(/<meta name="robots" content="[^"]*" \/>/, '<meta name="robots" content="noindex, nofollow" />')
    .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${title}" />`)
    .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${description}" />`)
    .replace(/<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${title}" />`)
    .replace(/<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${description}" />`)
    .replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${canonicalUrl}" />`)
    .replace(/<link rel="alternate" hreflang="zh-CN" href="[^"]*" \/>/, `<link rel="alternate" hreflang="zh-CN" href="${english ? alternateUrl : canonicalUrl}" />`)
    .replace(/<link rel="alternate" hreflang="en" href="[^"]*" \/>/, `<link rel="alternate" hreflang="en" href="${english ? canonicalUrl : alternateUrl}" />`)
    .replace(/<link rel="alternate" hreflang="x-default" href="[^"]*" \/>/, `<link rel="alternate" hreflang="x-default" href="${english ? alternateUrl : canonicalUrl}" />`)
    .replace(/<h1 id="page-title">.*?<\/h1>/, `<h1 id="page-title">${english ? 'Favorites' : '我的收藏'}</h1>`)
    .replace('<b id="section-date"></b>', `<b id="section-date">${english ? 'Favorites' : '我的收藏'}</b>`);
}

function renderPage(template, report, date, canonicalUrl, locale = 'zh-CN') {
  const english = locale === 'en';
  template = localizedTemplate(template, locale);
  const items = reportItems(report);
  const sourceNames = (report.results || []).filter((source) => source.items?.length).map((source) => localizedSourceName(source, locale));
  const isHomepage = canonicalUrl === `${siteOrigin}${english ? '/en' : ''}/`;
  const title = isHomepage
    ? (english ? 'DevTrends | What developers are building' : 'DevTrends 开发者趋势｜大家都在做什么')
    : (english ? `${date} Developer Trends Report | DevTrends` : `${date} 开发者趋势日报｜DevTrends`);
  const description = isHomepage
    ? (english ? 'Daily discoveries from GitHub Trending, VibeCafé, Product Hunt, and independent developer communities.' : '每日聚合 GitHub Trending、VibeCafé、Product Hunt 与中文独立开发者社区的新项目、新产品和开源趋势。')
    : (english ? `${date} developer trends report with ${items.length} projects from ${sourceNames.slice(0, 4).join(', ')}, and more.` : `${date} 开发者趋势日报，共收录 ${items.length} 条动态，来自 ${sourceNames.slice(0, 4).join('、')}等社区。`);
  const route = canonicalUrl.replace(siteOrigin, '').replace(/^\/en(?=\/)/, '');
  const zhUrl = `${siteOrigin}${route}`;
  const enUrl = `${siteOrigin}/en${route}`;
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    description,
    url: canonicalUrl,
    inLanguage: locale,
    datePublished: date,
    publisher: {
      '@type': 'Organization',
      name: english ? 'DevTrends' : 'DevTrends 开发者趋势',
      url: siteOrigin,
      logo: `${siteOrigin}/logo.svg`,
    },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: items.length,
      itemListElement: items.slice(0, 100).map((item, index) => ({
        '@type': 'ListItem', position: index + 1, name: displayTitle(item), url: itemUrl(item),
      })),
    },
  };

  return template
    .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escapeHtml(description)}" />`)
    .replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${canonicalUrl}" />`)
    .replace(/<link rel="alternate" hreflang="zh-CN" href="[^"]*" \/>/, `<link rel="alternate" hreflang="zh-CN" href="${zhUrl}" />`)
    .replace(/<link rel="alternate" hreflang="en" href="[^"]*" \/>/, `<link rel="alternate" hreflang="en" href="${enUrl}" />`)
    .replace(/<link rel="alternate" hreflang="x-default" href="[^"]*" \/>/, `<link rel="alternate" hreflang="x-default" href="${zhUrl}" />`)
    .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${escapeHtml(title)}" />`)
    .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${escapeHtml(description)}" />`)
    .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${canonicalUrl}" />`)
    .replace(/<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${escapeHtml(title)}" />`)
    .replace(/<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${escapeHtml(description)}" />`)
    .replace('</head>', `    <script type="application/ld+json">${JSON.stringify(structuredData).replace(/</g, '\\u003c')}</script>\n  </head>`)
    .replace('<div id="feed" class="feed" aria-live="polite"></div>', `<div id="feed" class="feed" aria-live="polite">${items.map((item) => renderSeoItem(item, date, locale)).join('')}</div>`)
    .replace('<b id="section-date"></b>', `<b id="section-date">${date}</b>`)
    .replace('<span id="report-stat" aria-live="polite"></span>', `<span id="report-stat" aria-live="polite">${items.length} ${english ? 'items' : '条'}</span>`);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(reportsDir, { recursive: true });
fs.mkdirSync(markdownDir, { recursive: true });
fs.mkdirSync(path.join(outputDir, 'en', 'reports'), { recursive: true });

for (const name of ['styles.css', 'app.js', 'logo.svg']) {
  fs.copyFileSync(path.join(webDir, name), path.join(outputDir, name));
}

const htmlTemplate = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');

const dates = fs.readdirSync(sourceDir)
  .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
  .map((name) => name.slice(0, -5))
  .sort()
  .reverse();

for (const date of dates) {
  const reportPath = path.join(sourceDir, `${date}.json`);
  const enhancedMarkdown = path.join(finalDir, `${date}.md`);
  const rawMarkdown = path.join(sourceDir, `${date}.md`);
  const markdownSource = fs.existsSync(enhancedMarkdown) ? enhancedMarkdown : rawMarkdown;
  let report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (fs.existsSync(enhancedMarkdown)) {
    report = applyEnhancedMarkdown(report, fs.readFileSync(enhancedMarkdown, 'utf8'), date);
  } else {
    report.presentation = {
      summarySource: 'raw',
      enhancedItemCount: 0,
      totalItemCount: reportItems(report).length,
    };
  }
  fs.writeFileSync(path.join(reportsDir, `${date}.json`), `${JSON.stringify(report)}\n`);
  if (fs.existsSync(markdownSource)) {
    fs.copyFileSync(markdownSource, path.join(markdownDir, `${date}.md`));
  }
  const pageDir = path.join(outputDir, 'reports', date);
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, 'index.html'), renderPage(htmlTemplate, report, date, `${siteOrigin}/reports/${date}/`));
  const englishPageDir = path.join(outputDir, 'en', 'reports', date);
  fs.mkdirSync(englishPageDir, { recursive: true });
  fs.writeFileSync(path.join(englishPageDir, 'index.html'), renderPage(htmlTemplate, report, date, `${siteOrigin}/en/reports/${date}/`, 'en'));
}

const latest = dates[0] || null;
if (latest) {
  const latestReport = JSON.parse(fs.readFileSync(path.join(reportsDir, `${latest}.json`), 'utf8'));
  fs.writeFileSync(path.join(outputDir, 'index.html'), renderPage(htmlTemplate, latestReport, latest, `${siteOrigin}/`));
  fs.writeFileSync(path.join(outputDir, 'en', 'index.html'), renderPage(htmlTemplate, latestReport, latest, `${siteOrigin}/en/`, 'en'));
} else {
  fs.writeFileSync(path.join(outputDir, 'index.html'), htmlTemplate);
  fs.writeFileSync(path.join(outputDir, 'en', 'index.html'), localizedTemplate(htmlTemplate, 'en'));
}

const favoritesDir = path.join(outputDir, 'favorites');
fs.mkdirSync(favoritesDir, { recursive: true });
fs.writeFileSync(path.join(favoritesDir, 'index.html'), renderFavoritesPage(htmlTemplate));
const englishFavoritesDir = path.join(outputDir, 'en', 'favorites');
fs.mkdirSync(englishFavoritesDir, { recursive: true });
fs.writeFileSync(path.join(englishFavoritesDir, 'index.html'), renderFavoritesPage(htmlTemplate, 'en'));

fs.writeFileSync(
  path.join(outputDir, 'data', 'index.json'),
  `${JSON.stringify({ latest, dates, generatedAt: new Date().toISOString() }, null, 2)}\n`,
);

fs.writeFileSync(path.join(outputDir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${siteOrigin}/sitemap.xml\n`);
const sitemapUrls = [
  `<url><loc>${siteOrigin}/</loc>${latest ? `<lastmod>${latest}</lastmod>` : ''}</url>`,
  `<url><loc>${siteOrigin}/en/</loc>${latest ? `<lastmod>${latest}</lastmod>` : ''}</url>`,
  ...dates.map((date) => `<url><loc>${siteOrigin}/reports/${date}/</loc><lastmod>${date}</lastmod></url>`),
  ...dates.map((date) => `<url><loc>${siteOrigin}/en/reports/${date}/</loc><lastmod>${date}</lastmod></url>`),
];
fs.writeFileSync(path.join(outputDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapUrls.join('')}</urlset>\n`);

console.log(`Built ${dates.length} reports${latest ? `; latest is ${latest}` : ''}.`);
