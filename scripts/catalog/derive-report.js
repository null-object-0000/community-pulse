#!/usr/bin/env node
/**
 * 从发布记录**派生**日报对象 —— 第二批「发布层」的派生端。
 *
 * 现在 `build-site.js` 是：`raw/<date>.json` → `admitReport`（渲染期重算准入）→ 合并 `final/*.md`
 * → 图片本地化 → 渲染。新链是：`report_items`（冻结的发布行）→ 重建同一个 report 对象 → **后面
 * 两步完全共用**。所以这里的职责只有一件：把记录还原成 `admitReport(raw)` 等价的那个形状。
 *
 * 三条纪律：
 * ① **顺序不许重排。** `report_items.position` 就是发布顺序；`results[]` 按「来源首次出现的顺序」
 *    分组还原，组内按 position 排 —— `renderMarkdown` 是 `results → source → items` 渲染的。
 * ② **准入不许重算。** 被排除的条目在写记录时就已经不在 `report_items` 里了；这里只把
 *    `selection.admission` 原样带回去，供渲染层知道「这期有哪几条被挡下」。
 * ③ **双语不在记录里。** 按拍板的口径只冻选品层，译文仍由 Git 的 `final/<date>.md` 合并，
 *    所以派生出来的对象要交给同一个 `applyEnhancedMarkdown`。
 */
const D = require('../../web/shared.js');

/** 记录 → `admitReport(raw)` 等价的对象（不含 final 合并与图片本地化，那两步两边共用）。 */
function deriveReportFromRecord(record) {
  const { report, items } = record;
  const selection = report.selection || {};
  const results = [];
  const bySource = new Map();
  const continuedItems = [];
  // 先按记录里的来源清单建组（含空分组），保证 `results[]` 的顺序与来源名与旧链逐字一致 ——
  // `renderMarkdown` 就是 results → source → items 渲染的。
  for (const source of selection.sources || []) {
    const entry = { sourceId: source.sourceId, sourceName: source.sourceName || null, items: [] };
    bySource.set(source.sourceId, entry);
    results.push(entry);
  }
  for (const item of [...items].sort((a, b) => a.position - b.position)) {
    const snapshot = item.snapshot || {};
    if (item.selectionReason === 'trending-continuation') {
      continuedItems.push(snapshot);
      continue;
    }
    const sourceId = snapshot.sourceId || null;
    if (!bySource.has(sourceId)) {
      const source = { sourceId, sourceName: snapshot.sourceName || null, items: [] };
      bySource.set(sourceId, source);
      results.push(source);
    }
    bySource.get(sourceId).items.push(snapshot);
  }
  const trendingPolicy = selection.trendingPolicy
    ? {
      cooldownDays: selection.trendingPolicy.cooldownDays,
      suppressedCount: selection.trendingPolicy.suppressedCount,
      ...(selection.trendingPolicy.continuationLimit != null ? { continuationLimit: selection.trendingPolicy.continuationLimit } : {}),
      ...(selection.trendingPolicy.suppressed ? { suppressedItems: selection.trendingPolicy.suppressed } : {}),
      continuedItems,
    }
    : (continuedItems.length ? { continuedItems } : undefined);
  return {
    // 这些字段原样带回去：feed 的 pubDate 用 generatedAt，`check-report-identity` 用 observedDate，
    // `enhanced-report.js` 用 date。
    generatedAt: selection.generatedAt || null,
    date: selection.date || report.reportDate,
    observedDate: selection.observedDate || null,
    inputMode: selection.inputMode || null,
    publication: selection.publication || null,
    admission: selection.admission || null,
    ...(trendingPolicy ? { trendingPolicy } : {}),
    results,
  };
}

/**
 * 逐字段比较「旧链（raw + 渲染期准入）」与「新链（记录派生）」的 report 对象。
 * 返回差异清单；**空数组 = 派生无损**。
 */
function diffReportObjects(oldReport, newReport) {
  const differences = [];
  const record = (path, oldValue, newValue) => {
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) differences.push({ path, old: oldValue, new: newValue });
  };
  record('results.length', (oldReport.results || []).length, (newReport.results || []).length);
  const oldSources = (oldReport.results || []).map(source => source.sourceId);
  const newSources = (newReport.results || []).map(source => source.sourceId);
  record('results.sourceOrder', oldSources, newSources);
  const oldItems = D.reportItems(oldReport);
  const newItems = D.reportItems(newReport);
  record('items.count', oldItems.length, newItems.length);
  const key = (item) => `${item.sourceId}|${item.externalId}|${item.productId || ''}`;
  const oldKeys = oldItems.map(key);
  const newKeys = newItems.map(key);
  if (JSON.stringify(oldKeys) !== JSON.stringify(newKeys)) {
    const newSet = new Set(newKeys);
    const oldSet = new Set(oldKeys);
    differences.push({
      path: 'items.order',
      old: oldKeys.filter(k => !newSet.has(k)).slice(0, 5),
      new: newKeys.filter(k => !oldSet.has(k)).slice(0, 5),
      detail: { oldCount: oldKeys.length, newCount: newKeys.length, onlyOld: oldKeys.filter(k => !newSet.has(k)).length, onlyNew: newKeys.filter(k => !oldSet.has(k)).length },
    });
  }
  // 逐行逐字段比：冻结的发布行必须与旧链渲染出来的那一行一致
  const oldByKey = new Map(oldItems.map(item => [key(item), item]));
  let fieldMismatches = 0;
  const samples = [];
  for (const item of newItems) {
    const before = oldByKey.get(key(item));
    if (!before) continue;
    for (const field of ['title', 'summary', 'url', 'githubUrl', 'author', 'publishedAt', 'externalId', 'sourceId']) {
      if (JSON.stringify(before[field]) !== JSON.stringify(item[field])) {
        fieldMismatches += 1;
        if (samples.length < 5) samples.push({ key: key(item), field, old: before[field], new: item[field] });
      }
    }
  }
  record('items.fieldMismatches', 0, fieldMismatches);
  if (samples.length) differences.push({ path: 'items.fieldSamples', old: null, new: samples });
  // 持续热门**逐条**比（不只比条数）：它们不在 `D.reportItems` 里，只比长度的话内容被改也发现不了
  const continuationKey = (item) => `${item.sourceId || ''}|${item.githubUrl || item.url || ''}|${item.title || ''}`;
  const oldContinued = (oldReport.trendingPolicy?.continuedItems || []).map(continuationKey);
  const newContinued = (newReport.trendingPolicy?.continuedItems || []).map(continuationKey);
  record('trendingPolicy.continuedItems', oldContinued, newContinued);
  record('trendingPolicy.cooldownDays', oldReport.trendingPolicy?.cooldownDays, newReport.trendingPolicy?.cooldownDays);
  record('trendingPolicy.suppressedCount', oldReport.trendingPolicy?.suppressedCount, newReport.trendingPolicy?.suppressedCount);
  record('generatedAt', oldReport.generatedAt || null, newReport.generatedAt || null);
  record('observedDate', oldReport.observedDate || null, newReport.observedDate || null);
  record('publication', oldReport.publication || null, newReport.publication || null);
  return differences;
}

module.exports = { deriveReportFromRecord, diffReportObjects };
