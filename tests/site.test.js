const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const D = require('../web/shared.js');
const { buildProjects, projectPage } = require('../scripts/projects.js');
const { applyEnhancedMarkdown } = require('../scripts/enhanced-report.js');
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

test('language selection uses translated summaries and explicitly labels fallback originals', () => {
  assert.equal(D.summary({ summary: '中文介绍', summaryEn: 'English translation' }, 'en').text, 'English translation');
  assert.equal(D.summary({ summary: '中文介绍' }, 'en').original, true);
  assert.equal(D.summary({ summary: '中文介绍', github: { description: 'English description' } }, 'en').original, false);
  assert.equal(D.summary({ summary: 'English description' }, 'zh-CN').original, true);
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
