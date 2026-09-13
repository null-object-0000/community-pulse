const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyTrendingPolicy,
  dedupe,
  itemIdentity,
  shiftDate,
} = require('../.agents/skills/community-pulse/scripts/collect.js');
const R = require('../scripts/render-site.js');

const item = (repo, today = 0, extra = {}) => ({
  sourceId: extra.sourceId || 'github-trending',
  title: repo,
  url: `https://github.com/${repo}`,
  githubUrl: `https://github.com/${repo}`,
  author: repo.split('/')[0],
  externalId: `daily-${repo}`,
  metrics: { today },
  ...extra,
});

test('trending policy suppresses recently published repositories, merges regions, then truncates', () => {
  const historyReports = [{
    results: [
      { sourceId: 'github-trending', items: [item('Acme/A')] },
      { sourceId: 'github-trending-cn', items: [item('Acme/B', 0, { sourceId: 'github-trending-cn' })] },
    ],
  }];
  const results = [
    {
      sourceId: 'github-trending', sourceName: 'GitHub Trending', sourceRaw: {},
      items: [item('acme/a', 30), item('acme/b', 50), item('acme/c', 20), item('acme/d', 10)],
    },
    {
      sourceId: 'github-trending-cn', sourceName: 'GitHub 中文趋势', sourceRaw: {},
      items: [
        item('Acme/C', 18, { sourceId: 'github-trending-cn' }),
        item('Acme/E', 15, { sourceId: 'github-trending-cn' }),
        item('Acme/F', 5, { sourceId: 'github-trending-cn' }),
        item('Acme/B', 40, { sourceId: 'github-trending-cn' }),
      ],
    },
  ];

  const policy = applyTrendingPolicy(results, {
    historyReports,
    maxItemsBySource: new Map([['github-trending', 2], ['github-trending-cn', 2]]),
  });

  assert.deepEqual(results[0].items.map(x => itemIdentity(x)), ['github:acme/c', 'github:acme/d']);
  assert.deepEqual(results[1].items.map(x => itemIdentity(x)), ['github:acme/e', 'github:acme/f']);
  assert.deepEqual(results[0].items[0].__mergedSources, ['GitHub Trending', 'GitHub 中文趋势']);
  assert.equal(policy.suppressedCount, 2);
  assert.deepEqual(policy.continuedItems.map(x => itemIdentity(x)), ['github:acme/b', 'github:acme/a']);
  assert.equal(results[0].sourceRaw.outputItemCount, 2);
  assert.equal(results[0].sourceRaw.suppressedRecentCount, 2);
  assert.equal(results[1].sourceRaw.suppressedRecentCount, 0);
  assert.equal(policy.continuedItems[0].github, undefined);
  assert.equal(policy.continuedItems[0].siteLogo, undefined);
});

test('a global row below its cap may still be published from the Chinese ranking', () => {
  const results = [
    {
      sourceId: 'github-trending', sourceName: 'Global', items: [item('acme/one'), item('acme/shared')],
    },
    {
      sourceId: 'github-trending-cn', sourceName: 'Chinese', items: [item('ACME/SHARED', 1, { sourceId: 'github-trending-cn' })],
    },
  ];
  applyTrendingPolicy(results, {
    maxItemsBySource: new Map([['github-trending', 1], ['github-trending-cn', 1]]),
  });
  assert.deepEqual(results[0].items.map(x => itemIdentity(x)), ['github:acme/one']);
  assert.deepEqual(results[1].items.map(x => itemIdentity(x)), ['github:acme/shared']);
});

test('repository identity ignores case and primary-link differences during general dedupe', () => {
  const results = [
    { sourceId: 'one', sourceName: 'One', items: [item('Acme/Tool', 0, { sourceId: 'one', url: 'https://tool.example', publishedAt: '2026-09-12T00:00:00Z' })] },
    { sourceId: 'two', sourceName: 'Two', items: [item('acme/tool', 0, { sourceId: 'two', publishedAt: '2026-09-13T00:00:00Z' })] },
  ];
  const output = dedupe(results);
  assert.equal(output.flatMap(result => result.items).length, 1);
  assert.equal(output[1].items[0].__mergedCount, 2);
});

test('date shifting is UTC-stable across month boundaries', () => {
  assert.equal(shiftDate('2026-09-01', -1), '2026-08-31');
});

test('report pages keep continuation highlights collapsed outside the discovery feed', () => {
  const report = {
    results: [{ sourceId: 'github-trending', sourceName: 'GitHub Trending', items: [item('acme/new')] }],
    trendingPolicy: {
      cooldownDays: 3,
      suppressedCount: 7,
      continuedItems: [{
        ...item('acme/still-hot', 1234),
        trendingContinuation: { cooldownDays: 3, recentAppearances: 2 },
      }],
    },
  };
  const html = R.reportPage(report, '2026-09-13', 'zh-CN');
  assert.match(html, /<details class="trending-continuation">/);
  assert.match(html, /7 个仓库已在最近 3 期日报出现/);
  assert.match(html, /acme\/still-hot/);
  assert.equal((html.match(/class="feed-item"/g) || []).length, 1);
});
