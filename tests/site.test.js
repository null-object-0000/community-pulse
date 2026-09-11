const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const D = require('../web/shared.js');
const { buildProjects, projectPage } = require('../scripts/projects.js');
const { applyEnhancedMarkdown } = require('../scripts/enhanced-report.js');
const { metadataComment, renderLocalizedMarkdown, extractItems, validateLocalization } = require('../.agents/skills/community-pulse/scripts/enhance.js');
const report = (date, sources) => ({ date, results: sources.map(([sourceId, items]) => ({ sourceId, sourceName: sourceId, items })) });

test('repository identities normalize case, trailing slash, query, and .git without colliding owner/repo pairs', () => {
  for (const url of ['https://github.com/Owner/Repo', 'http://www.github.com/OWNER/repo.git/?tab=readme#about']) assert.equal(D.repository({ githubUrl: url }).key, 'owner/repo');
  assert.notEqual(D.repository({ url: 'https://github.com/a-b/c' }).path, D.repository({ url: 'https://github.com/a/b-c' }).path);
  for (const url of ['https://github.com/owner', 'https://github.com/owner/repo/issues/1', 'https://github.com/owner/repo/blob/main/README.md', 'https://github.com/topics/python', 'https://github.com/orgs/openai', 'https://github.com.evil.test/a/b', 'javascript:alert(1)', 'https://evil.test/a/b', 'https://github.com/a/%2e%2e']) assert.equal(D.repository({ githubUrl: url }), null, url);
  assert.equal(D.repository({ githubUrl: 'https://github.com/owner/repo/issues/1', url: 'https://github.com/other/valid' }).key, 'other/valid');
});

test('cross-source and cross-date occurrences become one project with unique discovery days and newest metadata', () => {
  const old = report('2026-01-01', [['old', [{ title: 'old', githubUrl: 'https://github.com/Owner/Repo.git', github: { stars: 9 }, summary: '旧摘要' }]]]);
  const recent = report('2026-09-09', [['one', [{ title: 'new', githubUrl: 'https://github.com/owner/repo', github: { stars: 20, snapshotDate: '2026-09-09' }, summary: '新摘要' }]], ['two', [{ title: 'same', githubUrl: 'https://github.com/OWNER/REPO/' }]], ['product', [{ title: 'website', url: 'https://example.org' }]]]);
  const projects = buildProjects([old, recent]);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].firstSeen, '2026-01-01'); assert.equal(projects[0].lastSeen, '2026-09-09');
  assert.equal(projects[0].observations.length, 2); assert.equal(projects[0].observations[0].sources.length, 2);
  assert.equal(projects[0].item.github.stars, 20);
  assert.equal(recent.results[2].items[0].projectPath, undefined);
  assert.equal(D.favoriteId(old.results[0].items[0]), D.favoriteId(recent.results[0].items[0]));
});

test('final summaries override raw and preserve metrics', () => {
  const raw = report('2026-09-09', [['Feed', [{ title: 'Repo', author: 'Author', summary: 'raw', metrics: { stars: 12 } }]]]);
  const enhanced = applyEnhancedMarkdown(raw, '## Feed（1 条）\n### Repo 👤 Author\n> 最终摘要', '2026-09-09');
  assert.equal(enhanced.presentation.summarySource, 'llm-final');
  assert.equal(enhanced.results[0].items[0].summary, '最终摘要');
  assert.equal(enhanced.results[0].items[0].metrics.stars, 12);
  assert.equal(raw.results[0].items[0].summary, 'raw');
});

test('bilingual enhancement carries English titles and summaries through hidden final metadata', () => {
  const rawMarkdown = '## Feed（1 条）\n\n### 中文工具\n> 一个帮助开发者整理数据的工具。\n';
  const items = extractItems(rawMarkdown);
  const localized = { schemaVersion: 2, titleEn: 'Developer Data Organizer', summaryZh: '一个帮助开发者整理数据的工具。', summaryEn: 'A tool that helps developers organize data.', primaryCategory: 'developer-tools' };
  const finalMarkdown = renderLocalizedMarkdown(rawMarkdown, items, new Map([[items[0].idx, localized]]));
  assert.ok(finalMarkdown.includes(metadataComment(localized)));
  const enhanced = applyEnhancedMarkdown(report('2026-09-09', [['Feed', [{ title: '中文工具', summary: 'raw' }]]]), finalMarkdown, '2026-09-09');
  const item = enhanced.results[0].items[0];
  assert.equal(item.summaryZh, localized.summaryZh);
  assert.equal(item.summaryEn, localized.summaryEn);
  assert.equal(item.primaryCategory, 'developer-tools');
  assert.equal(D.displayTitle(item, 'en'), localized.titleEn);
  assert.equal(D.displayTitle(item, 'zh-CN'), '中文工具');
  assert.equal(D.summary(item, 'en').original, false);
});

test('preset categories provide one stable primary category and reject unknown LLM output', () => {
  assert.deepEqual(D.categories.map(category => category.id), ['ai', 'developer-tools', 'data-infrastructure', 'design-media', 'productivity-collaboration', 'business-growth', 'learning-research', 'lifestyle-entertainment', 'other']);
  assert.equal(D.itemCategory({ primaryCategory: 'developer-tools', title: 'AI framework' }), 'developer-tools');
  assert.deepEqual(D.itemCategories({ title: 'A terminal and code editor for developers' }), ['developer-tools']);
  assert.equal(D.itemCategory({ title: 'A quiet music player' }), 'design-media');
  const item = { title: 'Data Tool', heading: 'Data Tool', desc: 'A database monitoring tool.', section: 'Feed' };
  assert.equal(validateLocalization({ summaryZh: '数据库监控工具。', summaryEn: item.desc, primaryCategory: 'data-infrastructure' }, item).primaryCategory, 'data-infrastructure');
  assert.throws(() => validateLocalization({ summaryZh: '数据库监控工具。', summaryEn: item.desc, primaryCategory: 'random' }, item), /primaryCategory/);
});

test('known data sources expose safe destination links and real website logos', () => {
  for (const sourceId of ['vibecafe', 'chinese-indie-dev', 'weekly-issues', 'weekly-issue', 'hellogithub-issues', 'hellogithub-issue', 'github-trending', 'github-trending-cn', 'producthunt']) {
    const source = D.sourceInfo({ sourceId });
    assert.ok(source, sourceId);
    assert.ok(D.safeUrl(source.url), `${sourceId} URL`);
    assert.match(source.logo, /^\/source-[a-z]+\.svg$/, `${sourceId} logo`);
  }
  assert.equal(D.sourceInfo({ sourceId: 'unknown-source' }), null);
});

test('filter chips carry counts, disable empty filters, and always offer a mobile select', () => {
  const options = [
    { id: 'all', label: '全部', count: 12, active: true },
    { id: 'ai', label: 'AI 与智能体', count: 9, active: false },
    { id: 'other', label: '其他', count: 0, active: false },
  ];
  const html = D.chipFilterHtml('category', options, 'zh-CN');
  assert.ok(html.includes('class="chip-row"'));
  assert.ok(html.includes('data-more-label="更多分类"'));
  assert.ok(html.includes('id="category-chips-menu"'));
  assert.ok(html.includes('id="category-select"'));
  assert.ok(/data-category="all"[^>]*aria-pressed="true"/.test(html));
  assert.ok(/data-category="other"[^>]*disabled/.test(html));
  assert.ok(html.includes('<option value="other" disabled>其他 (0)</option>'));
  assert.ok(html.includes('<option value="all" selected>全部 (12)</option>'));
  // An empty filter stays selectable when it is the active one, otherwise the state is unreachable.
  assert.ok(!/data-category="other"[^>]*disabled/.test(D.chipFilterHtml('category', [{ ...options[2], active: true }], 'zh-CN')));
  const source = D.chipFilterMeta('source', 'en');
  assert.equal(source.containerId, 'source-chips');
  assert.equal(source.selectId, 'source-select');
  assert.equal(source.all, 'All');
  assert.ok(D.chipFilterHtml('source', [{ id: 'all', label: 'All', count: 3, active: true }], 'en').includes('More sources'));
});

test('built pages ship one collapsed chip row per mode with no horizontal scroller', () => {
  const dist = path.join(__dirname, '../dist');
  for (const file of ['index.html', 'en/index.html', 'reports/2026-09-10/index.html', 'en/reports/2026-09-10/index.html']) {
    const html = fs.readFileSync(path.join(dist, file), 'utf8');
    assert.equal((html.match(/class="chip-filter"/g) || []).length, 1, file);
    assert.ok(html.includes('class="chip-more"'), file);
    assert.ok(html.includes('class="chip-select"'), file);
    assert.ok(html.includes('<noscript><style>.chip-row { flex-wrap: wrap; overflow: visible; }</style></noscript>'), file);
    assert.ok(!html.includes('id="view-toggle"'), file);
    assert.equal((html.match(/class="view-switch"/g) || []).length, 1, file);
  }
  const home = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.ok(home.includes('data-mode="category"'));
  assert.equal((home.match(/data-category="/g) || []).length, D.categories.length + 1);
  const report = fs.readFileSync(path.join(dist, 'reports/2026-09-10/index.html'), 'utf8');
  assert.ok(report.includes('data-mode="source"'));
  const styles = fs.readFileSync(path.join(dist, 'styles.css'), 'utf8');
  assert.ok(/\.chip-row \{[^}]*flex-wrap: nowrap[^}]*overflow: hidden/.test(styles));
  assert.ok(!styles.includes('.source-chips'));
});

test('chip row keeps only the leading run that fits and never collapses entirely', () => {
  // budget = 400 - 100 = 300: 70, then +8+110, then +8+100 = 296 fits; the 130 chip does not.
  assert.equal(D.fitChipCount([70, 110, 100, 130], 400, 100, 8), 3);
  assert.equal(D.fitChipCount([70, 110, 100], 400, 0, 8), 3);
  assert.equal(D.fitChipCount([70, 110, 100, 130], 200, 0, 8), 2);
  // A single chip wider than the row still stays visible rather than leaving a bare trigger.
  assert.equal(D.fitChipCount([500], 100, 0, 8), 1);
  assert.equal(D.fitChipCount([70], 20, 40, 8), 1);
  assert.equal(D.fitChipCount([], 400, 0, 8), 0);
});

test('language selection uses translated summaries and explicitly labels fallback originals', () => {
  assert.equal(D.summary({ summary: '中文介绍', summaryEn: 'English translation' }, 'en').text, 'English translation');
  assert.equal(D.summary({ summary: '中文介绍' }, 'en').original, true);
  assert.equal(D.summary({ summary: '中文介绍', github: { description: 'English description' } }, 'en').original, false);
  assert.equal(D.summary({ summary: 'English description' }, 'zh-CN').original, true);
  assert.equal(D.displayTitle({ title: '中文名称', titleEn: 'English Name' }, 'en'), 'English Name');
  assert.deepEqual(Object.keys(D.messages.en).sort(), Object.keys(D.messages['zh-CN']).sort());
});

test('untrusted source text and URL protocols cannot inject markup or script', () => {
  const item = { title: '<script>alert(1)</script>', summary: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', sourceName: '<svg onload=x>' };
  const html = D.renderItem(item, 'en');
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img')); assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('&lt;script&gt;'));
  const project = buildProjects([report('2026-09-09', [['feed', [{ ...item, githubUrl: 'https://github.com/test/repo', summary: '</script><script>alert(1)</script>' }]]])])[0];
  const rendered = projectPage(project, 'en');
  assert.ok(!rendered.includes('</script><script>alert(1)</script>'));
  const data = JSON.parse(rendered.match(/<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.projectItem.summary, project.item.summary);
});

test('saved theme applies before rendering, reacts to system changes, and tolerates blocked storage', () => {
  function environment(saved, blocked = false) {
    let change; const attrs = {};
    const document = { documentElement: { dataset: {}, style: {} }, querySelector: () => ({ setAttribute: (k, v) => { attrs[k] = v; } }) };
    const media = { matches: true, addEventListener: (_, callback) => { change = callback; } };
    const context = { document, localStorage: { getItem() { if (blocked) throw Error('blocked'); return saved; }, setItem() { if (blocked) throw Error('blocked'); } }, window: { matchMedia: () => media } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/theme.js'), 'utf8'), context);
    return { document, media, change: () => change(), theme: context.window.DevTrendsTheme, attrs };
  }
  const env = environment('light'); assert.equal(env.document.documentElement.dataset.theme, 'light');
  env.theme.set('system'); assert.equal(env.document.documentElement.dataset.theme, 'dark');
  env.media.matches = false; env.change(); assert.equal(env.document.documentElement.dataset.theme, 'light');
  assert.equal(environment(null, true).document.documentElement.dataset.theme, 'dark');
});

test('every emitted project, report, and sitemap entry has a real static page and canonical language URLs', () => {
  const dist = path.join(__dirname, '../dist');
  const index = JSON.parse(fs.readFileSync(path.join(dist, 'data/index.json')));
  const projects = JSON.parse(fs.readFileSync(path.join(dist, 'data/projects.json')));
  assert.equal(Object.keys(projects).length, index.projectCount); assert.ok(index.projectCount > 0);
  const sitemap = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8');
  const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(!sitemap.includes('/favorites/'));
  for (const url of urls) {
    assert.ok(url.startsWith(D.origin + '/'));
    const route = url.slice(D.origin.length);
    const html = fs.readFileSync(path.join(dist, route, 'index.html'), 'utf8');
    assert.ok(html.includes(`<link rel="canonical" href="${url}"`), url);
    assert.ok(html.includes(`<html lang="${route.startsWith('/en/') ? 'en' : 'zh-CN'}">`), url);
    assert.ok(!html.includes('style-select'), url);
    const data = JSON.parse(html.match(/<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.ok(data.locale);
    if (route.includes('/projects/')) {
      assert.ok(html.includes('SoftwareSourceCode')); assert.ok(html.includes('BreadcrumbList'));
      const repo = D.repository(data.projectItem); assert.ok(repo, url);
      assert.equal(repo.path, route.replace(/^\/en(?=\/)/, ''));
    }
  }
  for (const date of index.dates) {
    const data = JSON.parse(fs.readFileSync(path.join(dist, `data/reports/${date}.json`)));
    for (const item of D.reportItems(data)) {
      assert.ok(D.isCategoryId(D.itemCategory(item)), `${date}: ${item.title}`);
      assert.equal(D.itemCategories(item).length, 1, `${date}: ${item.title}`);
      if (D.repository(item)) assert.equal(item.projectPath, projects[D.repository(item).key]);
      else assert.equal(item.projectPath, undefined);
    }
    if (fs.existsSync(path.join(__dirname, `../知识/大家都在做什么/final/${date}.md`))) {
      assert.ok(['llm-final', 'mixed'].includes(data.presentation.summarySource), date);
      assert.equal(data.presentation.enhancedItemCount, D.reportItems(data).filter(item => item.summarySource === 'llm-final').length);
      if (date === index.latest) assert.equal(data.presentation.summarySource, 'llm-final');
    }
  }
});
