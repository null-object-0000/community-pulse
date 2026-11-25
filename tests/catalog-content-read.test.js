/**
 * `product_content` 读取端（`worker/catalog-api.mjs` 的 `attachProductContent` / `mergeContent`）的回归用例。
 *
 * 守的是**「页面上的产品名为什么是中文」这条链**：`item_json` 是 `source-raw` 的投影，从不含 LLM
 * 增强结果，所以分类页与详情页的产品名一直是英文原文 —— 中文译文早就躺在 `product_content` 里
 * （travel-mobility 分类页 2,924 个产品里 2,916 个有中文行），缺的只是把值并进 item。
 *
 * 三条不能退化：
 *  ① 合并后的字段名必须是 `titleZh`/`summaryZh`/`titleEn`/`summaryEn` —— `D.displayTitle` 与
 *     `D.summary`（以及详情页的 `summaryOf`）只认这些名字，写错就是静默不显示；
 *  ② 中英文必须**一次取回两行**：Worker 同一份数据要渲染 `/`（中文）与 `/en/`（英文），
 *     而产品页的缓存键只含 pathname，按请求语言取一行会让另一种语言拿到错的语言；
 *  ③ 列表页要一次批量取（不能每个产品一次查询）—— 列表一页 60~300 行，N+1 会打穿 Hyperdrive。
 *
 * 纯函数层 + 假 db，不需要真实数据库。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WORKER = path.join(__dirname, '..', 'worker', 'catalog-api.mjs');

/** 读源码断言「某段实现存在」—— 读取端是模块内私有函数，没有导出面可测。 */
const source = fs.readFileSync(WORKER, 'utf8');

test('两种分页模式都在一次查询中取得当前双语内容', async () => {
  const { queryProducts } = await import('../worker/catalog-api.mjs');
  const ids = ['prd_000000000000000000000001', 'prd_000000000000000000000002'];
  const date = '2026-11-24';
  const item = { title: 'Original', summaryZh: '保留原始摘要', summaryEn: 'Old summary' };
  const rows = [
    { id: ids[0], date, itemJson: JSON.stringify(item), sourceIds: 'showhn', titleZh: '中文标题',
      summaryZh: '', titleEn: null, summaryEn: 'Current summary' },
    { id: ids[1], date },
  ];
  const filters = { sources: ['showhn'], facet: 'useCases', from: '2026-09-02', to: date };
  for (const allSources of [true, false]) {
    const statements = [];
    const db = { prepare(sql) {
      statements.push(sql);
      return { bind: () => ({ all: async () => ({ results: rows }) }) };
    } };
    const result = await queryProducts(db, filters, 'data-operations', [], { allSources, pageSize: 1 });
    assert.equal(statements.length, 1);
    const sql = statements[0];
    for (const locale of ['zh-CN', 'en']) {
      assert.ok(sql.includes(`locale = '${locale}' AND is_current = 1`));
    }
    assert.equal((sql.match(/ORDER BY created_at DESC LIMIT 1/g) || []).length, 2);
    assert.equal(result.count, 1);
    assert.equal(result.hasMore, true);
    assert.deepEqual(result.products.map(({ productId, title, titleZh, titleEn, summaryZh, summaryEn }) =>
      ({ productId, title, titleZh, titleEn, summaryZh, summaryEn })), [{
      productId: ids[0], title: 'Original', titleZh: '中文标题', titleEn: undefined,
      summaryZh: '保留原始摘要', summaryEn: 'Current summary',
    }]);
    assert.equal(result.nextCursor, allSources ? btoa(`${date}|${ids[0]}`) : null);
    assert.equal(result.nextPage, allSources ? null : 2);
  }
});

test('显式结束日期只查启用来源和空库状态，默认日期沿用最新观测', async () => {
  const { productFilters } = await import('../worker/catalog-api.mjs');
  const statements = [];
  let rows = [{ id: 'showhn', hasProducts: 1 }, { id: 'producthunt', hasProducts: 0 }];
  const db = { prepare(sql) {
    statements.push(sql);
    return { bind: () => ({ all: async () => ({ results: rows }) }) };
  } };
  const explicit = new URL('https://devtrends.site/api/v1/products?to=2026-11-24&sources=showhn');
  const selected = await productFilters(db, explicit);
  assert.equal(selected.filters.to, '2026-11-24');
  assert.equal(selected.filters.from, '2026-11-18');
  assert.deepEqual(selected.filters.sources, ['showhn']);
  assert.equal(selected.allSources, false);
  assert.match(statements[0], /EXISTS.*product_source_first_seen/);
  assert.doesNotMatch(statements[0], /COUNT|MIN|MAX/);
  assert.match(statements[0], /WHERE s.enabled = 1/);
  const unknown = new URL(explicit);
  unknown.searchParams.set('sources', 'unknown');
  await assert.rejects(() => productFilters(db, unknown), /unknown sources/);
  rows = [{ id: 'showhn', hasProducts: '0' }];
  assert.equal(await productFilters(db, explicit), null);
  rows = [{ id: 'showhn', lastSeenDate: '2026-11-23' }];
  const defaults = await productFilters(db, new URL('https://devtrends.site/api/v1/products'));
  assert.equal(defaults.filters.to, '2026-11-23');
  assert.equal(defaults.allSources, true);
});

test('一次取回中英两行（缓存键只有 pathname，同一份数据要能渲染两种语言）', () => {
  assert.match(source, /SELECT product_id AS productId, locale, title, summary/);
  assert.match(source, /byProduct\.get\(`\$\{row\.id\}\\0zh-CN`\)/);
  assert.match(source, /byProduct\.get\(`\$\{row\.id\}\\0en`\)/);
});

test('同产品同 locale 多行时取 created_at 最新的那行', () => {
  // PK 含 created_at，每次重跑都新增一行；不排序就会随机取到旧加工版本。
  assert.match(source, /ORDER BY product_id, locale, created_at DESC/);
  assert.match(source, /if \(!byProduct\.has\(key\)\) byProduct\.set\(key, row\)/);
});

test('读取端只认 is_current=1 —— 不自己发明「读 shadow」的第二套语义', () => {
  const block = source.slice(source.indexOf('async function attachProductContent'),
    source.indexOf('/** 把当前生效的双语字段并进 item'));
  assert.match(block, /AND is_current = 1/);
  assert.doesNotMatch(block, /is_current = 0/, 'shadow 行不该被读取端直接放出去');
});

test('0006 迁移为读取端补了索引（主键的 locale 夹在中间，过滤 is_current 会退化成回表）', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'mysql',
    '0006_product_content_read_index.sql'), 'utf8');
  assert.match(migration, /ALTER TABLE product_content/);
  assert.match(migration, /ADD KEY idx_content_current \(product_id, locale, is_current, created_at\)/);
});
