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

test('列表查询一次批量取 product_content，不逐产品查询（N+1）', () => {
  // attachProductContent 必须在 productRows 的 map 之外调用。
  assert.match(source, /async function productRows\(db, rows/);
  assert.match(source, /await attachProductContent\(db, rows\.slice\(0, pageSize\), timings\);/);
  // 批量形状：IN (?, ?, …) + 单次 all()，而不是在 map 里 prepare。
  assert.match(source, /WHERE product_id IN \(\$\{placeholders\}\) AND is_current = 1/);
  assert.doesNotMatch(source, /products\.map\(async/);
});

test('两处列表查询与详情查询都接上了读取端', () => {
  const calls = source.match(/attachProductContent\(/g) || [];
  // 一处定义 + 三处调用（productRows 内、详情查询内）。
  assert.equal(calls.length, 3, `attachProductContent 调用点应为 2 处 + 定义 1 处，实际 ${calls.length}`);
  const awaited = source.match(/await productRows\(db, rows/g) || [];
  assert.equal(awaited.length, 2, '两处 productRows 调用都必须 await（它现在是 async）');
});

test('合并只写 D.displayTitle / D.summary / summaryOf 认得的字段名', () => {
  // 这些是渲染层唯一的取值键；改名等于静默不显示。
  for (const key of ['titleZh', 'summaryZh', 'titleEn', 'summaryEn']) {
    assert.match(source, new RegExp(`merged\\.${key} = row\\.content`), `mergeContent 必须写 ${key}`);
  }
  // 不能被 item_json 里的空值顶掉：只在有值时才覆盖。
  assert.match(source, /if \(row\.contentZh\) \{/);
  assert.match(source, /if \(row\.contentZh\.title\) merged\.titleZh/);
  assert.match(source, /if \(row\.contentZh\.summary\) merged\.summaryZh/);
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
    source.indexOf('/** 把 attachProductContent 取到的两行并进 detail item'));
  assert.match(block, /AND is_current = 1/);
  assert.doesNotMatch(block, /is_current = 0/, 'shadow 行不该被读取端直接放出去');
});

test('0006 迁移为读取端补了索引（主键的 locale 夹在中间，过滤 is_current 会退化成回表）', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'mysql',
    '0006_product_content_read_index.sql'), 'utf8');
  assert.match(migration, /ALTER TABLE product_content/);
  assert.match(migration, /ADD KEY idx_content_current \(product_id, locale, is_current, created_at\)/);
});
