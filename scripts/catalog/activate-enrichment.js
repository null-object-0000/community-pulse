#!/usr/bin/env node
/**
 * 激活一批 LLM 加工结果（把 shadow 行提为 current，并把同产品的规则行撤下）。
 *
 * **这是仓库里第一个「激活」操作** —— `enrich-products.js` 的纪律是「所有输出 `is_current=0`，
 * 激活是单独的受审操作」，此前一直没有这个入口。它必须显式调用、显式确认，不能挂在日更流水线里。
 *
 * 为什么「提 LLM」和「撤规则」必须成对做：
 * 读端（`worker/catalog-api.mjs` 的 `/api/v1/*`）只按 `ta.is_current = 1` 过滤，**不看
 * `assignment_source`** —— 只提 LLM 而不撤规则，同一个 facet 下两套标签会同时成立，计数直接翻倍。
 *
 * `languages` facet 例外：LLM 不产出它（只有规则侧写），所以撤规则时要把它留下，否则语言标签
 * 会整批消失。`primaryCategory` 是 LLM 独有（导入链只写 `itemTaxonomy` 的 5 个 facet），无冲突。
 *
 * 用法：
 *   node scripts/catalog/activate-enrichment.js --processor-version travel-localize-v1 --out .scratch/activate.sql
 *   node scripts/catalog/activate-enrichment.js --processor-version travel-localize-v1 --dry-run
 */
const fs = require('fs');
const path = require('path');
const D = require('../../web/shared.js');

/** LLM 不产出、必须保留规则行的 facet。写死在这里而不是配置：漏掉它就是静默丢数据。 */
const RULE_ONLY_FACETS = ['languages'];

function parseArgs(argv) {
  const options = { processorVersion: null, out: null, dryRun: false, scope: 'version' };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split('=', 2);
    const value = inline === undefined ? argv[++index] : inline;
    if (name === '--processor-version') options.processorVersion = value;
    else if (name === '--out') options.out = path.resolve(value);
    else if (name === '--dry-run') options.dryRun = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!options.processorVersion) throw new Error('需要 --processor-version（例如 travel-localize-v1）');
  if (!options.dryRun && !options.out) throw new Error('需要 --out（或 --dry-run）');
  return options;
}

/** 本次要激活的产品集合：有该 processor_version 的 LLM 行的产品。 */
function activationScope(processorVersion) {
  return `SELECT DISTINCT product_id FROM taxonomy_assignments WHERE processor_version=${quote(processorVersion)}`;
}

function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/**
 * 生成激活语句。顺序有讲究：
 *  ① 先把 LLM 行提为 current —— 读端（`/api/v1/*`）立刻能看到新标签；
 *  ② 再撤同产品的规则行（保留 RULE_ONLY_FACETS）。
 *
 * ② 用**自连接**而不是子查询：MySQL 不允许在 UPDATE 的子查询里引用同一张表
 * （`You can't specify target table for update in FROM clause`），而多表 UPDATE 允许。
 * 同一个产品有多条 LLM 行时会重复匹配同一规则行，但 SET 是固定值，重复匹配是幂等的。
 */
function buildStatements(processorVersion) {
  const version = quote(processorVersion);
  return [
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
}

/**
 * 回滚：把规则行恢复成 current、LLM 行退回 shadow。激活前先把它一并生成并提交 ——
 * 激活是改线上数据的操作，没有回滚稿就不要执行。
 */
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

/** 激活后的自检查询（由调用方执行；写在报告里让人能复核）。 */
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
    // 同一产品同一 facet 同时有 llm 与 rule 的 current 行 —— 期望为空（白名单除外）
    overlap: `SELECT ta.facet, COUNT(*) AS n FROM taxonomy_assignments ta
      JOIN (${activationScope(processorVersion)}) scope ON scope.product_id = ta.product_id
      WHERE ta.is_current=1 AND ta.facet NOT IN (${RULE_ONLY_FACETS.map(quote).join(',')})
      GROUP BY ta.facet, ta.product_id HAVING COUNT(DISTINCT ta.assignment_source) > 1`,
  };
}

function main(options) {
  const statements = buildStatements(options.processorVersion);
  const rollback = buildRollbackStatements(options.processorVersion);
  const report = {
    processorVersion: options.processorVersion,
    ruleOnlyFacets: RULE_ONLY_FACETS,
    statements: statements.length,
    verify: verifyQueries(options.processorVersion),
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
  console.log(`[activate] ${statements.length} 条语句 → ${options.out}`);
  console.log(`[activate] ${rollback.length} 条回滚语句 → ${rollbackPath}`);
  console.log(`[activate] 保留规则行的 facet: ${RULE_ONLY_FACETS.join(', ')}`);
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

module.exports = { parseArgs, buildStatements, buildRollbackStatements, verifyQueries, RULE_ONLY_FACETS, activationScope };
