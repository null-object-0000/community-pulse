const FACETS = new Set(['useCases', 'agentRoles', 'productForms', 'platforms', 'integrations', 'languages']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function json(value, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', init.cacheControl || 'public, max-age=60, s-maxage=300');
  return new Response(JSON.stringify(value), { ...init, headers });
}

function offsetDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

export function parseTrendFilters(url, availableSources, latestDate) {
  const requested = (url.searchParams.get('sources') || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const known = new Set(availableSources);
  const unknown = requested.filter((source) => !known.has(source));
  if (unknown.length) throw new Error(`unknown sources: ${unknown.join(', ')}`);
  const sources = [...new Set(requested.length ? requested : availableSources)].sort();
  if (!sources.length) throw new Error('at least one source is required');

  const to = url.searchParams.get('to') || latestDate;
  const from = url.searchParams.get('from') || offsetDate(to, -6);
  if (!DATE.test(from) || !DATE.test(to) || from > to) throw new Error('invalid date range');
  const days = daysBetween(from, to);
  if (days < 1 || days > 366) throw new Error('date range must be between 1 and 366 days');
  const facet = url.searchParams.get('facet') || 'useCases';
  if (!FACETS.has(facet)) throw new Error(`unknown facet: ${facet}`);
  const previousTo = offsetDate(from, -1);
  const baselineDays = 28;
  const previousFrom = offsetDate(previousTo, -(baselineDays - 1));
  return { sources, from, to, days, baselineDays, facet, previousFrom, previousTo };
}

function selectedCte(sourceCount) {
  const placeholders = Array.from({ length: sourceCount }, () => '?').join(', ');
  return `selected_products AS (
    SELECT product_id, MIN(first_seen_date) AS selected_first_seen
    FROM product_source_first_seen
    WHERE source_id IN (${placeholders})
    GROUP BY product_id
  )`;
}

async function all(db, sql, bindings = []) {
  const result = await db.prepare(sql).bind(...bindings).all();
  return result.results || [];
}

export async function availableSources(db) {
  return all(db, `SELECT s.id, s.name, s.description,
    COUNT(DISTINCT f.product_id) AS productCount,
    MIN(f.first_seen_date) AS firstSeenDate,
    MAX(f.last_seen_date) AS lastSeenDate
    FROM sources s
    LEFT JOIN product_source_first_seen f ON f.source_id = s.id
    WHERE s.enabled = 1
    GROUP BY s.id, s.name, s.description, s.sort_order
    ORDER BY s.sort_order, s.id`);
}

export async function queryTrends(db, filters) {
  const baselineDays = filters.baselineDays || filters.days;
  const cte = selectedCte(filters.sources.length);
  // Assignments store leaf terms. The recursive relation rolls each leaf up to
  // every ancestor at read time, so a novel-writing product also contributes to
  // content-creation without storing the parent twice. Totals, coverage and term
  // rows share one materialized selected_products CTE so MySQL does not repeat the
  // expensive selected-source MIN(first_seen_date) scan three times per request.
  const resultsSql = `WITH RECURSIVE
    ${cte},
    totals AS (
      SELECT
        SUM(CASE WHEN selected_first_seen BETWEEN ? AND ? THEN 1 ELSE 0 END) AS currentCount,
        SUM(CASE WHEN selected_first_seen BETWEEN ? AND ? THEN 1 ELSE 0 END) AS previousCount
      FROM selected_products
    ),
    classified AS (
      SELECT COUNT(DISTINCT sp.product_id) AS classifiedCount
      FROM selected_products sp
      JOIN taxonomy_assignments ta ON ta.product_id = sp.product_id
      WHERE sp.selected_first_seen BETWEEN ? AND ? AND ta.facet = ? AND ta.is_current = 1
    ),
    ancestors(facet, leaf_id, term_id) AS (
      SELECT facet, id, id FROM taxonomy_terms WHERE facet = ? AND active = 1
      UNION ALL
      SELECT a.facet, a.leaf_id, t.parent_id
      FROM ancestors a
      JOIN taxonomy_terms t ON t.facet = a.facet AND t.id = a.term_id
      WHERE t.parent_id IS NOT NULL
    ),
    memberships AS (
      SELECT DISTINCT ta.product_id, a.term_id
      FROM taxonomy_assignments ta
      JOIN ancestors a ON a.facet = ta.facet AND a.leaf_id = ta.term_id
      WHERE ta.facet = ? AND ta.is_current = 1
    )
    SELECT t.id, t.parent_id AS parentId, t.label_zh AS labelZh, t.label_en AS labelEn,
      COUNT(DISTINCT CASE WHEN sp.selected_first_seen BETWEEN ? AND ? THEN sp.product_id END) AS currentCount,
      COUNT(DISTINCT CASE WHEN sp.selected_first_seen BETWEEN ? AND ? THEN sp.product_id END) AS previousCount,
      COUNT(DISTINCT CASE WHEN sp.selected_first_seen BETWEEN ? AND ? THEN sf.source_id END) AS sourceCount,
      totals.currentCount AS totalCurrentCount, totals.previousCount AS totalPreviousCount,
      classified.classifiedCount AS classifiedCount
    FROM taxonomy_terms t
    CROSS JOIN totals
    CROSS JOIN classified
    LEFT JOIN memberships m ON m.term_id = t.id
    LEFT JOIN selected_products sp ON sp.product_id = m.product_id
    LEFT JOIN product_source_first_seen sf ON sf.product_id = sp.product_id
      AND sf.source_id IN (${Array.from({ length: filters.sources.length }, () => '?').join(', ')})
      AND sf.first_seen_date = sp.selected_first_seen
    WHERE t.facet = ? AND t.active = 1
    GROUP BY t.id, t.parent_id, t.label_zh, t.label_en, t.sort_order,
      totals.currentCount, totals.previousCount, classified.classifiedCount
    ORDER BY currentCount DESC, t.sort_order, t.id`;
  const rows = await all(db, resultsSql, [
    ...filters.sources,
    filters.from, filters.to, filters.previousFrom, filters.previousTo,
    filters.from, filters.to, filters.facet,
    filters.facet, filters.facet,
    filters.from, filters.to, filters.previousFrom, filters.previousTo,
    filters.from, filters.to, ...filters.sources, filters.facet,
  ]);
  const taxonomyCtes = `${cte},
    ancestors(facet, leaf_id, term_id) AS (
      SELECT facet, id, id FROM taxonomy_terms WHERE facet = ? AND active = 1
      UNION ALL
      SELECT a.facet, a.leaf_id, t.parent_id
      FROM ancestors a
      JOIN taxonomy_terms t ON t.facet = a.facet AND t.id = a.term_id
      WHERE t.parent_id IS NOT NULL
    ),
    memberships AS (
      SELECT DISTINCT ta.product_id, a.term_id
      FROM taxonomy_assignments ta
      JOIN ancestors a ON a.facet = ta.facet AND a.leaf_id = ta.term_id
      WHERE ta.facet = ? AND ta.is_current = 1
    )`;
  const weeklyStart = offsetDate(filters.to, -83);
  const weeklyRows = await all(db, `WITH RECURSIVE ${taxonomyCtes}
    SELECT m.term_id AS id, sp.selected_first_seen AS date, COUNT(DISTINCT sp.product_id) AS count
    FROM memberships m
    JOIN selected_products sp ON sp.product_id = m.product_id
    WHERE sp.selected_first_seen BETWEEN ? AND ?
    GROUP BY m.term_id, sp.selected_first_seen
    ORDER BY m.term_id, sp.selected_first_seen`, [
    ...filters.sources, filters.facet, filters.facet, weeklyStart, filters.to,
  ]);
  const exampleRows = await all(db, `WITH RECURSIVE ${taxonomyCtes},
    ranked AS (
      SELECT m.term_id AS id, p.id AS productId, p.title,
        p.canonical_url AS url, p.github_repo AS githubRepo, sp.selected_first_seen AS date,
        ROW_NUMBER() OVER (PARTITION BY m.term_id ORDER BY sp.selected_first_seen DESC, p.id) AS position
      FROM memberships m
      JOIN selected_products sp ON sp.product_id = m.product_id
      JOIN products p ON p.id = sp.product_id
      WHERE sp.selected_first_seen BETWEEN ? AND ?
    )
    SELECT id, productId, title, url, githubRepo, date
    FROM ranked WHERE position <= 4 ORDER BY id, date DESC, productId`, [
    ...filters.sources, filters.facet, filters.facet, filters.from, filters.to,
  ]);
  const weeklyByTerm = new Map();
  for (const row of weeklyRows) {
    if (!weeklyByTerm.has(row.id)) weeklyByTerm.set(row.id, new Map());
    weeklyByTerm.get(row.id).set(String(row.date).slice(0, 10), Number(row.count || 0));
  }
  const examplesByTerm = new Map();
  for (const row of exampleRows) {
    if (!examplesByTerm.has(row.id)) examplesByTerm.set(row.id, []);
    examplesByTerm.get(row.id).push({
      title: row.title, url: row.url || (row.githubRepo ? `https://github.com/${row.githubRepo}` : ''),
      date: String(row.date).slice(0, 10),
    });
  }
  const segment = { useCases: 'use-cases', agentRoles: 'agent-roles', languages: 'programming-languages' }[filters.facet];
  const currentTotal = Number(rows[0]?.totalCurrentCount || 0);
  const previousTotal = Number(rows[0]?.totalPreviousCount || 0);
  const classifiedTotal = Number(rows[0]?.classifiedCount || 0);
  return {
    schemaVersion: 1,
    filters: {
      sources: filters.sources,
      from: filters.from,
      to: filters.to,
      days: filters.days,
      baselineDays,
      facet: filters.facet,
      mode: 'selected-source-first-seen',
      comparison: { from: filters.previousFrom, to: filters.previousTo, days: baselineDays },
    },
    coverage: {
      uniqueProducts: currentTotal,
      previousUniqueProducts: previousTotal,
      classifiedProducts: classifiedTotal,
      classificationRate: currentTotal ? classifiedTotal / currentTotal : 0,
    },
    thresholds: { minProjects: 3, minSources: 2, minGrowthPercent: 25 },
    results: rows.map((row) => {
      const currentCount = Number(row.currentCount || 0);
      const previousCount = Number(row.previousCount || 0);
      const currentRate = currentCount / filters.days;
      const previousRate = previousCount / baselineDays;
      const daily = weeklyByTerm.get(row.id) || new Map();
      const weekly = Array.from({ length: 12 }, (_, index) => {
        const start = offsetDate(weeklyStart, index * 7);
        const end = offsetDate(start, 6);
        let count = 0;
        for (let date = start; date <= end; date = offsetDate(date, 1)) count += daily.get(date) || 0;
        return { start, end, count };
      });
      return {
        id: row.id,
        parentId: row.parentId || null,
        labelZh: row.labelZh,
        labelEn: row.labelEn,
        currentCount,
        previousCount,
        sourceCount: Number(row.sourceCount || 0),
        share: currentTotal ? currentCount / currentTotal : 0,
        growth: previousRate ? currentRate / previousRate - 1 : null,
        isNew: currentCount > 0 && previousCount === 0,
        path: segment ? `/trends/${segment}/${row.id}/` : null,
        weekly,
        examples: examplesByTerm.get(row.id) || [],
      };
    }).filter((row) => row.currentCount || row.previousCount),
  };
}

export async function queryProducts(db, filters, term) {
  if (!/^[a-z0-9-]+$/.test(term || '')) throw new Error('invalid taxonomy term');
  const cte = selectedCte(filters.sources.length);
  const rows = await all(db, `WITH RECURSIVE
    ${cte},
    ancestors(facet, leaf_id, term_id) AS (
      SELECT facet, id, id FROM taxonomy_terms WHERE facet = ? AND active = 1
      UNION ALL
      SELECT a.facet, a.leaf_id, t.parent_id
      FROM ancestors a
      JOIN taxonomy_terms t ON t.facet = a.facet AND t.id = a.term_id
      WHERE t.parent_id IS NOT NULL
    ),
    memberships AS (
      SELECT DISTINCT ta.product_id, a.term_id
      FROM taxonomy_assignments ta
      JOIN ancestors a ON a.facet = ta.facet AND a.leaf_id = ta.term_id
      WHERE ta.facet = ? AND ta.is_current = 1
    )
    SELECT p.id, p.title, p.canonical_url AS url, p.github_repo AS githubRepo,
      sp.selected_first_seen AS date, GROUP_CONCAT(DISTINCT sf.source_id) AS sourceIds
    FROM memberships m
    JOIN selected_products sp ON sp.product_id = m.product_id
    JOIN products p ON p.id = sp.product_id
    LEFT JOIN product_source_first_seen sf ON sf.product_id = sp.product_id
      AND sf.source_id IN (${Array.from({ length: filters.sources.length }, () => '?').join(', ')})
      AND sf.first_seen_date = sp.selected_first_seen
    WHERE m.term_id = ? AND sp.selected_first_seen BETWEEN ? AND ?
    GROUP BY p.id, p.title, p.canonical_url, p.github_repo, sp.selected_first_seen
    ORDER BY sp.selected_first_seen DESC, p.id
    LIMIT 10000`, [
    ...filters.sources, filters.facet, filters.facet, ...filters.sources,
    term, filters.from, filters.to,
  ]);
  const sources = new Set();
  const products = rows.map(row => {
    const sourceIds = String(row.sourceIds || '').split(',').filter(Boolean);
    sourceIds.forEach(source => sources.add(source));
    return {
      sourceId: sourceIds[0] || 'catalog', externalId: row.id, title: row.title,
      url: row.url || (row.githubRepo ? `https://github.com/${row.githubRepo}` : ''),
      githubUrl: row.githubRepo ? `https://github.com/${row.githubRepo}` : undefined,
      trendDate: String(row.date).slice(0, 10), taxonomy: { [filters.facet]: [term] },
    };
  });
  return { schemaVersion: 1, filters: { ...filters, term }, count: products.length, sourceCount: sources.size, products };
}

export async function handleCatalogApi(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, { status: 405, cacheControl: 'no-store' });
  if (!env.HYPERDRIVE_READ) return json({ error: 'catalog_database_unavailable' }, { status: 503, cacheControl: 'no-store' });
  let db;
  let close = async () => {};
  try {
    const opened = await (await import('./mysql-db.mjs')).openMysql(env.HYPERDRIVE_READ);
    db = opened.db;
    close = opened.close;
    const sources = await availableSources(db);
    if (url.pathname === '/api/v1/sources') {
      return json({ schemaVersion: 1, sources });
    }
    if (url.pathname === '/api/v1/trends') {
      const latest = sources.map((source) => source.lastSeenDate).filter(Boolean).sort().at(-1);
      if (!latest) return json({ error: 'catalog_is_empty' }, { status: 503, cacheControl: 'no-store' });
      const filters = parseTrendFilters(url, sources.map((source) => source.id), latest);
      return json(await queryTrends(db, filters));
    }
    if (url.pathname === '/api/v1/products') {
      const latest = sources.map((source) => source.lastSeenDate).filter(Boolean).sort().at(-1);
      if (!latest) return json({ error: 'catalog_is_empty' }, { status: 503, cacheControl: 'no-store' });
      const filters = parseTrendFilters(url, sources.map((source) => source.id), latest);
      return json(await queryProducts(db, filters, url.searchParams.get('term')));
    }
    return json({ error: 'not_found' }, { status: 404, cacheControl: 'no-store' });
  } catch (error) {
    return json({ error: 'invalid_request', message: error.message }, { status: 400, cacheControl: 'no-store' });
  } finally {
    await close();
  }
}
