/**
 * 产品级 LLM 加工流水线（第一批）的回归用例。
 *
 * 分两层：
 *  ① 纯函数层：队列口径、输入哈希、门禁、SQL 文本纪律 —— 不需要数据库，任何环境都跑。
 *  ② 集成层：对着**真 MySQL** 跑完整状态机（入队 → 门禁 → 结果 → 续跑 → 重入），
 *     验证「0 请求续跑」「无描述零请求」「输出全是 is_current=0」。没有可达的 MySQL 时跳过，
 *     所以 CI 不会因为缺数据库而变红；本地用 `CP_MYSQL_URL` 指到容器即会真的跑。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const D = require('../web/shared.js');
const {
  parseArgs, stableRunId, inputHashFor, localizationInput, hasEvidence,
  planQueue, newBucketSql, reentrySql, runStatusSql, seedSql, resultSql, skipStatusSql, finishRunSql,
  runEnrichment, PROCESSOR_VERSION,
} = require('../scripts/catalog/enrich-products.js');
const { sourceHash, PROMPT_VERSION, translationInput } = require('../.agents/skills/community-pulse/scripts/enhance.js');

const MYSQL_URL = process.env.CP_MYSQL_URL || 'mysql://root:root@127.0.0.1:13306/devtrends_enrich_test';
const MIGRATIONS = ['0001_catalog', '0002_enrichment_product_status', '0003_first_seen_covering_index',
  '0004_dynamic_product_pages', '0005_enrichment_run_cost'];
const ROOT = path.join(__dirname, '..');

function baseArgs(extra = []) {
  return ['--date', '2026-09-19', '--mysql-url', MYSQL_URL, ...extra];
}

function row(productId, summary, title = `标题 ${productId}`) {
  return {
    product_id: productId,
    first_seen_date: '2026-09-19',
    product_title: title,
    observed_date: '2026-09-19',
    content_score: summary.length,
    item_json: { title, summary, sourceName: 'Product Hunt 新品', sourceId: 'producthunt' },
  };
}

// ---- ① 纯函数层 ------------------------------------------------------------------------------

test('enrichment CLI only accepts shadow mode and a bounded concurrency', () => {
  assert.equal(parseArgs(baseArgs()).mode, 'shadow');
  assert.equal(parseArgs(baseArgs(['--concurrency', '20'])).concurrency, 20);
  assert.throws(() => parseArgs(baseArgs(['--mode', 'active'])), /only --mode shadow/);
  assert.throws(() => parseArgs(baseArgs(['--concurrency', '0'])), /between 1 and 50/);
  assert.throws(() => parseArgs(baseArgs(['--concurrency', '51'])), /between 1 and 50/);
  assert.throws(() => parseArgs(['--mysql-url', MYSQL_URL]), /--date YYYY-MM-DD is required/);
  assert.throws(() => parseArgs(['--date', '2026-09-19']), /CATALOG_MYSQL_URL/);
});

test('enrichment run id is stable per date and version, and moves when the version moves', () => {
  const options = parseArgs(baseArgs());
  const again = parseArgs(baseArgs());
  assert.equal(stableRunId(options), stableRunId(again));
  assert.match(stableRunId(options), /^enr_[a-f0-9]{24}$/);
  assert.notEqual(stableRunId(options), stableRunId(parseArgs(baseArgs(['--date', '2026-09-20']))));
  assert.notEqual(stableRunId(options), stableRunId(parseArgs(baseArgs(['--processor-version', 'v2']))));
});

test('enrichment input hash covers the description, the prompt version and the taxonomy version', () => {
  const options = parseArgs(baseArgs());
  const input = localizationInput(row('prd_a', '一段足够长的中文描述，用来判定有没有证据。'));
  const expected = require('node:crypto').createHash('sha256')
    .update(JSON.stringify([sourceHash(input), PROMPT_VERSION, D.taxonomyVersion])).digest('hex');
  assert.equal(inputHashFor(input), expected);
  // 描述变了 → 哈希变（这是「描述补齐后自动回到队列」的判据）
  const changed = localizationInput(row('prd_a', '描述后来被补齐了，内容完全不一样。'));
  assert.notEqual(inputHashFor(input), inputHashFor(changed));
  // 标题/分区变了 → 哈希也变（它们都进 prompt）
  assert.notEqual(inputHashFor(input), inputHashFor({ ...input, title: '别的标题' }));
  assert.notEqual(inputHashFor(input), inputHashFor({ ...input, section: 'Show HN' }));
  assert.notEqual(stableRunId(options), stableRunId(parseArgs(baseArgs(['--processor-version', PROCESSOR_VERSION + 'x']))));
});

test('enrichment gate reuses enhance.js evidence rule instead of inventing a second one', () => {
  assert.equal(hasEvidence(''), false);
  assert.equal(hasEvidence('   '), false);
  // 只有 markdown 链接/图片/裸 URL 的描述，按 enhance.js 的 plainDescription 会剥空 → 无证据
  assert.equal(hasEvidence('![shot](https://example.com/a.png)'), false);
  assert.equal(hasEvidence('https://example.com/only-a-link'), false);
  assert.equal(hasEvidence('这是一个真实的项目描述。'), true);
  // 与 enhance.js 的判据逐字一致
  assert.equal(hasEvidence('https://example.com/x'), Boolean(translationInput('https://example.com/x')));
});

test('enrichment input passes the source NAME to localize so the Product Hunt branch matches', () => {
  const input = localizationInput(row('prd_a', '描述'));
  // localize() 判的是 /^Product Hunt\b/i.test(item.section)：传 sourceId 'producthunt' 会命不中
  assert.equal(input.section, 'Product Hunt 新品');
  assert.match(input.section, /^Product Hunt\b/i);
  // 标题回退到 products.title（item_json 缺 title 时）
  const fallback = localizationInput({ product_id: 'prd_b', product_title: '兜底标题', item_json: { summary: '描述' } });
  assert.equal(fallback.title, '兜底标题');
  assert.equal(fallback.heading, '兜底标题');
  // item_json 从 mysql2 出来是对象，从 SQL 文本出来是字符串，两种都要能读
  assert.equal(localizationInput({ product_id: 'prd_c', item_json: JSON.stringify({ title: 'T', summary: 'S' }) }).desc, 'S');
});

test('enrichment queue is the new bucket plus the re-entry arm, minus terminal unchanged products', () => {
  const options = parseArgs(baseArgs());
  // 重入臂的产品**不在**新增桶里（reentrySql 也显式排除了它），所以这里分开构造。
  const rows = [
    row('prd_new', '一条有证据的描述。'),
    row('prd_empty', ''),
    row('prd_done', '已经加工过、输入没变。'),
    row('prd_changed', '输入变了要重跑。'),
    row('prd_failed', '失败的行。'),
  ];
  const inputOf = (r) => inputHashFor(localizationInput(r));
  const statusRows = [
    { product_id: 'prd_done', status: 'complete', input_hash: inputOf(rows[2]), attempt_count: 1, model_request_count: 1 },
    { product_id: 'prd_changed', status: 'complete', input_hash: 'stale', attempt_count: 1, model_request_count: 1 },
    { product_id: 'prd_failed', status: 'failed', input_hash: 'stale', attempt_count: 1, model_request_count: 1 },
  ];
  const reentryRow = row('prd_skipped_back', '描述补齐了，应当重入。');
  const plan = planQueue(options, rows, statusRows, [reentryRow]);
  const ids = plan.pending.map(entry => entry.row.product_id).sort();
  // prd_done 输入未变 → 0 请求续跑，不在队列里；prd_empty 无证据 → 门禁；prd_failed 未开 --retry-failed
  assert.deepEqual(ids, ['prd_changed', 'prd_new', 'prd_skipped_back']);
  assert.equal(plan.resumedCount, 1);
  assert.equal(plan.skippedFailedCount, 1);
  assert.deepEqual(plan.skipped.map(entry => entry.row.product_id), ['prd_empty']);
  assert.equal(plan.reentryCount, 1);
  assert.equal(plan.pending.find(entry => entry.row.product_id === 'prd_skipped_back').fromReentry, true);
  // 同一个产品同时在两臂里时，新增桶赢（seen 去重），不会重复加工
  const both = planQueue(options, [...rows, reentryRow], statusRows, [reentryRow]);
  assert.equal(both.pending.filter(entry => entry.row.product_id === 'prd_skipped_back').length, 1);
  assert.equal(both.reentryCount, 0);
});

test('enrichment queue re-queues failed products only with --retry-failed, and --limit never hides gate skips', () => {
  const done = row('prd_done', '已经加工过、输入没变。');
  const rows = [row('prd_failed', '失败的行。'), row('prd_empty', ''), row('prd_new', '有证据。'), done];
  const statusRows = [
    { product_id: 'prd_failed', status: 'failed', input_hash: 'stale', attempt_count: 1, model_request_count: 1 },
    { product_id: 'prd_done', status: 'complete', input_hash: inputHashFor(localizationInput(done)), attempt_count: 1, model_request_count: 1 },
  ];
  const retry = planQueue(parseArgs(baseArgs(['--retry-failed'])), rows, statusRows, []);
  assert.ok(retry.pending.some(entry => entry.row.product_id === 'prd_failed'));
  const limited = planQueue(parseArgs(baseArgs(['--limit', '1'])), rows, statusRows, []);
  assert.equal(limited.pending.length, 1);
  // 门禁统计覆盖全部候选：跳过的产品零成本，不该被 --limit 截掉，否则「零请求」的计数证据就残缺了
  assert.equal(limited.skipped.length, 1);
  const single = planQueue(parseArgs(baseArgs(['--product-id', 'prd_new'])), rows, statusRows, []);
  assert.deepEqual(single.pending.map(entry => entry.row.product_id), ['prd_new']);
  assert.equal(single.skipped.length, 0);
  // --no-resume 是唯一会让「终态且输入未变」重新进模型的开关（默认永远续跑）
  const forced = planQueue(parseArgs(baseArgs(['--no-resume'])), rows, statusRows, []);
  assert.ok(forced.pending.some(entry => entry.row.product_id === 'prd_done'));
  assert.equal(forced.resumedCount, 0);
  assert.ok(planQueue(parseArgs(baseArgs(['--no-resume', '--retry-failed'])), rows, statusRows, [])
    .pending.some(entry => entry.row.product_id === 'prd_failed'));
});

test('enrichment writes only shadow rows and never invents a created_at literal', () => {
  const options = parseArgs(baseArgs());
  const entry = { row: row('prd_a', '描述'), input: localizationInput(row('prd_a', '描述')) };
  const localized = {
    titleEn: 'English title', summaryZh: '中文摘要', summaryEn: 'English summary',
    primaryCategory: 'developer-tools', taxonomy: { useCases: ['software-development'], platforms: ['macos'] },
  };
  const statements = resultSql('enr_test', options, entry, localized, 1);
  const text = statements.join('\n');
  // 每一条 product_content / taxonomy_assignments 插入都必须显式 is_current=0（shadow 的唯一保证）
  for (const statement of statements.filter(s => s.startsWith('INSERT INTO'))) {
    assert.match(statement, /,\s*0\)$/, `应当以 is_current=0 结尾: ${statement.slice(0, 80)}`);
  }
  // created_at 交给列默认值：旧实现写 new Date().toISOString()，MySQL 的 DATETIME(3) 收不了
  assert.doesNotMatch(text, /created_at/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/);
  // zh-CN 的标题是原标题，英文标题来自模型
  assert.match(text, /'zh-CN', '标题 prd_a'/);
  assert.match(text, /'en', 'English title'/);
  // 主分类 + 各分面都落 assignment，且 confidence 留空
  assert.equal((text.match(/INSERT INTO taxonomy_assignments/g) || []).length, 3);
  assert.match(text, /'primaryCategory', 'developer-tools', 'llm', NULL/);
  // 模型没返回 titleEn 时回退到原标题，不写空标题
  const noTitle = resultSql('enr_test', options, entry, { ...localized, titleEn: '' }, 1).join('\n');
  assert.match(noTitle, /'en', '标题 prd_a'/);
});

test('enrichment escapes quotes and backslashes in model output', () => {
  const options = parseArgs(baseArgs());
  const entry = { row: row('prd_a', '描述'), input: localizationInput(row('prd_a', '描述')) };
  const statements = resultSql('enr_test', options, entry, {
    titleEn: "It's a \\ backslash", summaryZh: "含 ' 单引号", summaryEn: 'ok',
    primaryCategory: 'other', taxonomy: { useCases: ['software-development'] },
  }, 1);
  const insert = statements.find(s => s.includes("'zh-CN'"));
  assert.match(insert, /含 '' 单引号/);
  assert.match(statements.join('\n'), /It''s a \\\\ backslash/);
});

test('enrichment gate writes an independent terminal state with zero requests recorded', () => {
  const options = parseArgs(baseArgs());
  const entry = { row: row('prd_empty', ''), input: localizationInput(row('prd_empty', '')), inputHash: 'h' };
  const statement = skipStatusSql('enr_test', [entry])[0];
  assert.match(statement, /'skipped_no_input'/);
  // 不是 failed：两者含义不同，失败要重试、跳过不要
  assert.doesNotMatch(statement, /'failed'/);
  // attempt/request 都不写 → 保持列默认 0，这就是「零模型请求」的可计数证据
  assert.doesNotMatch(statement, /attempt_count/);
  assert.doesNotMatch(statement, /model_request_count/);
});

test('enrichment run record carries the cost curve columns and a readable summary', () => {
  const statement = finishRunSql('enr_test', {
    productCount: 793, newProductCount: 762, reentryCount: 31, requestedCount: 732, completedCount: 730,
    failedCount: 2, skippedNoInputCount: 31, resumedCount: 0, modelRequests: 735, wallClockMs: 123456,
    states: { pending: 0, running: 0, complete: 730, failed: 2 },
  });
  assert.match(statement, /status='failed'/);
  assert.match(statement, /product_count=793/);
  assert.match(statement, /new_product_count=762/);
  assert.match(statement, /reentry_count=31/);
  assert.match(statement, /requested_count=732/);
  assert.match(statement, /completed_count=730/);
  assert.match(statement, /failed_count=2/);
  assert.match(statement, /skipped_no_input_count=31/);
  assert.match(statement, /resumed_count=0/);
  assert.match(statement, /model_request_count=735/);
  assert.match(statement, /wall_clock_ms=123456/);
  assert.match(statement, /summary_json='\{/);
  // 没有失败/残留时记为 complete
  assert.match(finishRunSql('enr_test', {
    productCount: 1, newProductCount: 1, reentryCount: 0, requestedCount: 1, completedCount: 1,
    failedCount: 0, skippedNoInputCount: 0, resumedCount: 0, modelRequests: 1, wallClockMs: 1,
    states: { pending: 0, running: 0, complete: 1, failed: 0 },
  }), /status='complete'/);
});

test('enrichment queue SQL keys on first_seen_date and seeds the controlled vocabulary first', () => {
  const options = parseArgs(baseArgs());
  const bucket = newBucketSql(options.date);
  assert.match(bucket, /p\.first_seen_date = '2026-09-19'/);
  assert.match(bucket, /JOIN product_details d/);
  // 队列只读单条 SELECT：生产只读通道只放行单条 SELECT
  assert.doesNotMatch(bucket, /;/);
  assert.doesNotMatch(reentrySql(options), /;/);
  assert.doesNotMatch(runStatusSql('enr_x'), /;/);
  // 重入臂要跨 run 找 skipped_no_input，且子查询必须限定别名（不限定会和外层 product_details 撞列）
  const reentry = reentrySql(options);
  assert.match(reentry, /s\.status IN \('skipped_no_input'\)/);
  assert.match(reentry, /SELECT fresh\.id FROM products fresh/);
  assert.doesNotMatch(reentry, /\(SELECT product_id FROM products/);
  assert.match(reentrySql(parseArgs(baseArgs(['--retry-failed']))), /s\.status IN \('skipped_no_input','failed'\)/);
  // 词表种子必须含主分类与全部分面，且幂等
  const seed = seedSql().join('\n');
  assert.match(seed, /INSERT INTO taxonomy_terms/);
  assert.match(seed, /ON DUPLICATE KEY UPDATE/);
  for (const category of D.categories) assert.ok(seed.includes(`'${category.id}'`), `缺主分类 ${category.id}`);
  for (const facet of Object.keys(D.taxonomyFacets)) assert.ok(seed.includes(`'${facet}'`), `缺分面 ${facet}`);
});

test('no migration uses SQL-level PREPARE, because Hyperdrive rejects it', () => {
  // 生产写入走 Cloudflare Hyperdrive，它**不支持 MySQL 的 SQL 级 prepared statement**：
  // 0005 最初用 information_schema + PREPARE 让 ALTER 幂等，本地直连 MySQL 8.4 跑得通、
  // 在 Hyperdrive 上直接 500（error code 1104），第一次跑生产迁移就是这样炸的。
  // 幂等因此搬到 scripts/catalog/apply-mysql-migrations.js：记账 + 逐条执行 + 「已存在」容错。
  const directory = path.join(ROOT, 'migrations', 'mysql');
  const files = fs.readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  assert.ok(files.length >= 5);
  for (const name of files) {
    // 只看语句本身：注释里可以（也应该）解释为什么不能用 PREPARE
    const sql = fs.readFileSync(path.join(directory, name), 'utf8')
      .replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(sql, /\bPREPARE\b/i, `${name} 的语句含 PREPARE，Hyperdrive 不支持`);
    assert.doesNotMatch(sql, /\bDEALLOCATE\b/i, `${name} 的语句含 DEALLOCATE，Hyperdrive 不支持`);
  }
  const applier = fs.readFileSync(path.join(ROOT, 'scripts', 'catalog', 'apply-mysql-migrations.js'), 'utf8');
  assert.match(applier, /schema_migrations/, '幂等必须由应用器记账');
  assert.match(applier, /Duplicate column name/, '引导路径要容忍「已存在」');
});

test('migration applier applies in filename order and validates its transport', () => {
  const { parseArgs, migrationFiles } = require('../scripts/catalog/apply-mysql-migrations.js');
  const files = migrationFiles();
  assert.deepEqual(files, [...files].sort());
  assert.equal(files[0], '0001_catalog.sql');
  assert.ok(files.includes('0005_enrichment_run_cost.sql'));
  assert.deepEqual(migrationFiles('0005'), ['0005_enrichment_run_cost.sql']);
  assert.throws(() => parseArgs([]), /CATALOG_MYSQL_URL/);
  assert.equal(parseArgs(['--channel']).channel, true);
});

test('mysql channel deploys lazily, posts to the right endpoint and tears down', async () => {
  const { createChannelDb } = require('../scripts/catalog/mysql-channel.js');
  const deployed = [];
  const destroyed = [];
  const calls = [];
  const spawnSync = (command, args) => {
    // 真实调用是 spawnSync('npx', ['wrangler', 'deploy', ...])，所以判 args.includes 而不是 args[0]
    const config = args[args.indexOf('--config') + 1];
    if (args.includes('deploy')) {
      deployed.push(config);
      return { status: 0, stdout: `Uploaded\nhttps://${config.replace(/\./g, '-')}.example.workers.dev\n`, stderr: '' };
    }
    destroyed.push(config);
    return { status: 0, stdout: '', stderr: '' };
  };
  const fetch = async (url, init) => {
    calls.push({ url, body: init.body, auth: init.headers.authorization });
    return url.endsWith('/query')
      ? { status: 200, json: async () => ({ ok: true, rows: [{ product_id: 'prd_a' }] }) }
      : { status: 200, json: async () => ({ ok: true, statements: 1 }) };
  };
  const db = createChannelDb({ spawnSync, fetch });
  // 懒部署：没用到的那一侧不部署 —— 干跑（只读队列、不写结果）因此不碰写入入口
  assert.deepEqual(deployed, []);
  assert.deepEqual(await db.select('SELECT 1'), [{ product_id: 'prd_a' }]);
  assert.deepEqual(deployed, ['wrangler.mysql-read.toml']);
  assert.match(calls[0].url, /\/query$/);
  assert.match(calls[0].auth, /^Bearer [a-f0-9]{64}$/);
  await db.batch(['UPDATE a SET x=1', 'UPDATE b SET x=1']);
  assert.deepEqual(deployed, ['wrangler.mysql-read.toml', 'wrangler.mysql-import.toml']);
  assert.match(calls[1].url, /\/import$/);
  // 一批语句合成一个请求：写入 Worker 会把它放进同一个事务
  assert.equal(calls[1].body, 'UPDATE a SET x=1;\nUPDATE b SET x=1;');
  await db.execute('UPDATE c SET x=1');
  assert.equal(calls[2].body, 'UPDATE c SET x=1');
  await db.close();
  assert.deepEqual(destroyed.sort(), ['wrangler.mysql-import.toml', 'wrangler.mysql-read.toml']);
});

test('mysql channel surfaces worker errors instead of swallowing them', async () => {
  const { createChannelDb } = require('../scripts/catalog/mysql-channel.js');
  const okDeploy = () => ({ status: 0, stdout: 'https://x.example.workers.dev', stderr: '' });
  // 这条错误就是第一次推生产迁移时真实拿到的那个
  const failing = async () => ({ status: 500, json: async () => ({ ok: false, error: 'Hyperdrive does not currently support MySQL prepared statements' }) });
  const db = createChannelDb({ spawnSync: okDeploy, fetch: failing });
  await assert.rejects(() => db.select('SELECT 1'), /Hyperdrive does not currently support/);
  await assert.rejects(() => db.batch(['ALTER TABLE x ADD COLUMN y INT']), /Hyperdrive does not currently support/);
  await db.close();
  // 部署失败要把 wrangler 的输出带出来，否则「为什么连不上」只能靠猜
  const broken = createChannelDb({ spawnSync: () => ({ status: 1, stdout: 'boom', stderr: 'nope' }), fetch: failing });
  await assert.rejects(() => broken.select('SELECT 1'), /部署失败[\s\S]*boom/);
});

// ---- ② 集成层（真 MySQL） ---------------------------------------------------------------------

async function connect(databaseOverride) {
  const mysql = require('mysql2/promise');
  const url = new URL(MYSQL_URL);
  const database = databaseOverride || url.pathname.replace(/^\//, '') || 'devtrends_enrich_test';
  const base = { host: url.hostname, port: Number(url.port || 3306), user: url.username, password: url.password, connectTimeout: 3000 };
  // 每次都整库重建：逐表 DROP 会留下指向已删表的旧外键，重建后状态不可预期。
  const admin = await mysql.createConnection(base);
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.query(`CREATE DATABASE \`${database}\``);
  await admin.end();
  const connection = await mysql.createConnection({ ...base, database, multipleStatements: false, dateStrings: true });
  return { connection, database };
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

/** 本地没有可达的 MySQL 就跳过集成层（CI 没有容器，不该因此变红）。 */
async function withDatabase(t, databaseOverride) {
  let handle;
  try {
    handle = await connect(databaseOverride);
  } catch (error) {
    t.skip(`没有可达的 MySQL（${MYSQL_URL}）：${error.message}`);
    return null;
  }
  const { connection, database } = handle;
  void database;
  for (const name of MIGRATIONS) {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations', 'mysql', `${name}.sql`), 'utf8');
    // 迁移里用了会话变量 @ddl 的守卫，必须单连接顺序执行（与生产上传 Worker 一致）
    for (const statement of splitSql(sql)) await connection.query(statement);
  }
  return { connection, database };
}

/** 与 worker/catalog-import.mjs 同一份切分实现。 */
function splitSql(sql) {
  const source = fs.readFileSync(path.join(ROOT, 'worker', 'catalog-import.mjs'), 'utf8');
  const start = source.indexOf('export function splitSql');
  const end = source.indexOf('\nexport default');
  const body = source.slice(start, end).replace('export function splitSql', 'function splitSql');
  return new Function(`${body}; return splitSql;`)()(sql);
}

async function seed(connection, rows) {
  for (const item of rows) {
    const json = JSON.stringify(item.item_json).replaceAll('\\', '\\\\').replaceAll("'", "''");
    await connection.query(`INSERT INTO products (id, canonical_key, title, first_seen_date, last_seen_date)
      VALUES ('${item.product_id}', 'key-${item.product_id}', '${item.product_title}', '${item.first_seen_date}', '${item.first_seen_date}')`);
    await connection.query(`INSERT INTO product_details (product_id, observed_date, content_score, item_json, content_hash)
      VALUES ('${item.product_id}', '${item.observed_date}', ${item.content_score}, '${json}', REPEAT('a',64))`);
  }
}

function stubLocalize(calls) {
  return async (input, options = {}) => {
    calls.push(input);
    options.onRequest?.();
    return {
      titleEn: 'English title', summaryZh: '中文摘要', summaryEn: 'English summary',
      primaryCategory: 'developer-tools', taxonomy: { useCases: ['software-development'], platforms: ['macos'] },
    };
  };
}

test('enrichment integration: full state machine against a real MySQL', async (t) => {
  const handle = await withDatabase(t);
  if (!handle) return;
  const { connection } = handle;
  const options = { ...parseArgs(['--date', '2026-09-19', '--mysql-url', MYSQL_URL]), mysqlUrl: MYSQL_URL };
  const run = (extra = {}, calls = []) => runEnrichment(
    { ...options, ...extra, quiet: true },
    { db: makeDb(connection), localize: stubLocalize(calls), now: () => Date.now() },
  );
  try {
    // 一个更早日期上被门禁跳过的产品：它不在 09-19 的新增桶里，只能靠重入臂回到队列。
    // 这正是「跳过必须可重入」要解决的形状 —— 描述补齐时 first_seen_date 还是旧的那天。
    await seed(connection, [{ ...row('prd_old', ''), first_seen_date: '2026-09-18', observed_date: '2026-09-18' }]);
    const oldRun = await run({ date: '2026-09-18' });
    assert.equal(oldRun.skippedNoInputCount, 1);
    assert.equal(oldRun.modelRequests, 0);

    await seed(connection, [
      row('prd_1', '一条有证据的描述，足够长。'),
      row('prd_2', '另一条有证据的描述。'),
      row('prd_3', ''),                            // 门禁：无证据
      row('prd_4', 'https://only-a-link.example'), // 门禁：剥完是空
    ]);

    // R1：新增桶 4 个，2 个进模型、2 个被门禁挡下
    const calls1 = [];
    const first = await run({}, calls1);
    assert.equal(first.newProductCount, 4);
    assert.equal(first.requestedCount, 2);
    assert.equal(first.skippedNoInputCount, 2);
    assert.equal(first.completedCount, 2);
    assert.equal(first.failedCount, 0);
    assert.equal(first.modelRequests, 2);
    assert.equal(calls1.length, 2);

    // 门禁的验收证据：按状态计数证明「无描述产品零模型请求」，不是读代码分支
    const [skipped] = await connection.query(`SELECT COUNT(*) AS n FROM enrichment_product_status
      WHERE status='skipped_no_input' AND attempt_count=0 AND model_request_count=0`);
    assert.equal(skipped[0].n, 3);   // 09-18 的 prd_old + 09-19 的 prd_3 / prd_4
    const [attempted] = await connection.query(`SELECT COUNT(*) AS n FROM enrichment_product_status WHERE attempt_count > 0`);
    assert.equal(attempted[0].n, 2);

    // shadow 不变量：两张结果表里不能有任何 is_current=1
    const [current] = await connection.query(`SELECT
      (SELECT COUNT(*) FROM product_content WHERE is_current=1) AS content,
      (SELECT COUNT(*) FROM taxonomy_assignments WHERE is_current=1) AS taxonomy`);
    assert.equal(current[0].content, 0);
    assert.equal(current[0].taxonomy, 0);
    const [written] = await connection.query(`SELECT
      (SELECT COUNT(*) FROM product_content) AS content,
      (SELECT COUNT(*) FROM taxonomy_assignments) AS taxonomy`);
    assert.equal(written[0].content, 4);      // 2 个产品 × 双语
    assert.equal(written[0].taxonomy, 6);     // 2 个产品 ×（主分类 + useCases + platforms）
    // 词表先种子后写标签，否则外键会让整批 assignment 失败
    const [terms] = await connection.query(`SELECT COUNT(*) AS n FROM taxonomy_terms`);
    assert.ok(terms[0].n > 0);

    // R2：终态且输入未变 → 0 请求、0 写入
    const calls2 = [];
    const second = await run({}, calls2);
    assert.equal(second.modelRequests, 0);
    assert.equal(second.requestedCount, 0);
    assert.equal(second.skippedNoInputCount, 0);
    assert.equal(second.resumedCount, 5);     // prd_1..4 + prd_old
    assert.equal(calls2.length, 0);
    const [afterSecond] = await connection.query(`SELECT COUNT(*) AS n FROM product_content`);
    assert.equal(afterSecond[0].n, 4);

    // R3：把 09-18 那条被跳过产品的描述补齐 → 重入臂自动把它拉回队列，不需要人工干预
    await connection.query(`UPDATE product_details SET item_json='${JSON.stringify({
      title: '标题 prd_old', summary: '描述后来被补齐了，内容足够长。', sourceName: 'Product Hunt 新品',
    }).replaceAll("'", "''")}' WHERE product_id='prd_old'`);
    const calls3 = [];
    const third = await run({}, calls3);
    assert.equal(third.reentryCount, 1);
    assert.equal(third.modelRequests, 1);
    assert.equal(third.resumedCount, 4);
    assert.equal(calls3.length, 1);
    assert.equal(calls3[0].productId, 'prd_old');
    // prd_old 现在有两条状态行（09-18 那次跳过、09-19 这次重入成功），必须按 run 取
    const [reentered] = await connection.query(`SELECT status FROM enrichment_product_status
      WHERE product_id='prd_old' AND enrichment_run_id='${third.runId}'`);
    assert.equal(reentered[0].status, 'complete');
    const [oldStillSkipped] = await connection.query(`SELECT status FROM enrichment_product_status
      WHERE product_id='prd_old' AND enrichment_run_id='${oldRun.runId}'`);
    assert.equal(oldStillSkipped[0].status, 'skipped_no_input');   // 历史 run 的状态不被改写

    // R4：新增桶内的产品描述变了同样要重跑 —— 它由新增桶承接，不重复计进重入臂
    await connection.query(`UPDATE product_details SET item_json='${JSON.stringify({
      title: '标题 prd_3', summary: '这条的描述当天就补上了。', sourceName: 'Product Hunt 新品',
    }).replaceAll("'", "''")}' WHERE product_id='prd_3'`);
    const calls4 = [];
    const fourth = await run({}, calls4);
    assert.equal(fourth.reentryCount, 0);
    assert.equal(fourth.requestedCount, 1);
    assert.equal(fourth.resumedCount, 4);
    assert.equal(calls4[0].productId, 'prd_3');

    // 成本记录落成了可读数字
    const [record] = await connection.query(`SELECT product_count, new_product_count, reentry_count, requested_count,
      completed_count, failed_count, skipped_no_input_count, resumed_count, model_request_count, wall_clock_ms, summary_json, status
      FROM enrichment_runs WHERE id='${fourth.runId}'`);
    assert.equal(record[0].new_product_count, 4);
    assert.equal(record[0].reentry_count, 0);
    assert.equal(record[0].requested_count, 1);
    assert.equal(record[0].resumed_count, 4);
    assert.equal(record[0].model_request_count, 1);
    assert.equal(record[0].status, 'complete');
    // mysql2 会把 JSON 列直接解析成对象；按字符串读的通道（上传 Worker 的返回）才需要 JSON.parse
    const runSummary = typeof record[0].summary_json === 'string' ? JSON.parse(record[0].summary_json) : record[0].summary_json;
    assert.equal(runSummary.modelRequests, 1);
    assert.equal(runSummary.statePersisted, true);

    // 版本变化 → 新 run → 该日重付一次（刻意的：改了 prompt / 词表就该重跑）
    const calls5 = [];
    const versioned = await run({ processorVersion: 'catalog-localize-v2' }, calls5);
    assert.notEqual(versioned.runId, fourth.runId);
    assert.equal(versioned.requestedCount, 3);   // prd_4 仍然只有一条链接，门禁照旧挡住
    assert.equal(versioned.modelRequests, 3);
    assert.equal(versioned.resumedCount, 0);
  } finally {
    await connection.end();
  }
});

test('enrichment integration: --dry-run writes nothing at all', async (t) => {
  const handle = await withDatabase(t);
  if (!handle) return;
  const { connection } = handle;
  const options = { ...parseArgs(['--date', '2026-09-19', '--mysql-url', MYSQL_URL]), mysqlUrl: MYSQL_URL, dryRun: true };
  try {
    await seed(connection, [row('prd_dry', '一条有证据的描述，足够长。')]);
    const db = makeDb(connection);
    const calls = [];
    const summary = await runEnrichment({ ...options, quiet: true }, { db, localize: stubLocalize(calls), now: () => Date.now() });
    assert.equal(summary.modelRequests, 1);
    assert.equal(summary.statePersisted, false);
    const [counts] = await connection.query(`SELECT
      (SELECT COUNT(*) FROM enrichment_runs) AS runs,
      (SELECT COUNT(*) FROM enrichment_product_status) AS statuses,
      (SELECT COUNT(*) FROM product_content) AS content,
      (SELECT COUNT(*) FROM taxonomy_assignments) AS taxonomy`);
    assert.deepEqual({ ...counts[0] }, { runs: 0, statuses: 0, content: 0, taxonomy: 0 });
  } finally {
    await connection.end();
  }
});

test('enrichment integration: migration applier is idempotent and bootstraps an existing schema', async (t) => {
  const handle = await withDatabase(t, 'devtrends_enrich_migrate_test');
  if (!handle) return;
  const { connection } = handle;
  const { applyAll } = require('../scripts/catalog/apply-mysql-migrations.js');
  const db = makeDb(connection);
  try {
    // 空库：五个迁移全跑，全部记账
    const first = await applyAll(db, {});
    assert.equal(first.applied, 5);
    assert.equal(first.alreadyRecorded, 0);
    const [recorded] = await connection.query('SELECT COUNT(*) AS n FROM schema_migrations');
    assert.equal(recorded[0].n, 5);

    // 二次运行：记账挡住，一条都不执行
    const second = await applyAll(db, {});
    assert.equal(second.applied, 0);
    assert.equal(second.alreadyRecorded, 5);

    // 引导路径（生产就是这形状：schema 已在、记账表是空的）：重复的语句被跳过、缺的补上
    await connection.query('DELETE FROM schema_migrations');
    const third = await applyAll(db, {});
    assert.equal(third.applied, 5);
    const skippedOf = (prefix) => third.migrations.find(entry => entry.name.startsWith(prefix)).skipped;
    assert.ok(skippedOf('0003') >= 1, '0003 的裸 ADD KEY 应当被容错跳过');
    // 0005 的 13 个 ADD COLUMN 被容错跳过，MODIFY COLUMN 本身幂等所以会真的执行一次
    assert.equal(skippedOf('0005'), 13);
    const [columns] = await connection.query(`SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='enrichment_runs' AND COLUMN_NAME='model_request_count'`);
    assert.equal(columns[0].n, 1);
  } finally {
    await connection.end();
  }
});
