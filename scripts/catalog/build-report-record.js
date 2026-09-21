#!/usr/bin/env node
/**
 * 把一期**已发布**的日报投影成 MySQL 发布记录（`reports` + `report_items`）。
 *
 * 第二批「发布层」的核心：日报的选品、顺序、冷却、持续热门、当期加工版本落成结构化记录，
 * 日报的 JSON / Markdown / HTML 从这份记录派生，而不是各自从 Git 的 raw/final 再推一遍。
 *
 * ## 记录里有什么（口径）
 *
 * `reports` 一行 = 一期发布。`report_date` 上有唯一键，所以**一期一行**，中英双语在同一行的
 * `selection_json` 里 —— 站点本来就从同一个 report 对象渲染 zh-CN / en 两个页面，这里不另造一份。
 *
 * `report_items` 一行 = **一个去重后的产品**（主键 `(report_id, product_id)`，`dedupe()` 已经
 * 做了跨源合并，与这个主键一致），`position` 是发布顺序，`snapshot_json` 是**冻结的发布行**。
 * 持续热门（折叠展示的那几条）也在这期发布了，所以也进 `report_items`，排在主列表之后，
 * `selection_reason = 'trending-continuation'`。
 *
 * ## 三条必须守住的纪律
 *
 * ① **准入在写入时冻结，不在渲染时算。** 现在 `build-site.js` 在渲染时跑 `admitReport` —— 也就是
 *    说改了准入规则，**历史日报会被悄悄改写**，这正好违反「已发布日报固定其版本」。记录把
 *    `admission.decisions` 冻进 `selection_json`，被排除的条目从此有据可查。
 * ② **记录一旦写入就不由 raw 重算**（除非显式 `--force`）。否则 `revoke-admissions.js` 删掉的
 *    `report_items` 行会被下一次重算悄悄加回来。
 * ③ **不重算选品**。顺序/冷却/持续热门仍然是 `collect.js` 的唯一实现，这里只做「结构化落库」——
 *    批次 1 的教训是别养第二套语义。
 *
 * 用法：
 *   node scripts/catalog/build-report-record.js --date 2026-09-20 --dry-run
 *   node scripts/catalog/build-report-record.js --date 2026-09-20 --channel
 *   node scripts/catalog/build-report-record.js --all --channel        # 历史全量（只写缺失的）
 */
const fs = require('node:fs');
const path = require('node:path');
const { identityFor, productId } = require('./identity.js');
const { sqlValue } = require('./build-mysql-import.js');
const { admitReport } = require('../../.agents/skills/community-pulse/scripts/issue-admission.js');
// 选品规则版本只有一份实现（collect.js），记录侧引用它 —— 各定一个常量就等于又养了第二套语义。
const { SELECTION_VERSION } = require('../../.agents/skills/community-pulse/scripts/collect.js');

const ROOT = path.resolve(__dirname, '..', '..');
const RAW_DIR = path.join(ROOT, '知识', '大家都在做什么', 'raw');
// 记录机制之前发布的日报没有版本号可考，冻成这个值而不是今天的常量 —— 不能假装它们是按
// 现行规则选的（历史 337 行身份漂移就是「用今天的实现去解释当时的产物」造成的）。
const LEGACY_SELECTION_VERSION = 'legacy-pre-record';

/**
 * ISO 8601（带 `T`/`Z`）→ MySQL `DATETIME(3)` 的字面量。
 * `DATETIME` 收不了带 `T`/`Z` 的字符串 —— 批次 1 在 `product_content.created_at` 上踩过同一个坑，
 * 这次由集成用例在写库时挡下（`Incorrect datetime value: '…T…Z'`）。
 */
function mysqlDateTime(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  return parsed.toISOString().slice(0, 23).replace('T', ' ');
}

function reportId(date) {
  return `rpt_${String(date).replace(/-/g, '')}`;
}

/** 报告行的身份：新日报带 `productId`（09-20 起），历史日报按同一条实现现算。 */
function productIdOf(item) {
  if (item.productId) return item.productId;
  return productId(identityFor(item));
}

/** 持续热门的元数据进记录，但 `continuedItems` 本身不进 —— 它们已经是 `report_items` 的行。 */
function trendingPolicySummary(policy) {
  if (!policy) return null;
  return {
    cooldownDays: policy.cooldownDays,
    suppressedCount: policy.suppressedCount,
    continuationLimit: policy.continuationLimit ?? null,
    // 被冷却压制、又没进折叠列表的那些：留着才能回答「这期为什么没有 X」。
    suppressed: (policy.suppressedItems || []).map(item => ({
      sourceId: item.sourceId || null, externalId: item.externalId || null,
      title: item.title || null, githubUrl: item.githubUrl || null,
      recentAppearances: item.trendingContinuation?.recentAppearances ?? null,
    })),
  };
}

/**
 * raw 报告 → 发布记录（纯函数，不碰数据库）。
 * 返回 `{ report, items }`：`report` 是 `reports` 那一行，`items` 是 `report_items` 的行。
 */
function buildReportRecord(rawReport, date, options = {}) {
  const admitted = admitReport(rawReport);
  const items = [];
  const push = (item, source, selectionReason) => {
    items.push({
      productId: productIdOf(item),
      position: items.length,
      selectionReason,
      snapshot: {
        ...item,
        sourceId: item.sourceId || source?.sourceId || null,
        sourceName: item.sourceName || source?.sourceName || source?.name || null,
      },
    });
  };
  for (const source of admitted.results || []) {
    for (const item of source.items || []) push(item, source, `source:${source.sourceId}`);
  }
  for (const item of admitted.trendingPolicy?.continuedItems || []) push(item, null, 'trending-continuation');

  return {
    report: {
      id: reportId(date),
      reportDate: date,
      // 一期一行：站点本来就从同一个 report 对象渲染中英两版。
      locale: options.locale || 'zh-CN',
      selectionVersion: rawReport.publication?.selectionVersion || options.selectionVersion || LEGACY_SELECTION_VERSION,
      status: 'published',
      publishedAt: rawReport.generatedAt || null,
      selection: {
        observedDate: rawReport.observedDate || null,
        // 来源清单（含**没有条目**的来源）：`renderMarkdown` 是 results → source → items 渲染的，
        // 所以来源顺序与来源名也是发布内容；只靠 report_items 还原不出空分组。
        sources: (admitted.results || []).map(source => ({ sourceId: source.sourceId, sourceName: source.sourceName || null })),
        // 原始 ISO 时间戳（带 T/Z）也留一份：`reports.published_at` 是 DATETIME(3)、没有时区标记，
        // 从它反推 ISO 会按本地时区解释，feed 的 pubDate 会整体偏移 8 小时。
        generatedAt: rawReport.generatedAt || null,
        date: rawReport.date || date,
        inputMode: rawReport.inputMode || null,
        // 来源文件哈希 + taxonomyVersion（09-20 起就在 raw 里）：这一期读的是哪些不可变输入。
        publication: rawReport.publication || null,
        // 准入决策（含被排除的条目与原因）——冻在这里，渲染期不再重算。
        admission: admitted.admission || null,
        trendingPolicy: trendingPolicySummary(admitted.trendingPolicy),
        selectionVersion: SELECTION_VERSION,
      },
    },
    items,
  };
}

/**
 * 记录 → SQL。**先删这一期的 items 再插**，因为 `position` 上有唯一键：条目变少时旧行会与
 * 新行抢位置。删除只限这一期，且写入器默认对已存在的期跳过，所以不会误伤撤销结果。
 */
function reportRecordSql(record) {
  const { report, items } = record;
  const publishedAt = mysqlDateTime(report.publishedAt);
  const statements = [
    `INSERT INTO reports (id, report_date, locale, selection_version, status, published_at, selection_json)
      VALUES (${sqlValue(report.id)}, ${sqlValue(report.reportDate)}, ${sqlValue(report.locale)},
        ${sqlValue(report.selectionVersion)}, ${sqlValue(report.status)}, ${publishedAt ? sqlValue(publishedAt) : 'CURRENT_TIMESTAMP(3)'},
        ${sqlValue(JSON.stringify(report.selection))})
      ON DUPLICATE KEY UPDATE locale=VALUES(locale), selection_version=VALUES(selection_version),
        status=VALUES(status), published_at=COALESCE(reports.published_at, VALUES(published_at)),
        selection_json=VALUES(selection_json)`,
    `DELETE FROM report_items WHERE report_id=${sqlValue(report.id)}`,
  ];
  if (items.length) {
    const rows = items.map(item => `(${sqlValue(report.id)}, ${sqlValue(item.productId)}, NULL, ${item.position}, `
      + `${sqlValue(item.selectionReason)}, ${sqlValue(JSON.stringify(item.snapshot))})`);
    statements.push(`INSERT INTO report_items (report_id, product_id, source_item_id, position, selection_reason, snapshot_json)
      VALUES ${rows.join(',')}
      ON DUPLICATE KEY UPDATE position=VALUES(position), selection_reason=VALUES(selection_reason),
        snapshot_json=VALUES(snapshot_json)`);
  }
  return statements;
}

function parseArgs(argv) {
  const options = { date: null, all: false, force: false, dryRun: false, out: null, channel: false, mysqlUrl: process.env.CATALOG_MYSQL_URL || '' };
  const booleans = new Set(['--all', '--force', '--dry-run', '--channel']);
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined && !booleans.has(name) ? argv[++index] : inline;
    if (name === '--date') options.date = value;
    else if (name === '--out') options.out = path.resolve(value);
    else if (name === '--mysql-url') options.mysqlUrl = value;
    else if (name === '--all') options.all = true;
    else if (name === '--force') options.force = true;
    else if (name === '--dry-run') options.dryRun = true;
    else if (name === '--channel') options.channel = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!options.date && !options.all) throw new Error('需要 --date YYYY-MM-DD 或 --all');
  if (options.date && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) throw new Error('--date 必须是 YYYY-MM-DD');
  return options;
}

function reportDates(options) {
  if (options.date) return [options.date];
  return fs.readdirSync(RAW_DIR).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map(name => name.slice(0, 10)).sort();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dates = reportDates(options);
  const records = dates.map((date) => {
    const raw = JSON.parse(fs.readFileSync(path.join(RAW_DIR, `${date}.json`), 'utf8'));
    return buildReportRecord(raw, date, options);
  });
  const summary = records.map(record => ({
    date: record.report.reportDate, items: record.items.length,
    continuations: record.items.filter(item => item.selectionReason === 'trending-continuation').length,
    excluded: (record.report.selection.admission?.decisions || []).filter(decision => decision.status === 'excluded').length,
    selectionVersion: record.report.selectionVersion,
  }));

  if (options.dryRun || !options.channel && !options.mysqlUrl) {
    if (options.out) {
      fs.mkdirSync(options.out, { recursive: true });
      for (const record of records) {
        fs.writeFileSync(path.join(options.out, `${record.report.reportDate}.sql`), `${reportRecordSql(record).join(';\n')};\n`);
      }
    }
    console.log(JSON.stringify({ mode: options.out ? `sql → ${options.out}` : 'dry-run', dates: records.length, summary }, null, 2));
    return;
  }

  const { openDb } = require('./db-transport.js');
  const { db, transport } = await openDb({ ...options, preferDirect: !options.channel, log: message => console.error(message) });
  const written = [];
  const skipped = [];
  const dropped = [];
  try {
    for (const record of records) {
      if (!options.force) {
        // 已发布即固定：记录一旦写入就不由 raw 重算，否则撤销过的行会被加回来。
        const existing = await db.select(`SELECT id FROM reports WHERE report_date=${sqlValue(record.report.reportDate)}`);
        if (existing.length) { skipped.push(record.report.reportDate); continue; }
      }
      // `report_items.product_id` 有外键指向 `products(id)`，所以日报行对应的产品若不在产品库里，
      // **整批**会被拒。实测全历史 12,020 条记录行里有 460 条（3.83%、151 期）属于这种 ——
      // 集中在 6–8 月，最近 12 期只有 1 行（日更导入覆盖 TARGET..OBSERVED、与日报同源，所以日更
      // 不受影响）。这里先筛掉并把清单记进 `selection_json`：少记了哪几行必须可查，不能静默。
      const ids = [...new Set(record.items.map(item => item.productId))];
      const present = new Set((await db.select(`SELECT id FROM products WHERE id IN (${ids.map(sqlValue).join(',')})`))
        .map(row => row.id));
      const kept = record.items.filter(item => present.has(item.productId));
      const droppedItems = record.items.filter(item => !present.has(item.productId));
      const toWrite = droppedItems.length ? {
        ...record,
        report: {
          ...record.report,
          selection: {
            ...record.report.selection,
            skippedMissingProduct: droppedItems.map(item => ({
              productId: item.productId, position: item.position,
              title: item.snapshot?.title || null, reason: 'product_not_in_catalog',
            })),
          },
        },
        items: kept,
      } : record;
      await db.batch(reportRecordSql(toWrite));
      written.push(record.report.reportDate);
      if (droppedItems.length) dropped.push({ date: record.report.reportDate, rows: droppedItems.length });
    }
  } finally {
    await db.close();
  }
  console.log(JSON.stringify({
    transport, written: written.length, skipped: skipped.length, skippedDates: skipped,
    droppedMissingProduct: dropped.length ? { dates: dropped.length, rows: dropped.reduce((sum, entry) => sum + entry.rows, 0), worst: dropped.slice(0, 5) } : null,
    summary: summary.filter(entry => written.includes(entry.date)),
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = {
  SELECTION_VERSION, LEGACY_SELECTION_VERSION,
  reportId, mysqlDateTime, productIdOf, trendingPolicySummary, buildReportRecord, reportRecordSql,
  parseArgs, reportDates,
};
