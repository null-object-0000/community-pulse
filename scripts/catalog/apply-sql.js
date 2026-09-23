#!/usr/bin/env node
/**
 * 把一份 SQL 文件应用到产品库（离线增强的第二跳：本机跑模型 → 这里写库）。
 *
 * 为什么需要它：本机所在网络在协议层重置到 RDS 3306 的 TLS 握手（公司网络限制），直连不通；
 * 而模型网关是本机自建的，GitHub Actions 到不了。于是「跑模型」留在本机、「写库」交给有
 * Cloudflare 凭据的一方，两边通过一份 SQL 文件交接。
 *
 * **写入通道复用 `createChannelDb`**（与 `upload-mysql.js`、`enrich-products.js` 同一个）：
 * 那条路已经处理了临时 Worker 的部署/删除、workers.dev 路由生效前的等待、令牌校验。
 * 这里不手搓 fetch —— 手搓的第二条路会在「路由没生效返回 HTML 404」这类场景下给出假的
 * 失败信号。
 *
 * 用法：
 *   node scripts/catalog/apply-sql.js --file .scratch/travel.sql --channel
 *   node scripts/catalog/apply-sql.js --file .scratch/travel.sql --channel --dry-run
 *   node scripts/catalog/apply-sql.js --file .scratch/travel.sql --mysql-url "mysql://..."
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createChannelDb } = require('./mysql-channel.js');
const {
  buildStatements: buildTagStatements, buildContentStatements, buildContentRollbackStatements,
  buildRollbackStatements, higherPriorityVersions, contentVersions, VERSION_PRIORITY,
} = require('./activate-enrichment.js');

/** 每批提交的语句数。整份文件一次性 batch 会变成单个超长事务与超大请求体。 */
const STATEMENTS_PER_BATCH = 100;

/**
 * 读 SQL 文件，支持 `.gz`。为什么值得支持：一批全量增强的 SQL 约 10 MB，而它要经一个分支
 * 交给 Actions（仓库是公开的，这个 blob 会永久留在对象里）。gzip 后约 1/7，代价只有这几行。
 */
function readSql(file) {
  const raw = fs.readFileSync(file);
  return /\.gz$/.test(file) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
}

function parseArgs(argv) {
  const options = {
    file: null, channel: false, mysqlUrl: process.env.CATALOG_MYSQL_URL || '',
    dryRun: false, batch: STATEMENTS_PER_BATCH, allowActivation: false,
    hold: false, rollbackOut: null,
  };
  // 布尔开关必须在这里列出：否则 `--allow-activation` 会被当成「取值开关」，
  // 把下一个参数（这里是 `--dry-run`）吃掉当值 —— 与 enrich-travel.js 的 `--pull` 同一个坑。
  const booleans = new Set(['--channel', '--dry-run', '--allow-activation', '--hold']);
  for (let i = 0; i < argv.length; i += 1) {
    const [name, inline] = argv[i].split('=', 2);
    const value = inline === undefined && !booleans.has(name) ? argv[++i] : inline;
    if (name === '--file') options.file = path.resolve(value);
    else if (name === '--channel') options.channel = true;
    else if (name === '--mysql-url') options.mysqlUrl = value;
    else if (name === '--dry-run') options.dryRun = true;
    else if (name === '--batch') options.batch = Number(value);
    else if (name === '--allow-activation') options.allowActivation = true;
    else if (name === '--hold') options.hold = true;
    else if (name === '--rollback-out') options.rollbackOut = path.resolve(value);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!options.file) throw new Error('需要 --file <sql 文件>');
  return options;
}

/**
 * 与 `worker/catalog-import.mjs` 的 `splitSql` 逐字同源 —— 两边对「一条语句」的判断必须一致，
 * 否则语句计数就失去意义（引号里的分号是最常见的分歧点）。
 */
function splitSql(sql) {
  const result = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    if (sql[index] === "'") {
      if (quoted && sql[index + 1] === "'") index += 1;
      else quoted = !quoted;
    } else if (sql[index] === ';' && !quoted) {
      const statement = sql.slice(start, index).trim();
      if (statement) result.push(statement);
      start = index + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

/**
 * shadow 闸：默认只允许写 `is_current=0` 的行。激活（改 `is_current`）是单独的受审操作 ——
 * 曾经就是因为自动激活，线上短暂出现过半成品描述。
 *
 * `--allow-activation` 是那道受审入口：只有显式传它才放行含 `is_current=1` 的语句，且仍然要求
 * 每一条这样的语句都来自 `activate-enrichment.js` 的形状，不允许任意写。默认（不传）保持拒绝。
 * 两种受审形状：
 *   · `UPDATE taxonomy_assignments … SET is_current=1`（标签激活）
 *   · `UPDATE product_content … SET …is_current = 1`（正文激活，Worker 读取端）
 *
 * **注意这道闸只管「文件里带的语句」**：写库后自动上架（`activateVersions`）走的是另一条路 ——
 * 它的语句由 `activate-enrichment.js` 现算，不是从文件读来的，所以不受这里约束。
 */
const ACTIVATION_SHAPES = [
  /^\s*UPDATE\s+taxonomy_assignments\b/i,
  /^\s*UPDATE\s+product_content\b/i,
];

function assertShadowOnly(statements, { allowActivation = false } = {}) {
  const offenders = statements.filter((statement) => /is_current\s*=\s*1/.test(statement));
  if (!offenders.length) return;
  if (!allowActivation) {
    throw new Error(`拒绝应用：${offenders.length} 条语句含 is_current=1，激活需要显式 --allow-activation`);
  }
  const unexpected = offenders.filter((statement) => !ACTIVATION_SHAPES.some(shape => shape.test(statement)));
  if (unexpected.length) {
    throw new Error(`拒绝应用：${unexpected.length} 条激活语句不是受审的激活形状（只允许 taxonomy_assignments / product_content）`);
  }
  console.log(`[apply] --allow-activation：放行 ${offenders.length} 条激活语句`);
}

/**
 * 从 SQL 里探测这批写入涉及哪些加工版本。
 *
 * **为什么从 SQL 里认、而不是让调用方传版本**：调用方传就等于「又要记得」—— 而这正是
 * 2026-09-23 那次事故的形状（`catalog-localize-v1` 的 35,893 条标签跑完从没激活过，因为
 * 「激活」是另一个要人记得的命令）。SQL 是**唯一的事实来源**：它写进去什么版本，就该上架什么版本。
 * 只认 `enrich-products.js` 的 `resultBatchSql` 产出的两种形状，认不出的一律不碰。
 */
function detectVersions(statements) {
  const versions = new Set();
  for (const statement of statements) {
    if (/INSERT INTO product_content/i.test(statement)) {
      for (const match of statement.matchAll(/'llm:([a-z0-9][a-z0-9._-]*)'/gi)) versions.add(match[1]);
    }
    if (/INSERT INTO taxonomy_assignments/i.test(statement)) {
      for (const match of statement.matchAll(/'llm'\s*,\s*NULL\s*,\s*'([a-z0-9][a-z0-9._-]*)'/gi)) versions.add(match[1]);
    }
  }
  return [...versions];
}

/**
 * 写库之后**顺手把这一批上架**（把 shadow 提为 current、撤下被取代的规则标签）。
 *
 * **为什么要自动做**：原来的纪律是「所有输出 shadow，激活是单独的受审操作」。这条纪律在
 * 2026-09-23 被证明只在纸面上成立 —— 一批 2,000 条没人会逐条看，那道「人工关卡」实际什么都没拦，
 * 只拦住了忘记敲命令的人。代价是静默失效：数据早在库里，页面一点都不变，`catalog-localize-v1`
 * 的 35,893 条标签就这样躺了 7 天，网站一直用规则推断（用户发现的 `Lingua Playlist` 被算成
 * 旅行产品就是这么来的）。**自动上架 + 回滚稿 + 显式日志**取代了「靠人记得」。
 *
 * 顺序**必须从高优先级到低优先级**：低优先级那步的「让位」判断依赖高优先级行已经是 current。
 */
async function activateVersions(db, versions, { log = () => {} } = {}) {
  const rank = (version) => {
    const index = VERSION_PRIORITY.indexOf(version);
    return index < 0 ? VERSION_PRIORITY.length : index;
  };
  const ordered = [...versions].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const tagStatements = [];
  for (const version of ordered) {
    // 保护更高优先级版本：传 `--versions` 只写自己那个版本的坑已经踩过一次，这里自动推导。
    tagStatements.push(...buildTagStatements(version, higherPriorityVersions(version)));
  }
  const contentStatements = buildContentStatements(ordered);
  if (tagStatements.length) await db.batch(tagStatements);
  if (contentStatements.length) await db.batch(contentStatements);
  log(`上架 ${ordered.join(', ')}：标签 ${tagStatements.length} 条 + 正文 ${contentStatements.length} 条语句`);
  return { versions: ordered, tagStatements: tagStatements.length, contentStatements: contentStatements.length };
}

/**
 * 回滚稿：把这次上架的版本整体退回 shadow，并把撤下的规则标签还原。
 * 与激活稿同时产出 —— **改线上数据却没有退路，等于把「能不能回头」寄托在记性上**。
 */
function buildRollbackFor(versions) {
  const rank = (version) => {
    const index = VERSION_PRIORITY.indexOf(version);
    return index < 0 ? VERSION_PRIORITY.length : index;
  };
  const ordered = [...versions].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [
    ...ordered.map(version => buildRollbackStatements(version)).flat(),
    ...buildContentRollbackStatements(contentVersions(ordered)),
  ];
}

function summarize(file, sql, statements) {
  return {
    file: path.basename(file),
    bytes: Buffer.byteLength(sql),
    statements: statements.length,
    kinds: {
      content: statements.filter((s) => /INSERT INTO product_content/i.test(s)).length,
      assignments: statements.filter((s) => /INSERT INTO taxonomy_assignments/i.test(s)).length,
      status: statements.filter((s) => /INSERT INTO enrichment_product_status/i.test(s)).length,
      terms: statements.filter((s) => /INSERT INTO taxonomy_terms/i.test(s)).length,
    },
  };
}

async function main(options) {
  const sql = readSql(options.file);
  const statements = splitSql(sql);
  assertShadowOnly(statements, { allowActivation: options.allowActivation });
  const summary = summarize(options.file, sql, statements);
  console.log(`[apply] ${summary.file}: ${summary.bytes} 字节 / ${statements.length} 条语句`);
  console.log(`[apply] ${JSON.stringify(summary.kinds)}`);

  if (options.dryRun) {
    const versions = options.hold ? [] : detectVersions(statements);
    if (versions.length) console.log(`[apply] --dry-run：写库后会顺手上架 ${versions.join(', ')}`);
    console.log('[apply] --dry-run：只校验，未写库');
    return summary;
  }
  if (!options.channel && !options.mysqlUrl) throw new Error('需要 --channel 或 --mysql-url（或设 CATALOG_MYSQL_URL）');

  let db;
  if (options.mysqlUrl && !options.channel) {
    const { openDb } = require('./db-transport.js');
    ({ db } = await openDb({ mysqlUrl: options.mysqlUrl, preferDirect: true }));
  } else {
    db = createChannelDb({ log: (message) => console.log(`[apply] ${message}`) });
  }

  try {
    const applied = await applyStatements(db, statements, { batch: options.batch, log: (m) => console.log(`[apply] ${m}`) });
    console.log(`[apply] 完成：${applied} 条语句已应用（shadow）`);

    // 写库后顺手上架：**默认做**，`--hold` 才留成 shadow 等人确认。
    // 自动做的理由见 `activateVersions` 的注释 —— 「靠人记得」这道关卡实际什么都没拦。
    const versions = options.hold ? [] : detectVersions(statements);
    let activation = null;
    if (versions.length) {
      activation = await activateVersions(db, versions, { log: (m) => console.log(`[apply] ${m}`) });
      const rollback = buildRollbackFor(versions);
      const rollbackPath = options.rollbackOut
        || `${options.file.replace(/\.gz$/, '')}.rollback.sql`;
      fs.writeFileSync(rollbackPath, `${rollback.join(';\n')};\n`);
      console.log(`[apply] 已上架 ${activation.versions.join(', ')}`
        + `（标签 ${activation.tagStatements} 条 + 正文 ${activation.contentStatements} 条）`);
      console.log(`[apply] 回滚稿 ${rollbackPath}（${rollback.length} 条语句）`);
    } else if (options.hold) {
      console.log('[apply] --hold：只写 shadow，未上架（需要人工跑 activate-enrichment.js）');
    } else {
      console.log('[apply] 未识别到可上架的加工版本，保持 shadow');
    }
    return { ...summary, applied, activation };
  } finally {
    await db.close();
  }
}

/**
 * 分批把语句写进去。**抽成函数是为了让「上架」那一步复用同一条执行路径** ——
 * 批次大小与进度打印各写一份的话，两条路的提交粒度会悄悄分叉，而「一批多大」直接决定
 * 崩在中途时重跑要重发多少次模型请求（见 `enrich-products.js` 的 `resultBatchSql` 注释）。
 */
async function applyStatements(db, statements, { batch = STATEMENTS_PER_BATCH, log = () => {} } = {}) {
  let applied = 0;
  for (let i = 0; i < statements.length; i += batch) {
    const chunk = statements.slice(i, i + batch);
    await db.batch(chunk);
    applied += chunk.length;
    log(`${applied}/${statements.length}`);
  }
  return applied;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  main(options).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = {
  parseArgs, splitSql, assertShadowOnly, summarize, main, applyStatements, readSql,
  detectVersions, activateVersions, buildRollbackFor,
};
