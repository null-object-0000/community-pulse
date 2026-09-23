/**
 * 离线增强的第二跳（`apply-sql.js`）的回归用例。
 *
 * 这里守的是**交接面**：本机跑完模型后把结果写成一份 SQL 文件，由有 Cloudflare 凭据的一方
 * 应用。文件是唯一契约，所以三件事必须成立 ——
 *  ① 分句与通道 Worker 的 `splitSql` 判断一致（引号里的分号是最常见的分歧点，一旦分歧，
 *     语句计数就是假的，「这批 SQL 会做什么」也就无从判断）；
 *  ② 文件里只写 shadow（`is_current=0`）—— 上架不靠文件带激活语句；
 *  ③ **写库后自动上架**：从 SQL 里认出加工版本、按优先级顺序上架、并产出回滚稿。
 *
 * 第 ③ 条是 2026-09-23 事故的修复：原来的纪律是「输出 shadow，激活是单独的受审操作」，
 * 而那道「人工关卡」实际什么都没拦 —— `catalog-localize-v1` 的 35,893 条标签跑完 7 天
 * 从没激活过，网站一直用规则推断，页面看起来毫无变化。
 *
 * 纯函数层，不需要数据库。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  splitSql, assertShadowOnly, summarize, detectVersions, buildRollbackFor,
} = require('../scripts/catalog/apply-sql.js');
const { buildStatements, higherPriorityVersions, VERSION_PRIORITY } = require('../scripts/catalog/activate-enrichment.js');

/**
 * `worker/catalog-import.mjs` 的 `splitSql` 的逐字复刻。写在测试里而不是 import 过来：
 * Worker 与脚本运行在不同运行时（Worker 用的是模块 worker，本地脚本是 node），
 * 这份复刻就是「两边必须一致」的那条断言本身 —— Worker 那边的实现改了而这里没改，
 * 说明契约被单方面改动了，测试应当红。
 */
function workerSplitSql(sql) {
  const result = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    if (sql[index] === "'") {
      if (quoted && sql[index + 1] === "'") index += 1;
      else quoted = !quoted;
    } else if (sql[index] === ';' && !quoted) {
      const statement = sql.slice(start, index).trim();
      if (statement) result.push(statement);
      start = index + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

const CASES = [
  ['空文件', ''],
  ['只有分号与空白', ';  ;\n\t;'],
  ['单条无尾分号', 'SELECT 1'],
  ['单条有尾分号', 'SELECT 1;'],
  ['两条', 'SELECT 1;\nSELECT 2;'],
  // 引号里的分号不能当分隔符 —— 摘要正文里出现分号是常态。
  ['字符串里的分号', "INSERT INTO t VALUES ('a;b;c');"],
  // SQL 转义的单引号（''）不能让引号状态翻转，否则后面整段都被当成字符串。
  ['转义单引号后仍能分句', "INSERT INTO t VALUES ('it''s here');\nSELECT 2;"],
  ['中文与换行的多行 INSERT', "INSERT INTO t VALUES ('第一行\n第二行；分号在内');\nSELECT '完';"],
  ['多行 INSERT 自身含分号', "INSERT INTO t VALUES ('a;b'),('c;d');"],
];

test('splitSql 与 Worker 的分句判断逐条一致', () => {
  for (const [name, sql] of CASES) {
    assert.deepEqual(splitSql(sql), workerSplitSql(sql), `分句不一致：${name}`);
  }
});

test('splitSql 不把字符串里的分号当成语句边界', () => {
  const statements = splitSql("INSERT INTO t VALUES ('a;b;c');");
  assert.equal(statements.length, 1);
  assert.equal(statements[0], "INSERT INTO t VALUES ('a;b;c')");
});

test('splitSql 丢掉空语句但保留最后一条无分号的语句', () => {
  assert.deepEqual(splitSql('SELECT 1;;\n\nSELECT 2'), ['SELECT 1', 'SELECT 2']);
});

test('shadow 闸拦下任何 is_current=1（文件里不该带激活语句）', () => {
  assert.throws(
    () => assertShadowOnly(["UPDATE product_content SET is_current=1 WHERE product_id='x'"]),
    /is_current=1/,
  );
  // 换行与空格的不同写法都要拦住。
  assert.throws(() => assertShadowOnly(["UPDATE t SET\n  is_current = 1\nWHERE a=1"]), /is_current=1/);
  // 只有 is_current=0 时放行。
  assert.doesNotThrow(() => assertShadowOnly([
    "INSERT INTO product_content (product_id, locale, is_current) VALUES ('a','zh-CN',0)",
    "UPDATE enrichment_runs SET status='complete' WHERE id='r'",
  ]));
});

test('--allow-activation 仍可放行「手工激活稿」这一形状（自动上架走另一条路）', () => {
  const activation = ["UPDATE taxonomy_assignments SET is_current=1 WHERE processor_version='travel-localize-v1'"];
  // 不传开关 → 拒绝。
  assert.throws(() => assertShadowOnly(activation), /--allow-activation/);
  // 传开关且形状正确 → 放行（人工补激活稿仍用这条路）。
  assert.doesNotThrow(() => assertShadowOnly(activation, { allowActivation: true }));
  // 正文激活是第二种受审形状。
  assert.doesNotThrow(() => assertShadowOnly(
    ["UPDATE product_content pc SET pc.is_current = 1 WHERE pc.content_source = 'llm:travel-localize-v1'"],
    { allowActivation: true }));
  // 传开关但改的是别的表 → 仍然拒绝（开关不是万能钥匙）。
  assert.throws(
    () => assertShadowOnly(["UPDATE products SET is_current=1 WHERE id='x'"],
      { allowActivation: true }),
    /不是受审的激活形状/,
  );
  // 混入一条越界的激活语句，整批都要被拒。
  assert.throws(
    () => assertShadowOnly([...activation, "UPDATE sources SET is_current=1 WHERE id='x'"],
      { allowActivation: true }),
    /不是受审的激活形状/,
  );
});

// ── 自动上架 ────────────────────────────────────────────────────────────────

/** `enrich-products.js` 的 `resultBatchSql` 产出的两种形状，取真实片段。 */
const CONTENT_INSERT = "INSERT INTO product_content (product_id, locale, title, summary, content_source, enrichment_run_id, is_current) "
  + "VALUES ('prd_a','zh-CN','标题','摘要','llm:catalog-localize-v1','enr_1',0),('prd_a','en','Title','Summary','llm:catalog-localize-v1','enr_1',0)";
const ASSIGNMENT_INSERT = "INSERT INTO taxonomy_assignments (product_id, facet, term_id, assignment_source, confidence, processor_version, enrichment_run_id, is_current) "
  + "VALUES ('prd_a','primaryCategory','software-development','llm',NULL,'catalog-localize-v1','enr_1',0)";
const SHADOW_DELETES = [
  "DELETE FROM product_content WHERE product_id IN ('prd_a') AND content_source='llm:catalog-localize-v1' AND is_current=0",
  "DELETE FROM taxonomy_assignments WHERE product_id IN ('prd_a') AND assignment_source='llm' AND processor_version='catalog-localize-v1' AND is_current=0",
];

test('detectVersions 从 SQL 里认出加工版本（调用方不需要记得传）', () => {
  const statements = splitSql([...SHADOW_DELETES, CONTENT_INSERT, ASSIGNMENT_INSERT].join(';\n'));
  assert.deepEqual(detectVersions(statements).sort(), ['catalog-localize-v1']);
});

test('detectVersions 同时认出多批（同一份 SQL 里混了两个版本）', () => {
  const other = ASSIGNMENT_INSERT.replace(/catalog-localize-v1/g, 'travel-localize-v1');
  const statements = splitSql([ASSIGNMENT_INSERT, other].join(';\n'));
  assert.deepEqual(detectVersions(statements).sort(), ['catalog-localize-v1', 'travel-localize-v1']);
});

test('detectVersions 对认不出的语句返回空 —— 不猜、不乱上架', () => {
  assert.deepEqual(detectVersions(splitSql("INSERT INTO taxonomy_terms (facet,id) VALUES ('useCases','x')")), []);
  assert.deepEqual(detectVersions(splitSql("SELECT 1")), []);
  // 纯 DELETE 不构成「这批写了什么版本」。
  assert.deepEqual(detectVersions(splitSql(SHADOW_DELETES.join(';\n'))), []);
});

test('自动上架的语句按优先级从高到低排列（低优先级那步依赖高优先级已是 current）', () => {
  assert.deepEqual(VERSION_PRIORITY, ['travel-localize-v1', 'catalog-localize-v1']);
  // travel 是最高优先级 → 不需要保护任何人；catalog 必须让位给 travel。
  assert.deepEqual(higherPriorityVersions('travel-localize-v1'), []);
  assert.deepEqual(higherPriorityVersions('catalog-localize-v1'), ['travel-localize-v1']);
  // catalog 的三条语句里，第三条正是「让位」。
  const catalog = buildStatements('catalog-localize-v1', higherPriorityVersions('catalog-localize-v1'));
  assert.equal(catalog.length, 3);
  assert.match(catalog[2], /hi\.processor_version IN \('travel-localize-v1'\)/);
});

test('回滚稿把上架的版本整体退回 shadow（改线上数据必须有退路）', () => {
  const rollback = buildRollbackFor(['catalog-localize-v1']);
  assert.ok(rollback.length >= 3, `回滚语句太少：${rollback.length}`);
  // 标签：还原规则行 + 把自己的 LLM 行退回 shadow。
  assert.ok(rollback.some(s => /UPDATE taxonomy_assignments ta/.test(s) && /SET ta\.is_current=1/.test(s)));
  assert.ok(rollback.some(s => /UPDATE taxonomy_assignments SET is_current=0/.test(s)));
  // 正文：整体退回 shadow。
  assert.ok(rollback.some(s => /UPDATE product_content SET is_current = 0/.test(s)));
});

test('summarize 按语句种类计数', () => {
  const sql = [
    "INSERT INTO taxonomy_terms (facet,id) VALUES ('useCases','travel-mobility')",
    "INSERT INTO product_content (product_id) VALUES ('a')",
    "INSERT INTO product_content (product_id) VALUES ('b')",
    "INSERT INTO taxonomy_assignments (product_id) VALUES ('a')",
    "INSERT INTO enrichment_product_status (product_id) VALUES ('a')",
  ].join(';\n');
  const summary = summarize('x.sql', sql, splitSql(sql));
  assert.equal(summary.statements, 5);
  assert.equal(summary.kinds.content, 2);
  assert.equal(summary.kinds.assignments, 1);
  assert.equal(summary.kinds.status, 1);
  assert.equal(summary.kinds.terms, 1);
  assert.equal(summary.file, path.basename('x.sql'));
});
