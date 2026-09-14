const D = require('../web/shared.js');

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
    if (!memberships?.length) continue;
    // A top-level topic's series is the sum of its direct hits and its sub-topics, exactly like its
    // counts and its category library — the sparkline must not contradict the heading.
    const scope = new Set(D.facetDescendants(type, id));
    if (!memberships.some(value => scope.has(value))) continue;
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

// Every cluster an entity belongs to, including the ancestors a sub-topic rolls up into. The trend
// model, the per-range stats and the category library all read this one function, so a project an
// item reaches only through a sub-topic still appears on the parent topic's page and counts there.
function clusterMemberships(entity) {
  const taxonomy = D.itemTaxonomy(entity.item);
  const memberships = [];
  const push = (type, id) => {
    // An item tagged with a sub-topic also belongs to its parent, so the parent's page and counts stay
    // the sum of its direct hits plus everything nested under it.
    for (const value of [id, ...D.facetAncestors(type, id)]) {
      if (!memberships.some(([knownType, knownId]) => knownType === type && knownId === value)) memberships.push([type, value]);
    }
  };
  for (const id of taxonomy.useCases) push('useCases', id);
  for (const id of taxonomy.agentRoles) push('agentRoles', id);
  for (const id of D.itemLanguages(entity.item)) push('languages', id);
  return memberships;
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

// Programming-language membership comes only from the GitHub repository snapshot layer, and
// that layer can only describe days whose report already carries a GitHub repository row. Two
// things consequently have to hold for a language comparison to mean anything:
//
//  1. Coverage is measured from the reports themselves — the exact input this model consumes —
//     not from whether snapshot files exist on disk. Backfilling those files without re-deriving
//     the reports would otherwise report completeness while the lens still saw nothing.
//  2. The denominator is the days that could carry a language at all, i.e. days whose report
//     holds a GitHub repository reference. Before 2026-06-22 the only such days were the weekly
//     and monthly issue days (one or two a week); since the GitHub Trending backfill every day
//     carries one, so the denominator is now close to the calendar length of the window.
//
// The constant below records when that densification starts. It is metadata for readers of
// /data/trends.json — the model derives everything it acts on from the reports.
const LANGUAGE_SERIES_START = '2026-06-22';

function languageCoverage(reports, recentStart, latest, baselineStart, baselineEnd) {
  const byDate = new Map(reports.map(report => [report.date, report]));
  const count = (from, to) => {
    let days = 0, eligible = 0, covered = 0;
    for (let date = from; date <= to; date = dateOffset(date, 1)) {
      days += 1;
      const report = byDate.get(date);
      if (!report) continue;
      const items = D.reportItems(report);
      // A day with no repository reference cannot yield a language, so it is not part of the scope.
      if (!items.some(item => item.githubUrl || item.github?.url)) continue;
      eligible += 1;
      if (items.some(item => D.itemLanguages(item).length)) covered += 1;
    }
    return { days, eligible, covered };
  };
  const recent = count(recentStart, latest);
  const baseline = count(baselineStart, baselineEnd);
  return {
    recent: { start: recentStart, end: latest, ...recent },
    baseline: { start: baselineStart, end: baselineEnd, ...baseline },
    source: 'github-repositories',
    sourceStart: LANGUAGE_SERIES_START,
    complete: baseline.covered === baseline.eligible && recent.covered === recent.eligible,
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
    || languageCoverage(reports, recentStart, latest, baselineStart, baselineEnd);
  // A cluster is only comparable when the snapshot layer covers both windows. Otherwise its "growth"
  // measures when the language data started, not what developers adopted, so it is dropped from the
  // page entirely rather than shown with a misleading percentage. The coverage object travels with
  // the model so the page can explain the omission (and so it disappears by itself once the layer is
  // backfilled).
  const facetComparable = type => type !== 'languages' || languages.complete;
  // The rate must divide by the days on which the facet could be observed at all, not by calendar
  // days. Language only exists on days whose report carries a repository reference — 7 of the 28
  // baseline days — so dividing by 28 understated the baseline roughly fourfold and inflated every
  // language's growth by the same factor. Taxonomy is observable on every day, so its denominator is
  // unchanged. `days` is what the page states; `observed` is what the rate uses.
  const observedDays = type => (type === 'languages'
    ? { recent: languages.recent.eligible, baseline: languages.baseline.eligible }
    : { recent: recentDays, baseline: baselineDays });

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
    const days = observedDays(value.type);
    const recentRate = value.recent.length / Math.max(1, days.recent);
    const baselineRate = value.baseline.length / Math.max(1, days.baseline);
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

  // Source filtering can surface a category that is not a global trend this week.
  // Publish a stable category-library route for every classified facet so dynamic
  // MySQL cards always have a real product-list destination instead of a 404.
  const catalogGroups = new Map();
  for (const entity of entityList) {
    for (const [type, id] of clusterMemberships(entity)) {
      if (!['useCases', 'agentRoles', 'languages'].includes(type)) continue;
      const key = `${type}:${id}`;
      if (!catalogGroups.has(key)) catalogGroups.set(key, { key, type, id, entities: [] });
      catalogGroups.get(key).entities.push(entity);
    }
  }
  const catalogClusters = [...catalogGroups.values()].map(value => {
    const recent = value.entities.filter(entity => entity.firstSeen >= recentStart && entity.firstSeen <= latest);
    const baseline = value.entities.filter(entity => entity.firstSeen >= baselineStart && entity.firstSeen <= baselineEnd);
    const sourceSet = new Set(recent.flatMap(entity => [...entity.sources]));
    const days = observedDays(value.type);
    const recentRate = recent.length / Math.max(1, days.recent);
    const baselineRate = baseline.length / Math.max(1, days.baseline);
    return {
      key: value.key, type: value.type, id: value.id,
      path: trendPath(value.type, value.id), dataPath: trendDataPath(value.type, value.id),
      ranges: rangeStats(value.entities, latest), recentCount: recent.length,
      baselineCount: baseline.length, sourceCount: sourceSet.size,
      growthPercent: baselineRate ? Math.round((recentRate / baselineRate - 1) * 100) : null,
      isNew: recent.length > 0 && baseline.length === 0,
      examples: [], weekly: buildWeeklySeries(entityList, value.type, value.id, latest, 12),
      projects: recent.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.key.localeCompare(b.key))
        .map(entity => ({ ...entity.item, trendDate: entity.firstSeen })),
    };
  }).filter(cluster => cluster.path).sort((a, b) => a.key.localeCompare(b.key));

  return {
    schemaVersion: 4, latest, seriesWeeks: 12,
    recent: { start: recentStart, end: latest, days: recentDays },
    baseline: { start: baselineStart, end: baselineEnd, days: baselineDays },
    thresholds: { minProjects, minSources, minGrowthPercent }, languages,
    clusters: output, catalogClusters,
  };
}

module.exports = { dateOffset, trendIdentity, buildWeeklySeries, trendPath, trendDataPath, buildEntityIndex, clusterMemberships, buildClusterLibrary, buildTrends, languageCoverage };
