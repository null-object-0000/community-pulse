/* Shared by the static builder and browser: one content model and one renderer. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DevTrends = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const origin = 'https://devtrends.site';
  // 详情页「内容够不够」的唯一门槛：有效摘要短于这个长度就是薄页 —— 可访问但 `noindex`，不进 sitemap，
  // 也不推给百度。以前这个 20 在 Worker、站点快照和搜索推送里各写了一份，采集层给空描述行补描述时
  // 另有一个 40 的下限，于是 20~39 字的真描述永远补不上、页面只能显示占位符（实测 2026-09-17：
  // github-repositories 层 893 个仓库里 95 个的描述正好落在这一段，如 chrome-devtools-mcp）。
  // 现在四个消费端都读这一份：worker/project-page.mjs、scripts/catalog/build-site-snapshot.js、
  // scripts/search-submit.js，以及采集层的 DESCRIPTION_MIN_LENGTH（source_raw_items.js）。
  const DETAIL_SUMMARY_MIN = 20;
  const messages = {
    'zh-CN': {
      discover: '今日发现', trends: '趋势洞察', archive: '历史日报', slogan: '大家都在做什么',
      intro: '每天发现开发者社区的新项目、新产品与开源趋势。', all: '全部来源', search: '搜索项目、作者或标签',
      language: '语言', theme: '外观', system: '跟随系统', light: '浅色', dark: '深色', accentTheme: '主题色', neutralAccent: '无主色', blueAccent: '蓝色', forestAccent: '墨绿', violetAccent: '紫罗兰',
      count: '{n} 个项目', sources: '{n} 个来源',
      website: '官网', repository: 'GitHub 仓库', source: '来源', details: '项目详情', original: '原文',
      noSummary: '暂无项目介绍。', empty: '没有找到相关项目', emptyHint: '换一个关键词或分类试试。',
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
      unknownSource: '开发者社区', reportTitle: '{date} 开发者趋势日报', reportHeading: '{date}大家都在做什么',
      archiveTitle: '历史日报', homeTitle: 'DevTrends 开发者趋势｜大家都在做什么', translationNote: '暂无此语言译文，以下保留原文。',
      gallery: '产品配图', galleryOpen: '查看配图', closeViewer: '关闭配图', previousImage: '上一张', nextImage: '下一张', imageCounter: '第 {n} 张，共 {total} 张',
      mediaOriginal: '原始配图', mediaScreenshot: '官网截图', mediaOg: 'OG 图',
      previousItem: '上一条', nextItem: '下一条', openItem: '打开项目', cardsTitle: '今日卡片', cardsIntro: '一张一张看完今天的新发现', cardsRead: '已读 {n} / {total}', cardsComplete: '已全部读完', cardsHint: '左滑下一条，右滑上一条',
      trendsEntryTitle: '趋势洞察', trendsEntryIntro: '看看大家最近在集中做什么，与此前四周比较', trendsEntryLink: '查看趋势',
      trendsTitle: '大家正在集中做什么', trendsIntro: '从业务场景、Agent 生态和编程语言观察最近的新项目，并与此前四周比较。', trendsWindow: '最近 7 天', trendsBaseline: '此前 28 天', trendsNew: '新出现', trendsProjects: '{n} 个新项目', trendsSources: '{n} 个来源', trendsExamples: '代表项目', trendsEmpty: '这个视角还没有形成达到展示门槛的趋势簇。', trendsDimension: '洞察视角', trendsUseCases: '业务场景', trendsAgentRoles: 'Agent 生态', trendsLanguages: '编程语言', trendsPeriod: '观察周期', trendsDataSource: '数据来源', trends4Weeks: '近 4 周', trends8Weeks: '近 8 周', trends12Weeks: '近 12 周', trendsWeekly: '每周新增项目',
      trendsLangUnavailable: '编程语言视角暂不可用：语言信息来自 GitHub 仓库快照，而「{label}」窗口内共 {eligible} 天含 GitHub 项目、其中仅 {covered} 天已解析出语言，增长率会被「数据从缺失变为可得」放大，因此不作为趋势展示。',
      trendsRange: '收录范围', trendsRangeRecent: '本周期', trendsRange4Weeks: '近 4 周', trendsRange12Weeks: '近 12 周', trendsRangeAll: '全部历史',
      trendsRangeSpan: '{start} – {end} 内首次发现 {n} 个项目', trendsLibrarySpan: '共收录 {n} 个项目 · 最早 {first} · 最近 {last}',
      trendsLoadMore: '显示更多（还有 {n} 个项目）', trendsSubTopics: '子主题', trendsSubTopicOf: '{parent}的子主题', tagDevTrends: 'DT', tagSource: '原始', tagLanguage: '语言', tagDevTrendsTitle: 'DevTrends 归类', tagSourceTitle: '项目或来源原始标签', tagLanguageTitle: '编程语言',
    },
    en: {
      discover: 'Discover', trends: 'Trends', archive: 'Archive', slogan: 'What developers are building',
      intro: 'Daily discoveries from developer communities, independent makers, and open source.', all: 'All sources', search: 'Search projects, authors, or tags',
      language: 'Language', theme: 'Appearance', system: 'System', light: 'Light', dark: 'Dark', accentTheme: 'Accent color', neutralAccent: 'Neutral', blueAccent: 'Blue', forestAccent: 'Forest', violetAccent: 'Violet',
      count: '{n} projects', sources: '{n} sources',
      website: 'Website', repository: 'GitHub repository', source: 'Source', details: 'Project details', original: 'Original',
      noSummary: 'No project description yet.', empty: 'No matching projects', emptyHint: 'Try another keyword or category.',
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
      unknownSource: 'Developer community', reportTitle: '{date} Developer Trends Report', reportHeading: '{date} · What developers are building',
      archiveTitle: 'Report archive', homeTitle: 'DevTrends | What developers are building', translationNote: 'A translation is not available yet. The original text is shown below.',
      gallery: 'Product screenshots', galleryOpen: 'View screenshots', closeViewer: 'Close viewer', previousImage: 'Previous image', nextImage: 'Next image', imageCounter: 'Image {n} of {total}',
      mediaOriginal: 'Source', mediaScreenshot: 'Screenshot', mediaOg: 'OG image',
      previousItem: 'Previous', nextItem: 'Next', openItem: 'Open project', cardsTitle: 'Today’s cards', cardsIntro: 'Browse today’s discoveries one at a time', cardsRead: 'Read {n} / {total}', cardsComplete: 'All read', cardsHint: 'Swipe left for next, right for previous',
      trendsEntryTitle: 'Trend insights', trendsEntryIntro: 'See what developers are converging on, compared with the preceding four weeks', trendsEntryLink: 'View trends',
      trendsTitle: 'What developers are converging on', trendsIntro: 'Explore recent projects by use case, agent ecosystem, or programming language, compared with the preceding four weeks.', trendsWindow: 'Last 7 days', trendsBaseline: 'Previous 28 days', trendsNew: 'New', trendsProjects: '{n} new projects', trendsSources: '{n} sources', trendsExamples: 'Representative projects', trendsEmpty: 'No trend cluster in this view has reached the display threshold yet.', trendsDimension: 'Lens', trendsUseCases: 'Use cases', trendsAgentRoles: 'Agent ecosystem', trendsLanguages: 'Programming languages', trendsPeriod: 'Time range', trendsDataSource: 'Sources', trends4Weeks: '4 weeks', trends8Weeks: '8 weeks', trends12Weeks: '12 weeks', trendsWeekly: 'New projects by week',
      trendsLangUnavailable: 'The programming-language lens is unavailable: language comes from the GitHub repository snapshot, and of the {eligible} days in the “{label}” window that carry GitHub projects only {covered} have a resolved language. The growth rate would measure the data arriving rather than adoption, so it is not shown as a trend.',
      trendsRange: 'Time range', trendsRangeRecent: 'This period', trendsRange4Weeks: '4 weeks', trendsRange12Weeks: '12 weeks', trendsRangeAll: 'All time',
      trendsRangeSpan: '{n} projects first discovered {start} – {end}', trendsLibrarySpan: 'Total {n} projects · first {first} · latest {last}',
      trendsLoadMore: 'Show more ({n} remaining)', trendsSubTopics: 'Sub-topics', trendsSubTopicOf: 'Sub-topic of {parent}', tagDevTrends: 'DT', tagSource: 'Original', tagLanguage: 'Language', tagDevTrendsTitle: 'DevTrends classification', tagSourceTitle: 'Original project or source tag', tagLanguageTitle: 'Programming language',
    },
  };
  const sourceLabels = {
    vibecafe: ['VibeCafé', 'VibeCafé'], 'chinese-indie-dev': ['中文独立开发者', 'Chinese Indie Developers'],
    'chinese-indie-dev-programmer': ['中文独立开发者·程序员版', 'Indie Dev · Programmers'],
    'chinese-indie-dev-game': ['中文独立开发者·游戏版', 'Indie Dev · Games'],
    // List rows give a source name one 150px column（12px 字号下，扣掉 28px 徽标与 8px 间距只剩 114px）；
    // 名字超过这个宽度就会被省略号截断，翻译和全称都放不下。
    'weekly-issues': ['科技爱好者周刊投稿', 'Weekly Submissions'], 'weekly-issue': ['科技爱好者周刊', 'Tech Enthusiast Weekly'],
    'hellogithub-issues': ['HelloGitHub 投稿', 'HelloGitHub Submissions'], 'hellogithub-issue': ['HelloGitHub 月刊', 'HelloGitHub Monthly Picks'],
    'github-trending': ['GitHub Trending', 'GitHub Trending'], 'github-trending-cn': ['GitHub 中文趋势', 'GitHub Trending China'],
    producthunt: ['Product Hunt', 'Product Hunt'],
    // Show HN 只是 HN 的投稿渠道，不是整个 HN 热榜；徽标已是 HN 图标，名字不必再背一遍品牌（原名宽 136px，行内必被截断）。
    showhn: ['Show HN', 'Show HN'], v2ex: ['V2EX·分享创造', 'V2EX · I Made This'],
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
    showhn: { url: 'https://news.ycombinator.com/show', logo: '/source-hackernews.svg' },
    v2ex: { url: 'https://www.v2ex.com/?tab=create', logo: '/source-v2ex.png' },
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
  // Facets answer different questions and must not compete in one flat category list. A use case
  // says what job the product does; an agent role says where it sits in the agent toolchain;
  // form/platform/integration describe how and where it is used. IDs are deliberately controlled
  // so historical rule-based inference and new LLM-enriched reports stay comparable over time.
  const taxonomyFacets = {
    useCases: [
      ['novel-writing', '小说创作', 'Novel writing'], ['content-creation', '内容创作', 'Content creation'],
      ['software-development', '软件开发', 'Software development'], ['research-learning', '研究与学习', 'Research & learning'],
      ['security-testing', '安全与测试', 'Security & testing'], ['data-operations', '数据与运维', 'Data & operations'],
      ['desktop-productivity', '桌面效率', 'Desktop productivity'], ['business-growth', '商业与增长', 'Business & growth'],
      ['travel-mobility', '旅行与出行', 'Travel & mobility'],
      ['lifestyle-entertainment', '生活与娱乐', 'Lifestyle & entertainment'],
    ],
    agentRoles: [
      ['vertical-agent', '垂直 Agent', 'Vertical agent'], ['capability-extension', 'Agent 能力扩展', 'Agent extension'],
      ['orchestration-control', 'Agent 管理与编排', 'Agent orchestration'], ['observability', 'Agent 可观测性', 'Agent observability'],
      ['evaluation-security', 'Agent 评测与安全', 'Agent evaluation & safety'], ['runtime-framework', 'Agent 运行时', 'Agent runtime'],
    ],
    productForms: [
      ['web-app', 'Web 应用', 'Web app'], ['desktop-app', '桌面应用', 'Desktop app'], ['mobile-app', '移动应用', 'Mobile app'],
      ['cli', '命令行工具', 'CLI'], ['skill-plugin', 'Skill / 插件', 'Skill / plugin'], ['mcp-service', 'MCP 服务', 'MCP service'],
      ['library-sdk', '库 / SDK', 'Library / SDK'], ['content-resource', '内容 / 资源', 'Content / resource'],
    ],
    platforms: [
      ['web', 'Web', 'Web'], ['macos', 'macOS', 'macOS'], ['windows', 'Windows', 'Windows'], ['linux', 'Linux', 'Linux'],
      ['ios', 'iOS', 'iOS'], ['android', 'Android', 'Android'], ['browser', '浏览器', 'Browser'], ['terminal', '终端', 'Terminal'],
    ],
    integrations: [
      ['claude-code', 'Claude Code', 'Claude Code'], ['codex', 'Codex', 'Codex'], ['opencode', 'OpenCode', 'OpenCode'],
      ['deepseek-harness', 'DeepSeek Harness', 'DeepSeek Harness'], ['openclaw', 'OpenClaw', 'OpenClaw'], ['cursor', 'Cursor', 'Cursor'],
    ],
  };
  // Second-level topics. A narrow scene belongs to exactly one top-level use case — novel writing is a
  // kind of content creation, and the travel scene expects narrower topics such as travel imagery.
  // Items are classified with the narrowest id only (`normalizeTaxonomy` drops a parent whose child is
  // also present, and the model is told to do the same), while readers roll every child back up into
  // its parent, so one project is never counted twice inside a single facet and a top-level topic's
  // numbers stay the sum of its direct hits plus its sub-topics.
  const taxonomyParents = {
    useCases: { 'novel-writing': 'content-creation' },
  };
  // 规则分类（`inferTaxonomy` / `itemTaxonomy`）的版本号：产品库把它写进
  // `taxonomy_assignments.processor_version`，日报的发布记录也记它 —— 规则一改，旧行存的标签
  // 与新行不可比，必须能一眼看出这一批是哪个版本产出的。
  const taxonomyVersion = 'legacy-infer-v1';
  // The trend page treats the primary implementation language as a third analytical lens. Keep it
  // deterministic and separate from editorial taxonomy so old reports participate immediately and
  // a model cannot turn synonymous spellings into incompatible time-series buckets.
  const languageFacets = [
    ['typescript', 'TypeScript', 'TypeScript'], ['javascript', 'JavaScript', 'JavaScript'], ['python', 'Python', 'Python'],
    ['go', 'Go', 'Go'], ['rust', 'Rust', 'Rust'], ['java-kotlin', 'Java / Kotlin', 'Java / Kotlin'],
    ['swift', 'Swift', 'Swift'], ['c-cpp', 'C / C++', 'C / C++'], ['csharp', 'C#', 'C#'],
    ['php', 'PHP', 'PHP'], ['ruby', 'Ruby', 'Ruby'], ['dart', 'Dart', 'Dart'],
  ];
  const languageIndex = new Map(languageFacets.map(([id, zh, en]) => [id, { id, labelZh: zh, labelEn: en }]));
  const facetIndex = Object.fromEntries(Object.entries(taxonomyFacets).map(([name, values]) => [name, new Map(values.map(([id, zh, en]) => [id, { id, labelZh: zh, labelEn: en }]))]));
  function normalizeTaxonomy(value = {}) {
    const result = { version: 1 };
    for (const [name, index] of Object.entries(facetIndex)) {
      const limit = name === 'integrations' ? 5 : (name === 'platforms' ? 3 : 2);
      const ids = [...new Set((Array.isArray(value?.[name]) ? value[name] : []).map(String).filter(id => index.has(id)))];
      // A sub-topic implies its parent, so an explicit pair would count the same project twice once
      // the parent rolls its children up. Keep the narrowest id; readers re-derive the parent.
      const narrowest = ids.filter(id => !ids.some(other => other !== id && facetAncestors(name, other).includes(id)));
      result[name] = narrowest.slice(0, limit);
    }
    return result;
  }
  const taxonomyHasValues = value => {
    const normalized = normalizeTaxonomy(value);
    return Object.keys(facetIndex).some(name => normalized[name].length);
  };
  const facetLabel = (name, id, locale = 'zh-CN') => {
    const entry = facetIndex[name]?.get(id) || (name === 'languages' ? languageIndex.get(id) : null);
    return entry ? (locale === 'en' ? entry.labelEn : entry.labelZh) : id;
  };
  // Hierarchy helpers shared by the trend model, the renderer, and the browser. `facetAncestors`
  // walks up (nearest first) and is what an item's own ids imply; `facetDescendants` walks down and is
  // what one cluster covers, i.e. itself plus every nested sub-topic.
  const facetParent = (name, id) => taxonomyParents[name]?.[id] || null;
  const facetChildren = (name, id) => Object.entries(taxonomyParents[name] || {}).filter(([, parent]) => parent === id).map(([child]) => child);
  const facetAncestors = (name, id) => {
    const chain = [];
    for (let current = facetParent(name, id); current; current = facetParent(name, current)) chain.push(current);
    return chain;
  };
  const facetDescendants = (name, id) => [id, ...facetChildren(name, id).flatMap(child => facetDescendants(name, child))];
  const facetLineage = (name, id) => [...facetAncestors(name, id).reverse(), id];
  // "内容创作 › 小说创作" — the flat label is still what chips show; this is for places that have room
  // to state where a sub-topic sits (trend cards, breadcrumbs, tag tooltips, JSON-LD item names).
  const facetPathLabel = (name, id, locale = 'zh-CN') => facetLineage(name, id).map(value => facetLabel(name, value, locale)).join(' › ');
  function itemLanguages(item = {}) {
    const raw = String(item.github?.language || item.language || '').trim().toLowerCase();
    const aliases = {
      typescript: 'typescript', javascript: 'javascript', python: 'python', go: 'go', golang: 'go', rust: 'rust',
      java: 'java-kotlin', kotlin: 'java-kotlin', swift: 'swift', c: 'c-cpp', 'c++': 'c-cpp', cpp: 'c-cpp',
      'c#': 'csharp', csharp: 'csharp', php: 'php', ruby: 'ruby', dart: 'dart',
    };
    return aliases[raw] ? [aliases[raw]] : [];
  }
  function taxonomyText(item) {
    const contentTags = (item.tags || []).filter(tag => {
      const key = String(tag).trim().toLowerCase();
      return !sourceScaffoldTags.has(key) && !collectionStatusTags.has(key) && !['程序员版', '游戏版'].includes(key);
    });
    return [item.title, item.titleEn, item.summary, item.summaryZh, item.summaryEn, item.content, item.description, item.github?.description, ...contentTags, ...(item.github?.topics || [])].filter(Boolean).join(' ').toLowerCase();
  }
  function inferTaxonomy(item) {
    const text = taxonomyText(item), useCases = [], agentRoles = [], productForms = [], platforms = [], integrations = [];
    const add = (list, id, pattern) => { if (pattern.test(text) && !list.includes(id)) list.push(id); };
    add(useCases, 'novel-writing', /(?:novel|fiction|story).{0,24}(?:writ|author|creation)|(?:writ|author).{0,24}(?:novel|fiction|story)|小说创作|小说写作|写小说|网文.{0,12}(?:写|创作)|故事创作|写作助手/i);
    add(useCases, 'content-creation', /\b(?:content creation|creative writing|copywriting|image generation|video editing|media production)\b|内容创作|文案|写作|绘图|图像生成|视频创作|音频创作|剪辑/i);
    add(useCases, 'security-testing', /\b(?:security|vulnerabilit\w*|penetration|audit|guardrail)\b|安全(?:工具|测试|审计|研究|防护)|网络安全|漏洞|渗透|攻防|红队|恶意|攻击|审计|护栏/i);
    add(useCases, 'research-learning', /\b(?:research|learning|education|study|paper|literature|book|course|guide)\b|科研|研究|学习|教育|论文|文献|书籍|教程|课程/i);
    add(useCases, 'data-operations', /database|infrastructure|devops|deploy|network|proxy|observability|数据库|基础设施|运维|部署|网络|代理环境/i);
    add(useCases, 'business-growth', /\b(?:marketing|sales|seo|crm|recruit(?:ing|ment)?|finance|business growth)\b|营销|销售|增长|招聘|求职|财务|商业增长/i);
    add(useCases, 'desktop-productivity', /desktop (?:app|tool|client|utility|workflow|pet)|menu bar|menubar|shortcut|clipboard|window manager|桌面(?:应用|工具|客户端|效率|宠物)|菜单栏|快捷键|剪贴板|窗口管理|效率工具/i);
    // Keep the top-level scene broad enough to include supporting travel utilities; narrower
    // distinctions such as travel imagery will live in its second-level topics. Exclude the
    // unrelated engineering phrase "time travel" used by replay/debugging tools.
    const travelText = text.replace(/\btime[ -]?travel(?:ling|ing)?\b/gi, '');
    if (/\b(?:travell?er|travell?ing|travel|tourism|tourist|road[ -]?trip|trip planner|trip planning|itinerary|destination guide|city guide|sightseeing|hotel|hostel|airfare|airline|flight (?:tracker|tracking|booking)|travel eSIM)\b|\b(?:visa|passport).{0,28}(?:photo|travel|application|ocr|verification|immigration|interview)\b|\b(?:photo|travel|application|ocr|verification|immigration|interview).{0,28}(?:visa|passport)\b|旅游|旅行|行程规划|出行规划|机票|航班|酒店|民宿|青旅|景点|签证|护照|圣地巡礼|旅拍|旅行.{0,20}足迹|足迹.{0,20}旅行|游记|自驾|包车|旅行社|境外上网/i.test(travelText)) useCases.push('travel-mobility');
    add(useCases, 'lifestyle-entertainment', /game|health|fitness|social|music|游戏|健康|健身|社交|音乐|娱乐/i);
    add(useCases, 'software-development', /\b(?:developer|coding|programming|code review|terminal|git|ide|sdk)\b|开发|编程|代码|终端|调试|测试/i);
    const agent = /\b(ai[- ]?agents?|agents?|agentic|coding agents?|claude code|codex|opencode|openclaw|deepseek harness|mcp)\b|\b(?:token|nerf)\s*(?:tracker|meter)\b|智能体|编程\s*agent/i.test(text);
    if (agent) {
      add(agentRoles, 'capability-extension', /skill|plugin|extension|hook|mcp|memory|context|integration|tool access|技能|插件|扩展|钩子|记忆|上下文|接入/i);
      add(agentRoles, 'orchestration-control', /orchestrat|manager|management|command center|control plane|kanban|multi[- ]agent|multiple agents|workspace|workbench|编排|管理|控制台|看板|多智能体|多个\s*agent|工作台/i);
      add(agentRoles, 'observability', /\b(?:agent|claude code|codex)\b.{0,48}\b(?:observability|monitor(?:ing)?|status|usage|quota|costs?|telemetry|logs?|traces?|sessions?|dashboard|alerts?|notifications?)\b|\b(?:observability|monitor(?:ing)?|status|usage|quota|costs?|telemetry|logs?|traces?|sessions?|dashboard|alerts?|notifications?)\b.{0,48}\b(?:agent|claude code|codex)\b|\b(?:token|nerf)\s*(?:tracker|meter)\b|\bsessions?\b.{0,32}\b(?:status|alerts?|monitor(?:ing)?|awaiting input)\b|(?:Agent|Claude Code|Codex).{0,28}(?:可观测|监控|状态|用量|额度|账本|日志|追踪|提醒|通知|会话)|(?:可观测|监控|状态|用量|额度|账本|日志|追踪|提醒|通知|会话).{0,28}(?:Agent|Claude Code|Codex)/i);
      add(agentRoles, 'evaluation-security', /\b(?:evaluation|benchmark|test harness|security|audit|guardrail|red team)\b|评测|基准测试|安全测试|安全审计|护栏|红队/i);
      add(agentRoles, 'runtime-framework', /\b(?:agent|agentic)\s+(?:runtime|framework|sdk|platform|harness)\b|\b(?:runtime|framework|platform)\s+for\s+(?:ai\s+)?agents?\b|智能体.{0,10}(?:运行时|框架|开发平台)/i);
      const verticalUseCase = useCases.some(id => !['software-development', 'data-operations', 'security-testing', 'desktop-productivity'].includes(id));
      if ((!agentRoles.length || /assistant|copilot|agent for|智能体|助手|搭档/i.test(text)) && verticalUseCase) agentRoles.push('vertical-agent');
    }
    add(productForms, 'web-app', /web app|website|browser[- ]based|网页|网站|web 应用/i);
    add(productForms, 'desktop-app', /desktop (?:app|tool|client|utility|pet)|native macos|menu bar|menubar|桌面应用|桌面端|桌面工具|桌面宠物|菜单栏|原生 mac/i);
    add(productForms, 'mobile-app', /mobile app|ios app|android app|移动应用|手机应用/i);
    add(productForms, 'cli', /\bcli\b|command line|terminal tool|命令行|终端工具/i);
    add(productForms, 'skill-plugin', /\bskills?\b|plugin|extension|技能包|插件/i);
    add(productForms, 'mcp-service', /\bmcp\b|model context protocol/i);
    add(productForms, 'library-sdk', /\bsdk\b|library|framework|开发库|组件库|框架/i);
    add(productForms, 'content-resource', /book|course|guide|directory|list|教程|课程|书籍|资源列表|导航站/i);
    add(platforms, 'web', /web app|website|browser[- ]based|网页|网站|\bweb\b/i); add(platforms, 'macos', /macos|mac os|\bmac\b|mac 菜单栏|mac桌面|原生 mac/i);
    add(platforms, 'windows', /windows|win32|win11|win10/i); add(platforms, 'linux', /linux|ubuntu|bash/i);
    add(platforms, 'ios', /\bios\b|iphone|ipad/i); add(platforms, 'android', /android/i); add(platforms, 'browser', /browser extension|chrome extension|浏览器扩展/i); add(platforms, 'terminal', /terminal|\bcli\b|命令行|终端/i);
    add(integrations, 'claude-code', /claude code/i); add(integrations, 'codex', /\bcodex\b/i); add(integrations, 'opencode', /opencode/i);
    add(integrations, 'deepseek-harness', /deepseek harness|\bdsh\b/i); add(integrations, 'openclaw', /openclaw/i); add(integrations, 'cursor', /\bcursor\b/i);
    return normalizeTaxonomy({ useCases, agentRoles, productForms, platforms, integrations });
  }
  function itemTaxonomy(item) {
    const explicit = normalizeTaxonomy(item?.taxonomy);
    if (!taxonomyHasValues(explicit)) return inferTaxonomy(item || {});
    // Travel used to live inside the broad lifestyle bucket. Preserve explicit LLM metadata for all
    // other facets, but deterministically promote historical travel products into the new stable
    // business scene so the trend starts with the full archive rather than only tomorrow's report.
    const inferred = inferTaxonomy(item || {});
    if (inferred.useCases.includes('travel-mobility') && !explicit.useCases.includes('travel-mobility')) {
      explicit.useCases = ['travel-mobility', ...explicit.useCases.filter(id => id !== 'lifestyle-entertainment')].slice(0, 2);
    }
    return normalizeTaxonomy(explicit);
  }
  // Facet tags carry the id and its hierarchy so a caller can label a sub-topic and still say what it
  // belongs to. `taxonomyTags` keeps returning plain labels for list rows, where there is no room.
  function taxonomyTagEntries(item, locale = 'zh-CN', limit = 3) {
    const taxonomy = itemTaxonomy(item), ordered = ['useCases', 'agentRoles', 'productForms', 'platforms', 'integrations'];
    const entries = [];
    for (const name of ordered) for (const id of taxonomy[name]) {
      const label = facetLabel(name, id, locale);
      if (entries.some(entry => entry.label === label)) continue;
      const parent = facetParent(name, id);
      entries.push({ name, id, label, path: parent ? facetPathLabel(name, id, locale) : '' });
      if (entries.length >= limit) return entries;
    }
    return entries;
  }
  const taxonomyTags = (item, locale = 'zh-CN', limit = 3) => taxonomyTagEntries(item, locale, limit).map(entry => entry.label);
  const t = (locale, key, args = {}) => String(messages[locale]?.[key] ?? messages['zh-CN'][key] ?? key)
    .replace(/\{(\w+)\}/g, (_, name) => args[name] ?? '');
  const escapeHtml = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
  const localPath = (route, locale) => (locale === 'en' ? '/en' : '') + route;
  const sourceName = (item, locale) => sourceLabels[item.sourceId]?.[locale === 'en' ? 1 : 0] || item.sourceName || t(locale, 'unknownSource');
  const sourceInfo = item => sourceDirectory[String(item?.sourceId || '').toLowerCase()] || null;
  // Filter chips are rendered by the build and rebuilt in the browser, so the markup lives here.
  // app.js only collapses overflowing chips into the "more" menu; nothing else is generated client-side.
  // Every page filters by the preset categories: the report pages used to offer a source filter too.
  const chipCopy = {
    'zh-CN': { more: '更多分类', field: '分类', aria: '项目分类', all: '全部' },
    en: { more: 'More categories', field: 'Category', aria: 'Categories', all: 'All' },
  };
  function chipFilterMeta(locale) {
    return { attr: 'data-category', containerId: 'category-chips', menuId: 'category-chips-menu', selectId: 'category-select', ...chipCopy[locale === 'en' ? 'en' : 'zh-CN'] };
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
  function chipFilterHtml(options, locale) {
    const meta = chipFilterMeta(locale);
    const chips = options.map(option => `<button type="button" class="chip${option.active ? ' is-active' : ''}" ${meta.attr}="${escapeHtml(option.id)}" data-label="${escapeHtml(option.label)}" aria-pressed="${option.active}"${chipDisabled(option) ? ' disabled' : ''}>${escapeHtml(option.label)}<span class="chip-count">${Number(option.count) || 0}</span></button>`).join('');
    const listOptions = options.map(option => `<option value="${escapeHtml(option.id)}"${option.active ? ' selected' : ''}${chipDisabled(option) ? ' disabled' : ''}>${escapeHtml(option.label)} (${Number(option.count) || 0})</option>`).join('');
    return `<div class="chip-row">${chips}`
      + `<div class="chip-more" data-more-label="${escapeHtml(meta.more)}" hidden><button type="button" class="chip chip-more-trigger" aria-expanded="false" aria-controls="${meta.menuId}"><span class="chip-more-label">${escapeHtml(meta.more)}</span><svg class="chip-caret" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button></div></div>`
      + `<div class="chip-menu" id="${meta.menuId}" hidden></div>`
      + `<label class="chip-select"><span class="chip-select-label">${escapeHtml(meta.field)}</span><select id="${meta.selectId}" aria-label="${escapeHtml(meta.aria)}">${listOptions}</select><svg class="select-control-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></label>`;
  }
  // A host that cannot resolve is not a usable link. Submission text used to leak markdown
  // emphasis into the address (`**https://seichigo.com**` → host `seichigo.com**`), and
  // `new URL()` accepts that (`*` is not a forbidden host code point), so the 官网 button
  // rendered happily and only failed when clicked. `issue-description.bareUrls` now strips
  // that at the data layer; this is the second line — the 9 historical rows that still carry
  // a trailing `）` in the host (`createvision.ai)`) render as no link instead of a dead one.
  // IDN hosts arrive here already punycoded, IPv6 keeps its brackets, and `_` is allowed
  // because it shows up in real hostnames even though DNS proper forbids it.
  const HOSTNAME_OK = /^[a-z0-9._-]+$/i;
  const IPV6_HOST = /^\[[0-9a-f:.]+\]$/i;
  function safeUrl(value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
      return HOSTNAME_OK.test(url.hostname) || IPV6_HOST.test(url.hostname) ? url.href : '';
    } catch { return ''; }
  }
  // Only the newest reports are mirrored into this site; the archive keeps referencing the
  // source CDN. Un-mirrored images may render only from these hosts, so an unexpected or
  // hostile URL still cannot reach the page.
  const hotlinkOrigins = new Set([
    'akxlagkpqhwjrwrq.public.blob.vercel-storage.com', // VibeCafé product media
    'ph-files.imgix.net', // Product Hunt launch media
  ]);
  // GitHub 上的投稿插图（issue 附件与仓库里提交的截图）不能按 host 整站放行 —— 那样 `github.com`
  // 的任意页面地址都会变成可渲染的 `<img>`。所以按「host + 路径形状」放行三种确定是图片的位置：
  //   github.com/user-attachments/assets/<uuid>              投稿附件（302 到带签名的 S3 图片，可长期引用）
  //   github.com/<owner>/<repo>/blob/<ref>/…<ext>?raw=true   仓库里的图片，GitHub 按 raw 直出
  //   raw.githubusercontent.com/<owner>/<repo>/<ref>/…<ext>  仓库原始文件
  // 这份白名单只有这一处实现：浏览器、Worker 详情页与构建期（scripts/image-store.js）都问它。
  const IMAGE_FILE_PATH = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;
  const hotlinkPaths = [
    ({ hostname, pathname }) => hostname === 'github.com'
      && /^\/user-attachments\/assets\/[0-9a-f][0-9a-f-]{10,}$/i.test(pathname),
    ({ hostname, pathname, searchParams }) => hostname === 'github.com'
      && /^\/[^/]+\/[^/]+\/blob\/[^/]+\/.+$/i.test(pathname) && IMAGE_FILE_PATH.test(pathname) && searchParams.has('raw'),
    ({ hostname, pathname }) => hostname === 'raw.githubusercontent.com'
      && /^\/[^/]+\/[^/]+\/[^/]+\/.+$/i.test(pathname) && IMAGE_FILE_PATH.test(pathname),
  ];
  const localImagePath = /^\/images\/[a-f0-9]{64}\.(png|jpg|gif|webp|avif|ico|svg)$/;
  // Mirrors can also be served from the CDN origin that `IMAGE_BASE` selects at build time
  // (see scripts/image-store.js). Only these hosts may appear in markup, so a foreign origin
  // cannot smuggle in an image even when it copies our path shape.
  const imageOrigins = new Set(['img.devtrends.site']);
  function hotlinkable(value) {
    const url = safeUrl(value);
    if (!url) return '';
    const parsed = new URL(url);
    if (hotlinkOrigins.has(parsed.hostname.toLowerCase())) return url;
    return hotlinkPaths.some(rule => rule(parsed)) ? url : '';
  }
  // A managed mirror is either a same-site path or the same content-addressed path on the
  // configured image CDN. Anything else is not a managed image.
  function managedImage(value) {
    if (typeof value !== 'string') return '';
    if (localImagePath.test(value)) return value;
    const url = safeUrl(value);
    if (!url) return '';
    const parsed = new URL(url);
    return imageOrigins.has(parsed.hostname.toLowerCase()) && !parsed.search && !parsed.hash && localImagePath.test(parsed.pathname) ? url : '';
  }
  // Only managed, content-addressed images may reach the browser; a URL whose mirror was pruned
  // falls back to its source CDN when that host is trusted.
  function localImage(value, manifest = {}) {
    const mapped = manifest[value];
    const candidate = typeof mapped === 'string' && mapped ? mapped : value;
    return managedImage(candidate) || hotlinkable(candidate);
  }
  // Screenshot lists (`images`) are managed exactly like single images; anything unsafe is dropped.
  function localImages(value, manifest = {}) {
    return (Array.isArray(value) ? value : []).map(entry => localImage(entry, manifest)).filter(Boolean);
  }
  // The product mark identifies an item at 48–56px: platform logo → declared icon → the icon its
  // official website declares (`siteLogo`, captured offline), then initials. Only managed mirrors
  // pass; a software screenshot is never borrowed for the mark. `localizeReport` in
  // scripts/image-store.js reads the tone of this same mark, so the precedence lives here only once.
  function itemMark(item) {
    return localImage(item?.logo) || localImage(item?.icon) || localImage(item?.siteLogo);
  }
  // A mark that is itself a pale transparent drawing is invisible on the white tile the rows use;
  // `item.markTone` is set at build time (scripts/mark-tone.js) and switches the tile to dark.
  function markClass(item) {
    return item?.markTone === 'light' ? ' is-light' : '';
  }
  // ── 插图集 ──────────────────────────────────────────────────────────────────
  // 一条行可能有三类配图，按信息量排序展示：
  //
  //   original   来源自带的配图（Product Hunt media 等）—— 平台原图，最能代表产品
  //   screenshot 我们自己去官网截的首屏图 —— 反映官网现在真实的样子
  //   og         官网声明的 og:image —— 常是营销主视觉（实测有 4 张只是 logo）
  //
  // 只返回「本地/可信来源」的 URL；三类之外的原始地址一律丢掉。
  const MEDIA_ORIGIN_LABELS = { original: 'mediaOriginal', screenshot: 'mediaScreenshot', og: 'mediaOg' };
  function mediaKindUrl(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return value.url;
    return '';
  }
  // OG 图与产品标志相同（同一地址、或同一内容哈希）时不再重复展示：它要么就是那个 logo，
  // 要么是同一张图，放进插图集只会和头像重复。dHash 距离 <= 2 视为同图。
  function sameImageAsMark(entry, markHash) {
    if (!markHash || !entry) return false;
    if (entry.sha256 && entry.sha256 === markHash.sha256) return true;
    if (typeof entry.dhash === 'number' && typeof markHash.dhash === 'number') {
      const distance = popcount(entry.dhash ^ markHash.dhash);
      if (distance <= 2) return true;
    }
    return false;
  }
  function popcount(value) {
    let count = 0, n = value >>> 0;
    while (n) { n &= n - 1; count += 1; }
    return count;
  }
  function markImageRef(item) {
    return item?.markImage && typeof item.markImage === 'object' ? item.markImage : null;
  }
  function mediaEntries(item, manifest = {}) {
    const mark = markImageRef(item);
    const entries = [];
    const push = (value, origin) => {
      const url = localImage(mediaKindUrl(value), manifest);
      if (url) entries.push({ url, origin });
    };
    for (const value of Array.isArray(item?.images) ? item.images : []) push(value, 'original');
    push(item?.image, 'original');
    for (const value of Array.isArray(item?.screenshots) ? item.screenshots : []) push(value, 'screenshot');
    const og = item?.ogImage;
    if (og && !sameImageAsMark(og, mark)) push(og, 'og');
    // The same file can arrive from two sources (a mirror path from images and from screenshots);
    // the first — highest-priority — origin keeps it.
    const seen = new Set();
    return entries.filter(entry => (seen.has(entry.url) ? false : (seen.add(entry.url), true)));
  }
  // Thumbnail strip for a product's gallery. Values must already be managed local paths; the full
  // list travels in data-gallery so app.js can open the viewer without a second request.
  function galleryHtml(value, locale) {
    // A plain URL list keeps the old signature working (tests and older callers pass images directly).
    const entries = (Array.isArray(value) ? value : [])
      .map(entry => (typeof entry === 'string' ? { url: entry, origin: 'original' } : entry))
      .map(entry => ({ url: localImage(entry?.url), origin: entry?.origin || 'original' }))
      .filter(entry => entry.url);
    if (!entries.length) return '';
    const images = entries.map(entry => entry.url);
    const label = t(locale, 'galleryOpen');
    const visible = entries.slice(0, 3);
    const hidden = entries.length - visible.length;
    const originLabel = (origin) => t(locale, MEDIA_ORIGIN_LABELS[origin] || MEDIA_ORIGIN_LABELS.original);
    const originList = entries.map(entry => originLabel(entry.origin));
    // Every image carries its own text: an empty `alt` is what search consoles report as a missing
    // alt attribute, and here the description ("查看配图 · 1/3") is exactly what a reader needs.
    const thumb = (entry, index, extra = '') => {
      const description = `${label} · ${index + 1}/${entries.length} · ${originLabel(entry.origin)}`;
      return `<button type="button" class="gallery-thumb${extra}" data-index="${index}" data-origin="${escapeHtml(entry.origin)}" title="${escapeHtml(originLabel(entry.origin))}" aria-label="${escapeHtml(description)}"><img src="${escapeHtml(entry.url)}" alt="${escapeHtml(description)}" loading="lazy" /><span class="gallery-origin">${escapeHtml(originLabel(entry.origin))}</span></button>`;
    };
    const thumbs = visible.map((entry, index) => thumb(entry, index)).join('');
    const more = hidden > 0 ? `<button type="button" class="gallery-thumb gallery-more" data-index="${visible.length}" aria-label="${escapeHtml(`${label} · +${hidden}`)}">+${hidden}</button>` : '';
    // `data-gallery` stays a plain URL array — app.js parses it straight into the lightbox. The
    // per-image origin travels beside it so the viewer can label what is being shown.
    return `<div class="item-gallery" data-gallery="${escapeHtml(JSON.stringify(images))}" data-origins="${escapeHtml(JSON.stringify(originList))}" role="group" aria-label="${escapeHtml(t(locale, 'gallery'))}">${thumbs}${more}</div>`;
  }
  // Accept repository roots only. Issue/blob/profile URLs must not create false projects.
  function repository(item) {
    for (const candidate of [item.githubUrl, item.github?.url, item.url, item.websiteUrl]) {
      try {
        const url = new URL(candidate);
        if (!['https:', 'http:'].includes(url.protocol) || !['github.com', 'www.github.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) continue;
        const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
        if (parts.length !== 2) continue;
        // Submissions copy the URL out of a sentence, so it can end in the sentence's punctuation
        // ("github.com/larryteal/mcp-workspace."); a trailing dot would otherwise become a project
        // page whose own address ends in a dot. GitHub names cannot end in one anyway.
        const trim = value => value.replace(/[\s.]+$/, '');
        const owner = trim(parts[0]), repo = trim(parts[1]).replace(/\.git$/i, '');
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
  // 投稿标签描述「这条是怎么来的」，不是产品名的一部分：【开源自荐】、[开源推荐]、〖工具自荐〗
  // 这类前缀本来就该从标题里去掉。老规则只认中文的 自荐/推荐/投稿，所以同一批英文投稿
  // （[Open Source]、[Tool Recommendation]、[Show HN]、[Self-promo]）会原样留在标题里（2026-09 走查）。
  // 现在命中条件有两种，都只针对开头的括号（或带分隔符的前缀）：
  //   ① 括号里含投稿动词（自荐/推荐/投稿）—— 沿用老规则，所以「【AI SaaS自荐】」也能清；
  //   ② 括号里整段都由标签词拼成（[Open Source]、[Tool Self-Promotion]、[Show HN]、【文章】）。
  // 词表只收「标签词」，所以拿方括号当书名号的产品名（【Tokenscope】、【Wegent】、[MAC]）不受影响。
  const TITLE_LABEL_WORD = '(?:' + [
    '(?:已|新)?[开開]源', '工具', '小工具', '[网網][站页頁]', '软件|軟[体件]', '插件', '[项項]目', '[产產]品', '[应應]用', '[资資]源',
    '文章', '教程', '[课課]程', '[周週]刊', '[资資]讯|資訊', '[内內]容', '好文', '[独獨]立', '[实實]用', '有趣', '博客',
    '[免兎]费|免費', '系列', '[书書]籍', '言[论論]', '[开開]发|開發', 'AI',
    '自[荐薦建推宣检]', '自部署', '推[荐薦]', '投稿', 'skills?',
    'open\\s*source', 'opensource', 'tools?', 'websites?', 'web', 'sites?', 'software', 'plugins?', 'extensions?',
    'projects?', 'products?', 'apps?', 'resources?', 'articles?', 'tutorials?', 'guides?', 'courses?',
    'newsletters?', 'blogs?', 'books?', 'free', 'ai', 'submissions?', 'show\\s*hn', 'submit\\s+tool',
    'self[-\\s]?(?:promo(?:tion)?|recommendation)', 'promos?',
    'recommend(?:ation|ed|s)?', 'recomend(?:ation|ed)?', 'recommandation',
    'recomendaci[oó]n(?:\\s+de\\s+herramienta)?', 'おすすめ', 'お勧め',
  ].join('|') + ')';
  // 标签词之间允许空格、斜杠、顿号这类连接符；数量都写死上限，避免 (词|词)* 这类写法在长标题上
  // 退化成指数回溯（浏览器里渲染列表时会卡死）。
  const TITLE_LABEL_SEP = '[\\s\\-–—/·、,，]{0,2}';
  const TITLE_LABEL_PHRASE = `${TITLE_LABEL_WORD}(?:${TITLE_LABEL_SEP}${TITLE_LABEL_WORD}){0,4}`;
  // 括号里的「投稿动词」沿用老规则：只要括号里出现这些词就整段清掉（所以 【AI SaaS自荐】 也能清）。
  // 只放不会和产品名撞车的写法，recommend 这类英文词不算——[Recommendation Engine] 可能真是产品。
  const TITLE_LOOSE_VERB = '(?:自[荐薦]|推[荐薦]|投稿|self[-\\s]?(?:promo(?:tion)?|recommendation)|show\\s*hn|submit\\s+tool)';
  // 不带括号的前缀（Recommend: X、工具自荐：X）必须由「投稿动词」+ 分隔符组成，
  // 否则「AI-Native PM: …」这种正常标题会被当成 AI 标签吃掉开头。
  const TITLE_PLAIN_VERB = `(?:${TITLE_LOOSE_VERB}|recommend(?:ation|ed|s)?|recomend(?:ation|ed)?|recommandation|open\\s*source|recomendaci[oó]n|おすすめ|お勧め)`;
  // 括号标签可以连着写（[开源推荐] [Tool Recommendation] X、[Show HN] / [Tool] X）。
  const TITLE_BRACKET_LABEL = `[【\\[［〖〔]\\s*(?:[^】\\]］〗〕]*?${TITLE_LOOSE_VERB}[^】\\]］〗〕]*|${TITLE_LABEL_PHRASE})\\s*[】\\]］〗〕]`;
  // 漏写开括号的投稿标签：`开源自荐】PiX: …`、`工具自荐】MathLite —— …`。右括号还在、左边没有配对，
  // 是投稿人手打的（2026-05-03 / 2026-09-17 各有一条，其中一条就是 11762）。命中条件与括号标签完全一致
  // （括号前那段含投稿动词，或整段都是标签词），只是不要求开括号；前缀限定在**第一个空白之前、最多 16 字**，
  // 所以 `C++ 性能优化】实战笔记`、`【Tokenscope】…` 这类正常标题不会被吃掉开头。
  const TITLE_DANGLING_LABEL = `(?:[^】\\]］〗〕\\s]{0,16}?${TITLE_LOOSE_VERB}|${TITLE_LABEL_PHRASE})\\s*[】\\]］〗〕]`;
  const TITLE_PLAIN_LABEL = `(?:${TITLE_LABEL_WORD}${TITLE_LABEL_SEP}){0,4}${TITLE_PLAIN_VERB}(?:${TITLE_LABEL_SEP}${TITLE_LABEL_WORD}){0,4}\\s*[:：\\-–—]`;
  const TITLE_PREFIX = new RegExp(
    `^\\s*(?:(?:${TITLE_BRACKET_LABEL}|${TITLE_DANGLING_LABEL}|${TITLE_PLAIN_LABEL})\\s*[/|｜·、,，\\-–—]?\\s*)+`,
    'i');
  // Preserve source title for final matching; only explicit fields may supply a name.
  // A "项目标题" that is really a release note (v2.18.3发布：…) names a version, not the product;
  // taking it would put a changelog line in the list row, so it falls through to owner/repo.
  function isReleaseNote(value) {
    return /^v?\d+(?:\.\d+)*\s*(?:发布|release)\b/i.test(value)
      || /^v?\d+(?:\.\d+){1,3}\b.*(?:发布|更新|支持|修复|新增)/.test(value)
      || /^(?:更新|发布|升级)\s*(?:日志|说明|内容)|(?:更新|发布|升级)日志/.test(value);
  }
  function titleFallback(item) {
    if (String(item.title || '').replace(TITLE_PREFIX, '').trim()) return null;
    if (item.titleFallback) return { value: item.titleFallback, source: item.titleFallbackSource || 'normalized' };
    const lines = String(item.content || '').replace(/```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, '').split(/\r?\n/);
    const values = { '项目名称': [], '产品名称': [], '工具名称': [], '项目标题': [] };
    let field = '';
    for (const raw of lines) {
      const line = raw.trim();
      const heading = line.match(/^#{1,6}\s+(项目名称|产品名称|工具名称|项目标题)\s*[:：]?\s*$/);
      if (heading) { field = heading[1]; continue; }
      if (/^#{1,6}\s/.test(line)) { field = ''; continue; }
      const inline = line.match(/^(?:[-*]\s+)?(?:\*\*)?(项目名称|产品名称|工具名称|项目标题)(?:\*\*)?\s*[:：]\s*(.+)$/);
      const label = inline?.[1] || field;
      const value = (inline?.[2] || (field ? line : '')).replace(/[*_`]/g, '').trim();
      if (label && value) {
        if (value.length <= 240 && !/^(?:No response|无|暂无|待补充|todo|https?:\/\/)/i.test(value) && !/[<>]/.test(value) && !isReleaseNote(value)) values[label].push(value);
        field = '';
      }
    }
    for (const label of ['项目名称', '产品名称', '工具名称', '项目标题']) {
      const candidates = [...new Set(values[label])];
      if (candidates.length === 1) return { value: candidates[0], source: `issue-body:${label}` };
      if (candidates.length > 1) break;
    }
    const repo = repository(item);
    return repo ? { value: repo.fullName, source: 'github-repository' } : null;
  }
  // 只去掉开头的投稿标签，其余原样返回。产品详情页的 SEO 标题用它：目录（MySQL / 站点快照）里的
  // title 是发布时那一行的原始投稿标题，`开源自荐】PiX: …` 这样的标签不该进 <title> / og:title，
  // 而那里既不该换成 LLM 译文、也不该退到 owner/repo（那是列表行 displayTitle 的口径）。
  const stripTitleLabel = value => String(value ?? '').replace(TITLE_PREFIX, '').trim();
  function displayTitle(item, locale = 'zh-CN') {
    const localized = locale === 'en' ? item.titleEn || item.title_en : item.titleZh || item.title_zh;
    const title = String(localized || item.title || repository(item)?.fullName || 'Untitled');
    return titleFallback(item)?.value || stripTitleLabel(title) || title.trim();
  }
  function withTitleFallback(item) {
    const fallback = titleFallback(item);
    return fallback ? { ...item, titleFallback: fallback.value, titleFallbackSource: fallback.source } : item;
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
  // Three destinations with three different meanings: the repository, the product's own website,
  // and where DevTrends actually found it. `url` is NOT an origin URL — boards such as 中国独立开发者
  // store the product link there, and trending / Show HN store the repository — so using it as the
  // last source fallback made 来源 repeat 官网 or the GitHub button. Prefer the item's own
  // post/thread (Show HN's hnUrl, a submission issue, VibeCafé / Product Hunt page, V2EX thread),
  // then the source board itself.
  function itemLinks(item) {
    const repo = repository(item);
    const repositoryUrl = safeUrl(repo?.url);
    const website = safeUrl(item.websiteUrl || item.github?.homepage || (!repo ? item.url : ''));
    const post = safeUrl(item.issueUrl || item.relatedIssue || item.hnUrl || item.vibecafeUrl || item.productHuntUrl || item.url);
    const board = safeUrl(sourceInfo(item)?.url);
    // Repository identity is lowercased upstream while the raw item keeps the owner's casing, so a
    // byte comparison would let https://github.com/Owner/Repo and https://github.com/owner/repo count
    // as two different destinations and show the repository twice.
    const key = url => String(url).toLowerCase();
    const distinct = url => (url && key(url) !== key(website) && key(url) !== key(repositoryUrl) ? url : '');
    const source = distinct(post) || distinct(board) || '';
    const seen = new Set();
    return [['repository', repositoryUrl], ['website', website], ['source', source]]
      .filter(([, url]) => url && !seen.has(key(url)) && seen.add(key(url)));
  }
  const icon = (name) => {
    const paths = {
      arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
      search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
      repo: '<path d="M5 4h14v16H7a2 2 0 0 1-2-2V4Zm0 12h14M9 7h6"/>',
      github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7.4A5.8 5.8 0 0 0 19.3 3 5.4 5.4 0 0 0 19.1 0S17.9-.4 15 1.5a14 14 0 0 0-6 0C6.1-.4 4.9 0 4.9 0a5.4 5.4 0 0 0-.2 3A5.8 5.8 0 0 0 3.2 7c0 5.8 3.5 7 6.8 7.4A4.8 4.8 0 0 0 9 18v4M9 19c-3 .9-3-1.5-4.2-2"/>',
      box: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9"/>',
      comment: '<path d="M21 12a8 8 0 0 1-8 8H5l-3 2 1-5a9 9 0 1 1 18-5Z"/>',
      source: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="m8.3 7 7.2-.1M7.5 8.1l3.2 7.6m5.6-6.5-3.1 6.6"/>',
      star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
      trend: '<path d="M3 17.5 9 11l4 4 8-8.5M15 6.5h6v6"/>',
    };
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.box}</svg>`;
  };
  // A rendered box hides content when its scroll size exceeds its client size, so only a genuinely
  // clipped list title or description earns a tooltip.
  const isClipped = element => element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight;
  const canStickSidebar = (viewportWidth, viewportHeight, sidebarHeight, minWidth, edgeGap = 20) =>
    Number(viewportWidth) >= Number(minWidth)
      && Number(sidebarHeight) <= Math.max(0, Number(viewportHeight) - Number(edgeGap) * 2);
  // Fallback only: a source with a logo asset renders that logo instead. Keyed off sourceId, never the
  // display name, because "HelloGitHub" would otherwise match a /github/ test and borrow GitHub's mark.
  function sourceMark(item) {
    const id = String(item?.sourceId || '').toLowerCase();
    if (id === 'github-trending' || id === 'github-trending-cn') return icon('github');
    const known = { producthunt: 'P', vibecafe: 'V', hackernews: 'Y', showhn: 'Y', v2ex: 'V2', reddit: 'R', devto: 'D', indiehackers: 'IH' };
    return escapeHtml(known[id] || sourceName(item, 'en').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'D');
  }
  // Collectors tag every item with its own source (`producthunt`, `ruanyf-weekly`, `hellogithub`,
  // `indie-dev`) and with collection bookkeeping (`new`, `official`, `submission`). The row already
  // names its source beside a badge, so those chips would only repeat what the row already says.
  const sourceScaffoldTags = new Set([
    'product', 'vibecafe', 'producthunt', 'ruanyf-weekly', 'hellogithub', 'indie-dev', 'github-trending',
    'showhn', 'v2ex', 'hackernews', 'show-hn', 'create',
    'daily', 'new', 'official', 'submission', 'official-featured',
  ]);
  // The chinese-independent-developer boards carry the line's status emoji as a tag (`✅ 已上线`,
  // `🕗 开发中`, `❌ 已关闭`). A status is not a topic: it says nothing a reader can browse by, and
  // "已上线" is true of nearly every row, so those chips are dropped. The raw tag stays in the report JSON.
  const collectionStatusTags = new Set(['已上线', '开发中', '已关闭']);
  // Up to three chips per row, minus everything the row already states elsewhere: the source (badge
  // and name) and the primary language, which is rendered as its own chip and repeated by the
  // github-trending collector inside `tags`. Casing variants count as the same tag.
  function visibleTagEntries(item, locale = 'zh-CN', limit = 3) {
    const seen = new Set([String(item.sourceId || '').toLowerCase(), String(metric(item, ['language', 'lang']) || '').toLowerCase(), ...sourceScaffoldTags, ...collectionStatusTags]);
    const taxonomy = itemTaxonomy(item);
    const semanticIds = new Set(Object.values(taxonomy).flat().map(value => String(value).toLowerCase()));
    if (semanticIds.has('mcp-service')) semanticIds.add('mcp');
    const facetTags = taxonomyTagEntries({ ...item, taxonomy }, locale);
    const originalTags = [];
    for (const tag of [...(item.github?.topics || []), ...(item.tags || [])]) {
      const key = String(tag).trim().toLowerCase();
      if (!key || seen.has(key) || semanticIds.has(key)) continue;
      seen.add(key);
      originalTags.push({ label: tag, origin: 'source' });
    }
    const tags = [];
    // When the project supplies a meaningful original label, reserve one of the three visible
    // slots for it so the provenance marker is useful rather than merely theoretical.
    const devtrendsLimit = Math.max(0, limit - Math.min(1, originalTags.length));
    for (const entry of facetTags) {
      const key = String(entry.label).trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      tags.push({ label: entry.label, origin: 'devtrends', path: entry.path });
      if (tags.length === devtrendsLimit) break;
    }
    tags.push(...originalTags.slice(0, limit - tags.length));
    return tags;
  }
  const visibleTags = (item, locale = 'zh-CN') => visibleTagEntries(item, locale).map(tag => tag.label);
  function tagHtml(tag, locale = 'zh-CN') {
    const origin = tag.origin === 'source' ? 'source' : tag.origin === 'language' ? 'language' : 'devtrends';
    const marker = origin === 'source' ? t(locale, 'tagSource') : origin === 'language' ? t(locale, 'tagLanguage') : t(locale, 'tagDevTrends');
    const title = origin === 'source' ? t(locale, 'tagSourceTitle') : origin === 'language' ? t(locale, 'tagLanguageTitle') : t(locale, 'tagDevTrendsTitle');
    // A sub-topic says what it belongs to in the tooltip, so the chip can stay one or two words.
    return `<span class="tag tag-${origin}" data-tag-origin="${origin}" data-tag-label="${escapeHtml(tag.label)}"${tag.path ? ` data-tag-path="${escapeHtml(tag.path)}"` : ''} title="${escapeHtml(tag.path ? `${title} · ${tag.path}` : title)}"><small>${escapeHtml(marker)}</small>${escapeHtml(tag.label)}</span>`;
  }
  // A repository that is still on GitHub Trending is not a new discovery: its source never changes
  // and its total-star column restates the ranking it was already published in. A continuation row
  // trades both for the one line that explains why it is here — today's stars and how many of the
  // cooldown reports already showed it. Both numbers ride on the item (`trendingPolicy.continuedItems`
  // in collect.js) so the row still explains itself once the policy object is gone.
  function continuationMeta(item, locale) {
    const today = Number(item.metrics?.today || 0);
    const continuation = item.trendingContinuation || {};
    const appearances = Math.max(1, Number(continuation.recentAppearances) || 1);
    const window = Math.max(appearances, Number(continuation.cooldownDays) || 3);
    return [
      today > 0 ? (locale === 'en' ? `+${compact(today, locale)} stars today` : `今日 +${compact(today, locale)} stars`) : '',
      locale === 'en' ? `seen in ${appearances} of the last ${window} reports` : `近 ${window} 期出现 ${appearances} 次`,
    ].filter(Boolean).join(' · ');
  }
  function renderItem(item, locale, { date = '', index = 0, showDate = false, continuation = false } = {}) {
    const repo = repository(item), projectPath = item.projectPath;
    const links = itemLinks(item), primary = safeUrl(item.websiteUrl || item.url) || repo?.url;
    const source = sourceInfo(item);
    const titleUrl = projectPath ? localPath(projectPath, locale) : trackedUrl(repo?.url || primary, item, date);
    const s = summary(item, locale);
    const language = metric(item, ['language', 'lang']);
    const stars = metric(item, ['stars', 'stargazers_count', 'totalStars']);
    const votes = metric(item, ['votes', 'votesCount']);
    const tags = visibleTagEntries(item, locale);
    // The product mark identifies an item at 48px. A software screenshot is never borrowed for the
    // avatar: it belongs to the gallery. A row without a platform mark falls back to the logo its
    // official website declares (`siteLogo`, captured offline) and only then to its initials.
    const markUrl = itemMark(item);
    const markTone = markClass(item);
    const title = displayTitle(item, locale);
    const score = stars !== null ? stars : votes;
    const scoreIcon = stars !== null ? icon('star') : (votes !== null ? '<span aria-hidden="true">▲</span>' : '');
    const sourceUrl = itemLinks(item).find(([label]) => label === 'source')?.[1];
    const discoveryDate = showDate && date ? `<time class="tag tag-date item-discovery-date" datetime="${escapeHtml(date)}">${escapeHtml(dateLabel(date, locale))}</time>` : '';
    // Every row already belongs to the report date in the selector, and an item's own publishedAt
    // (UTC, per source) only contradicted it, so the row carries no date of its own.
    const trailing = continuation
      ? `<div class="item-continuation">${escapeHtml(continuationMeta(item, locale))}</div>`
      : `<div class="item-source"><span class="source-mini source-mini-${escapeHtml(String(item.sourceId || '').toLowerCase())}" aria-hidden="true">${source?.logo ? `<img src="${escapeHtml(source.logo)}" alt="${escapeHtml(sourceName(item, locale))}" loading="lazy" />` : sourceMark(item)}</span>${sourceUrl ? `<a class="source-label" href="${escapeHtml(trackedUrl(sourceUrl, item, date))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(sourceName(item, locale))}">${escapeHtml(sourceName(item, locale))}</a>` : `<span class="source-label" title="${escapeHtml(sourceName(item, locale))}">${escapeHtml(sourceName(item, locale))}</span>`}</div>
      <div class="item-score">${score !== null ? `${scoreIcon}<span>${compact(score, locale)}</span>` : '<span>—</span>'}</div>`;
    return `<article class="feed-item${continuation ? ' is-continuation' : ''}" data-source-id="${escapeHtml(item.sourceId)}" data-item-id="${escapeHtml(item.externalId || itemId(item))}">
      <span class="item-number" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
      <span class="item-avatar avatar-${index % 5}${markUrl ? ` has-logo${markTone}` : ''}" aria-hidden="true">${markUrl ? `<img src="${escapeHtml(markUrl)}" class="is-logo" alt="${escapeHtml(title)}" loading="lazy" />` : escapeHtml((repo?.name || title).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2))}</span>
      <div class="item-primary"><h2>${titleUrl ? `<a href="${escapeHtml(titleUrl)}"${projectPath ? '' : ' target="_blank" rel="noopener noreferrer"'}>${escapeHtml(title)}</a>` : escapeHtml(title)}</h2><p class="summary" lang="${s.lang}">${escapeHtml(s.text)}</p>${s.original ? `<span class="original-label">${t(locale, 'original')}</span>` : ''}<div class="item-tags${discoveryDate ? ' has-date' : ''}">${discoveryDate}${language ? tagHtml({ label: language, origin: 'language' }, locale) : ''}${tags.map(tag => tagHtml(tag, locale)).join('')}</div></div>
      ${trailing}</article>`;
  }
  // Mobile card deck. Stacked cards are what makes the gesture read as "the content is moving":
  // the card under the top one rises to full size as the top card leaves, so a drag always shows
  // two cards in motion. Geometry lives here (not in cards.js) so the maths is testable without a
  // DOM and the deck markup and the drag handler cannot drift apart.
  const CARDS_STACK_DEPTH = 3;
  // Distance and speed both commit a card, which is what every shipped implementation does:
  // Android's SwipeDismissBehavior uses 50% of the width, Tinder-style open source cards default to
  // 25%, and Wear OS / Material Compose explicitly ignore the distance whenever the gesture is a
  // flick (velocity threshold 1.8 dp/ms). Distance alone forces a long drag on every card; the flick
  // is what makes the deck feel light. 0.18 sits at the low end of that 25–50% band on purpose.
  function swipeCommitDistance(width, min = 36, max = 96) {
    return Math.min(Math.max(width * 0.18, min), max);
  }
  // A flick commits regardless of distance. 0.5 px/ms is well below the 1.8 dp/ms Android treats as
  // a deliberate fling, so an ordinary quick swipe registers while a slow nudge still snaps back.
  function swipeFlicked(velocity) {
    return Math.abs(velocity) >= 0.5;
  }
  function swipeStackGeometry(dx, width) {
    const progress = width > 0 ? Math.min(Math.abs(dx) / width, 1) : 0;
    // Promotion is driven to completion by the commit distance, not by the full card width: a swipe
    // only ever travels a fraction of the width, so a width-based ramp would leave the card behind
    // still shrunken at the moment of release (which reads as a page swap rather than a card leaving).
    const ramp = width > 0 ? Math.min(Math.abs(dx) / swipeCommitDistance(width), 1) : 0;
    return {
      progress,
      // The top card tilts as it is dragged, the way a physical card would when pushed sideways.
      rotate: Math.max(-14, Math.min(14, dx / 14)),
      nextScale: 1 - 0.06 * (1 - ramp),
      nextOffset: 14 * (1 - ramp),
      // The third card moves up one slot: it takes the size and offset the second card rests at.
      thirdScale: 0.94 - 0.06 * (1 - ramp),
      thirdOffset: 14 + 12 * (1 - ramp),
    };
  }
  function renderSwipeItem(item, locale, { date = '', index = 0, depth = 0, interactive = true } = {}) {
    const repo = repository(item), projectPath = item.projectPath;
    const primary = safeUrl(item.websiteUrl || item.url) || repo?.url;
    const titleUrl = projectPath ? localPath(projectPath, locale) : trackedUrl(repo?.url || primary, item, date);
    const titleTarget = titleUrl && !projectPath ? ' target="_blank" rel="noopener noreferrer"' : '';
    const s = summary(item, locale), title = displayTitle(item, locale), source = sourceInfo(item);
    const language = metric(item, ['language', 'lang']);
    const stars = metric(item, ['stars', 'stargazers_count', 'totalStars']);
    const votes = metric(item, ['votes', 'votesCount']);
    const score = stars !== null ? stars : votes;
    const scoreIcon = stars !== null ? icon('star') : (votes !== null ? '<span aria-hidden="true">▲</span>' : '');
    const tags = visibleTags(item, locale).slice(0, 2);
    const markUrl = itemMark(item);
    const markTone = markClass(item);
    const screenshots = mediaEntries(item).map(entry => entry.url);
    const initials = escapeHtml((repo?.name || title).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2));
    const sourceBadge = source?.logo ? `<img src="${escapeHtml(source.logo)}" alt="${escapeHtml(sourceName(item, locale))}" loading="lazy" />` : sourceMark(item);
    const visual = screenshots.length
      ? `<div class="swipe-visual has-image"><img src="${escapeHtml(screenshots[0])}" alt="${escapeHtml(`${title} · ${t(locale, 'gallery')}`)}" /></div>`
      : `<div class="swipe-visual is-typographic" aria-hidden="true"><span class="swipe-mark avatar-${index % 5}${markUrl ? ` has-logo${markTone}` : ''}">${markUrl ? `<img src="${escapeHtml(markUrl)}" class="is-logo" alt="${escapeHtml(title)}" />` : initials}</span><span class="swipe-wordmark">${escapeHtml(title)}</span></div>`;
    const metadata = [language ? `<span class="tag">${escapeHtml(language)}</span>` : '', ...tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`), score !== null ? `<span class="swipe-score">${scoreIcon}<span>${compact(score, locale)}</span></span>` : ''].join('');
    // Only the top card is reachable. The cards waiting behind it must not carry links or buttons at
    // all: `inert` alone still leaves them in the tab order in Chromium, so a keyboard user would
    // tab into a card they cannot see. The title is plain text there for the same reason.
    const deferred = interactive ? '' : ' inert aria-hidden="true"';
    const titleTag = interactive && titleUrl ? `<a href="${escapeHtml(titleUrl)}"${titleTarget}>${escapeHtml(title)}</a>` : escapeHtml(title);
    const openLink = interactive && titleUrl ? `<a class="swipe-open" href="${escapeHtml(titleUrl)}"${titleTarget}>${escapeHtml(t(locale, 'openItem'))}<span aria-hidden="true">↗</span></a>` : '';
    return `<article class="swipe-item" data-depth="${depth}"${deferred} data-source-id="${escapeHtml(item.sourceId)}" data-item-id="${escapeHtml(item.externalId || itemId(item))}">
      <header class="swipe-source"><span class="source-mini source-mini-${escapeHtml(String(item.sourceId || '').toLowerCase())}" aria-hidden="true">${sourceBadge}</span><span>${escapeHtml(sourceName(item, locale))}</span></header>
      ${visual}
      <div class="swipe-copy"><h2>${titleTag}</h2><p class="summary" lang="${s.lang}">${escapeHtml(s.text)}</p>${s.original ? `<span class="swipe-original">${t(locale, 'original')}</span>` : ''}</div>
      <div class="swipe-meta">${metadata}</div>
      ${openLink}
    </article>`;
  }
  function boundedIndex(index, delta, length) {
    return Math.min(Math.max(index + delta, 0), Math.max(length - 1, 0));
  }
  function swipeStep(deltaX, deltaY, threshold = 54) {
    return Math.abs(deltaX) >= threshold && Math.abs(deltaX) > Math.abs(deltaY) * 1.15 ? (deltaX < 0 ? 1 : -1) : 0;
  }
  // The deck's items: the current one first, then what sits behind it. Bounded so the last card
  // simply has an emptier stack instead of wrapping around.
  function swipeDeck(items, index) {
    const deck = [];
    for (let i = 0; i < CARDS_STACK_DEPTH; i += 1) {
      const at = index + i;
      if (at < 0 || at >= items.length) continue;
      deck.push({ item: items[at], index: at, depth: i, interactive: i === 0 });
    }
    return deck;
  }
  const cardsProgressKey = 'devtrends-cards-v1';
  function readCardsProgress(storage, date, total) {
    let record = null;
    try { record = JSON.parse(storage.getItem(cardsProgressKey) || 'null'); } catch {}
    const matches = record && record.date === date && Number.isInteger(record.maxIndex) && record.maxIndex >= 0;
    const maxIndex = matches ? boundedIndex(record.maxIndex, 0, total) : 0;
    if (!matches) {
      try { storage.setItem(cardsProgressKey, JSON.stringify({ date, maxIndex: 0 })); } catch {}
    }
    return { date, maxIndex, readCount: total > 0 && matches ? Math.min(maxIndex + 1, total) : 0, complete: Boolean(total > 0 && matches && maxIndex === total - 1) };
  }
  function writeCardsProgress(storage, date, index, total) {
    const current = readCardsProgress(storage, date, total);
    const maxIndex = Math.max(current.maxIndex, boundedIndex(index, 0, total));
    try { storage.setItem(cardsProgressKey, JSON.stringify({ date, maxIndex })); } catch {}
    return { date, maxIndex, readCount: Math.min(maxIndex + 1, total), complete: total > 0 && maxIndex === total - 1 };
  }
  // ---- global chrome: one implementation for every renderer ----
  // The static builder injects these through the `{{topbar}}` / `{{footerHtml}}` placeholders in
  // web/index.html; the Worker's MySQL-rendered product pages call the same functions. Copying this
  // markup into the Worker by hand is exactly what left /products/* without the appearance and
  // language controls — and, because app.js reads #theme-picker unconditionally, it also threw there
  // and killed every binding after it. Keep both entry points on these two functions.
  const navItems = [['discover', '/'], ['trends', '/trends/'], ['archive', '/reports/']];
  function topbarHtml({ locale = 'zh-CN', active = '', homePath = localPath('/', locale), headerSearch = '' } = {}) {
    const navigation = navItems.map(([key, url]) =>
      `<a href="${localPath(url, locale)}"${active === key ? ' aria-current="page"' : ''}>${t(locale, key)}</a>`).join('');
    const label = key => t(locale, key);
    return `<header class="topbar"><div class="topbar-inner">
      <a class="brand" href="${homePath}" aria-label="DevTrends"><svg class="brand-logo" width="34" height="34" viewBox="0 0 48 48" role="img" aria-label="DevTrends"><rect x="1" y="1" width="46" height="46" rx="12" fill="#161b22"/><path fill="#fff" fill-rule="evenodd" d="M9.5 9h12c9.39 0 17 6.72 17 15s-7.61 15-17 15h-12V9Zm8 8v14h4c4.97 0 9-3.13 9-7s-4.03-7-9-7h-4Z"/><path d="m15.5 30.51 5.8-5.81 3.7 2.8 6.7-7.7M27.48 20.62 31.7 19.8 31.47 24.09" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>DevTrends<small>${label('brandLabel')}</small></span></a>
      <nav class="main-nav" aria-label="${locale === 'en' ? 'Main navigation' : '主导航'}">${navigation}</nav>
      ${headerSearch}
      <div class="preferences">
        <details class="theme-picker" id="theme-picker">
          <summary aria-label="${label('theme')}" title="${label('theme')}">
            <svg class="theme-sun" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>
            <svg class="theme-moon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20.5 14a9 9 0 0 1-10.5-10.5A9 9 0 1 0 20.5 14Z"/></svg>
          </summary>
          <div class="theme-options" role="group" aria-label="${label('theme')}">
            <button type="button" data-theme-choice="light" aria-pressed="false"><span class="theme-option-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"/></svg></span>${label('light')}<span class="theme-check" aria-hidden="true">✓</span></button>
            <button type="button" data-theme-choice="dark" aria-pressed="false"><span class="theme-option-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.2 15.1A8.4 8.4 0 0 1 8.9 3.8 8.5 8.5 0 1 0 20.2 15.1Z"/></svg></span>${label('dark')}<span class="theme-check" aria-hidden="true">✓</span></button>
            <button type="button" data-theme-choice="system" aria-pressed="true"><span class="theme-option-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></span>${label('system')}<span class="theme-check" aria-hidden="true">✓</span></button>
            <div class="theme-options-divider" aria-hidden="true"></div>
            <span class="accent-options-label">${label('accentTheme')}</span>
            <div class="accent-options" role="group" aria-label="${label('accentTheme')}">
              <button type="button" data-accent-choice="neutral" aria-label="${label('neutralAccent')}" title="${label('neutralAccent')}" aria-pressed="true"><span class="accent-swatch is-neutral" aria-hidden="true"></span><span class="theme-check" aria-hidden="true">✓</span></button>
              <button type="button" data-accent-choice="blue" aria-label="${label('blueAccent')}" title="${label('blueAccent')}" aria-pressed="false"><span class="accent-swatch is-blue" aria-hidden="true"></span><span class="theme-check" aria-hidden="true">✓</span></button>
              <button type="button" data-accent-choice="forest" aria-label="${label('forestAccent')}" title="${label('forestAccent')}" aria-pressed="false"><span class="accent-swatch is-forest" aria-hidden="true"></span><span class="theme-check" aria-hidden="true">✓</span></button>
              <button type="button" data-accent-choice="violet" aria-label="${label('violetAccent')}" title="${label('violetAccent')}" aria-pressed="false"><span class="accent-swatch is-violet" aria-hidden="true"></span><span class="theme-check" aria-hidden="true">✓</span></button>
            </div>
          </div>
        </details>
        <details class="menu-picker language-picker" id="language-picker">
          <summary aria-label="${label('language')}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6.5h14M5 17.5h14"/></svg><span data-menu-current>${locale === 'en' ? 'English' : '简体中文'}</span><svg class="menu-caret" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></summary>
          <div class="menu-options" role="menu" aria-label="${label('language')}">
            <button type="button" role="menuitemradio" aria-checked="${locale === 'zh-CN' ? 'true' : 'false'}" data-language-choice="zh-CN" data-menu-label="简体中文"><span>简体中文</span><span class="menu-check" aria-hidden="true">✓</span></button>
            <button type="button" role="menuitemradio" aria-checked="${locale === 'en' ? 'true' : 'false'}" data-language-choice="en" data-menu-label="English"><span>English</span><span class="menu-check" aria-hidden="true">✓</span></button>
          </div>
        </details>
      </div>
    </div></header>`;
  }
  function footerHtml({ locale = 'zh-CN', homePath = localPath('/', locale) } = {}) {
    return `<footer class="footer"><a class="footer-brand" href="${homePath}">DevTrends <span>↗</span></a><p>${t(locale, 'footer')}</p></footer>`;
  }
  return { titleFallback, withTitleFallback, origin, DETAIL_SUMMARY_MIN, messages, topbarHtml, footerHtml, categories, taxonomyFacets, taxonomyParents, taxonomyVersion, languageFacets, normalizeTaxonomy, taxonomyHasValues, facetLabel, facetParent, facetChildren, facetAncestors, facetDescendants, facetLineage, facetPathLabel, itemLanguages, inferTaxonomy, itemTaxonomy, taxonomyTagEntries, taxonomyTags, visibleTagEntries, tagHtml, isCategoryId, t, escapeHtml, json, localPath, sourceName, sourceInfo, chipFilterMeta, chipFilterHtml, fitChipCount, safeUrl, managedImage, localImage, localImages, itemMark, markClass, hotlinkable, galleryHtml, mediaEntries, sameImageAsMark, repository, itemId, isClipped, canStickSidebar, visibleTags, summary, displayTitle, stripTitleLabel, reportItems, itemCategory, itemCategories, metric, compact, dateLabel, trackedUrl, itemLinks, icon, renderItem, renderSwipeItem, boundedIndex, swipeStep, CARDS_STACK_DEPTH, swipeCommitDistance, swipeFlicked, swipeStackGeometry, swipeDeck, cardsProgressKey, readCardsProgress, writeCardsProgress };
});
