const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/shared.js');
const { buildTrends, buildEntityIndex, buildClusterLibrary } = require('../scripts/trends.js');

const item = (title, summary, sourceId, url, taxonomy, language) => ({ title, summary, sourceId, url, taxonomy, ...(language ? { github: { language } } : {}) });
const report = (date, items) => ({ date, results: [{ sourceId: 'feed', items }] });
const travel = { useCases: ['travel-mobility'], agentRoles: [], productForms: ['web-app'], platforms: ['web'], integrations: [] };

test('cluster libraries cover the full archive with per-range counts', () => {
  const reports = [
    report('2026-05-10', [item('Old Trip', 'old trip planner', 'archive', 'https://old-trip.example/', travel)]),
    report('2026-09-01', [item('Trip One', 'trip one', 'vibecafe', 'https://trip-one.example/', travel)]),
    report('2026-09-06', [item('Trip Two', 'trip two', 'weekly-issues', 'https://trip-two.example/', travel)]),
    report('2026-09-12', [item('Trip Three', 'trip three', 'github-trending', 'https://trip-three.example/', travel)]),
    report('2026-09-12', [item('Trip Four', 'trip four', 'producthunt', 'https://trip-four.example/', travel)]),
    report('2026-09-13', [item('Trip Five', 'trip five', 'vibecafe', 'https://trip-five.example/', travel)]),
  ];
  const entities = buildEntityIndex(reports);
  const model = buildTrends(reports, '2026-09-13', { entities });
  const cluster = model.clusters.find(value => value.key === 'useCases:travel-mobility');
  assert.ok(cluster, 'fixture must reach the cluster thresholds');
  assert.equal(cluster.ranges.recent.count, 3);
  assert.equal(cluster.ranges['4w'].count, 5);
  assert.equal(cluster.ranges['12w'].count, 5);
  assert.equal(cluster.ranges.all.count, 6);
  assert.equal(cluster.ranges.all.sources, 5);
  assert.equal(cluster.dataPath, '/data/trends/use-cases/travel-mobility.json');
  const library = buildClusterLibrary(entities, cluster, model.latest);
  assert.equal(library.schemaVersion, 1);
  assert.equal(library.projects.length, 6);
  assert.equal(library.projects[0].trendDate, '2026-09-13');
  assert.deepEqual(library.ranges, cluster.ranges);
  // Every library row renders through the standard feed renderer with its discovery date.
  for (const row of library.projects) {
    const html = D.renderItem(row, 'zh-CN', { date: row.trendDate, showDate: true });
    assert.match(html, /class="feed-item"/);
    assert.match(html, /class="tag tag-date item-discovery-date"/);
  }
});

test('library rows carry resolved taxonomy and stay lean', () => {
  const full = { title: 'RoamVista', content: '全文内容不该进库存清单', summary: '免注册云旅行：从 120 座城市中选择目的地', sourceId: 'vibecafe', url: 'https://roam.example/', tags: ['vibecafe', 'tour'], metrics: { votes: 12 } };
  const entities = buildEntityIndex([report('2026-09-12', [full])]);
  const cluster = { type: 'useCases', id: 'travel-mobility', path: '/trends/use-cases/travel-mobility/' };
  const library = buildClusterLibrary(entities, cluster, '2026-09-13');
  assert.equal(library.projects.length, 1);
  const row = library.projects[0];
  assert.equal(row.trendDate, '2026-09-12');
  assert.equal(row.content, undefined, 'the full text is not shipped into the archive payload');
  assert.equal(row.summary, full.summary);
  assert.ok(D.itemTaxonomy(row).useCases.includes('travel-mobility'));
  assert.equal(D.displayTitle(row, 'zh-CN'), 'RoamVista');
  assert.equal(D.metric(row, ['votes', 'votesCount']), 12);
});

test('the build emits one library file per cluster and the cluster page keeps its recent SSR list', () => {
  const dist = path.join(__dirname, '../dist');
  const index = JSON.parse(fs.readFileSync(path.join(dist, 'data/index.json'), 'utf8'));
  const trends = JSON.parse(fs.readFileSync(path.join(dist, 'data/trends.json'), 'utf8'));
  assert.equal(trends.clusters.length, index.trendCount);
  for (const cluster of trends.clusters) {
    assert.ok(cluster.dataPath, cluster.key);
    assert.ok(cluster.ranges?.all, cluster.key);
    const file = path.join(dist, cluster.dataPath.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), cluster.dataPath);
    const library = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(library.id, cluster.id);
    assert.equal(library.projects.length, library.ranges.all.count);
    assert.ok(library.ranges.recent.count <= library.ranges['4w'].count, cluster.key);
    assert.ok(library.ranges['4w'].count <= library.ranges['12w'].count, cluster.key);
    assert.ok(library.ranges['12w'].count <= library.ranges.all.count, cluster.key);
    for (const row of library.projects) {
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(row.trendDate), 'library rows keep their discovery date');
      assert.equal(row.content, undefined);
    }
  }
  const travel = trends.clusters.find(cluster => cluster.key === 'useCases:travel-mobility');
  assert.ok(travel, 'travel must remain a business scene cluster');
  const page = fs.readFileSync(path.join(dist, travel.path.replace(/^\//, ''), 'index.html'), 'utf8');
  assert.match(page, /data-cluster-range/);
  assert.match(page, /data-range="recent" aria-pressed="true"/);
  assert.match(page, /data-range="4w"/);
  assert.match(page, /data-range="12w"/);
  assert.match(page, /data-range="all"/);
  assert.match(page, /id="cluster-range-stats"/);
  assert.match(page, /id="cluster-count"/);
  assert.match(page, /id="load-more"/);
  assert.equal((page.match(/class="feed-item"/g) || []).length, travel.recentCount, 'SSR stays the recent window only');
});