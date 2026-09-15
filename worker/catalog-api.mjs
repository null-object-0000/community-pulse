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

function productCursor(value) {
  if (!value) return null;
  try {
    const [date, id] = atob(value).split('|');
    if (!DATE.test(date) || !/^prd_[a-f0-9]{24}$/.test(id || '')) throw new Error('shape');
    return { date, id };
  } catch { throw new Error('invalid product cursor'); }
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
  if (days < 1 || days > 5000) throw new Error('date range must be between 1 and 5000 days');
  const facet = url.searchParams.get('facet') || 'useCases';
  if (!FACETS.has(facet)) throw new Error(`unknown facet: ${facet}`);
  const previousTo = offsetDate(from, -1);
  const baselineDays = 28;
  const previousFrom = offsetDate(previousTo, -(baselineDays - 1));
  return { sources, from, to, days, baselineDays, facet, previousFrom, previousTo };
}

function selectedPlan(filters, allSources = false, rangeFrom = null) {
  const range = rangeFrom ? ' WHERE first_seen_date BETWEEN ? AND ?' : '';
  const rangeBindings = rangeFrom ? [rangeFrom, filters.to] : [];
  if (allSources) {
    return {
      cte: `selected_products AS (
        SELECT id AS product_id, first_seen_date AS selected_first_seen FROM products${range}
      )`,
      bindings: rangeBindings,
    };
  }
  if (filters.sources.length === 1) {
    return {
      cte: `selected_products AS (
        SELECT product_id, first_seen_date AS selected_first_seen
        FROM product_source_first_seen WHERE source_id = ?${range ? ' AND first_seen_date BETWEEN ? AND ?' : ''}
      )`,
      bindings: [filters.sources[0], ...rangeBindings],
    };
  }
  const placeholders = Array.from({ length: filters.sources.length }, () => '?').join(', ');
  return {
    cte: `selected_products AS (
      SELECT product_id, MIN(first_seen_date) AS selected_first_seen
      FROM product_source_first_seen
      WHERE source_id IN (${placeholders})
      GROUP BY product_id
      ${rangeFrom ? 'HAVING MIN(first_seen_date) BETWEEN ? AND ?' : ''}
    )`,
    bindings: [...filters.sources, ...rangeBindings],
  };
}

async function all(db, sql, bindings = [], timings = null, label = '') {
  const started = performance.now();
  try {
    const result = await db.prepare(sql).bind(...bindings).all();
    return result.results || [];
  } finally {
    if (timings && label) timings.push(`${label};dur=${(performance.now() - started).toFixed(1)}`);
  }
}

export async function availableSources(db, timings = null) {
  return all(db, `SELECT s.id, s.name, s.description,
    COUNT(f.product_id) AS productCount,
    MIN(f.first_seen_date) AS firstSeenDate,
    MAX(f.last_seen_date) AS lastSeenDate
    FROM sources s
    LEFT JOIN product_source_first_seen f ON f.source_id = s.id
    WHERE s.enabled = 1
    GROUP BY s.id
    ORDER BY s.sort_order, s.id`, [], timings, 'sources');
}

export async function queryTrends(db, filters, timings = null, options = {}) {
  const databases = options.databases || [db, db, db];
  const baselineDays = filters.baselineDays || filters.days;
  const weeklyStart = offsetDate(filters.to, -83);
  const selected = selectedPlan(filters, options.allSources, [filters.previousFrom, filters.from].sort()[0]);
  const cte = selected.cte;
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
      SELECT DISTINCT sp.product_id, a.term_id
      FROM selected_products sp
      JOIN taxonomy_assignments ta ON ta.product_id = sp.product_id
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
  const rowsPromise = all(databases[0], resultsSql, [
    ...selected.bindings,
    filters.from, filters.to, filters.previousFrom, filters.previousTo,
    filters.from, filters.to, filters.facet,
    filters.facet, filters.facet,
    filters.from, filters.to, filters.previousFrom, filters.previousTo,
    filters.from, filters.to, ...filters.sources, filters.facet,
  ], timings, 'trendTotals');
  const taxonomyCtes = (plan) => `${plan.cte},
    ancestors(facet, leaf_id, term_id) AS (
      SELECT facet, id, id FROM taxonomy_terms WHERE facet = ? AND active = 1
      UNION ALL
      SELECT a.facet, a.leaf_id, t.parent_id
      FROM ancestors a
      JOIN taxonomy_terms t ON t.facet = a.facet AND t.id = a.term_id
      WHERE t.parent_id IS NOT NULL
    ),
    memberships AS (
      SELECT DISTINCT sp.product_id, a.term_id
      FROM selected_products sp
      JOIN taxonomy_assignments ta ON ta.product_id = sp.product_id
      JOIN ancestors a ON a.facet = ta.facet AND a.leaf_id = ta.term_id
      WHERE ta.facet = ? AND ta.is_current = 1
    )`;
  const weeklySelected = selectedPlan(filters, options.allSources, weeklyStart);
  const weeklyPromise = all(databases[1], `WITH RECURSIVE ${taxonomyCtes(weeklySelected)}
    SELECT m.term_id AS id, sp.selected_first_seen AS date, COUNT(DISTINCT sp.product_id) AS count
    FROM memberships m
    JOIN selected_products sp ON sp.product_id = m.product_id
    WHERE sp.selected_first_seen BETWEEN ? AND ?
    GROUP BY m.term_id, sp.selected_first_seen
    ORDER BY m.term_id, sp.selected_first_seen`, [
    ...weeklySelected.bindings, filters.facet, filters.facet, weeklyStart, filters.to,
  ], timings, 'trendWeekly');
  // MySQL used to rank every candidate with ROW_NUMBER before keeping four rows per term. On the
  // production RDS that window sort dominated the endpoint (6.4s in a real request). The current
  // window contains only a few thousand classified products, so returning that bounded set and
  // applying the four-row cap below is both simpler and substantially cheaper.
  const exampleSelected = selectedPlan(filters, options.allSources, filters.from);
  const examplesPromise = all(databases[2], `WITH RECURSIVE ${taxonomyCtes(exampleSelected)}
    SELECT m.term_id AS id, p.id AS productId, p.title,
      p.canonical_url AS url, p.github_repo AS githubRepo, sp.selected_first_seen AS date
    FROM memberships m
    JOIN selected_products sp ON sp.product_id = m.product_id
    JOIN products p ON p.id = sp.product_id
    WHERE sp.selected_first_seen BETWEEN ? AND ?
    ORDER BY m.term_id, sp.selected_first_seen DESC, p.id`, [
    ...exampleSelected.bindings, filters.facet, filters.facet, filters.from, filters.to,
  ], timings, 'trendExamples');
  const [rows, weeklyRows, exampleRows] = await Promise.all([rowsPromise, weeklyPromise, examplesPromise]);
  const weeklyByTerm = new Map();
  for (const row of weeklyRows) {
    if (!weeklyByTerm.has(row.id)) weeklyByTerm.set(row.id, new Map());
    weeklyByTerm.get(row.id).set(String(row.date).slice(0, 10), Number(row.count || 0));
  }
  const examplesByTerm = new Map();
  for (const row of exampleRows) {
    if (!examplesByTerm.has(row.id)) examplesByTerm.set(row.id, []);
    if (examplesByTerm.get(row.id).length >= 4) continue;
    examplesByTerm.get(row.id).push({
      title: row.title,
      url: row.githubRepo ? `/projects/${String(row.githubRepo).toLowerCase()}/` : `/products/${row.productId}/`,
      internal: true, date: String(row.date).slice(0, 10),
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

export async function queryProducts(db, filters, term, timings = null, options = {}) {
  if (!/^[a-z0-9-]+$/.test(term || '')) throw new Error('invalid taxonomy term');
  const pageSize = Math.max(1, Math.min(300, Number(options.pageSize) || 100));
  const page = Math.max(1, Math.min(10000, Number(options.page) || 1));
  const offset = (page - 1) * pageSize;
  if (options.allSources) {
    const cursor = productCursor(options.cursor);
    const cursorWhere = cursor ? ' AND (p.first_seen_date < ? OR (p.first_seen_date = ? AND p.id > ?))' : '';
    const cursorBindings = cursor ? [cursor.date, cursor.date, cursor.id] : [];
    const rows = await all(db, `WITH RECURSIVE descendants(id) AS (
        SELECT ? UNION ALL
        SELECT t.id FROM taxonomy_terms t JOIN descendants d ON t.parent_id = d.id
        WHERE t.facet = ? AND t.active = 1
      )
      SELECT page.id, page.title, page.url, page.githubRepo, pd.item_json AS itemJson,
        page.date,
        (SELECT GROUP_CONCAT(sf.source_id) FROM product_source_first_seen sf
          WHERE sf.product_id = page.id AND sf.first_seen_date = page.date) AS sourceIds
      FROM (
        SELECT p.id, p.title, p.canonical_url AS url, p.github_repo AS githubRepo,
          p.first_seen_date AS date
        FROM products p
        WHERE p.first_seen_date BETWEEN ? AND ?${cursorWhere}
          AND EXISTS (
            SELECT 1 FROM taxonomy_assignments ta
            JOIN descendants d ON d.id = ta.term_id
            WHERE ta.product_id = p.id AND ta.facet = ? AND ta.is_current = 1
          )
        ORDER BY p.first_seen_date DESC, p.id
        LIMIT ${pageSize + 1}
      ) page
      LEFT JOIN product_details pd ON pd.product_id = page.id
      ORDER BY page.date DESC, page.id`, [term, filters.facet, filters.from, filters.to, ...cursorBindings, filters.facet], timings, 'productsAllSources');
    return productRows(rows, filters, term, page, pageSize, true);
  }
  const selected = selectedPlan(filters, false, filters.from);
  const cte = selected.cte;
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
      SELECT DISTINCT sp.product_id, a.term_id
      FROM selected_products sp
      JOIN taxonomy_assignments ta ON ta.product_id = sp.product_id
      JOIN ancestors a ON a.facet = ta.facet AND a.leaf_id = ta.term_id
      WHERE ta.facet = ? AND ta.is_current = 1
    )
    SELECT page.id, page.title, page.url, page.githubRepo, pd.item_json AS itemJson,
      page.date,
      (SELECT GROUP_CONCAT(sf.source_id) FROM product_source_first_seen sf
        WHERE sf.product_id = page.id AND sf.first_seen_date = page.date
          AND sf.source_id IN (${Array.from({ length: filters.sources.length }, () => '?').join(', ')})) AS sourceIds
    FROM (
      SELECT p.id, p.title, p.canonical_url AS url, p.github_repo AS githubRepo,
        sp.selected_first_seen AS date
      FROM memberships m
      JOIN selected_products sp ON sp.product_id = m.product_id
      JOIN products p ON p.id = sp.product_id
      WHERE m.term_id = ? AND sp.selected_first_seen BETWEEN ? AND ?
      ORDER BY sp.selected_first_seen DESC, p.id
      LIMIT ${pageSize + 1} OFFSET ${offset}
    ) page
    LEFT JOIN product_details pd ON pd.product_id = page.id
    ORDER BY page.date DESC, page.id`, [
    ...selected.bindings, filters.facet, filters.facet, ...filters.sources,
    term, filters.from, filters.to,
  ], timings, 'products');
  return productRows(rows, filters, term, page, pageSize);
}

function productRows(rows, filters, term, page, pageSize, cursorMode = false) {
  const hasMore = rows.length > pageSize;
  const sources = new Set();
  const products = rows.slice(0, pageSize).map(row => {
    const sourceIds = String(row.sourceIds || '').split(',').filter(Boolean);
    sourceIds.forEach(source => sources.add(source));
    let detail = row.itemJson || {};
    if (typeof detail === 'string') {
      try { detail = JSON.parse(detail); } catch { detail = {}; }
    }
    const projectPath = row.githubRepo ? `/projects/${String(row.githubRepo).toLowerCase()}/` : `/products/${row.id}/`;
    return {
      ...detail, sourceId: detail.sourceId || sourceIds[0] || 'catalog', sourceIds,
      externalId: detail.externalId || row.id, productId: row.id, title: detail.title || row.title,
      url: row.url || (row.githubRepo ? `https://github.com/${row.githubRepo}` : ''),
      githubUrl: row.githubRepo ? `https://github.com/${row.githubRepo}` : undefined,
      projectPath, trendDate: String(row.date).slice(0, 10),
      taxonomy: { ...(detail.taxonomy || {}), [filters.facet]: [term] },
    };
  });
  const last = products.at(-1);
  return { schemaVersion: 2, filters: { ...filters, term }, count: products.length, sourceCount: sources.size,
    page, pageSize, hasMore, nextPage: hasMore && !cursorMode ? page + 1 : null,
    nextCursor: hasMore && cursorMode && last ? btoa(`${last.trendDate}|${last.productId}`) : null, products };
}

export async function queryProductDetail(db, routePath, timings = null) {
  const rows = await all(db, `SELECT p.id, p.title, p.canonical_url AS canonicalUrl,
      p.github_repo AS githubRepo, p.first_seen_date AS firstSeenDate, p.last_seen_date AS lastSeenDate,
      pd.item_json AS itemJson, pd.content_hash AS contentHash
    FROM product_routes r
    JOIN products p ON p.id = r.product_id
    LEFT JOIN product_details pd ON pd.product_id = p.id
    WHERE r.route_path = ? LIMIT 1`, [routePath], timings, 'productDetail');
  if (!rows.length) return null;
  const row = rows[0];
  let item = row.itemJson || {};
  if (typeof item === 'string') {
    try { item = JSON.parse(item); } catch { item = {}; }
  }
  const taxonomy = await all(db, `SELECT ta.facet, ta.term_id AS termId
    FROM taxonomy_assignments ta
    WHERE ta.product_id = ? AND ta.is_current = 1
    ORDER BY ta.facet, ta.term_id`, [row.id], timings, 'productTaxonomy');
  const sources = await all(db, `SELECT f.source_id AS sourceId, s.name AS sourceName,
      f.first_seen_date AS firstSeenDate, f.last_seen_date AS lastSeenDate,
      f.observation_count AS observationCount
    FROM product_source_first_seen f JOIN sources s ON s.id = f.source_id
    WHERE f.product_id = ? ORDER BY f.first_seen_date, f.source_id`, [row.id], timings, 'productSources');
  const facets = {};
  for (const value of taxonomy) (facets[value.facet] ||= []).push(value.termId);
  const githubRepo = row.githubRepo ? String(row.githubRepo).toLowerCase() : '';
  return {
    schemaVersion: 1,
    catalogVersion: `${String(row.lastSeenDate).slice(0, 10)}-${row.contentHash || 'base'}`,
    product: {
      id: row.id, title: item.title || row.title, canonicalUrl: row.canonicalUrl || '', githubRepo,
      route: githubRepo ? `/projects/${githubRepo}/` : `/products/${row.id}/`,
      firstSeenDate: String(row.firstSeenDate).slice(0, 10), lastSeenDate: String(row.lastSeenDate).slice(0, 10),
      item: { ...item, taxonomy: facets },
      sources: sources.map(source => ({ ...source,
        firstSeenDate: String(source.firstSeenDate).slice(0, 10), lastSeenDate: String(source.lastSeenDate).slice(0, 10),
        observationCount: Number(source.observationCount || 0),
      })),
    },
  };
}

export async function handleCatalogApi(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, { status: 405, cacheControl: 'no-store' });
  if (!env.HYPERDRIVE_READ) return json({ error: 'catalog_database_unavailable' }, { status: 503, cacheControl: 'no-store' });
  let db;
  const closes = [];
  const timings = [];
  try {
    const connectStarted = performance.now();
    const opened = await (await import('./mysql-db.mjs')).openMysql(env.HYPERDRIVE_READ);
    timings.push(`connect;dur=${(performance.now() - connectStarted).toFixed(1)}`);
    db = opened.db;
    closes.push(opened.close);
    const sources = await availableSources(db, timings);
    const headers = () => ({ 'server-timing': timings.join(', ') });
    if (url.pathname === '/api/v1/sources') {
      return json({ schemaVersion: 1, sources }, { headers: headers() });
    }
    if (url.pathname === '/api/v1/trends') {
      const latest = sources.map((source) => source.lastSeenDate).filter(Boolean).sort().at(-1);
      if (!latest) return json({ error: 'catalog_is_empty' }, { status: 503, cacheControl: 'no-store' });
      const filters = parseTrendFilters(url, sources.map((source) => source.id), latest);
      const extraStarted = performance.now();
      const mysql = await import('./mysql-db.mjs');
      const extras = await Promise.all([
        mysql.openMysql(env.HYPERDRIVE_READ),
        mysql.openMysql(env.HYPERDRIVE_READ),
      ]);
      extras.forEach((extra) => closes.push(extra.close));
      timings.push(`parallelConnect;dur=${(performance.now() - extraStarted).toFixed(1)}`);
      const data = await queryTrends(db, filters, timings, {
        allSources: filters.sources.length === sources.length,
        databases: [db, ...extras.map((extra) => extra.db)],
      });
      return json(data, { headers: headers() });
    }
    if (url.pathname === '/api/v1/products') {
      const latest = sources.map((source) => source.lastSeenDate).filter(Boolean).sort().at(-1);
      if (!latest) return json({ error: 'catalog_is_empty' }, { status: 503, cacheControl: 'no-store' });
      const filters = parseTrendFilters(url, sources.map((source) => source.id), latest);
      const data = await queryProducts(db, filters, url.searchParams.get('term'), timings, {
        allSources: filters.sources.length === sources.length,
        page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize'), cursor: url.searchParams.get('cursor'),
      });
      return json(data, { headers: headers() });
    }
    return json({ error: 'not_found' }, { status: 404, cacheControl: 'no-store' });
  } catch (error) {
    return json({ error: 'invalid_request', message: error.message }, { status: 400, cacheControl: 'no-store' });
  } finally {
    const closing = Promise.allSettled(closes.map((close) => close()));
    if (ctx?.waitUntil) ctx.waitUntil(closing);
    else await closing;
  }
}
