const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../web/shared.js');
const { buildTrends, buildEntityIndex, buildClusterLibrary, trendIdentity, trendPath } = require('../scripts/trends.js');
const R = require('../scripts/render-site.js');

const item = (title, summary, sourceId, url, taxonomy, language) => ({ title, summary, sourceId, url, taxonomy, ...(language ? { github: { language } } : {}) });
const report = (date, items) => ({ date, results: [{ sourceId: 'feed', items }] });

test('controlled facets distinguish use case, agent role, form, platform, and integration', () => {
  const novel = D.inferTaxonomy({ title: 'oh-story-claudecode', summary: 'Claude Code skills for long-form novel and fiction writing.' });
  assert.ok(novel.useCases.includes('novel-writing'));
  assert.ok(novel.agentRoles.includes('capability-extension'));
  assert.ok(novel.productForms.includes('skill-plugin'));
  assert.ok(novel.integrations.includes('claude-code'));

  const deck = D.inferTaxonomy({ title: 'Deck', summary: 'A native macOS command center to manage and monitor multiple coding agent terminal sessions.' });
  assert.ok(deck.agentRoles.includes('orchestration-control'));
  assert.ok(deck.agentRoles.includes('observability'));
  assert.ok(deck.platforms.includes('macos'));

  const nerfMeter = D.inferTaxonomy({ title: 'Nerf Meter', summary: 'A browser-based live GPT and Claude status meter showing whether models are nerfed or recovered.', websiteUrl: 'https://nerfmeter.com/' });
  assert.ok(nerfMeter.agentRoles.includes('observability'));
  assert.ok(nerfMeter.productForms.includes('web-app'));

  const prox = D.inferTaxonomy({ title: 'prox', summary: 'A Linux terminal proxy environment manager CLI.' });
  assert.ok(prox.useCases.includes('data-operations'));
  assert.ok(prox.productForms.includes('cli'));
  assert.ok(prox.platforms.includes('linux'));
  assert.deepEqual(prox.agentRoles, []);

  const travel = D.inferTaxonomy({ title: 'RoadTrip', summary: '检查自驾行程、景点开放时间和酒店预订的旅行规划助手' });
  assert.ok(travel.useCases.includes('travel-mobility'));
  assert.ok(!travel.useCases.includes('lifestyle-entertainment'));
  const historicalTravel = D.itemTaxonomy({ title: 'RoamVista', summary: '免注册云旅行：转动交互式地球，从 120 座城市中选择目的地', taxonomy: { useCases: ['lifestyle-entertainment'] } });
  assert.deepEqual(historicalTravel.useCases, ['travel-mobility']);
  for (const falsePositive of [
    { title: 'CVS Preflight', summary: 'Validate files before deployment' },
    { title: 'Nomad scheduler', summary: 'Cluster workload orchestration' },
    { title: 'Passport.js', summary: 'Authentication middleware for Node.js' },
    { title: 'OrcaReplay', summary: 'Time travel for AI agents. Record, replay, fork, and debug any agent run.' },
  ]) assert.ok(!D.inferTaxonomy(falsePositive).useCases.includes('travel-mobility'), falsePositive.title);

  assert.deepEqual(D.normalizeTaxonomy({ useCases: ['novel-writing', 'unknown'], platforms: ['web', 'web'] }).useCases, ['novel-writing']);
});

test('trend model counts unique first-seen products and applies project/source thresholds', () => {
  const explicit = { useCases: ['novel-writing'], agentRoles: ['vertical-agent'], productForms: ['web-app'], platforms: ['web'], integrations: [] };
  const reports = [
    report('2026-08-12', [item('Old novel tool', 'old', 'archive', 'https://old.example/', explicit, 'TypeScript')]),
    report('2026-09-08', [item('Story One', 'one', 'vibecafe', 'https://one.example/?utm_source=devtrends', explicit, 'TypeScript')]),
    report('2026-09-09', [item('Story One duplicate', 'one again', 'weekly-issues', 'https://one.example/?utm_campaign=daily', explicit, 'TypeScript')]),
    report('2026-09-10', [item('Story Two', 'two', 'weekly-issues', 'https://two.example/', explicit, 'TypeScript')]),
    report('2026-09-12', [item('Story Three', 'three', 'github-trending', 'https://three.example/', explicit, 'TypeScript')]),
  ];
  const model = buildTrends(reports, '2026-09-13');
  const useCase = model.clusters.find(cluster => cluster.key === 'useCases:novel-writing');
  assert.ok(useCase);
  assert.equal(useCase.recentCount, 3, 'tracking parameters and repeat appearances must not create another project');
  assert.equal(useCase.baselineCount, 1);
  assert.ok(useCase.sourceCount >= 2);
  assert.equal(trendIdentity(reports[1].results[0].items[0]), trendIdentity(reports[2].results[0].items[0]));
  assert.equal(model.recent.start, '2026-09-07');
  assert.equal(model.baseline.start, '2026-08-10');
  assert.equal(model.schemaVersion, 4);
  assert.equal(useCase.weekly.length, 12);
  assert.equal(useCase.weekly.at(-1).count, 3, 'the newest weekly bucket shows the three recent projects');
  assert.equal(useCase.weekly.reduce((total, point) => total + point.count, 0), 4, 'repeat appearances stay deduplicated in the timeline');
  assert.equal(useCase.path, '/trends/use-cases/novel-writing/');
  assert.equal(useCase.projects.length, useCase.recentCount);
  assert.equal(trendPath('agentRoles', 'observability'), '/trends/agent-roles/observability/');
  // The language lens is suppressed here only because the standalone fixture has no repository
  // snapshots on disk, i.e. the layer under-covers the window (covered < days). The comparisons
  // themselves are exercised by the dedicated coverage test below.
  const language = model.clusters.find(cluster => cluster.key === 'languages:typescript');
  if (model.languages.complete) {
    assert.ok(language.recentCount >= 3);
    assert.ok(language.baselineCount >= 1);
    assert.equal(language.path, '/trends/programming-languages/typescript/');
  } else {
    assert.equal(language, undefined, 'an under-covered snapshot must not publish language clusters');
    assert.ok(model.languages.baseline.covered < model.languages.baseline.eligible,
      'eligible days are those carrying GitHub projects');
  }
});

test('sub-topics stay narrowest on an item and roll up into their parent topic', () => {
  // novel-writing is a second-level topic of content-creation. An item is stored with the narrowest id
  // only, and every reader re-derives the parent, so one project is never counted twice inside a facet.
  assert.equal(D.facetParent('useCases', 'novel-writing'), 'content-creation');
  assert.equal(D.facetParent('useCases', 'content-creation'), null);
  assert.deepEqual(D.facetChildren('useCases', 'content-creation'), ['novel-writing']);
  assert.deepEqual(D.facetAncestors('useCases', 'novel-writing'), ['content-creation']);
  assert.deepEqual(D.facetDescendants('useCases', 'content-creation'), ['content-creation', 'novel-writing']);
  assert.deepEqual(D.facetDescendants('useCases', 'novel-writing'), ['novel-writing']);
  assert.deepEqual(D.facetDescendants('useCases', 'travel-mobility'), ['travel-mobility']);
  assert.equal(D.facetPathLabel('useCases', 'novel-writing', 'zh-CN'), '内容创作 › 小说创作');
  assert.equal(D.facetPathLabel('useCases', 'novel-writing', 'en'), 'Content creation › Novel writing');
  assert.equal(D.facetPathLabel('useCases', 'travel-mobility', 'zh-CN'), '旅行与出行');
  // An explicit parent + child pair collapses to the child, whatever order it arrives in.
  assert.deepEqual(D.normalizeTaxonomy({ useCases: ['content-creation', 'novel-writing'] }).useCases, ['novel-writing']);
  assert.deepEqual(D.normalizeTaxonomy({ useCases: ['novel-writing', 'content-creation'] }).useCases, ['novel-writing']);
  // Historical rules do the same: a title matching both patterns carries only the sub-topic.
  assert.deepEqual(D.inferTaxonomy({ title: 'Novel Studio', summary: '小说创作与写作助手' }).useCases, ['novel-writing']);
  // The chip stays short; the hierarchy rides along for tooltips and for the category pages.
  assert.deepEqual(D.taxonomyTagEntries({ taxonomy: { useCases: ['novel-writing'] } }, 'zh-CN').map(entry => [entry.label, entry.path]),
    [['小说创作', '内容创作 › 小说创作']]);
  const html = D.renderItem({ title: 'Novel Studio', sourceId: 'weekly-issues', taxonomy: { useCases: ['novel-writing'] } }, 'zh-CN');
  assert.match(html, /data-tag-label="小说创作" data-tag-path="内容创作 › 小说创作"/);
  assert.match(html, /title="DevTrends 归类 · 内容创作 › 小说创作"/);
});

test('a parent topic owns its sub-topics in counts, ranges, library, and weekly series', () => {
  const content = { useCases: ['content-creation'], agentRoles: [], productForms: [], platforms: [], integrations: [] };
  const novel = { useCases: ['novel-writing'], agentRoles: [], productForms: [], platforms: [], integrations: [] };
  const reports = [
    report('2026-08-12', [item('Old copy tool', 'old', 'archive', 'https://old-copy.example/', content)]),
    report('2026-09-08', [item('Copy One', 'copy', 'vibecafe', 'https://copy-one.example/', content)]),
    report('2026-09-09', [item('Copy Two', 'copy', 'weekly-issues', 'https://copy-two.example/', content)]),
    report('2026-09-10', [item('Novel One', 'novel', 'weekly-issues', 'https://novel-one.example/', novel)]),
    report('2026-09-11', [item('Novel Two', 'novel', 'producthunt', 'https://novel-two.example/', novel)]),
    report('2026-09-12', [item('Novel Three', 'novel', 'github-trending', 'https://novel-three.example/', novel)]),
  ];
  const entities = buildEntityIndex(reports);
  const model = buildTrends(reports, '2026-09-13', { entities });
  const parent = model.clusters.find(cluster => cluster.key === 'useCases:content-creation');
  const child = model.clusters.find(cluster => cluster.key === 'useCases:novel-writing');
  assert.ok(parent, 'the parent topic reaches the thresholds on its own hits plus its sub-topic');
  assert.ok(child, 'a sub-topic is published as its own cluster too');
  assert.equal(child.recentCount, 3);
  assert.equal(child.baselineCount, 0);
  assert.equal(parent.recentCount, 5, 'two direct hits plus the three sub-topic projects');
  assert.equal(parent.baselineCount, 1);
  assert.equal(parent.ranges.recent.count, 5);
  assert.equal(parent.ranges.all.count, 6);
  // The sparkline must agree with the heading rather than quietly dropping the sub-topic.
  assert.equal(child.weekly.reduce((total, point) => total + point.count, 0), 3);
  assert.equal(parent.weekly.reduce((total, point) => total + point.count, 0), 6);
  // Browsing the parent shows both levels; browsing the child stays narrow.
  const parentLibrary = buildClusterLibrary(entities, parent, model.latest);
  const childLibrary = buildClusterLibrary(entities, child, model.latest);
  assert.equal(parentLibrary.projects.length, 6);
  assert.equal(childLibrary.projects.length, 3);
  assert.deepEqual(parentLibrary.projects.map(row => D.itemTaxonomy(row).useCases[0]).sort(),
    ['content-creation', 'content-creation', 'content-creation', 'novel-writing', 'novel-writing', 'novel-writing']);
});

test('the trends page and category pages state the parent/sub-topic relationship', () => {
  const content = { useCases: ['content-creation'], agentRoles: [], productForms: [], platforms: [], integrations: [] };
  const novel = { useCases: ['novel-writing'], agentRoles: [], productForms: [], platforms: [], integrations: [] };
  const reports = [
    report('2026-09-08', [item('Copy One', 'copy', 'vibecafe', 'https://copy-one.example/', content)]),
    report('2026-09-09', [item('Copy Two', 'copy', 'weekly-issues', 'https://copy-two.example/', content)]),
    report('2026-09-10', [item('Novel One', 'novel', 'weekly-issues', 'https://novel-one.example/', novel)]),
    report('2026-09-11', [item('Novel Two', 'novel', 'producthunt', 'https://novel-two.example/', novel)]),
    report('2026-09-12', [item('Novel Three', 'novel', 'github-trending', 'https://novel-three.example/', novel)]),
  ];
  const model = buildTrends(reports, '2026-09-13', { entities: buildEntityIndex(reports) });
  const parent = model.clusters.find(cluster => cluster.key === 'useCases:content-creation');
  const child = model.clusters.find(cluster => cluster.key === 'useCases:novel-writing');
  const page = R.trendsPage(model, 'zh-CN');
  // The child card names its parent; the parent card links the published sub-topic with its count.
  assert.match(page, /业务场景 · 内容创作的子主题/);
  assert.match(page, /class="trend-card is-subtopic"/);
  assert.match(page, /class="trend-subtopics"><span>子主题<\/span><a href="\/trends\/use-cases\/novel-writing\/">小说创作<em>3<\/em><\/a>/);
  assert.match(page, /"name":"内容创作 › 小说创作"/, 'structured data keeps the path');
  const en = R.trendsPage(model, 'en');
  assert.match(en, /Sub-topic of Content creation/);
  assert.match(en, /href="\/en\/trends\/use-cases\/novel-writing\/">Novel writing<em>3<\/em>/);
  const parentPage = R.trendClusterPage(model, parent, 'zh-CN');
  assert.match(parentPage, /<h1>业务场景 · 内容创作<\/h1>/);
  assert.match(parentPage, /trend-subtopics-page[\s\S]*?href="\/trends\/use-cases\/novel-writing\/"/);
  const childPage = R.trendClusterPage(model, child, 'zh-CN');
  assert.match(childPage, /<h1>业务场景 · 内容创作 › 小说创作<\/h1>/);
  // The trail is a real link, and the structured breadcrumb grows a level with it.
  assert.match(childPage, /面包屑导航"><a href="\/trends\/">大家正在集中做什么<\/a><span>\/<\/span><a href="\/trends\/use-cases\/content-creation\/">内容创作<\/a><span>\/<\/span><span>小说创作<\/span>/);
  assert.match(childPage, /"position":3,"name":"小说创作","item":"https:\/\/devtrends.site\/trends\/use-cases\/novel-writing\/"/);
  assert.match(childPage, /<title>业务场景 · 内容创作 › 小说创作 \| DevTrends<\/title>/);
});

test('programming languages are deterministic families with stable routes', () => {  assert.deepEqual(D.itemLanguages({ github: { language: 'TypeScript' } }), ['typescript']);
  assert.deepEqual(D.itemLanguages({ language: 'Kotlin' }), ['java-kotlin']);
  assert.deepEqual(D.itemLanguages({ github: { language: 'C++' } }), ['c-cpp']);
  assert.deepEqual(D.itemLanguages({ github: { language: 'HTML' } }), []);
  assert.equal(D.facetLabel('languages', 'java-kotlin', 'zh-CN'), 'Java / Kotlin');
  assert.equal(trendPath('languages', 'typescript'), '/trends/programming-languages/typescript/');
});

test('an under-covered language snapshot suppresses the language lens instead of printing a fake trend', () => {
  // Language membership comes only from the github-repositories snapshot. When that layer covers only
  // part of the comparison window, a language's "growth" measures the data arriving rather than
  // adoption — inventing figures like +454% / +1700%. The lens must disappear rather than mislead.
  const explicit = { useCases: ['novel-writing'], agentRoles: [], productForms: [], platforms: [], integrations: [] };
  const reports = [
    report('2026-08-12', [item('Old novel tool', 'old', 'archive', 'https://old.example/', explicit, 'TypeScript')]),
    report('2026-09-08', [item('Story One', 'one', 'vibecafe', 'https://one.example/', explicit, 'TypeScript')]),
    report('2026-09-10', [item('Story Two', 'two', 'weekly-issues', 'https://two.example/', explicit, 'TypeScript')]),
    report('2026-09-12', [item('Story Three', 'three', 'github-trending', 'https://three.example/', explicit, 'TypeScript')]),
  ];
  // A synthetic under-covered layer: the shape is what matters, the dates only have to line up
  // with the fixture reports. Since the Trending backfill real coverage is close to the whole
  // window, so this no longer mirrors production — it guards the suppression path.
  const partial = {
    recent: { start: "2026-09-07", end: "2026-09-13", days: 7, eligible: 7, covered: 6 },
    baseline: { start: "2026-08-10", end: "2026-09-06", days: 28, eligible: 7, covered: 4 },
    source: 'github-repositories', sourceStart: '2026-06-22', complete: false,
  };
  const suppressed = buildTrends(reports, '2026-09-13', { languages: partial });
  assert.equal(suppressed.languages.complete, false);
  assert.ok(!suppressed.clusters.some(cluster => cluster.type === 'languages'),
    'no language cluster may be published while the snapshot under-covers the window');
  // The non-language lenses are unaffected: they do not depend on the snapshot layer.
  assert.ok(suppressed.clusters.some(cluster => cluster.key === 'useCases:novel-writing'));

  // Once the layer covers the whole window the lens returns by itself — no code change needed.
  const complete = { ...partial, baseline: { ...partial.baseline, covered: 7 }, recent: { ...partial.recent, covered: 7 }, complete: true };
  const restored = buildTrends(reports, '2026-09-13', { languages: complete });
  assert.ok(restored.clusters.some(cluster => cluster.key === 'languages:typescript'));
});
