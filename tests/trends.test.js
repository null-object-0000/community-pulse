const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../web/shared.js');
const { buildTrends, trendIdentity, trendPath } = require('../scripts/trends.js');

const item = (title, summary, sourceId, url, taxonomy) => ({ title, summary, sourceId, url, taxonomy });
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

  assert.deepEqual(D.normalizeTaxonomy({ useCases: ['novel-writing', 'unknown'], platforms: ['web', 'web'] }).useCases, ['novel-writing']);
});

test('trend model counts unique first-seen products and applies project/source thresholds', () => {
  const explicit = { useCases: ['novel-writing'], agentRoles: ['vertical-agent'], productForms: ['web-app'], platforms: ['web'], integrations: [] };
  const reports = [
    report('2026-08-12', [item('Old novel tool', 'old', 'archive', 'https://old.example/', explicit)]),
    report('2026-09-08', [item('Story One', 'one', 'vibecafe', 'https://one.example/?utm_source=devtrends', explicit)]),
    report('2026-09-09', [item('Story One duplicate', 'one again', 'weekly-issues', 'https://one.example/?utm_campaign=daily', explicit)]),
    report('2026-09-10', [item('Story Two', 'two', 'weekly-issues', 'https://two.example/', explicit)]),
    report('2026-09-12', [item('Story Three', 'three', 'github-trending', 'https://three.example/', explicit)]),
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
  assert.equal(model.schemaVersion, 2);
  assert.equal(useCase.weekly.length, 12);
  assert.equal(useCase.weekly.at(-1).count, 3, 'the newest weekly bucket shows the three recent projects');
  assert.equal(useCase.weekly.reduce((total, point) => total + point.count, 0), 4, 'repeat appearances stay deduplicated in the timeline');
  assert.equal(useCase.path, '/trends/use-cases/novel-writing/');
  assert.equal(useCase.projects.length, useCase.recentCount);
  assert.equal(trendPath('agentRoles', 'observability'), '/trends/agent-roles/observability/');
});
