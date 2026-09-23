/**
 * 离线增强的第二跳（`apply-sql.js`）的回归用例。
 *
 * 这里守的是**交接面**：本机跑完模型后把结果写成一份 SQL 文件，由有 Cloudflare 凭据的一方
 * 应用。文件是唯一契约，所以两件事必须成立 ——
 *  ① 分句与通道 Worker 的 `splitSql` 判断一致（引号里的分号是最常见的分歧点，一旦分歧，
 *     语句计数就是假的，「这批 SQL 会做什么」也就无从判断）；
 *  ② 只写 shadow（`is_current=0`），激活不被自动流水线代做。
 *
 * 纯函数层，不需要数据库。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { splitSql, assertShadowOnly, summarize } = require('../scripts/catalog/apply-sql.js');

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

test('shadow 闸拦下任何 is_current=1（激活不是这条流水线的职责）', () => {
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

test('--allow-activation 是受审入口：放行 taxonomy_assignments 的激活，其余仍拒绝', () => {
  const activation = ["UPDATE taxonomy_assignments SET is_current=1 WHERE processor_version='travel-localize-v1'"];
  // 不传开关 → 拒绝（默认永远是 shadow）。
  assert.throws(() => assertShadowOnly(activation), /--allow-activation/);
  // 传开关且形状正确 → 放行。
  assert.doesNotThrow(() => assertShadowOnly(activation, { allowActivation: true }));
  // 传开关但改的是别的表 → 仍然拒绝（开关不是万能钥匙）。
  assert.throws(
    () => assertShadowOnly(["UPDATE product_content SET is_current=1 WHERE product_id='x'"],
      { allowActivation: true }),
    /不是 taxonomy_assignments 的激活形状/,
  );
  // 混入一条越界的激活语句，整批都要被拒。
  assert.throws(
    () => assertShadowOnly([...activation, "UPDATE products SET is_current=1 WHERE id='x'"],
      { allowActivation: true }),
    /不是 taxonomy_assignments 的激活形状/,
  );
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
