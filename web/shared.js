/* Shared by the static builder and browser: one content model and one renderer. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DevTrends = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const origin = 'https://devtrends.site';
  const messages = {
    'zh-CN': {
      discover: '今日发现', archive: '历史日报', slogan: '大家都在做什么',
      intro: '每天发现开发者社区的新项目、新产品与开源趋势。', all: '全部来源', search: '搜索项目、作者或标签',
      language: '语言', theme: '外观', system: '跟随系统', light: '浅色', dark: '深色', date: '日报日期',
      count: '{n} 个项目', sources: '{n} 个来源',
      website: '官网', repository: 'GitHub 仓库', source: '来源', details: '项目详情', original: '原文',
      noSummary: '暂无项目介绍。', empty: '没有找到相关项目', emptyHint: '换一个关键词或来源试试。',
      clear: '清除筛选',
      unavailable: '内容暂时无法加载', retry: '重新加载',
      archiveIntro: '沿着日期，回看开发者们的创造。', readReport: '阅读日报', download: '下载 Markdown',
      about: '项目介绍', facts: '仓库信息', timeline: '收录记录', related: '相关项目',
      firstSeen: '首次收录', lastSeen: '最近收录', appearances: '收录天数', days: '{n} 天',
      owner: '所有者', programmingLanguage: '主要语言', license: '许可证', stars: 'Stars', forks: 'Forks',
      todayStars: '今日新增 {n} Stars', snapshot: '仓库数据快照 · {date}', archived: '仓库已归档',
      timelineHint: '以下日期为 DevTrends 收录日期，指标来自当时的数据快照。', viewSource: '查看来源',
      brandLabel: '开发者趋势', footer: '从社区出发，发现值得关注的创造。', skip: '跳转到内容',
      noReports: '暂无日报', missing: '页面不存在', missingHint: '这个地址没有对应的项目或日报。', home: '返回今日发现',
      summaryNote: '介绍整理自已收录的社区资料。', projectIntro: '{name} 的项目介绍、GitHub 仓库信息与社区收录记录。',
      unknownSource: '开发者社区', reportTitle: '{date} 开发者趋势日报',
      archiveTitle: '历史日报', homeTitle: 'DevTrends 开发者趋势｜大家都在做什么', translationNote: '暂无此语言译文，以下保留原文。',
      gallery: '产品配图', galleryOpen: '查看配图', closeViewer: '关闭配图', previousImage: '上一张', nextImage: '下一张', imageCounter: '第 {n} 张，共 {total} 张',
    },
    en: {
      discover: 'Discover', archive: 'Archive', slogan: 'What developers are building',
      intro: 'Daily discoveries from developer communities, independent makers, and open source.', all: 'All sources', search: 'Search projects, authors, or tags',
      language: 'Language', theme: 'Appearance', system: 'System', light: 'Light', dark: 'Dark', date: 'Report date',
      count: '{n} projects', sources: '{n} sources',
      website: 'Website', repository: 'GitHub repository', source: 'Source', details: 'Project details', original: 'Original',
      noSummary: 'No project description yet.', empty: 'No matching projects', emptyHint: 'Try another keyword or source.',
      clear: 'Clear filters',
      unavailable: 'Content could not be loaded', retry: 'Try again',
      archiveIntro: 'Explore what developers have been building, day by day.', readReport: 'Read report', download: 'Download Markdown',
      about: 'About the project', facts: 'Repository details', timeline: 'Discovery history', related: 'Related projects',
      firstSeen: 'First discovered', lastSeen: 'Last discovered', appearances: 'Days featured', days: '{n} days',
      owner: 'Owner', programmingLanguage: 'Primary language', license: 'License', stars: 'Stars', forks: 'Forks',
      todayStars: '+{n} stars today', snapshot: 'Repository snapshot · {date}', archived: 'Archived repository',
      timelineHint: 'Dates refer to DevTrends reports. Metrics reflect the snapshot collected at the time.', viewSource: 'View source',
      brandLabel: 'Developer trends', footer: 'Discover what’s worth following, straight from the community.', skip: 'Skip to content',
      noReports: 'No reports yet', missing: 'Page not found', missingHint: 'There is no project or report at this address.', home: 'Back to Discover',
      summaryNote: 'Descriptions are drawn from collected community sources.', projectIntro: 'Explore {name}, its GitHub repository, and its discovery history across developer communities.',
      unknownSource: 'Developer community', reportTitle: '{date} Developer Trends Report',
      archiveTitle: 'Report archive', homeTitle: 'DevTrends | What developers are building', translationNote: 'A translation is not available yet. The original text is shown below.',
      gallery: 'Product screenshots', galleryOpen: 'View screenshots', closeViewer: 'Close viewer', previousImage: 'Previous image', nextImage: 'Next image', imageCounter: 'Image {n} of {total}',
    },
  };
  const sourceLabels = {
    vibecafe: ['VibeCafé', 'VibeCafé'], 'chinese-indie-dev': ['中文独立开发者', 'Chinese Indie Developers'],
    'chinese-indie-dev-programmer': ['中文独立开发者·程序员版', 'Indie Dev · Programmers'],
    'chinese-indie-dev-game': ['中文独立开发者·游戏版', 'Indie Dev · Games'],
    // List rows give a source name one 172px column; a literal translation no longer fits there.
    'weekly-issues': ['科技爱好者周刊投稿', 'Weekly Submissions'], 'weekly-issue': ['科技爱好者周刊', 'Tech Enthusiast Weekly'],
    'hellogithub-issues': ['HelloGitHub 投稿', 'HelloGitHub Submissions'], 'hellogithub-issue': ['HelloGitHub 月刊', 'HelloGitHub Monthly Picks'],
    'github-trending': ['GitHub Trending', 'GitHub Trending'], 'github-trending-cn': ['GitHub 中文趋势', 'GitHub Trending China'],
    producthunt: ['Product Hunt', 'Product Hunt'],
  };
  const sourceDirectory = {
    vibecafe: { url: 'https://vibecafe.ai/', logo: '/source-vibecafe.svg' },
    'chinese-indie-dev': { url: 'https://github.com/1c7/chinese-independent-developer', logo: '/source-github.svg' },
    'chinese-indie-dev-programmer': { url: 'https://github.com/1c7/chinese-independent-developer/blob/master/.github/pages/README-Programmer-Edition.md', logo: '/source-github.svg' },
    'chinese-indie-dev-game': { url: 'https://github.com/1c7/chinese-independent-developer/blob/master/.github/pages/README-Game.md', logo: '/source-github.svg' },
    'weekly-issues': { url: 'https://github.com/ruanyf/weekly/issues', logo: '/source-ruanyifeng.png' },
    'weekly-issue': { url: 'https://www.ruanyifeng.com/blog/index.html', logo: '/source-ruanyifeng.png' },
    'hellogithub-issues': { url: 'https://github.com/521xueweihan/HelloGitHub/issues', logo: '/source-hellogithub.svg' },
    'hellogithub-issue': { url: 'https://hellogithub.com/', logo: '/source-hellogithub.svg' },
    'github-trending': { url: 'https://github.com/trending', logo: '/source-github.svg' },
    'github-trending-cn': { url: 'https://github.com/trending?spoken_language_code=zh', logo: '/source-github.svg' },
    producthunt: { url: 'https://www.producthunt.com/', logo: '/source-producthunt.svg' },
  };
  const categories = [
    { id: 'ai', labelZh: 'AI 与智能体', labelEn: 'AI & agents', description: '主要价值来自 AI 模型、智能体、生成、推理或机器学习；仅把 AI 当辅助功能的产品按实际用途归类' },
    { id: 'developer-tools', labelZh: '开发工具', labelEn: 'Developer tools', description: '面向软件开发的编辑器、终端、调试测试、代码工具、自动化、框架、SDK、组件库与运行时' },
    { id: 'data-infrastructure', labelZh: '数据与基础设施', labelEn: 'Data & infrastructure', description: '数据库、数据工程、后端、云服务、部署运维、网络、安全、存储与可观测性' },
    { id: 'design-media', labelZh: '设计与媒体', labelEn: 'Design & media', description: '设计、图像、音视频、摄影、创意制作、内容处理与相关专业工作流' },
    { id: 'productivity-collaboration', labelZh: '效率与协作', labelEn: 'Productivity & collaboration', description: '任务、笔记、文档、日历、会议、知识管理、团队协作与个人工作效率' },
    { id: 'business-growth', labelZh: '商业与增长', labelEn: 'Business & growth', description: '营销、销售、客户服务、电商、财务、支付、招聘、创业运营与增长工具' },
    { id: 'learning-research', labelZh: '学习与研究', labelEn: 'Learning & research', description: '教育、课程、学习、阅读、知识整理、学术研究与文档资料' },
    { id: 'lifestyle-entertainment', labelZh: '生活与娱乐', labelEn: 'Lifestyle & entertainment', description: '健康、旅行、美食、社交、游戏、影音娱乐及其他面向日常生活的消费产品' },
    { id: 'other', labelZh: '其他', labelEn: 'Other', description: '信息不足，或主要用途无法准确归入以上主题' },
  ];
  const categoryIds = new Set(categories.map(category => category.id));
  const t = (locale, key, args = {}) => String(messages[locale]?.[key] ?? messages['zh-CN'][key] ?? key)
    .replace(/\{(\w+)\}/g, (_, name) => args[name] ?? '');
  const escapeHtml = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
  const localPath = (route, locale) => (locale === 'en' ? '/en' : '') + route;
  const sourceName = (item, locale) => sourceLabels[item.sourceId]?.[locale === 'en' ? 1 : 0] || item.sourceName || t(locale, 'unknownSource');
  const sourceInfo = item => sourceDirectory[String(item?.sourceId || '').toLowerCase()] || null;
  // Filter chips are rendered by the build and rebuilt in the browser, so the markup lives here.
  // app.js only collapses overflowing chips into the "more" menu; nothing else is generated client-side.
  const chipModes = {
    category: { attr: 'data-category', containerId: 'category-chips', menuId: 'category-chips-menu', selectId: 'category-select' },
    source: { attr: 'data-source', containerId: 'source-chips', menuId: 'source-chips-menu', selectId: 'source-select' },
  };
  const chipCopy = {
    'zh-CN': { all: '全部', category: { more: '更多分类', field: '分类', aria: '项目分类' }, source: { more: '更多来源', field: '来源', aria: '数据来源' } },
    en: { all: 'All', category: { more: 'More categories', field: 'Category', aria: 'Categories' }, source: { more: 'More sources', field: 'Source', aria: 'Sources' } },
  };
  function chipFilterMeta(mode, locale) {
    const copy = chipCopy[locale === 'en' ? 'en' : 'zh-CN'];
    return { ...chipModes[mode], ...copy[mode], all: copy.all, mode };
  }
  // A zero-count filter stays visible but disabled, so no chip can lead to an empty list.
  const chipDisabled = option => option.id !== 'all' && Number(option.count) === 0 && !option.active;
  // Greedy packing for the chip row: how many leading chips fit once `reserve` (the "more"
  // trigger) is set aside. Always keeps at least one chip so the row is never just a trigger.
  function fitChipCount(widths, available, reserve = 0, gap = 8) {
    const budget = available - reserve;
    let used = 0, count = 0;
    for (const width of widths) {
      const cost = width + (count ? gap : 0);
      if (used + cost > budget) break;
      used += cost; count += 1;
    }
    return widths.length ? Math.max(1, count) : 0;
  }
  function chipFilterHtml(mode, options, locale) {
    const meta = chipFilterMeta(mode, locale);
    const chips = options.map(option => `<button type="button" class="chip${option.active ? ' is-active' : ''}" ${meta.attr}="${escapeHtml(option.id)}" data-label="${escapeHtml(option.label)}" aria-pressed="${option.active}"${chipDisabled(option) ? ' disabled' : ''}>${escapeHtml(option.label)}<span class="chip-count">${Number(option.count) || 0}</span></button>`).join('');
    const listOptions = options.map(option => `<option value="${escapeHtml(option.id)}"${option.active ? ' selected' : ''}${chipDisabled(option) ? ' disabled' : ''}>${escapeHtml(option.label)} (${Number(option.count) || 0})</option>`).join('');
    return `<div class="chip-row">${chips}`
      + `<div class="chip-more" data-more-label="${escapeHtml(meta.more)}" hidden><button type="button" class="chip chip-more-trigger" aria-expanded="false" aria-controls="${meta.menuId}"><span class="chip-more-label">${escapeHtml(meta.more)}</span><svg class="chip-caret" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button></div></div>`
      + `<div class="chip-menu" id="${meta.menuId}" hidden></div>`
      + `<label class="chip-select"><span class="chip-select-label">${escapeHtml(meta.field)}</span><select id="${meta.selectId}" aria-label="${escapeHtml(meta.aria)}">${listOptions}</select></label>`;
  }
  function safeUrl(value) {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
  }
  // Only the newest reports are mirrored into this site; the archive keeps referencing the
  // source CDN. Un-mirrored images may render only from these hosts, so an unexpected or
  // hostile URL still cannot reach the page.
  const hotlinkOrigins = new Set([
    'akxlagkpqhwjrwrq.public.blob.vercel-storage.com', // VibeCafé product media
    'ph-files.imgix.net', // Product Hunt launch media
  ]);
  const localImagePath = /^\/images\/[a-f0-9]{64}\.(png|jpg|gif|webp|avif|ico|svg)$/;
  function hotlinkable(value) {
    const url = safeUrl(value);
    return url && hotlinkOrigins.has(new URL(url).hostname.toLowerCase()) ? url : '';
  }
  // Only managed, content-addressed images may reach the browser, including old favorites;
  // a URL whose mirror was pruned falls back to its source CDN when that host is trusted.
  function localImage(value, manifest = {}) {
    const mapped = manifest[value];
    const candidate = typeof mapped === 'string' && mapped ? mapped : value;
    if (typeof candidate !== 'string') return '';
    return localImagePath.test(candidate) ? candidate : hotlinkable(candidate);
  }
  // Screenshot lists (`images`) are managed exactly like single images; anything unsafe is dropped.
  function localImages(value, manifest = {}) {
    return (Array.isArray(value) ? value : []).map(entry => localImage(entry, manifest)).filter(Boolean);
  }
  // Thumbnail strip for a product's screenshots. Values must already be managed local paths;
  // the full list travels in data-gallery so app.js can open the viewer without a second request.
  function galleryHtml(value, locale) {
    const images = localImages(value);
    if (!images.length) return '';
    const label = t(locale, 'galleryOpen');
    const visible = images.slice(0, 3);
    const hidden = images.length - visible.length;
    const thumb = (src, index, extra = '') => `<button type="button" class="gallery-thumb${extra}" data-index="${index}" aria-label="${escapeHtml(`${label} · ${index + 1}/${images.length}`)}"><img src="${escapeHtml(src)}" alt="" loading="lazy" /></button>`;
    const thumbs = visible.map((src, index) => thumb(src, index)).join('');
    const more = hidden > 0 ? `<button type="button" class="gallery-thumb gallery-more" data-index="${visible.length}" aria-label="${escapeHtml(`${label} · +${hidden}`)}">+${hidden}</button>` : '';
    return `<div class="item-gallery" data-gallery="${escapeHtml(JSON.stringify(images))}" role="group" aria-label="${escapeHtml(t(locale, 'gallery'))}">${thumbs}${more}</div>`;
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
  // Stable identity for list rows: the canonical repository URL when there is one, otherwise a
  // source-scoped URL or key. Used for row analytics, not for any stored state.
  function itemId(item) {
    return repository(item)?.url || String(item.websiteUrl || item.url || `${item.sourceId || 'item'}:${item.externalId || item.title || 'untitled'}`).replace(/#.*$/, '').replace(/\/$/, '');
  }
  // 投稿模板字段名。采集层已按字段解析，这里兜底清理历史日报：老数据在采集时把换行压成了
  // 空格，字段名会以「项目地址 类别 Rust 项目标题 …」的形式留在摘要里（2026-09 走查）。
  // 只在字段名后紧跟分隔符或行尾时匹配，避免误伤「地址栏」这类正常词语。重建即生效，不改历史文件。
  const SUMMARY_LABELS = '项目地址|项目URL|项目 Url|项目标题|项目名称|项目描述|项目简介|项目介绍|项目语言|项目类别|项目截图|项目依赖|项目文档|项目网址|项目链接|作品网址|作品地址|在线体验|在线地址|在线演示|推荐理由|示例代码|运行环境|使用方法|使用说明|后续更新计划|更新计划|推荐项目|开源地址|源码地址|仓库地址|开源协议|主要受众|产品名称|一句话介绍|详细介绍|产品介绍|官方网站|官网地址|必写|可选|类别|语言|描述|简介|介绍|地址|网址|链接|官网|仓库|源码|demo|description|screenshots|repo';
  // 带冒号的字段名直接消费；不带冒号的必须后面跟分隔符或行尾，避免误伤「地址栏」这类正常词语。
  const SUMMARY_LABEL_TOKEN = new RegExp(`(?:^|[\\s，。；、])(${SUMMARY_LABELS})\\s*(?:[（(][^）)]{0,12}[）)])?\\s*(?:[：:]\\s*|(?=[\\s，。；、]|$))`, 'gi');
  function cleanSummaryText(value) {
    let text = String(value ?? '');
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');          // 图片
    text = text.replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1');      // [文字](链接) → 文字
    text = text.replace(/<https?:\/\/[^>\s]+>/g, ' ');          // <https://...>
    text = text.replace(/https?:\/\/[^\s)\]]+/g, ' ');          // 裸链接
    text = text.replace(/\b_?no response_?\b/gi, ' ');          // 投稿模板里的空回答
    text = text.replace(SUMMARY_LABEL_TOKEN, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text.replace(/^[\s，。；、:：,;.\-–—]+/, '').trim();
  }
  function summary(item, locale) {
    const explicit = locale === 'en' ? item.summaryEn || item.summary_en : item.summaryZh || item.summary_zh;
    if (explicit) { const cleaned = cleanSummaryText(explicit); if (cleaned) return { text: cleaned, original: false, lang: locale }; }
    const candidates = locale === 'en'
      ? [item.github?.description, item.tagline, item.description, item.summary, item.content]
      : [item.summary, item.tagline, item.github?.description, item.description, item.content];
    const available = candidates.filter(value => typeof value === 'string' && value.trim());
    const matches = value => locale === 'en' ? !/[\u3400-\u9fff]/u.test(value) : /[\u3400-\u9fff]/u.test(value);
    const raw = locale === 'zh-CN' ? available[0] : (available.find(matches) || available[0]);
    const text = cleanSummaryText(raw);
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
  const isCategoryId = value => typeof value === 'string' && categoryIds.has(value);
  function itemCategory(item) {
    const explicit = item.primaryCategory || item.primary_category || item.category;
    if (isCategoryId(explicit)) return explicit;
    const titleText = [item.title, item.titleEn].filter(Boolean).join(' ').toLowerCase();
    const text = [titleText, item.summary, item.summaryZh, item.summaryEn, item.github?.description, ...(item.tags || []), ...(item.github?.topics || [])].filter(Boolean).join(' ').toLowerCase();
    const scores = Object.fromEntries(categories.map(category => [category.id, 0]));
    const add = (id, pattern) => {
      if (pattern.test(text)) scores[id] += 2;
      if (pattern.test(titleText)) scores[id] += 3;
    };
    add('ai', /\b(ai|llms?|gpt|agentic|agents?|machine[- ]learning|deep[- ]learning|neural|inference|embeddings?|rag|computer vision)\b|人工智能|大模型|智能体|机器学习|深度学习|模型推理|文生|图生/i);
    add('developer-tools', /\b(cli|ides?|code editor|terminal|debugg?er|testing|test runner|compiler|linter|codegen|developer tools?|devtools|coding|programming|git|api client|automation|workflow|browser extension|frameworks?|sdks?|libraries|library|runtimes?|packages?|components?|starter kit|boilerplate|react|vue|next\.?js|node\.?js|swiftui|toolkit)\b|开发工具|代码编辑|编辑器|终端|命令行|调试|测试工具|编译器|代码生成|编程|自动化|浏览器扩展|框架|组件库|运行时|软件包|开发库|脚手架/i);
    add('data-infrastructure', /\b(databases?|sql|data pipeline|analytics|cloud|deploy|devops|containers?|docker|kubernetes|servers?|hosting|network|proxy|security|observability|monitoring|logging|storage|backend|api gateway|self[- ]hosted)\b|数据库|数据分析|数据管道|云服务|部署|运维|容器|服务器|托管|网络|代理|安全|监控|可观测|日志|存储|后端|自托管/i);
    add('design-media', /\b(design|images?|photos?|video|audio|music|ui|ux|creative|canvas|drawing|animation|3d|ocr|screenshot|screen recording|podcast|subtitle|media|voice)\b|设计|图像|图片|照片|视频|音频|音乐|创作|画布|绘图|动画|封面|截图|录屏|播客|字幕|媒体|语音/i);
    add('productivity-collaboration', /\b(productivity|collaboration|calendar|notes?|todo|task management|project management|documents?|spreadsheet|email|meeting|knowledge base|reader|bookmark|focus|workspace)\b|效率|协作|日历|笔记|待办|任务管理|项目管理|文档|表格|邮件|会议|知识库|阅读器|书签|专注|工作台/i);
    add('business-growth', /\b(marketing|sales|crm|commerce|ecommerce|customer support|customer service|seo|advertising|finance|fintech|invoice|billing|payment|startup|business|recruiting|hiring|job search)\b|营销|销售|客户管理|客户服务|电商|商业|广告|金融|财务|发票|账单|支付|创业|招聘|求职|报价/i);
    add('learning-research', /\b(education|learning|course|tutorial|research|paper|book|reading|study|training|documentation|wiki)\b|教育|学习|课程|教程|研究|论文|书籍|阅读|知识|培训|百科/i);
    add('lifestyle-entertainment', /\b(health|fitness|travel|food|recipe|social|dating|game|gaming|entertainment|sports|shopping|weather|habit|personal finance)\b|健康|健身|旅行|旅游|美食|菜谱|社交|约会|游戏|娱乐|运动|购物|天气|习惯|生活/i);
    const ranked = categories.filter(category => category.id !== 'other').sort((a, b) => scores[b.id] - scores[a.id]);
    return scores[ranked[0].id] > 0 ? ranked[0].id : 'other';
  }
  const itemCategories = item => [itemCategory(item)];
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
      arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
      search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
      repo: '<path d="M5 4h14v16H7a2 2 0 0 1-2-2V4Zm0 12h14M9 7h6"/>',
      github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7.4A5.8 5.8 0 0 0 19.3 3 5.4 5.4 0 0 0 19.1 0S17.9-.4 15 1.5a14 14 0 0 0-6 0C6.1-.4 4.9 0 4.9 0a5.4 5.4 0 0 0-.2 3A5.8 5.8 0 0 0 3.2 7c0 5.8 3.5 7 6.8 7.4A4.8 4.8 0 0 0 9 18v4M9 19c-3 .9-3-1.5-4.2-2"/>',
      box: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9"/>',
      star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
    };
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.box}</svg>`;
  };
  // A rendered box hides content when its scroll size exceeds its client size. The list clips a
  // description to one line and the grid to three, so only a genuinely clipped row earns a tooltip.
  const isClipped = element => element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight;
  // Fallback only: a source with a logo asset renders that logo instead. Keyed off sourceId, never the
  // display name, because "HelloGitHub" would otherwise match a /github/ test and borrow GitHub's mark.
  function sourceMark(item) {
    const id = String(item?.sourceId || '').toLowerCase();
    if (id === 'github-trending' || id === 'github-trending-cn') return icon('github');
    const known = { producthunt: 'P', vibecafe: 'V', hackernews: 'Y', reddit: 'R', devto: 'D', indiehackers: 'IH' };
    return escapeHtml(known[id] || sourceName(item, 'en').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'D');
  }
  // Collectors tag every item with its own source (`producthunt`, `ruanyf-weekly`, `hellogithub`,
  // `indie-dev`) and with collection bookkeeping (`new`, `official`, `submission`). The row already
  // names its source beside a badge, so those chips would only repeat what the row already says.
  const sourceScaffoldTags = new Set([
    'product', 'vibecafe', 'producthunt', 'ruanyf-weekly', 'hellogithub', 'indie-dev', 'github-trending',
    'daily', 'new', 'official', 'submission', 'official-featured',
  ]);
  // Up to three chips per row, minus everything the row already states elsewhere: the source (badge
  // and name) and the primary language, which is rendered as its own chip and repeated by the
  // github-trending collector inside `tags`. Casing variants count as the same tag.
  function visibleTags(item) {
    const seen = new Set([String(item.sourceId || '').toLowerCase(), String(metric(item, ['language', 'lang']) || '').toLowerCase(), ...sourceScaffoldTags]);
    const tags = [];
    for (const tag of [...(item.github?.topics || []), ...(item.tags || [])]) {
      const key = String(tag).trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length === 3) break;
    }
    return tags;
  }
  function renderItem(item, locale, { date = '', index = 0 } = {}) {
    const repo = repository(item), projectPath = item.projectPath;
    const links = itemLinks(item), primary = safeUrl(item.websiteUrl || item.url) || repo?.url;
    const source = sourceInfo(item);
    const titleUrl = projectPath ? localPath(projectPath, locale) : trackedUrl(repo?.url || primary, item, date);
    const s = summary(item, locale);
    const language = metric(item, ['language', 'lang']);
    const stars = metric(item, ['stars', 'stargazers_count', 'totalStars']);
    const votes = metric(item, ['votes', 'votesCount']);
    const tags = visibleTags(item);
    // The product mark identifies an item at 48px. A software screenshot is never borrowed for the
    // avatar: it belongs to the gallery. A row without a platform mark falls back to the logo its
    // official website declares (`siteLogo`, captured offline) and only then to its initials.
    const logoUrl = localImage(item.logo);
    const markUrl = logoUrl || localImage(item.icon) || localImage(item.siteLogo);
    const gallery = galleryHtml(item.images, locale);
    const title = displayTitle(item, locale);
    const score = stars !== null ? stars : votes;
    const scoreIcon = stars !== null ? icon('star') : (votes !== null ? '<span aria-hidden="true">▲</span>' : '');
    const sourceUrl = itemLinks(item).find(([label]) => label === 'source')?.[1];
    // Every row already belongs to the report date in the selector, and an item's own publishedAt
    // (UTC, per source) only contradicted it, so the row carries no date of its own.
    return `<article class="feed-item" data-source-id="${escapeHtml(item.sourceId)}" data-item-id="${escapeHtml(item.externalId || itemId(item))}">
      <span class="item-number" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
      <span class="item-avatar avatar-${index % 5}" aria-hidden="true">${markUrl ? `<img src="${escapeHtml(markUrl)}" class="is-logo" alt="" loading="lazy" />` : escapeHtml((repo?.name || title).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2))}</span>
      <div class="item-primary"><h2>${titleUrl ? `<a href="${escapeHtml(titleUrl)}"${projectPath ? '' : ' target="_blank" rel="noopener noreferrer"'}>${escapeHtml(title)}</a>` : escapeHtml(title)}</h2><p class="summary" lang="${s.lang}">${escapeHtml(s.text)}</p>${s.original ? `<span class="original-label">${t(locale, 'original')}</span>` : ''}${gallery}</div>
      <div class="item-tags">${language ? `<span class="tag">${escapeHtml(language)}</span>` : ''}${tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="item-source"><span class="source-mini source-mini-${escapeHtml(String(item.sourceId || '').toLowerCase())}" aria-hidden="true">${source?.logo ? `<img src="${escapeHtml(source.logo)}" alt="" loading="lazy" />` : sourceMark(item)}</span>${sourceUrl ? `<a href="${escapeHtml(trackedUrl(sourceUrl, item, date))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(sourceName(item, locale))}">${escapeHtml(sourceName(item, locale))}</a>` : `<span title="${escapeHtml(sourceName(item, locale))}">${escapeHtml(sourceName(item, locale))}</span>`}</div>
      <div class="item-score">${score !== null ? `${scoreIcon}<span>${compact(score, locale)}</span>` : '<span>—</span>'}</div></article>`;
  }
  return { origin, messages, categories, isCategoryId, t, escapeHtml, json, localPath, sourceName, sourceInfo, chipFilterMeta, chipFilterHtml, fitChipCount, safeUrl, localImage, localImages, hotlinkable, galleryHtml, repository, itemId, isClipped, visibleTags, summary, displayTitle, reportItems, itemCategory, itemCategories, metric, compact, dateLabel, trackedUrl, itemLinks, icon, renderItem };
});
