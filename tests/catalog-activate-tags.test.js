/**
 * 标签激活（`activate-enrichment.js --taxonomy`）的回归用例。
 *
 * 守的是**「同产品同 facet 只能有一行 current」**：读端只按 `is_current=1` 过滤、不看
 * `assignment_source`，所以两批 LLM 标签同时 current 会让分面计数翻倍。
 *
 * 2026-09-23 实测踩过：激活 `catalog-localize-v1` 时 `--versions` 只传了自己，
 * 「保护更高优先级版本」的闸整体失效，travel 那批 8,214 行正文被误撤。
 * 标签侧同一批 4,107 个产品上有 330 个冲突对 —— 所以保护必须**自动推导**，
 * 不能指望调用方记得传全。
 *
 * 纯函数层，不需要数据库。
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildStatements, parseArgs, higherPriorityVersions, VERSION_PRIORITY,
} = require('../scripts/catalog/activate-enrichment.js');

test('优先级列表按高到低，最高优先级没有要保护的版本', () => {
  assert.deepStrictEqual(VERSION_PRIORITY, ['travel-localize-v1', 'catalog-localize-v1']);
  assert.deepStrictEqual(higherPriorityVersions('travel-localize-v1'), []);
});

test('低优先级版本自动保护高优先级版本（不需要调用方传全）', () => {
  assert.deepStrictEqual(higherPriorityVersions('catalog-localize-v1'), ['travel-localize-v1']);
});

test('不在优先级列表里的版本不产生保护语句（无从判断谁高谁低）', () => {
  assert.deepStrictEqual(higherPriorityVersions('some-future-v1'), []);
});

test('不传 protectVersions 时只有「提为 current + 撤规则」两条（向后兼容）', () => {
  const statements = buildStatements('travel-localize-v1');
  assert.strictEqual(statements.length, 2);
  assert.ok(statements[0].includes('SET is_current=1'));
  assert.ok(statements[1].includes("assignment_source='rule'"));
  // languages 是规则独占 facet，撤规则时必须保留。
  assert.ok(statements[1].includes("facet NOT IN ('languages')"));
});

test('传了 protectVersions 时追加「让位给高优先级」的第三条', () => {
  const statements = buildStatements('catalog-localize-v1', ['travel-localize-v1']);
  assert.strictEqual(statements.length, 3);
  const demote = statements[2];
  assert.ok(demote.includes('SET ta.is_current=0'));
  assert.ok(demote.includes("hi.processor_version IN ('travel-localize-v1')"));
  assert.ok(demote.includes("ta.processor_version='catalog-localize-v1'"));
  // 必须按 facet 对齐：不同 facet 上的标签不该互相挤掉。
  assert.ok(demote.includes('hi.facet = ta.facet'));
  // 必须是自连接 —— MySQL 不允许在 UPDATE 子查询里引用目标表。
  assert.ok(!/UPDATE taxonomy_assignments[\s\S]*IN \(\s*SELECT/i.test(demote));
});

test('--protect 可显式覆盖自动推导', () => {
  const options = parseArgs(['--processor-version', 'catalog-localize-v1', '--protect', 'a-v1,b-v1', '--dry-run']);
  assert.deepStrictEqual(options.protect, ['a-v1', 'b-v1']);
});
