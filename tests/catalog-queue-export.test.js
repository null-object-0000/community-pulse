/**
 * 离线补跑链（`export-queue.js` + `enrich-queue.js`）的回归用例。
 *
 * 守的是**「离线补跑的 run id 与日更链同源」**：`stableRunId` 把
 * `date + mode + processorVersion + promptVersion + taxonomyVersion` 算进 run id，而
 * `enrich-queue.js` 用 `stableRunId` 的结果去读「该 run 的既有状态」。这两处只要有一处漏了
 * `mode`（或用了不同的版本），读到的就是**另一个 run** 的状态行 —— 续跑判定失效、整批被当成
 * 新的重新付费，而钱花掉了才看得出来。所以这里把「同源」钉成断言，而不是靠人记得。
 *
 * 第二件不能退化的事：假 db **不许对不认识的查询静默返回空数组** —— 那会把「查不到状态」
 * 伪装成「全新一批」，同样是静默重付。
 *
 * 纯函数层，不需要数据库。
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  stableRunId, MODE, PROCESSOR_VERSION,
} = require('../scripts/catalog/enrich-products.js');
const { fakeDb } = require('../scripts/catalog/enrich-queue.js');

test('run id 把 mode 算进去（漏了就会读错 run 的状态）', () => {
  const withMode = stableRunId({ date: '2026-09-22', mode: MODE, processorVersion: PROCESSOR_VERSION });
  const withoutMode = stableRunId({ date: '2026-09-22', processorVersion: PROCESSOR_VERSION });
  assert.notStrictEqual(withMode, withoutMode, 'mode 必须影响 run id');
  assert.equal(MODE, 'shadow', 'mode 常量必须是 shadow（激活是单独的受审操作）');
});

test('run id 同参数稳定可复现（续跑才认得同一天）', () => {
  const a = stableRunId({ date: '2026-09-22', mode: MODE, processorVersion: PROCESSOR_VERSION });
  const b = stableRunId({ date: '2026-09-22', mode: MODE, processorVersion: PROCESSOR_VERSION });
  assert.equal(a, b);
  const other = stableRunId({ date: '2026-09-21', mode: MODE, processorVersion: PROCESSOR_VERSION });
  assert.notStrictEqual(a, other, '不同日期必须是不同 run');
});

test('假 db 对不认识的查询抛错，不静默返回空', async () => {
  const db = fakeDb({ rows: [], statusRows: [], log: () => {} });
  await assert.rejects(() => db.select('SELECT something_unexpected FROM nowhere'), /不认识这个查询/);
});

test('假 db 如实回答 schema 前置检查（0005 的列都在）', async () => {
  const db = fakeDb({ rows: [], statusRows: [], log: () => {} });
  const rows = await db.select('SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE 1');
  const byKey = new Map(rows.map((r) => [`${r.TABLE_NAME}.${r.COLUMN_NAME}`, r.COLUMN_TYPE]));
  assert.ok(String(byKey.get('enrichment_product_status.status')).includes('skipped_no_input'));
  assert.ok(byKey.has('enrichment_runs.summary_json'));
});

test('假 db 的重入臂返回空集（离线不重放历史跳过项）', async () => {
  const db = fakeDb({ rows: [], statusRows: [], log: () => {} });
  const rows = await db.select('SELECT s.product_id, s.status AS previous_status, s.input_hash AS previous_input_hash FROM enrichment_product_status s WHERE 1');
  assert.deepEqual(rows, []);
});
