/**
 * 身份门禁（`check-report-identity.js`）的回归用例。
 *
 * 守的是**「核对方与被核对方必须用同一份输入」**。
 *
 * 2026-09-23 的事故：门禁报出 1 行漂移（v2ex 1244325），挡在「提交并推送」之前，
 * 于是当期 raw / final / 站点整期缺失。但**那一行根本没漂移** —— 是门禁自己换了输入：
 * 导入链用 `repositoryEvidenceDate()` 把「09-23」回落到仓库里最近的一份快照（09-22），
 * 而门禁当时按**字面日期** `loadGithubRepositories(ROOT, cursor)` 取，观测日 09-24 那份
 * 快照还没提交进仓库 → 抛错 → 整批不挂仓库事实 → `githubUrl` 与报告行不同 → 同一行算出
 * 两个 product_id。核对方自己制造了它要抓的那种漂移。
 *
 * 所以这里钉两件事：
 *  ① 门禁取快照的日期口径 == 导入链的口径（同一个函数，不是「抄一遍同样的逻辑」）；
 *  ② 缺快照时两条链的行为一致（都退化成「不挂事实」，而不是一边抛错一边回落）。
 *
 * 纯函数 + 真实 source-raw 目录，不需要数据库。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'catalog', 'check-report-identity.js');
const SOURCE_RAW = path.join(ROOT, '知识', '大家都在做什么', 'source-raw');

test('门禁复用导入链的 repositoryEvidenceDate —— 不自己按字面日期取快照', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  // 这是修复的核心：快照日期来自导入链的同一函数。
  assert.match(source, /repositoryEvidenceDate\s*\(/, '门禁必须用导入链的证据日口径取快照');
  // 反例：按字面日期取（`loadGithubRepositories(<root>, cursor)`）就是那次事故的形状。
  assert.doesNotMatch(
    source,
    /loadGithubRepositories\(\s*SOURCE_RAW\s*,\s*cursor\s*\)/,
    '不能再按字面日期取快照 —— 缺快照时会整批不挂仓库事实，制造假漂移',
  );
});

test('repositoryEvidenceDate 对「无当日快照」回落到最近一份（而不是抛错）', () => {
  const { repositoryEvidenceDate } = require('../scripts/catalog/build-mysql-import.js');
  const dates = fs.readdirSync(path.join(SOURCE_RAW, 'github-repositories'))
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter(Boolean).sort();
  if (!dates.length) return; // 没有快照时这条无从验证
  const latest = dates.at(-1);
  // 当天有快照 → 就是它自己。
  assert.equal(repositoryEvidenceDate(SOURCE_RAW, latest), latest);
  // 比最新还晚的日子 → 回落到最新那份（这正是 09-24 观测日的情形）。
  const future = new Date(`${latest}T00:00:00Z`);
  future.setUTCDate(future.getUTCDate() + 5);
  const beyond = future.toISOString().slice(0, 10);
  assert.equal(repositoryEvidenceDate(SOURCE_RAW, beyond), latest,
    '晚于最新快照的日期必须回落到最新那份，否则门禁与导入链会用不同输入');
});

test('缺快照时两条链都退化成「不挂仓库事实」—— 行为一致才有可比性', () => {
  const { loadGithubRepositories, attachRepositoryFacts } = require('../.agents/skills/community-pulse/scripts/source_raw_items.js');
  const { repositoryEvidenceDate } = require('../scripts/catalog/build-mysql-import.js');
  const dates = fs.readdirSync(path.join(SOURCE_RAW, 'github-repositories'))
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter(Boolean).sort();
  if (!dates.length) return;
  // 一个远早于任何快照的日期：证据日为 null，两条链都不该抛错、都该保持原样。
  const none = repositoryEvidenceDate(SOURCE_RAW, '1999-01-01');
  assert.equal(none, null, '早于所有快照的日期没有证据日');
  const item = { externalId: 'x', title: 't', url: 'https://www.v2ex.com/t/x', sourceId: 'v2ex' };
  assert.deepEqual(attachRepositoryFacts([item], null), [item]);
  // 而按字面日期取一个不存在的快照会抛错 —— 这就是修复前门禁整批降级的原因。
  assert.throws(() => loadGithubRepositories(SOURCE_RAW, '1999-01-01'));
});

test('真实日报：09-22 那期身份一致（门禁在正常输入上不误报）', () => {
  const { checkReportIdentity } = require(SCRIPT);
  const reportPath = path.join(ROOT, '知识', '大家都在做什么', 'raw', '2026-09-22.json');
  if (!fs.existsSync(reportPath)) return; // 数据集不完整时跳过
  const result = checkReportIdentity('2026-09-22');
  assert.equal(result.mismatched.length, 0, `不该有漂移：${JSON.stringify(result.mismatched.slice(0, 3))}`);
  assert.ok(result.matched > 0, '至少要核对到一些行');
});