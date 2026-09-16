#!/usr/bin/env node
/**
 * 定向撤销：把准入判定为招聘广告的条目从生产产品库中撤回。
 *
 * 现有日更导入只有 upsert，没有撤销语义 —— 只改过滤规则并重跑增量，旧产品、来源首见、
 * 分类关系都不会自动消失。这个脚本只针对**确认为广告、且没有任何其它合法来源观察到**的
 * 条目生成定向 SQL，绝不按关键词批量删除，也绝不整条删掉有多来源的产品。
 *
 * 用法：
 *   node scripts/catalog/revoke-admissions.js --out .scratch/revoke [--date YYYY-MM-DD ...] [--dry-run]
 * 产物是可直接喂给 import Worker 的 SQL 分片（POST /import），与 upload-mysql.js 同一通道。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const D = require(path.join(ROOT, 'web', 'shared.js'));
const { admitReport } = require(path.join(ROOT, '.agents/skills/community-pulse/scripts/issue-admission'));

function parseArgs(argv) {
  const options = { out: path.join(ROOT, '.scratch', 'revoke'), rawRoot: path.join(ROOT, '知识', '大家都在做什么', 'raw'), dates: null, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined ? argv[++index] : inline;
    if (name === '--out') options.out = path.resolve(value);
    else if (name === '--raw-root') options.rawRoot = path.resolve(value);
    else if (name === '--date') (options.dates = options.dates || []).push(value);
    else if (name === '--dry-run') options.dryRun = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

/** 全历史里每个实体被哪些来源观察到（sourceId+externalId 为实体键）。 */
function collectObservations(options) {
  const dates = (options.dates || fs.readdirSync(options.rawRoot)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).map((name) => name.slice(0, 10))).sort();
  const entities = new Map();
  const excluded = [];
  const addUrls = (entity, item) => {
    for (const url of [item.url, item.githubUrl]) {
      const normalized = String(url || '').trim().replace(/\/+$/, '').toLowerCase();
      if (normalized) entity.urls.add(normalized);
    }
  };
  for (const date of dates) {
    const file = path.join(options.rawRoot, `${date}.json`);
    if (!fs.existsSync(file)) continue;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 实体表必须覆盖**全部**条目（含被排除的广告）：否则算不出「这条 url 还有没有别的来源」，
    // 会把所有广告都当成孤立条目删除。
    for (const source of raw.results || []) {
      for (const item of source.items || []) {
        const key = `${item.sourceId || source.sourceId}|${String(item.externalId || '')}`;
        const existing = entities.get(key);
        if (existing) addUrls(existing, item);
        else {
          const entity = {
            date, sourceId: item.sourceId || source.sourceId, externalId: String(item.externalId || ''),
            title: item.title || '', url: item.url || '', githubUrl: item.githubUrl || '', urls: new Set(),
          };
          addUrls(entity, item);
          entities.set(key, entity);
        }
      }
    }
    const admitted = admitReport(raw);
    for (const decision of admitted.admission.decisions) {
      if (decision.status === 'excluded') excluded.push({ date, ...decision });
    }
  }
  // 跨来源共享：同一 url 被另一个实体键也用到，说明这条产品还有别的合法观察。
  const urlOwners = new Map();
  for (const [k, entity] of entities) {
    for (const url of entity.urls) {
      if (!urlOwners.has(url)) urlOwners.set(url, new Set());
      urlOwners.get(url).add(k);
    }
  }
  return { excluded, entities, urlOwners };
}

/** 只有「除广告自身外没有别的合法观察」的条目才允许撤销。 */
function revocable(excluded, entities, urlOwners) {
  return excluded.filter((decision) => {
    const own = `${decision.sourceId}|${String(decision.externalId || '')}`;
    const entity = entities.get(own);
    if (!entity) return false;
    return ![...entity.urls].some((url) => (urlOwners.get(url)?.size || 0) > 1);
  });
}

function sqlFor(targets, entities, urlOwners) {
  const lines = [
    '-- 招聘广告定向撤销（revoke-admissions.js 生成）',
    '-- 只删「本来源的这次观察」；产品只有在撤销后不再被任何来源观察时才连带删除。',
    'START TRANSACTION;',
  ];
  const esc = (value) => String(value).replace(/'/g, "''");
  for (const decision of targets) {
    const key = `${decision.sourceId}|${String(decision.externalId || '')}`;
    const entity = entities.get(key);
    const sid = esc(decision.sourceId), eid = esc(String(decision.externalId));
    lines.push(`-- ${decision.date} ${decision.sourceId} #${decision.externalId}: ${String(decision.title || '').slice(0, 70)}`);
    lines.push(`SET @item_id = (SELECT id FROM source_items WHERE source_id = '${sid}' AND external_id = '${eid}' LIMIT 1);`);
    lines.push('SET @product_id = (SELECT product_id FROM observations WHERE source_item_id = @item_id ORDER BY observed_date LIMIT 1);');
    // 先按 @item_id/@product_id 读出的关系再删引用，最后才删行本身（顺序反了会读不到要删的东西）。
    lines.push('DELETE FROM report_items WHERE source_item_id = @item_id;');
    if (entity) lines.push(`-- urls: ${[...entity.urls].join(' ') || '(none)'}`);
    lines.push('DELETE psfs FROM product_source_first_seen psfs JOIN observations o ON o.product_id = psfs.product_id AND o.source_id = psfs.source_id WHERE o.source_item_id = @item_id;');
    lines.push('DELETE FROM taxonomy_assignments WHERE product_id = @product_id AND NOT EXISTS (SELECT 1 FROM observations WHERE product_id = @product_id AND source_item_id <> @item_id);');
    lines.push('DELETE FROM observations WHERE source_item_id = @item_id;');
    lines.push('DELETE FROM source_items WHERE id = @item_id;');
    // 只有彻底孤立（撤销后没有任何观察与来源首见）的产品才连带删除，避免误删跨来源产品。
    lines.push('DELETE FROM product_details WHERE product_id = @product_id AND NOT EXISTS (SELECT 1 FROM observations WHERE product_id = @product_id);');
    lines.push('DELETE FROM product_routes WHERE product_id = @product_id AND NOT EXISTS (SELECT 1 FROM observations WHERE product_id = @product_id);');
    lines.push('DELETE FROM product_source_first_seen WHERE product_id = @product_id AND NOT EXISTS (SELECT 1 FROM observations WHERE product_id = @product_id);');
    lines.push('DELETE FROM product_identities WHERE product_id = @product_id AND NOT EXISTS (SELECT 1 FROM observations WHERE product_id = @product_id);');
    lines.push('DELETE FROM products WHERE id = @product_id AND NOT EXISTS (SELECT 1 FROM observations WHERE product_id = @product_id);');
  }
  lines.push('COMMIT;');
  return { sql: `${lines.join('\n')}\n` };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { excluded, entities, urlOwners } = collectObservations(options);
  const targets = revocable(excluded, entities, urlOwners);
  const shared = excluded.filter((decision) => !targets.includes(decision));
  const { sql } = sqlFor(targets, entities, urlOwners);
  const report = {
    version: 'revoke-admissions-v1', generatedAt: new Date().toISOString(), dryRun: options.dryRun,
    excludedCount: excluded.length, targets: targets.length,
    sharedCount: shared.length,
    entries: targets.map((t) => ({ date: t.date, sourceId: t.sourceId, externalId: t.externalId, title: t.title })),
    shared: shared.map((t) => ({ date: t.date, sourceId: t.sourceId, externalId: t.externalId, title: t.title })),
  };
  fs.mkdirSync(options.out, { recursive: true });
  fs.writeFileSync(path.join(options.out, 'revoke.sql'), sql);
  fs.writeFileSync(path.join(options.out, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main();
module.exports = { collectObservations, sqlFor, revocable };