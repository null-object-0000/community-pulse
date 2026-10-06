/**
 * 产品级增强接入日更链的回归用例（纯离线，不需要数据库）。
 *
 * 守三件不能退化的事：
 *   ① **触发点顺序**：日更链里「导出当天队列」必须排在「将全量产品观察增量写入 MySQL」之后 ——
 *      早于它，当天新产品的 taxonomy_assignments 还没落库，旅行臂查不到，会静默少跑。
 *   ② **可观测性**：产品级覆盖率的判据（缺运行 / 低于阈值）必须能用纯函数复现，巡检脚本才可信。
 *   ③ **本地那一跳的接口**：导出器必须能 `--mysql-url` 直连（本地验收）也能 `--channel`（生产）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const DAILY = fs.readFileSync(path.join(ROOT, '.github/workflows/daily-report.yml'), 'utf8');
const EXPORT = fs.readFileSync(path.join(ROOT, '.github/workflows/catalog-queue-export.yml'), 'utf8');
const WATCHDOG = fs.readFileSync(path.join(ROOT, '.github/workflows/product-enhancement-watchdog.yml'), 'utf8');
const RUNNER = fs.readFileSync(path.join(ROOT, 'scripts/catalog/daily-enrich.sh'), 'utf8');

const {
  evaluateCoverage, enhancementDue, dueDates, DEFAULT_THRESHOLD,
} = require('../scripts/catalog/check-product-enhancement.js');
const { parseArgs: parseExportArgs } = require('../scripts/catalog/export-queue.js');

function lineOf(source, needle) {
  const index = source.split('\n').findIndex(line => line.includes(needle));
  assert.ok(index >= 0, `找不到：${needle}`);
  return index;
}

test('日更链在「写入 MySQL」之后导出产品增强队列（晚了没数据，早了查不到标签）', () => {
  const importLine = lineOf(DAILY, '将全量产品观察增量写入 MySQL');
  const exportLine = lineOf(DAILY, '导出当天产品增强队列');
  const uploadLine = lineOf(DAILY, '上传产品增强队列产物');
  assert.ok(exportLine > importLine, '导出必须排在导入之后');
  assert.ok(uploadLine > exportLine, '先导出再上传产物');
  // 产物名要带当天日期，本机侧按名字拉取
  assert.match(DAILY, /name: enrich-queue-\$\{\{ steps\.setdate\.outputs\.date \}\}/);
  assert.match(DAILY, /retention-days: 14/);
  // 附件失败不该连累日报存在（与「先落盘，再做周边」同一条纪律）
  const exportBlock = DAILY.split('\n').slice(exportLine - 3, uploadLine).join('\n');
  assert.match(exportBlock, /continue-on-error: true/);
});

test('产品级增强巡检：缺运行 / 低覆盖率都告警，健康运行不告警', () => {
  // 整批没跑：正是 2026-09-23..10-06 的形状
  assert.equal(evaluateCoverage(null).alert, true);
  assert.match(evaluateCoverage(null).reason, /缺运行/);
  // 覆盖率低于阈值
  const low = evaluateCoverage({ product_count: 100, completed_count: 50, failed_count: 5, skipped_no_input_count: 45 });
  assert.equal(low.alert, true);
  assert.match(low.reason, /覆盖率 50\.0%/);
  // 达标
  const ok = evaluateCoverage({ product_count: 100, completed_count: 95, failed_count: 1, skipped_no_input_count: 4 });
  assert.equal(ok.alert, false);
  assert.equal(ok.ratio, 0.95);
  // 当天没有待加工产品不是故障
  assert.equal(evaluateCoverage({ product_count: 0, completed_count: 0 }).alert, false);
  // 进程死在 finishRunSql 之前 → 状态停在 running，也要告警
  const stuck = evaluateCoverage({ status: 'running', product_count: 100, completed_count: 10 });
  assert.equal(stuck.alert, true);
  assert.match(stuck.reason, /未收尾/);
  assert.equal(DEFAULT_THRESHOLD, 0.8);
});

test('宽限期口径与日报级巡检一致（北京 D+1 中午后才判 D 日）', () => {
  const date = '2026-10-05';
  const before = new Date('2026-10-06T03:00:00Z'); // 北京 10-06 11:00，未到宽限
  const after = new Date('2026-10-06T05:00:00Z');  // 北京 10-06 13:00，已到宽限
  assert.equal(enhancementDue(date, before), false);
  assert.equal(enhancementDue(date, after), true);
  // 只回看最近几天，不把远古缺口当新告警
  assert.equal(enhancementDue('2026-01-01', after), false);
  const dates = dueDates(after, 3);
  assert.ok(dates.includes('2026-10-05'));
  assert.ok(!dates.includes('2026-01-01'));
});

test('巡检 workflow 只读、带 Cloudflare 凭据、可手动指定日期', () => {
  assert.match(WATCHDOG, /check-product-enhancement\.js --channel/);
  assert.match(WATCHDOG, /permissions:\s*\n\s*contents: read/);
  assert.match(WATCHDOG, /CLOUDFLARE_API_TOKEN/);
  assert.match(WATCHDOG, /workflow_dispatch/);
});

test('本机那一跳：能直连也能走通道，且 --dry-run 不提交/不触发写库', () => {
  // 导出器两种传输都支持：生产走 --channel，本地验收走 --mysql-url
  const direct = parseExportArgs(['--date', '2026-10-05', '--out', '/tmp/q.json', '--mysql-url', 'mysql://root@127.0.0.1/db']);
  assert.equal(direct.mysqlUrl, 'mysql://root@127.0.0.1/db');
  const channel = parseExportArgs(['--date', '2026-10-05', '--out', '/tmp/q.json', '--channel']);
  assert.equal(channel.channel, true);
  assert.throws(() => parseExportArgs(['--out', '/tmp/q.json']), /--date YYYY-MM-DD/);

  // 本机 runner：复用规范函数出 SQL，dry-run 时不 push、不 dispatch
  assert.match(RUNNER, /enrich-queue\.js/);
  assert.match(RUNNER, /apply-sql\.js.*--dry-run/);
  assert.match(RUNNER, /apply-catalog-sql\.yml/);
  assert.match(RUNNER, /if \[\[ "\$DRY_RUN" == "true" \]\]/);
  assert.ok(fs.statSync(path.join(ROOT, 'scripts/catalog/daily-enrich.sh')).mode & 0o111, 'runner 必须可执行');
});

test('离线导出 workflow 与本机 runner 共用同一套三跳，不另造队列', () => {
  // 日更/导出走 export-queue.js（queueSql）；本机 runner 走 enrich-queue.js（与日更逐字相同的
  // runEnrichment 路径）。两边都引用「队列口径」的同一个模块，不出现第二套拼 SQL 的实现。
  assert.match(EXPORT, /export-queue\.js/);
  assert.match(RUNNER, /enrich-queue\.js/);
});
