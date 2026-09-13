const fs = require('fs');
const path = require('path');
const D = require('../web/shared.js');

// The source-raw vault lives at the repository root; trends.js sits in scripts/.
const VAULT = path.resolve(__dirname, '..');

function dateOffset(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function trendIdentity(item) {
  const repository = D.repository(item);
  if (repository) return repository.url;
  const raw = D.safeUrl(item.websiteUrl || item.url);
  if (raw) {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
    url.hash = '';
    return url.href.replace(/\/$/, '').toLowerCase();
  }
  return `${item.sourceId || 'item'}:${item.externalId || item.title || 'untitled'}`.toLowerCase();
}

function buildWeeklySeries(entities, type, id, latest, weeks = 12) {
  const start = dateOffset(latest, -(weeks * 7 - 1));
  const buckets = Array.from({ length: weeks }, (_, index) => ({
    start: dateOffset(start, index * 7),
    end: dateOffset(start, index * 7 + 6),
    count: 0,
  }));
  const startTime = Date.parse(`${start}T00:00:00Z`);
  for (const entity of entities) {
    if (entity.firstSeen < start || entity.firstSeen > latest) continue;
    const memberships = type === 'languages' ? D.itemLanguages(entity.item) : D.itemTaxonomy(entity.item)[type];
    if (!memberships?.includes(id)) continue;
    const index = Math.floor((Date.parse(`${entity.firstSeen}T00:00:00Z`) - startTime) / 604800000);
    if (buckets[index]) buckets[index].count++;
  }
  return buckets;
}

function trendPath(type, id) {
  const segment = type === 'agentRoles' ? 'agent-roles' : type === 'useCases' ? 'use-cases' : type === 'languages' ? 'programming-languages' : null;
  return segment && /^[a-z0-9-]+$/.test(id || '') ? `/trends/${segment}/${id}/` : null;
}

// Range windows offered by the category library, in days. "recent" mirrors the trend model's
// display window (7 days); the wider ones are pure supersets computed over the same first-seen dates.
const WINDOW_DAYS = { recent: 7, '4w': 28, '12w': 84 };

function buildEntityIndex(reports) {
  const entities = new Map();
  for (const report of [...reports].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const item of D.reportItems(report)) {
      const key = trendIdentity(item);
      if (!entities.has(key)) entities.set(key, { key, firstSeen: report.date, item, sources: new Set() });
      const entity = entities.get(key);
      if (report.date === entity.firstSeen) entity.sources.add(item.sourceId || 'unknown');
      // Prefer a later, richer observation without changing the first-seen date.
      if (report.date >= entity.firstSeen && D.summary(item, 'zh-CN').text.length > D.summary(entity.item, 'zh-CN').text.length) entity.item = item;
    }
  }
  return entities;
}

function clusterMemberships(entity) {
  const taxonomy = D.itemTaxonomy(entity.item);
  return [
    ...taxonomy.useCases.map(id => ['useCases', id]),
    ...taxonomy.agentRoles.map(id => ['agentRoles', id]),
    ...D.itemLanguages(entity.item).map(id => ['languages', id]),
  ];
}

function rangeStats(list, latest) {
  const stats = {};
  for (const [id, days] of Object.entries(WINDOW_DAYS)) {
    const start = dateOffset(latest, -(days - 1));
    const members = list.filter(entity => entity.firstSeen >= start && entity.firstSeen <= latest);
    stats[id] = {
      start, end: latest, count: members.length,
      sources: new Set(members.flatMap(entity => [...entity.sources])).size,
    };
  }
  const first = list.reduce((best, entity) => entity.firstSeen < best ? entity.firstSeen : best, latest);
  stats.all = {
    start: first, end: latest, count: list.length,
    sources: new Set(list.flatMap(entity => [...entity.sources])).size,
  };
  return stats;
}

// The category library lists every first-seen product in the cluster, so it only carries the fields
// the feed renderer consumes (plus the computed taxonomy so classification matches the build exactly).
// `content` alone would multiply these files several times over for the largest categories.
const LIBRARY_FIELDS = [
  'sourceId', 'sourceName', 'externalId', 'title', 'titleZh', 'titleEn',
  'url', 'websiteUrl', 'githubUrl', 'issueUrl', 'relatedIssue', 'vibecafeUrl', 'productHuntUrl', 'projectPath',
  'author', 'summary', 'summaryZh', 'summaryEn', 'tags', 'github', 'metrics', 'language', 'lang',
  'logo', 'icon', 'siteLogo', 'image', 'images', 'imageUrls', 'primaryCategory',
];

function libraryRow(entity) {
  const row = { trendDate: entity.firstSeen };
  for (const key of LIBRARY_FIELDS) if (entity.item[key] !== undefined) row[key] = entity.item[key];
  row.taxonomy = D.itemTaxonomy(entity.item);
  return row;
}

function buildClusterLibrary(entities, cluster, latest) {
  const list = [...entities.values()].filter(entity =>
    clusterMemberships(entity).some(([type, id]) => type === cluster.type && id === cluster.id));
  return {
    schemaVersion: 1, type: cluster.type, id: cluster.id, path: cluster.path,
    latest, ranges: rangeStats(list, latest),
    projects: list.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.key.localeCompare(b.key)).map(libraryRow),
  };
}

function trendDataPath(type, id) {
  const segment = type === 'agentRoles' ? 'agent-roles' : type === 'useCases' ? 'use-cases' : type === 'languages' ? 'programming-languages' : null;
  return segment && /^[a-z0-9-]+$/.test(id || '') ? `/data/trends/${segment}/${id}.json` : null;
}

// Programming-language membership comes only from the GitHub repository snapshot, and that layer
// starts on 2026-09-01. Every earlier day contributes nothing, so a language's "baseline" is not a
// real 28-day baseline and its growth percentage is an artefact of the data arriving. Measuring the
// snapshot's actual day coverage lets the page state that instead of printing the number. Days
// without a snapshot file simply add nothing here and so lower the coverage, which is the point:
// when the layer is later backfilled the ratio rises on its own and the view recovers.
function languageCoverage(reports, recentStart, latest, baselineStart, baselineEnd, rawRoot) {
  const root = path.resolve(rawRoot || path.join(VAULT, '知识', '大家都在做什么', 'source-raw'));
  const hasSnapshot = date => fs.existsSync(path.join(root, 'github-repositories', `${date}.json`));
  const count = (from, to) => {
    let days = 0, covered = 0;
    for (let date = from; date <= to; date = dateOffset(date, 1)) { days += 1; if (hasSnapshot(date)) covered += 1; }
    return { days, covered };
  };
  const recent = count(recentStart, latest);
  const baseline = count(baselineStart, baselineEnd);
  const complete = baseline.days > 0 ? baseline.covered === baseline.days : true;
  return {
    recent: { start: recentStart, end: latest, ...recent },
    baseline: { start: baselineStart, end: baselineEnd, ...baseline },
    source: 'github-repositories',
    sourceStart: '2026-09-01',
    complete,
  };
}

function buildTrends(reports, latest, options = {}) {
  const recentDays = options.recentDays || 7;
  const baselineDays = options.baselineDays || 28;
  const minProjects = options.minProjects || 3;
  const minSources = options.minSources || 2;
  const minGrowthPercent = options.minGrowthPercent ?? 25;
  const recentStart = dateOffset(latest, -(recentDays - 1));
  const baselineEnd = dateOffset(recentStart, -1);
  const baselineStart = dateOffset(baselineEnd, -(baselineDays - 1));
  const entities = options.entities || buildEntityIndex(reports);
  const languages = options.languages
    || languageCoverage(reports, recentStart, latest, baselineStart, baselineEnd, options.rawRoot);
  // A language cluster is only comparable when the snapshot layer covers both windows. Otherwise its
  // "growth" measures when the language data started, not what developers adopted, so it is dropped
  // from the page entirely rather than shown with a misleading percentage. The coverage object
  // travels with the model so the page can explain the omission (and so it disappears by itself once
  // the layer is backfilled).
  const facetComparable = type => type !== 'languages' || languages.complete;

  const clusters = new Map();
  function cluster(type, id) {
    const key = `${type}:${id}`;
    if (!clusters.has(key)) clusters.set(key, { key, type, id, recent: [], baseline: [], sources: new Set() });
    return clusters.get(key);
  }
  for (const entity of entities.values()) {
    const memberships = clusterMemberships(entity);
    const period = entity.firstSeen >= recentStart && entity.firstSeen <= latest
      ? 'recent'
      : (entity.firstSeen >= baselineStart && entity.firstSeen <= baselineEnd ? 'baseline' : null);
    if (!period) continue;
    for (const [type, id] of memberships) {
      const value = cluster(type, id);
      value[period].push(entity);
      if (period === 'recent') for (const source of entity.sources) value.sources.add(source);
    }
  }

  const entityList = [...entities.values()];
  const output = [...clusters.values()].filter(value => facetComparable(value.type)).filter(value => value.recent.length >= minProjects && value.sources.size >= minSources).map(value => {
    const recentRate = value.recent.length / recentDays;
    const baselineRate = value.baseline.length / baselineDays;
    const growthPercent = baselineRate ? Math.round((recentRate / baselineRate - 1) * 100) : null;
    const examples = [...value.recent].sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.key.localeCompare(b.key)).slice(0, 4).map(entity => ({
      titleZh: D.displayTitle(entity.item, 'zh-CN'), titleEn: D.displayTitle(entity.item, 'en'),
      summaryZh: D.summary(entity.item, 'zh-CN').text, summaryEn: D.summary(entity.item, 'en').text,
      url: entity.item.projectPath || D.safeUrl(entity.item.websiteUrl || entity.item.url),
      internal: Boolean(entity.item.projectPath), date: entity.firstSeen,
    }));
    const projects = [...value.recent].sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.key.localeCompare(b.key)).map(entity => ({ ...entity.item, trendDate: entity.firstSeen }));
    return {
      key: value.key, type: value.type, id: value.id, path: trendPath(value.type, value.id),
      dataPath: trendDataPath(value.type, value.id),
      ranges: rangeStats(entityList.filter(entity => clusterMemberships(entity).some(([type, id]) => type === value.type && id === value.id)), latest),
      recentCount: value.recent.length, baselineCount: value.baseline.length, sourceCount: value.sources.size,
      growthPercent, isNew: value.baseline.length === 0, examples,
      weekly: buildWeeklySeries(entityList, value.type, value.id, latest, 12), projects,
    };
  }).filter(value => value.isNew || value.growthPercent >= minGrowthPercent).sort((a, b) => {
    const order = { useCases: 0, agentRoles: 1, languages: 2 };
    const typeOrder = (order[a.type] ?? 9) - (order[b.type] ?? 9);
    return typeOrder || b.recentCount - a.recentCount || (b.growthPercent ?? 9999) - (a.growthPercent ?? 9999) || a.key.localeCompare(b.key);
  });

  return {
    schemaVersion: 4, latest, seriesWeeks: 12,
    recent: { start: recentStart, end: latest, days: recentDays },
    baseline: { start: baselineStart, end: baselineEnd, days: baselineDays },
    thresholds: { minProjects, minSources, minGrowthPercent }, languages, clusters: output,
  };
}

module.exports = { dateOffset, trendIdentity, buildWeeklySeries, trendPath, trendDataPath, buildEntityIndex, clusterMemberships, buildClusterLibrary, buildTrends, languageCoverage };
