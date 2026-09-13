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

function buildTrends(reports, latest, options = {}) {
  const recentDays = options.recentDays || 7;
  const baselineDays = options.baselineDays || 28;
  const minProjects = options.minProjects || 3;
  const minSources = options.minSources || 2;
  const minGrowthPercent = options.minGrowthPercent ?? 25;
  const recentStart = dateOffset(latest, -(recentDays - 1));
  const baselineEnd = dateOffset(recentStart, -1);
  const baselineStart = dateOffset(baselineEnd, -(baselineDays - 1));
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

  const clusters = new Map();
  function cluster(type, id) {
    const key = `${type}:${id}`;
    if (!clusters.has(key)) clusters.set(key, { key, type, id, recent: [], baseline: [], sources: new Set() });
    return clusters.get(key);
  }
  for (const entity of entities.values()) {
    const taxonomy = D.itemTaxonomy(entity.item);
    const memberships = [
      ...taxonomy.useCases.map(id => ['useCases', id]),
      ...taxonomy.agentRoles.map(id => ['agentRoles', id]),
      ...D.itemLanguages(entity.item).map(id => ['languages', id]),
    ];
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
  const output = [...clusters.values()].filter(value => value.recent.length >= minProjects && value.sources.size >= minSources).map(value => {
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
    schemaVersion: 3, latest, seriesWeeks: 12,
    recent: { start: recentStart, end: latest, days: recentDays },
    baseline: { start: baselineStart, end: baselineEnd, days: baselineDays },
    thresholds: { minProjects, minSources, minGrowthPercent }, clusters: output,
  };
}

module.exports = { dateOffset, trendIdentity, buildWeeklySeries, trendPath, buildTrends };
