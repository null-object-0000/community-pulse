#!/usr/bin/env node
/**
 * 激活一批 LLM 加工结果（把 shadow 行提为 current）。
 *
 * **这是仓库里唯一「激活」入口** —— `enrich-products.js` 的纪律是「所有输出 `is_current=0`，
 * 激活是单独的受审操作」。它必须显式调用、显式确认，不能挂在日更流水线里。
 *
 * 两种模式：
 *   `--taxonomy`（默认，向后兼容）  标签：把 LLM 行提为 current，并把同产品的规则行撤下。
 *   `--content`                    正文：把 `product_content` 的双语行提为 current，
 *                                  供 Worker 的 `/api/v1/*` 与产品详情页读取（0006 迁移加了索引）。
 *
 * 为什么标签要「提 LLM」与「撤规则」成对做：读端只按 `is_current = 1` 过滤，**不看
 * `assignment_source`** —— 只提 LLM 而不撤规则，同一个 facet 下两套标签会同时成立，计数翻倍。
 * `languages` facet 例外：LLM 不产出它（只有规则侧写），撤规则时要留下，否则语言标签整批消失。
 *
 * 用法：
 *   node scripts/catalog/activate-enrichment.js --processor-version travel-localize-v1 --out .scratch/activate.sql
 *   node scripts/catalog/activate-enrichment.js --content --versions travel-localize-v1,catalog-localize-v1 --out .scratch/activate-content.sql
 *   node scripts/catalog/activate-enrichment.js --content --versions travel-localize-v1 --dry-run
 */
const fs = require('fs');
const path = require('path');

/** LLM 不产出、必须保留规则行的 facet。写死在这里而不是配置：漏掉它就是静默丢数据。 */
const RULE_ONLY_FACETS = ['languages'];

/**
 * 加工版本优先级，**标签与正文共用一份**。同产品同 facet（标签）/ 同 locale（正文）
 * 只允许一行 current，所以低优先级版本激活时要把自己的行让给高优先级的。
 *
 * 列表按优先级从高到低：按标签专门跑的那批（描述更全、是授权付费跑的）优先于日更链
 * 按天增量跑的那批（覆盖面广但每条更短）。新版本加进来时排在其后（按版本名），
 * 永远赢不过列表里的版本。
 */
const VERSION_PRIORITY = ['travel-localize-v1', 'catalog-localize-v1'];

/** @deprecated 旧名，正文激活沿用；新代码用 `VERSION_PRIORITY`。 */
const CONTENT_PRIORITY = VERSION_PRIORITY;

/**
 * 某个版本激活时，**自动**保护比它优先级高的版本。
 *
 * 这一步做成自动推导而不是「调用方自己传」：2026-09-23 实测踩过这个坑 ——
 * 激活 `catalog-localize-v1` 时忘了带上 `travel-localize-v1`，闸门整体失效，
 * travel 那批（4,107 个产品、描述更全）被误撤成 shadow。**只要版本在优先级列表里，
 * 它上面的版本就不需要调用方记得传。** 列表外的版本不受保护（无从判断谁高谁低）。
 */
function higherPriorityVersions(processorVersion) {
  const index = VERSION_PRIORITY.indexOf(processorVersion);
  return index <= 0 ? [] : VERSION_PRIORITY.slice(0, index);
}

function parseArgs(argv) {
  const options = { processorVersion: null, out: null, dryRun: false, mode: 'taxonomy', versions: null, protect: null };
  const booleans = new Set(['--dry-run', '--content', '--taxonomy']);
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined && !booleans.has(name) ? argv[++index] : inline;
    if (name === '--processor-version') options.processorVersion = value;
    else if (name === '--versions') options.versions = String(value).split(',').map(v => v.trim()).filter(Boolean);
    else if (name === '--protect') options.protect = String(value).split(',').map(v => v.trim()).filter(Boolean);
    else if (name === '--out') options.out = path.resolve(value);
    else if (name === '--dry-run') options.dryRun = true;
    else if (name === '--content') options.mode = 'content';
    else if (name === '--taxonomy') options.mode = 'taxonomy';
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (options.mode === 'taxonomy' && !options.processorVersion) {
    throw new Error('需要 --processor-version（例如 travel-localize-v1）');
  }
  if (options.mode === 'content' && !options.versions) options.versions = [...VERSION_PRIORITY];
  if (!options.dryRun && !options.out) throw new Error('需要 --out（或 --dry-run）');
  return options;
}

function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** 本次要激活的产品集合：有该 processor_version 的 LLM 行的产品。 */
function activationScope(processorVersion) {
  return `SELECT DISTINCT product_id FROM taxonomy_assignments WHERE processor_version=${quote(processorVersion)}`;
}

// ── 标签激活 ────────────────────────────────────────────────────────────────

/**
 * 顺序有讲究：
 *  ① 先把 LLM 行提为 current —— 读端立刻能看到新标签；
 *  ② 再撤同产品的规则行（保留 RULE_ONLY_FACETS）。
 *
 * ② 用**自连接**而不是子查询：MySQL 不允许在 UPDATE 的子查询里引用同一张表
 * （`You can't specify target table for update in FROM clause`），而多表 UPDATE 允许。
 *
 * `protectVersions`：**已经在 current 的更高优先级版本**。同一个 facet 上两批 LLM 标签
 * 同时 current 会让分面计数翻倍（同一个产品在一个分面里被算两次），所以低优先级版本
 * 激活时要把自己的行撤下来。**必须传全**：只传自己会让这个闸整体失效
 * （2026-09-23 实测：正文激活只传 `catalog-localize-v1` 时，travel 那批 8,214 行会被误撤；
 * 标签侧同理，travel 批 4,107 个产品的 330 个冲突对会变成双份计数）。
 */
function buildStatements(processorVersion, protectVersions = []) {
  const version = quote(processorVersion);
  const statements = [
    `UPDATE taxonomy_assignments SET is_current=1
WHERE processor_version=${version} AND is_current=0`,

    `UPDATE taxonomy_assignments ta
JOIN taxonomy_assignments llm
  ON llm.product_id = ta.product_id
 AND llm.processor_version = ${version}
SET ta.is_current=0
WHERE ta.assignment_source='rule'
  AND ta.facet NOT IN (${RULE_ONLY_FACETS.map(quote).join(',')})`,
  ];

  if (protectVersions.length) {
    // 同 facet 上已有更高优先级的 LLM 行时，本版本那一行退回 shadow —— 否则同分面双计数。
    statements.push(
      `UPDATE taxonomy_assignments ta
JOIN taxonomy_assignments hi
  ON hi.product_id = ta.product_id
 AND hi.facet = ta.facet
 AND hi.is_current = 1
 AND hi.processor_version IN (${protectVersions.map(quote).join(',')})
SET ta.is_current=0
WHERE ta.processor_version=${version}
  AND ta.is_current=1`
    );
  }

  return statements;
}

function buildRollbackStatements(processorVersion) {
  const version = quote(processorVersion);
  return [
    `UPDATE taxonomy_assignments ta
JOIN taxonomy_assignments llm
  ON llm.product_id = ta.product_id
 AND llm.processor_version = ${version}
SET ta.is_current=1
WHERE ta.assignment_source='rule'
  AND ta.facet NOT IN (${RULE_ONLY_FACETS.map(quote).join(',')})`,

    `UPDATE taxonomy_assignments SET is_current=0
WHERE processor_version=${version}`,
  ];
}

// ── 正文激活 ────────────────────────────────────────────────────────────────

/**
 * 正文激活比标签多一层约束：**同产品同 locale 只能有一行 current**。
 *
 * 做法：按优先级逐版本处理，每个版本两步 ——
 *  ① 先把这个版本的行提为 current，但**跳过已经有更高优先级 current 行的 (产品, locale)**；
 *  ② 再把该产品该 locale 上其它版本的 current 行撤下（此时高优先级的已经赢了，撤的必然是低的）。
 *
 * ① 用 `NOT EXISTS` 子查询会撞 MySQL 的「不能在 UPDATE 子查询里引用目标表」，所以用
 * `LEFT JOIN` 自连接：`keep` 是「同一 (产品, locale) 上优先级更高的 current 行」，
 * 它非空就跳过这一行。
 *
 * 版本按 `CONTENT_PRIORITY` 的顺序处理，列表里没有的版本排在其后（按版本名），
 * 这样新增加工版本时不必改代码，但它**永远赢不过**列表里的版本。
 */
function contentVersions(requested) {
  const known = requested.filter(v => CONTENT_PRIORITY.includes(v))
    .sort((a, b) => CONTENT_PRIORITY.indexOf(a) - CONTENT_PRIORITY.indexOf(b));
  const extra = requested.filter(v => !CONTENT_PRIORITY.includes(v)).sort();
  return [...known, ...extra];
}

function buildContentStatements(versions) {
  const statements = [];
  const ordered = contentVersions(versions);
  ordered.forEach((version) => {
    // 保护的版本**从优先级列表推导**，不依赖调用方传全 —— 与标签侧同一个理由
    // （2026-09-23 实测：只传本次要激活的版本时闸消失，更高优先级那批会被覆盖）。
    // 列表外的版本（`higherPriorityVersions` 返回空）不受保护，这是刻意的：无从判断谁高谁低。
    const higher = higherPriorityVersions(version).map(v => quote(`llm:${v}`));
    // ① 提为 current，跳过已经有更高优先级 current 行的 (产品, locale)。
    const keepGuard = higher.length
      ? `LEFT JOIN product_content keep
  ON keep.product_id = pc.product_id
 AND keep.locale = pc.locale
 AND keep.is_current = 1
 AND keep.content_source IN (${higher.join(', ')})`
      : '';
    const keepWhere = higher.length ? 'AND keep.product_id IS NULL' : '';
    statements.push(`UPDATE product_content pc
${keepGuard}
SET pc.is_current = 1
WHERE pc.content_source = ${quote(`llm:${version}`)} AND pc.is_current = 0 ${keepWhere}`);

    // ② 撤下同一 (产品, locale) 上其它版本的行（只可能更低优先级）。
    statements.push(`UPDATE product_content pc
JOIN product_content win
  ON win.product_id = pc.product_id
 AND win.locale = pc.locale
 AND win.is_current = 1
 AND win.content_source = ${quote(`llm:${version}`)}
SET pc.is_current = 0
WHERE pc.content_source <> ${quote(`llm:${version}`)} AND pc.is_current = 1`);
  });
  return statements;
}

function buildContentRollbackStatements(versions) {
  return versions.map(version => `UPDATE product_content SET is_current = 0
WHERE content_source = ${quote(`llm:${version}`)}`);
}

// ── 自检 ────────────────────────────────────────────────────────────────────

function verifyQueries(processorVersion) {
  return {
    llmCurrent: `SELECT COUNT(*) AS n FROM taxonomy_assignments
      WHERE processor_version=${quote(processorVersion)} AND is_current=1`,
    llmShadowLeft: `SELECT COUNT(*) AS n FROM taxonomy_assignments
      WHERE processor_version=${quote(processorVersion)} AND is_current=0`,
    ruleCurrentKept: `SELECT facet, COUNT(*) AS n FROM taxonomy_assignments
      WHERE assignment_source='rule' AND is_current=1
        AND product_id IN (${activationScope(processorVersion)})
      GROUP BY facet`,
    overlap: `SELECT ta.facet, COUNT(*) AS n FROM taxonomy_assignments ta
      JOIN (${activationScope(processorVersion)}) scope ON scope.product_id = ta.product_id
      WHERE ta.is_current=1 AND ta.facet NOT IN (${RULE_ONLY_FACETS.map(quote).join(',')})
      GROUP BY ta.facet, ta.product_id HAVING COUNT(DISTINCT ta.assignment_source) > 1`,
  };
}

function verifyContentQueries(versions) {
  const sources = versions.map(v => quote(`llm:${v}`)).join(', ');
  return {
    contentCurrent: `SELECT content_source, COUNT(*) AS n, COUNT(DISTINCT product_id) AS products
      FROM product_content WHERE is_current=1 GROUP BY content_source`,
    contentShadow: `SELECT content_source, COUNT(*) AS n FROM product_content
      WHERE is_current=0 AND content_source IN (${sources}) GROUP BY content_source`,
    // 期望为空：同产品同 locale 不能有两行 current（读取端取最新一条的语义依赖它）。
    duplicateCurrent: `SELECT product_id, locale, COUNT(*) AS n FROM product_content
      WHERE is_current=1 GROUP BY product_id, locale HAVING COUNT(*) > 1`,
  };
}

function main(options) {
  const content = options.mode === 'content';
  // 标签侧也自动保护更高优先级版本：否则两批 LLM 标签在同 facet 上同时 current，计数翻倍。
  const protect = options.protect || higherPriorityVersions(options.processorVersion);
  const statements = content
    ? buildContentStatements(options.versions)
    : buildStatements(options.processorVersion, protect);
  const rollback = content
    ? buildContentRollbackStatements(options.versions)
    : buildRollbackStatements(options.processorVersion);
  const report = {
    mode: options.mode,
    ...(content
      ? { versions: contentVersions(options.versions) }
      : { processorVersion: options.processorVersion, ruleOnlyFacets: RULE_ONLY_FACETS, protectVersions: protect }),
    statements: statements.length,
    verify: content ? verifyContentQueries(options.versions) : verifyQueries(options.processorVersion),
  };
  if (options.dryRun) {
    console.log(JSON.stringify(report, null, 2));
    console.log('\n--- 激活语句 ---');
    for (const s of statements) console.log(`${s};\n`);
    console.log('--- 回滚语句 ---');
    for (const s of rollback) console.log(`${s};\n`);
    return report;
  }
  fs.writeFileSync(options.out, `${statements.join(';\n')};\n`);
  // 回滚稿与激活稿同时落盘、同时提交 —— 改线上数据却没有回滚稿，等于没有退路。
  const rollbackPath = options.out.replace(/\.sql$/, '.rollback.sql');
  fs.writeFileSync(rollbackPath, `${rollback.join(';\n')};\n`);
  console.log(`[activate] ${options.mode} 模式：${statements.length} 条语句 → ${options.out}`);
  console.log(`[activate] ${rollback.length} 条回滚语句 → ${rollbackPath}`);
  if (!content) console.log(`[activate] 保留规则行的 facet: ${RULE_ONLY_FACETS.join(', ')}`);
  return report;
}

if (require.main === module) {
  try {
    main(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs, buildStatements, buildRollbackStatements, verifyQueries,
  buildContentStatements, buildContentRollbackStatements, verifyContentQueries, contentVersions,
  RULE_ONLY_FACETS, CONTENT_PRIORITY, VERSION_PRIORITY, higherPriorityVersions, activationScope,
};
