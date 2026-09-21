/**
 * 第二批「发布层」：发布记录（`reports` + `report_items`）的回归用例。
 *
 * 分三层：
 *  ① 纯函数层：记录的内容与顺序、准入冻结、持续热门、SQL 文本纪律；
 *  ② 真实数据层：拿仓库里**已发布的**历史日报跑一遍，检查记录的不变量；
 *  ③ 集成层：对着真 MySQL 写进去再读回来（没有可达的 MySQL 时跳过）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const D = require('../web/shared.js');
const {
  buildReportRecord, reportRecordSql, reportId, parseArgs, mysqlDateTime,
  SELECTION_VERSION, LEGACY_SELECTION_VERSION,
} = require('../scripts/catalog/build-report-record.js');

const ROOT = path.join(__dirname, '..');
const RAW_DIR = path.join(ROOT, '知识', '大家都在做什么', 'raw');
// 自己的库名：`node --test` 并行跑测试文件，而集成用例会 DROP/CREATE 目标库 —— 两个文件共用
// `CP_MYSQL_URL` 指向的那个库就会互相删表。所以这里只借用它的 host/port/凭据，库名固定成自己的。
const MYSQL_URL = (() => {
  const url = new URL(process.env.CP_MYSQL_URL || 'mysql://root:root@127.0.0.1:13306/devtrends_report_test');
  url.pathname = '/devtrends_report_test';
  return url.toString();
})();
const MIGRATIONS = ['0001_catalog', '0002_enrichment_product_status', '0003_first_seen_covering_index',
  '0004_dynamic_product_pages', '0005_enrichment_run_cost', '0006_report_selection'];

function rawReport(dates = {}) {
  return {
    generatedAt: '2026-09-20T01:00:00.000Z',
    date: '2026-09-20',
    observedDate: '2026-09-21',
    publication: { schemaVersion: 1, taxonomyVersion: D.taxonomyVersion, selectionVersion: SELECTION_VERSION, sourceRaw: [{ sourceId: 'showhn', path: 'x', contentSha256: 'a'.repeat(64), targetDate: '2026-09-20' }] },
    results: [
      { sourceId: 'showhn', sourceName: 'Show HN', items: [
        { productId: 'prd_a', title: 'Alpha', externalId: '1', url: 'https://a.example', summary: 'A' },
        { productId: 'prd_b', title: 'Beta', externalId: '2', url: 'https://b.example', summary: 'B' },
      ] },
      { sourceId: 'v2ex', sourceName: 'V2EX·分享创造', items: [
        { productId: 'prd_c', title: 'Gamma', externalId: '3', url: 'https://c.example', summary: 'C' },
      ] },
    ],
    trendingPolicy: {
      cooldownDays: 3, continuationLimit: 3, suppressedCount: 4,
      suppressedItems: [
        { sourceId: 'github-trending', externalId: 'x/y', title: 'X/Y', githubUrl: 'https://github.com/x/y', trendingContinuation: { cooldownDays: 3, recentAppearances: 2 } },
      ],
      continuedItems: [
        { sourceId: 'github-trending', title: 'X/Y', githubUrl: 'https://github.com/x/y', metrics: { today: 42 }, trendingContinuation: { cooldownDays: 3, recentAppearances: 2 } },
      ],
    },
    ...dates,
  };
}

// ---- ① 纯函数层 ------------------------------------------------------------------------------

test('report record keeps publication order and freezes each row with its source', () => {
  const record = buildReportRecord(rawReport(), '2026-09-20');
  assert.equal(record.report.id, reportId('2026-09-20'));
  assert.equal(record.report.reportDate, '2026-09-20');
  assert.equal(record.report.status, 'published');
  assert.equal(record.report.publishedAt, '2026-09-20T01:00:00.000Z');
  // 一期一行：双语在同一行，站点本来就从同一个 report 对象渲染中英两版
  assert.equal(record.report.locale, 'zh-CN');
  // 顺序 = 发布顺序（results → source → items），持续热门排在主列表之后
  const continuationId = record.items[3].productId;
  assert.match(continuationId, /^prd_[a-f0-9]{24}$/, '持续热门那行也要有身份（按同一份实现算）');
  assert.deepEqual(record.items.map(item => item.productId), ['prd_a', 'prd_b', 'prd_c', continuationId]);
  assert.deepEqual(record.items.map(item => item.position), [0, 1, 2, 3]);
  assert.deepEqual(record.items.map(item => item.selectionReason),
    ['source:showhn', 'source:showhn', 'source:v2ex', 'trending-continuation']);
  // 冻结的发布行必须带来源，否则渲染期无法还原 results[] 的分区
  assert.equal(record.items[0].snapshot.sourceId, 'showhn');
  assert.equal(record.items[0].snapshot.sourceName, 'Show HN');
  assert.equal(record.items[2].snapshot.sourceId, 'v2ex');
  // 持续热门那几行在 snapshot 里也要有来源
  assert.equal(record.items[3].snapshot.sourceId, 'github-trending');
});

test('report record freezes the admission decision instead of recomputing it at render time', () => {
  const report = rawReport();
  // 【上海招聘】这类会被判成招聘广告并排除（issue-admission-v2）；注意准入只对**投稿类来源**
  // 生效（weekly-issues / hellogithub-issues），放进 showhn 是测不到的。
  report.results.push({ sourceId: 'weekly-issues', sourceName: '阮一峰周刊·用户投稿', items: [
    { productId: 'prd_ad', title: '【上海招聘】资深前端工程师', externalId: '9', url: 'https://ad.example' },
  ] });
  const record = buildReportRecord(report, '2026-09-20');
  assert.ok(!record.items.some(item => item.productId === 'prd_ad'), '被排除的条目不能进发布记录');
  const decisions = record.report.selection.admission.decisions;
  assert.equal(record.report.selection.admission.version, 'issue-admission-v2');
  assert.ok(decisions.some(decision => decision.status === 'excluded' && decision.externalId === '9'),
    '排除决策必须冻进记录 —— 否则改规则会把历史日报悄悄改写');
  // 被排除的行不该出现在任何 items 的 snapshot 里
  assert.ok(!record.items.some(item => JSON.stringify(item.snapshot).includes('prd_ad')));
});

test('report record carries the selection rules, the suppressed list and the versions', () => {
  const record = buildReportRecord(rawReport(), '2026-09-20');
  const selection = record.report.selection;
  assert.equal(record.report.selectionVersion, SELECTION_VERSION);
  assert.equal(selection.selectionVersion, SELECTION_VERSION);
  assert.equal(selection.observedDate, '2026-09-21');
  assert.equal(selection.publication.taxonomyVersion, D.taxonomyVersion);
  assert.equal(selection.trendingPolicy.cooldownDays, 3);
  assert.equal(selection.trendingPolicy.suppressedCount, 4);
  assert.equal(selection.trendingPolicy.continuationLimit, 3);
  // 「这期为什么没有 X」：被冷却压制的条目要留身份
  assert.deepEqual(selection.trendingPolicy.suppressed.map(item => item.externalId), ['x/y']);
  assert.equal(selection.trendingPolicy.suppressed[0].recentAppearances, 2);
  // 历史日报没有 publication.selectionVersion → 冻成 legacy，不假装它按现行规则选的
  const legacy = buildReportRecord({ ...rawReport(), publication: undefined }, '2026-01-01');
  assert.equal(legacy.report.selectionVersion, LEGACY_SELECTION_VERSION);
  assert.equal(legacy.report.selection.publication, null);
});

test('report record computes identity with the shared implementation when the row has no productId', () => {
  const report = rawReport();
  delete report.results[0].items[0].productId;
  report.results[0].items[0].githubUrl = 'https://github.com/Owner/Repo';
  const record = buildReportRecord(report, '2026-09-20');
  const { identityFor, productId } = require('../scripts/catalog/identity.js');
  assert.equal(record.items[0].productId, productId(identityFor({ githubUrl: 'https://github.com/Owner/Repo' })));
  assert.match(record.items[0].productId, /^prd_[a-f0-9]{24}$/);
});

test('report record SQL is idempotent, uses multi-row inserts and never a prepared statement', () => {
  const record = buildReportRecord(rawReport(), '2026-09-20');
  const statements = reportRecordSql(record);
  assert.equal(statements.length, 3, 'reports upsert + 清空本期 items + items 多行插入');
  assert.match(statements[0], /^INSERT INTO reports /);
  assert.match(statements[0], /ON DUPLICATE KEY UPDATE/);
  assert.match(statements[0], /published_at=COALESCE\(reports\.published_at, VALUES\(published_at\)\)/,
    '重跑不能把首次发布时间冲掉');
  assert.match(statements[1], /^DELETE FROM report_items WHERE report_id='rpt_20260920'$/,
    'position 上有唯一键，条目变少时旧行会抢位置，所以先清本期');
  assert.match(statements[2], /^INSERT INTO report_items /);
  assert.equal((statements[2].match(/\('rpt_20260920', 'prd_/g) || []).length, 4, '一批 4 行一条语句');
  // source_item_id 恒为 NULL：它 FK 到 source_items，而那张表从来没被写入过
  assert.equal((statements[2].match(/, NULL, \d+, /g) || []).length, 4);
  const text = statements.join('\n');
  assert.doesNotMatch(text, /\bPREPARE\b/i, 'Hyperdrive 不支持 SQL 级 prepared statement');
  assert.doesNotMatch(text, /\bINSERT IGNORE\b/i);
  // 没有 items 的一期只写 reports 行
  assert.equal(reportRecordSql({ report: record.report, items: [] }).length, 2);
});

test('report record writes published_at in MySQL datetime form, never ISO with T and Z', () => {
  // DATETIME(3) 收不了 '2026-09-20T01:00:00.000Z' —— 批次 1 在 product_content.created_at
  // 上踩过同一个坑，这里由集成用例挡下；这条断言是纯函数层的同一道守卫。
  assert.equal(mysqlDateTime('2026-09-20T01:00:00.000Z'), '2026-09-20 01:00:00.000');
  assert.equal(mysqlDateTime('not a date'), null);
  assert.equal(mysqlDateTime(null), null);
  const statement = reportRecordSql(buildReportRecord(rawReport(), '2026-09-20'))[0];
  assert.match(statement, /'2026-09-20 01:00:00\.000'/);
  assert.doesNotMatch(statement, /'\d{4}-\d{2}-\d{2}T/, 'SQL 里不能出现 ISO 的 T 形式');
  // 没有 generatedAt 的历史日报退回 CURRENT_TIMESTAMP(3)
  const noTimestamp = buildReportRecord({ ...rawReport(), generatedAt: undefined }, '2026-01-01');
  assert.match(reportRecordSql(noTimestamp)[0], /CURRENT_TIMESTAMP\(3\)/);
});

test('report record SQL escapes quotes in frozen rows and in the selection blob', () => {
  const report = rawReport();
  report.results[0].items[0].title = "It's a \\ backslash";
  report.results[0].items[0].summary = "含 ' 单引号";
  const statements = reportRecordSql(buildReportRecord(report, '2026-09-20'));
  const items = statements[2];
  // 单引号翻倍、反斜杠翻倍（JSON 一层 + SQL 一层），往返保真由集成层验
  assert.match(items, /It''s a /);
  assert.match(items, /含 '' 单引号/);
  assert.doesNotMatch(items, /'\{"productId":"prd_a","title":"It's /, '原文里的裸单引号不能出现在 SQL 里');
});

test('report record CLI validates its inputs', () => {
  assert.throws(() => parseArgs([]), /需要 --date/);
  assert.throws(() => parseArgs(['--date', '2026-9-1']), /YYYY-MM-DD/);
  assert.throws(() => parseArgs(['--date', '2026-09-01', '--nope']), /unknown argument/);
  assert.equal(parseArgs(['--date', '2026-09-01']).date, '2026-09-01');
  assert.equal(parseArgs(['--all', '--channel']).all, true);
  assert.equal(parseArgs(['--all', '--force']).force, true);
});

// ---- 派生端（记录 → 日报对象）------------------------------------------------------------------

test('deriving the report from the record reproduces the old chain field by field', () => {
  // 这是第二批的**核心不变量**：旧链 = raw → admitReport（渲染期准入）；新链 = report_items →
  // 派生。派生之后两步（合并 final、图片本地化）两边共用，所以这两者必须逐字段相同 ——
  // 差一点就说明「从记录派生」会改变线上内容。
  const { deriveReportFromRecord, diffReportObjects } = require('../scripts/catalog/derive-report.js');
  const { admitReport } = require('../.agents/skills/community-pulse/scripts/issue-admission.js');
  const dates = fs.readdirSync(RAW_DIR).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map(name => name.slice(0, 10)).sort();
  const sample = [...dates.slice(0, 1), ...dates.slice(-5), dates[Math.floor(dates.length / 2)]];
  for (const date of sample) {
    const raw = JSON.parse(fs.readFileSync(path.join(RAW_DIR, `${date}.json`), 'utf8'));
    const oldReport = admitReport(raw);
    const newReport = deriveReportFromRecord(buildReportRecord(raw, date));
    assert.deepEqual(diffReportObjects(oldReport, newReport), [], `${date}：从记录派生必须无损`);
  }
});

test('derivation keeps the source order and the empty source groups', () => {
  const { deriveReportFromRecord } = require('../scripts/catalog/derive-report.js');
  // 某个来源的条目全被排除时，旧链仍然保留这个分组（items: []），派生也必须保留 ——
  // renderMarkdown 是 results → source → items 渲染的，来源顺序与来源名都是发布内容。
  const report = rawReport();
  report.results.push({ sourceId: 'hellogithub-issues', sourceName: 'HelloGitHub·用户投稿', items: [] });
  const record = buildReportRecord(report, '2026-09-20');
  const derived = deriveReportFromRecord(record);
  assert.deepEqual(derived.results.map(source => source.sourceId), ['showhn', 'v2ex', 'hellogithub-issues']);
  assert.deepEqual(derived.results[2], { sourceId: 'hellogithub-issues', sourceName: 'HelloGitHub·用户投稿', items: [] });
  // 持续热门回到 trendingPolicy，不混进 results
  assert.equal(derived.trendingPolicy.continuedItems.length, 1);
  assert.equal(derived.trendingPolicy.cooldownDays, 3);
  // 透传字段
  assert.equal(derived.generatedAt, '2026-09-20T01:00:00.000Z');
  assert.equal(derived.observedDate, '2026-09-21');
  assert.equal(derived.publication.selectionVersion, SELECTION_VERSION);
  assert.equal(derived.admission.version, 'issue-admission-v2');
});

test('chain diff reports what changed and stays empty for equal reports', () => {
  const { deriveReportFromRecord, diffReportObjects } = require('../scripts/catalog/derive-report.js');
  const record = buildReportRecord(rawReport(), '2026-09-20');
  const derived = deriveReportFromRecord(record);
  assert.deepEqual(diffReportObjects(derived, deriveReportFromRecord(record)), []);
  // 少一行主列表（外键筛掉的情形）必须报出来，而不是静默
  const shrunk = deriveReportFromRecord({ ...record, items: record.items.filter(item => item.productId !== 'prd_b') });
  const differences = diffReportObjects(derived, shrunk);
  assert.ok(differences.some(diff => diff.path === 'items.count'), '行数变化必须报出来');
  assert.ok(differences.some(diff => diff.path === 'items.order'));
  // 持续热门不在 D.reportItems 里，要单独逐条比
  const noContinuation = deriveReportFromRecord({ ...record, items: record.items.filter(item => item.selectionReason !== 'trending-continuation') });
  assert.ok(diffReportObjects(derived, noContinuation).some(diff => diff.path === 'trendingPolicy.continuedItems'),
    '持续热门少了也要报出来');
  // 字段级差异也要报
  const tweaked = { ...record, items: record.items.map((item, index) => index === 0 ? { ...item, snapshot: { ...item.snapshot, title: '改了标题' } } : item) };
  assert.ok(diffReportObjects(derived, deriveReportFromRecord(tweaked)).some(diff => diff.path === 'items.fieldMismatches'));
});

// ---- ② 真实数据层 ----------------------------------------------------------------------------

test('report records built from published reports keep their invariants', () => {
  const dates = fs.readdirSync(RAW_DIR).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map(name => name.slice(0, 10)).sort();
  assert.ok(dates.length > 200, '仓库里应当有 200 期以上的已发布日报');
  // 抽最新 3 期 + 最早 1 期（历史产物与现行产物都要覆盖）
  const sample = [...dates.slice(-3), dates[0]];
  for (const date of sample) {
    const raw = JSON.parse(fs.readFileSync(path.join(RAW_DIR, `${date}.json`), 'utf8'));
    const record = buildReportRecord(raw, date);
    const reportRows = D.reportItems(raw).length;
    // 记录里的行 = 报告行（去重后）+ 持续热门（折叠展示，也算发布）
    const continuations = record.items.filter(item => item.selectionReason === 'trending-continuation').length;
    assert.ok(record.items.length >= reportRows, `${date}: 记录行数不该少于报告行数`);
    assert.equal(record.items.length - continuations, reportRows, `${date}: 主列表行数应当与报告行数一致`);
    assert.ok(continuations <= 3, `${date}: 持续热门上限 3`);
    // position 必须连续且从 0 开始（唯一键 + 发布顺序）
    assert.deepEqual(record.items.map(item => item.position), record.items.map((_, index) => index), `${date}: position 必须连续`);
    // 每行都要有 product_id（否则 FK 会挡住整批）
    for (const item of record.items) assert.match(item.productId, /^prd_[a-f0-9]{24}$/, `${date}: ${item.productId}`);
    // 记录里的 product_id 必须是**报告行本身**算出来的那个（不许在这里重算身份）
    const expected = new Set(D.reportItems(raw).map(item => item.productId || null).filter(Boolean));
    if (expected.size === reportRows) {
      for (const item of record.items.filter(entry => entry.selectionReason.startsWith('source:'))) {
        assert.ok(expected.has(item.productId), `${date}: ${item.productId} 不在报告行的身份集合里`);
      }
    }
    assert.equal(record.report.selectionVersion, raw.publication?.selectionVersion || LEGACY_SELECTION_VERSION);
  }
});

// ---- ③ 集成层（真 MySQL） ---------------------------------------------------------------------

async function withDatabase(t) {
  const mysql = require('mysql2/promise');
  const url = new URL(MYSQL_URL);
  const database = url.pathname.replace(/^\//, '') || 'devtrends_report_test';
  const base = { host: url.hostname, port: Number(url.port || 3306), user: url.username, password: url.password, connectTimeout: 3000 };
  let connection;
  try {
    const admin = await mysql.createConnection(base);
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.query(`CREATE DATABASE \`${database}\``);
    await admin.end();
    connection = await mysql.createConnection({ ...base, database, dateStrings: true });
  } catch (error) {
    t.skip(`没有可达的 MySQL（${MYSQL_URL}）：${error.message}`);
    return null;
  }
  const splitSql = (sql) => {
    const source = fs.readFileSync(path.join(ROOT, 'worker', 'catalog-import.mjs'), 'utf8');
    const start = source.indexOf('export function splitSql');
    const end = source.indexOf('\nexport default');
    return new Function(`${source.slice(start, end).replace('export function splitSql', 'function splitSql')}; return splitSql;`)()(sql);
  };
  for (const name of MIGRATIONS) {
    for (const statement of splitSql(fs.readFileSync(path.join(ROOT, 'migrations', 'mysql', `${name}.sql`), 'utf8'))) {
      await connection.query(statement);
    }
  }
  return { connection };
}

function makeDb(connection) {
  return {
    select: async (sql) => (await connection.query(sql))[0],
    execute: async (sql) => { await connection.query(sql); },
    batch: async (statements) => {
      if (!statements.length) return;
      await connection.beginTransaction();
      try {
        for (const statement of statements) await connection.query(statement);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
    },
    close: async () => {},
  };
}

test('report record integration: rows land, re-running is idempotent and published_at is kept', async (t) => {
  const handle = await withDatabase(t);
  if (!handle) return;
  const { connection } = handle;
  const db = makeDb(connection);
  try {
    const raw = rawReport();
    const record = buildReportRecord(raw, '2026-09-20');
    // 持续热门那行的身份是按同一份实现算出来的，也要在产品库里，否则外键会挡
    for (const id of ['prd_a', 'prd_b', 'prd_c', record.items[3].productId]) {
      await connection.query(`INSERT INTO products (id, canonical_key, title, first_seen_date, last_seen_date)
        VALUES ('${id}', 'key-${id}', '${id}', '2026-09-20', '2026-09-20')`);
    }
    await db.batch(reportRecordSql(record));

    const [reports] = await connection.query('SELECT id, report_date, locale, selection_version, status, selection_json FROM reports');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].status, 'published');
    assert.equal(reports[0].selection_version, SELECTION_VERSION);
    const selection = typeof reports[0].selection_json === 'string' ? JSON.parse(reports[0].selection_json) : reports[0].selection_json;
    assert.equal(selection.trendingPolicy.cooldownDays, 3);
    assert.equal(selection.admission.version, 'issue-admission-v2');

    const [items] = await connection.query('SELECT product_id, position, selection_reason, snapshot_json FROM report_items ORDER BY position');
    assert.deepEqual(items.slice(0, 3).map(row => row.product_id), ['prd_a', 'prd_b', 'prd_c']);
    assert.match(items[3].product_id, /^prd_[a-f0-9]{24}$/);
    assert.equal(items[3].selection_reason, 'trending-continuation');
    assert.deepEqual(items.map(row => Number(row.position)), [0, 1, 2, 3]);
    const snapshot = typeof items[0].snapshot_json === 'string' ? JSON.parse(items[0].snapshot_json) : items[0].snapshot_json;
    assert.equal(snapshot.sourceId, 'showhn');
    assert.equal(snapshot.title, 'Alpha');

    // 重跑：行数不变、published_at 不被冲掉（COALESCE）
    const [before] = await connection.query('SELECT published_at FROM reports');
    await db.batch(reportRecordSql(record));
    const [after] = await connection.query('SELECT COUNT(*) AS reports FROM reports');
    const [itemsAfter] = await connection.query('SELECT COUNT(*) AS items FROM report_items');
    const [publishedAfter] = await connection.query('SELECT published_at FROM reports');
    assert.equal(after[0].reports, 1);
    assert.equal(itemsAfter[0].items, 4);
    assert.deepEqual(publishedAfter[0].published_at, before[0].published_at);

    // 条目变少时 position 唯一键不会挡住（先清本期）
    const smaller = buildReportRecord({ ...raw, results: [raw.results[0]] }, '2026-09-20');
    await db.batch(reportRecordSql(smaller));
    const [shrunk] = await connection.query('SELECT COUNT(*) AS items FROM report_items');
    assert.equal(shrunk[0].items, 3, '2 条主列表 + 1 条持续热门');
    // 别的期不受影响
    await db.batch(reportRecordSql(buildReportRecord(raw, '2026-09-19')));
    const [other] = await connection.query("SELECT COUNT(*) AS items FROM report_items WHERE report_id='rpt_20260919'");
    assert.equal(other[0].items, 4);
  } finally {
    await connection.end();
  }
});
