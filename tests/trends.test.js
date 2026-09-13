const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../web/shared.js');
const { buildTrends, trendIdentity, trendPath } = require('../scripts/trends.js');

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
    assert.ok(model.languages.baseline.covered < model.languages.baseline.days);
  }
});

test('programming languages are deterministic families with stable routes', () => {
  assert.deepEqual(D.itemLanguages({ github: { language: 'TypeScript' } }), ['typescript']);
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
  // 4 of 28 baseline days covered, mirroring the real layer (starts 2026-09-01).
  const partial = {
    recent: { start: '2026-09-07', end: '2026-09-13', days: 7, covered: 6 },
    baseline: { start: '2026-08-10', end: '2026-09-06', days: 28, covered: 4 },
    source: 'github-repositories', sourceStart: '2026-09-01', complete: false,
  };
  const suppressed = buildTrends(reports, '2026-09-13', { languages: partial });
  assert.equal(suppressed.languages.complete, false);
  assert.ok(!suppressed.clusters.some(cluster => cluster.type === 'languages'),
    'no language cluster may be published while the snapshot under-covers the window');
  // The non-language lenses are unaffected: they do not depend on the snapshot layer.
  assert.ok(suppressed.clusters.some(cluster => cluster.key === 'useCases:novel-writing'));

  // Once the layer covers the whole window the lens returns by itself — no code change needed.
  const complete = { ...partial, baseline: { ...partial.baseline, covered: 28 }, recent: { ...partial.recent, covered: 7 }, complete: true };
  const restored = buildTrends(reports, '2026-09-13', { languages: complete });
  assert.ok(restored.clusters.some(cluster => cluster.key === 'languages:typescript'));
});
