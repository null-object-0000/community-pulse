#!/usr/bin/env node
/**
 * 一致性门禁：日报里发布出去的每一行，都必须能在**产品库投影**里找到自己的 product_id。
 *
 * 为什么需要它：日报（`collect.js` → `raw/<date>.json`）和产品库（`build-mysql-import.js` → MySQL）
 * 是两条独立的推导链，都从 source-raw 出发。它们只在「同一份身份实现、同一个时点（仓库事实挂上
 * 之后）」这个前提下才必然一致 —— 2026-09-18 修投稿实体识别时发现的 677 行漂移，就是这条前提
 * 被破坏的结果（日报行指向 A 仓库、产品库是 B 仓库，两边都不报错）。
 *
 * 这里不查线上 MySQL（本机连不上 3306，而且线上还叠着 Hyperdrive 读缓存），而是**离线重建**
 * 当天的导入投影（`collectRows`），再逐行比对 —— 与导入链逐字同源，跑起来只要几秒。
 *
 * 用法：
 *   node scripts/catalog/check-report-identity.js                 # 最新一期日报
 *   node scripts/catalog/check-report-identity.js --date 2026-09-19
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const RAW_DIR = path.join(ROOT, '知识', '大家都在做什么', 'raw');
const SOURCE_RAW = path.join(ROOT, '知识', '大家都在做什么', 'source-raw');

function parseArgs(argv) {
  const options = { date: null };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    if (name === '--date') options.date = inline === undefined ? argv[++index] : inline;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

function latestReportDate() {
  return fs.readdirSync(RAW_DIR).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, 10)).sort().at(-1);
}

/** 报告行的身份：新日报带 productId，历史日报按同一条实现现算。 */
function productIdOf(item) {
  if (item.productId) return item.productId;
  const { identityFor, productId } = require('./identity.js');
  return productId(identityFor(item));
}

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * 这一期日报读的是哪一天的 Trending 快照。
 *
 * 新日报自己有 `observedDate`；2026-09-18 之前的老日报没有这个字段，于是拿报告里第一条
 * trending 行的 externalId 去比对候选日文件（报告日 / +1 / -1），命中哪个就是哪个 ——
 * 不能想当然按「报告日 + 1」，历史上既有当天抓的也有隔天抓的。
 */
function observedDateOf(report, date) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(report.observedDate || ''))) return report.observedDate;
  const trending = (report.results || []).find((result) => result.sourceId === 'github-trending' && result.items?.length);
  const externalId = trending?.items?.[0]?.externalId;
  if (!externalId) return date;
  for (const candidate of [date, shiftDate(date, 1), shiftDate(date, -1)]) {
    const file = path.join(SOURCE_RAW, 'github-trending', `${candidate}.json`);
    if (!fs.existsSync(file)) continue;
    if (fs.readFileSync(file, 'utf8').includes(externalId)) return candidate;
  }
  return date;
}

/**
 * 逐行核对。
 *
 * 三种结果，含义不同：
 *   - `matched`：报告行的身份 == 导入链对同一条来源观察算出的身份（要守的就是这个）；
 *   - `mismatched`：两边都有这一条观察，但算出的 product_id 不同 —— **真漂移**，退出码 1；
 *   - `unverifiable`：这条来源观察在 source-raw 里已经找不到了（历史产物：Trending 快照换过、
 *     周期刊重放过），无从比对，只计数。
 */
function checkReportIdentity(date) {
  const report = JSON.parse(fs.readFileSync(path.join(RAW_DIR, `${date}.json`), 'utf8'));
  const observedDate = observedDateOf(report, date);
  const start = [date, observedDate].sort()[0];
  const end = [date, observedDate].sort().at(-1);
  const { loadItems, loadGithubRepositories, attachRepositoryFacts, attachDescriptionFallback } =
    require('../../.agents/skills/community-pulse/scripts/source_raw_items.js');
  const { identityFor, productId } = require('./identity.js');
  const { repositoryEvidenceDate } = require('./build-mysql-import.js');
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, '.agents', 'skills', 'community-pulse', 'config', 'sources.json'), 'utf8'));

  // 与导入链逐字同源：loadItems → attachRepositoryFacts → attachDescriptionFallback → identitiesFor。
  //
  // **快照日期必须走 `repositoryEvidenceDate`（导入链的同一函数）**，不能按字面日期取。
  // 2026-09-23 的假漂移就是这么来的：导入链对「09-23」回落到仓库里最近的一份快照（09-22），
  // 而这里当时用字面日期 `loadGithubRepositories(ROOT, cursor)`，观测日 09-24 那份快照还没
  // 提交进仓库 → 抛错 → 整批不挂仓库事实 → githubUrl 与报告行不同 → 同一行算出两个 product_id。
  // **它不是数据漂移，是核对方自己换了输入。**
  const projected = new Map();
  for (const source of config.sources.filter((item) => item.enabled)) {
    for (let cursor = start; cursor <= end; cursor = shiftDate(cursor, 1)) {
      let loaded;
      try {
        loaded = loadItems(source, { date: cursor, observedDate: cursor, rawRoot: SOURCE_RAW, maxItems: Infinity, productHuntView: 'all' });
      } catch {
        continue;
      }
      let repositories = null;
      // 与导入链同源：先算这一期的证据日，再按证据日取快照（取不到就 null，与导入链一致）。
      const evidenceDate = repositoryEvidenceDate(SOURCE_RAW, cursor);
      if (evidenceDate) {
        try { repositories = loadGithubRepositories(SOURCE_RAW, evidenceDate).repositories; } catch { repositories = null; }
      }
      const items = attachDescriptionFallback(attachRepositoryFacts(loaded.items, repositories), { repositories, descriptions: null });
      for (const item of items) projected.set(`${source.id}|${item.externalId}`, productId(identityFor(item)));
    }
  }

  const rows = [];
  for (const source of report.results || []) {
    for (const item of source.items || []) rows.push({ sourceId: source.sourceId, item });
  }
  const matched = [];
  const mismatched = [];
  const unverifiable = [];
  for (const { sourceId, item } of rows) {
    const published = productIdOf(item);
    const expected = projected.get(`${sourceId}|${item.externalId}`);
    if (!expected) { unverifiable.push({ sourceId, externalId: item.externalId, title: item.title, productId: published }); continue; }
    if (expected === published) matched.push(published);
    else mismatched.push({ sourceId, externalId: item.externalId, title: item.title, published, expected });
  }
  return {
    date, observedDate, reportItems: rows.length, projectedObservations: projected.size,
    matched: matched.length, mismatched, unverifiable,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const date = options.date || latestReportDate();
  const result = checkReportIdentity(date);
  console.log(JSON.stringify({
    ...result,
    mismatched: result.mismatched.slice(0, 20),
    unverifiable: result.unverifiable.slice(0, 10),
  }, null, 2));
  // 只有带发布记录（`publication`）的日报才是新契约下的产物，漂移必须挡下；
  // 更早的日报是「当时写死的历史」，按计划「已发布日报固定其版本」，只报数不改写。
  const report = JSON.parse(fs.readFileSync(path.join(RAW_DIR, `${result.date}.json`), 'utf8'));
  if (result.mismatched.length) {
    const label = report.publication ? '✖' : '⚠️';
    console.error(`${label} ${result.date}: ${result.mismatched.length}/${result.reportItems} 行与导入链算出的身份不一致`
      + `${report.publication ? ' —— 日报与产品库已经漂移' : '（历史日报，按「已发布即固定」只报数）'}`);
    if (report.publication) process.exitCode = 1;
    return;
  }
  console.error(`✔ ${result.date}: ${result.matched}/${result.reportItems} 行身份一致`
    + `（投影 ${result.projectedObservations} 条观察${result.unverifiable.length ? `；另有 ${result.unverifiable.length} 行的来源观察已不在 source-raw，无法比对` : ''}）`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = { parseArgs, latestReportDate, productIdOf, observedDateOf, checkReportIdentity };
