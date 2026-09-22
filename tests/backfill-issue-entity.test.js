const test = require('node:test');
const assert = require('node:assert/strict');

const { reidentify, replaceLinkLine, replaceFinalProductId, classify } = require('../scripts/backfill_issue_entity.js');
const { identityFor, productId } = require('../scripts/catalog/identity.js');

const ISSUE = { body: '仓库地址：https://github.com/AnotiaWang/deep-research-web-ui', html_url: 'https://github.com/ruanyf/weekly/issues/6110' };

test('reidentify reports only the fields the current rule changes', () => {
  // 老 raw 文件没有 githubUrl / github：只改 url，不凭空补出仓库字段。
  const old = { url: 'https://github.com/dzhng/deep-research', issueUrl: ISSUE.html_url, title: 'x' };
  const outcome = reidentify(old, ISSUE, null);
  assert.equal(outcome.kind, 'repo');
  assert.equal(outcome.next.url, 'https://github.com/AnotiaWang/deep-research-web-ui');
  assert.equal('githubUrl' in outcome.next, false);
  assert.equal('github' in outcome.next, false);
});

test('reidentify leaves an unchanged row alone', () => {
  const item = { url: 'https://github.com/AnotiaWang/deep-research-web-ui', issueUrl: ISSUE.html_url, title: 'x' };
  assert.equal(reidentify(item, ISSUE, null), null);
});

test('a renamed repository keeps the canonical address from the facts snapshot', () => {
  // webc-site/wedb_embed 已改名成 fastalp：快照里记的是改名后的 html_url，
  // 于是「仓库 key 变了」但 githubUrl 原样 —— 这种行不该被算成改动。
  const item = {
    url: 'https://github.com/webc-site/wedb_embed', githubUrl: 'https://github.com/webc-site/fastalp',
    github: { url: 'https://github.com/webc-site/fastalp', name: 'webc-site/fastalp' },
    issueUrl: 'https://github.com/521xueweihan/HelloGitHub/issues/3626', title: 'fastalp',
  };
  const issue = { body: '### 项目地址\nhttps://github.com/webc-site/wedb_embed', html_url: item.issueUrl };
  const repositories = new Map([['webc-site/wedb_embed', { url: 'https://github.com/webc-site/fastalp', name: 'webc-site/fastalp' }]]);
  assert.equal(reidentify(item, issue, repositories), null);
});

test('an ambiguous submission loses its repository identity', () => {
  const item = {
    url: 'https://github.com/JuneYaooo/clinical-calculator', githubUrl: 'https://github.com/JuneYaooo/clinical-calculator',
    github: { url: 'https://github.com/JuneYaooo/clinical-calculator' },
    issueUrl: 'https://github.com/ruanyf/weekly/issues/11358', title: 'x',
  };
  const issue = {
    html_url: item.issueUrl,
    body: ['项目地址：https://github.com/JuneYaooo/clinical-calculator', '项目地址：https://github.com/JuneYaooo/find-similar-medical-cases'].join('\n'),
  };
  const outcome = reidentify(item, issue, null);
  assert.equal(outcome.next.url, item.issueUrl);
  assert.equal('githubUrl' in outcome.next, false);
  assert.equal('github' in outcome.next, false);
});

test('replaceLinkLine rewrites exactly one link line inside the matching block', () => {
  const markdown = [
    '# 📰 大家都在做什么 · 2026-04-13', '',
    '### 别的项目 👤 someone', '', '> 摘要', '',
    '🔗 [GitHub](https://github.com/other/repo) · [投稿页](https://github.com/ruanyf/weekly/issues/1)', '',
    '### 【开源自荐】OpenToggl 👤 CorrectRoadH', '', '> 摘要', '',
    '🔗 [GitHub](https://github.com/CorrectRoadH/OpenTickly) · [投稿页](https://github.com/ruanyf/weekly/issues/9615)', '',
  ].join('\n');
  const item = { title: '【开源自荐】OpenToggl', url: 'https://github.com/CorrectRoadH/OpenTickly', githubUrl: 'https://github.com/CorrectRoadH/OpenTickly' };
  const next = { ...item, url: 'https://github.com/CorrectRoadH/opentoggl' };
  const updated = replaceLinkLine(markdown, item, next);
  assert.match(updated, /🔗 \[GitHub\]\(https:\/\/github\.com\/CorrectRoadH\/opentoggl\)/);
  assert.match(updated, /🔗 \[GitHub\]\(https:\/\/github\.com\/other\/repo\)/, '别的行不能动');
});

test('replaceLinkLine refuses to guess when the block is not unique', () => {
  const markdown = [
    '### 同名项目 👤 a', '', '🔗 [GitHub](https://github.com/x/y)', '',
    '### 同名项目 👤 b', '', '🔗 [GitHub](https://github.com/x/y)', '',
  ].join('\n');
  const item = { title: '同名项目', url: 'https://github.com/x/y' };
  assert.equal(replaceLinkLine(markdown, item, { ...item, url: 'https://github.com/x/z' }), null);
});

// 地址变了身份就变了。已发布日报（2026-09-20 起）自带 productId，不同步改写会让
// `check:report-identity` 判「日报行与产品库漂移」—— 产品库那一行正是按新身份导入的。
test('a repaired address carries the published productId along', () => {
  const issue = { body: '做攻略的时候发现信息很散。\n\n**https://seichigo.com**', html_url: ISSUE.html_url };
  const item = { url: 'https://seichigo.com**', issueUrl: ISSUE.html_url, title: 'x', productId: 'prd_stale' };
  const outcome = reidentify(item, issue, null);
  assert.equal(outcome.next.url, 'https://seichigo.com');
  assert.notEqual(outcome.next.productId, 'prd_stale');
  assert.equal(outcome.next.productId, productId(identityFor(outcome.next)));
  // 老 raw 行本来就没有 productId：不能凭空补出来。
  const { productId: _published, ...legacyItem } = item;
  const legacy = reidentify(legacyItem, issue, null);
  assert.equal('productId' in legacy.next, false);
});

// 同日 final 的增强记录按 productId 匹配，身份换了它也得跟着换，否则整条 LLM 增强掉回 raw
// （presentation.summarySource 从 llm-final 变 mixed）。
test('replaceFinalProductId rewrites only the matching enhancement record', () => {
  const encode = (value) => `<!-- devtrends-i18n:${Buffer.from(JSON.stringify(value)).toString('base64')} -->`;
  const decode = (line) => JSON.parse(Buffer.from(line.match(/devtrends-i18n:([A-Za-z0-9+/=]+)/)[1], 'base64').toString('utf8'));
  const markdown = [
    '### 甲', '> 摘要', encode({ schemaVersion: 3, sourceHash: 'aaa', productId: 'prd_old', summaryZh: '甲摘要' }), '',
    '### 乙', '> 摘要', encode({ schemaVersion: 3, sourceHash: 'bbb', productId: 'prd_other', summaryZh: '乙摘要' }), '',
  ].join('\n');
  const { markdown: updated, replaced } = replaceFinalProductId(markdown, 'prd_old', 'prd_new');
  assert.equal(replaced, 1);
  const records = updated.split('\n').filter((line) => line.startsWith('<!--')).map(decode);
  assert.deepEqual(records.map((record) => record.productId), ['prd_new', 'prd_other']);
  // 只有身份键变，其余字段（含 sourceHash）逐字不动。
  assert.equal(records[0].summaryZh, '甲摘要');
  assert.equal(records[0].sourceHash, 'aaa');
  assert.equal(replaceFinalProductId(markdown, 'prd_missing', 'prd_new').replaced, 0);
});

test('audit categories separate junk addresses from real repository swaps', () => {
  assert.equal(classify({ before: { url: 'https://github.com/user-attachments/assets/abc' }, after: { url: 'https://github.com/a/b' } }), 'junk');
  assert.equal(classify({ before: { url: 'https://chromewebstore.google.com/detail/x/y' }, after: { url: 'https://github.com/a/b' } }), 'junk');
  assert.equal(classify({ before: { url: 'https://github.com/a/b/tree/main/sub' }, after: { url: 'https://github.com/a/b' } }), 'subpage');
  assert.equal(classify({ before: { url: 'https://example.com' }, after: { url: 'https://github.com/a/b' } }), 'website');
  assert.equal(classify({ before: { url: 'https://github.com/a/b', githubUrl: 'https://github.com/a/b' }, after: { url: 'https://github.com/c/d', githubUrl: 'https://github.com/c/d' } }), 'repo-swap');
});

// 撤销通道：按 product_id 删读路径上的 5 张表（source_items / observations 从来没被写入过，
// 老的 revoke-admissions.js 靠它们反查产品，@item_id 恒为 NULL，等于什么都没删）。
test('revoke SQL deletes the five live tables behind a single-source guard', () => {
  const { sqlFor } = require('../scripts/catalog/revoke-products.js');
  const sql = sqlFor([{ productId: 'prd_abc', reason: 'recruitment_advertisement', detail: '2026-09-15 weekly-issues #11707 PDD', before: { url: 'https://x' }, after: null }]);
  for (const table of ['product_routes', 'product_details', 'taxonomy_assignments', 'product_source_first_seen', 'products']) {
    assert.match(sql, new RegExp(`DELETE FROM ${table} WHERE`));
  }
  assert.match(sql, /@shared <= 1/, '跨来源观察过的产品不能整条删掉');
  assert.match(sql, /START TRANSACTION;/);
  assert.match(sql, /COMMIT;/);
  assert.doesNotMatch(sql, /source_items|observations/, '不能再依赖那两张空表');
});

test('a product the current import will recreate is never revoked', () => {
  const { survivingProductIds } = require('../scripts/catalog/revoke-products.js');
  // 不传 range 时没有「重建闸」名单；传了 range 才会真的去构建导入包（这里只锁默认行为）。
  assert.equal(survivingProductIds(null).size, 0);
});

// `--apply` 是 CI 那条路（catalog-refresh.yml 的 revoke_ids 输入）：布尔开关不能吃掉下一个 argv，
// 否则 `--apply --verify` 会把 `--verify` 当成 apply 的值。
test('--apply and --verify are booleans that never consume the next argument', () => {
  const { parseArgs } = require('../scripts/catalog/revoke-products.js');
  const options = parseArgs(['--product', 'prd_a', '--product', 'prd_b', '--apply', '--verify']);
  assert.deepEqual(options.products, ['prd_a', 'prd_b']);
  assert.equal(options.apply, true);
  assert.equal(options.verify, true);
  assert.equal(options.dryRun, false);
});

test('revoke SQL aligns the session collation before comparing ids', () => {
  // 列是 utf8mb4_0900_ai_ci、导入 Worker 的会话默认是 utf8mb4_general_ci：不对齐会
  // 报 Illegal mix of collations 并整体回滚（第一次真跑就是这么失败的）。
  const { sqlFor } = require('../scripts/catalog/revoke-products.js');
  const sql = sqlFor([{ productId: 'prd_abc', reason: 'x', detail: '', before: null, after: null }]);
  assert.match(sql, /SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci;/);
  assert.ok(sql.indexOf('SET NAMES') < sql.indexOf('START TRANSACTION'));
});

// 撤销必须能核对结果：`@shared <= 1` 的单来源闸在 SQL 里生效，多来源的行一行都不会删，
// 而脚本从返回值上看不出这个区别（2026-09-22：报告说撤销 13 个，线上 11 个页面仍然 200）。
test('inspectTargets reports the source count the single-source guard uses', async () => {
  const { inspectTargets } = require('../scripts/catalog/revoke-products.js');
  const a = 'prd_0f813588ffc0adcbab3da240';
  const b = 'prd_94546b6a51379787bbb9916a';
  const seen = [];
  const db = {
    select: async (sql) => {
      seen.push(sql);
      return [{ id: a, routes: 1, sources: 2, sourceIds: 'chinese-indie-dev,weekly-issues' }];
    },
  };
  const rows = await inspectTargets(db, [a, b]);
  assert.deepEqual(rows, [
    { productId: a, exists: true, routes: 1, sources: 2, sourceIds: 'chinese-indie-dev,weekly-issues' },
    { productId: b, exists: false, routes: 0, sources: 0, sourceIds: '' },
  ]);
  assert.match(seen[0], new RegExp(`IN \\('${a}','${b}'\\)`));
  // 通道的 select 不吃绑定参数，id 是内联的 —— 形状不对必须拒绝，不能拼进 SQL。
  await assert.rejects(() => inspectTargets(db, [`${a}'; DROP TABLE products; --`]), /形状不对/);
});

// `--verify` 只是参考：产品页有两层缓存（24 小时的 s-maxage），撤销后规范地址仍可能 200
// （2026-09-22 复核时就被 11 个这样的旧渲染骗过一次）；反过来 5xx / 网络抖动也不是「不存在」
// 的证据。所以只有**明确 404** 才算不在线上，其余保留。
test('only a definite 404 removes a revoke target', async () => {
  const { liveProductIds } = require('../scripts/catalog/revoke-products.js');
  const a = 'prd_0f813588ffc0adcbab3da240';
  const b = 'prd_1e0855fff6d8f8ed522fd28f';
  const c = 'prd_cc5dc02421c5f183a59744c9';
  const fetcher = async (url) => {
    if (String(url).includes(b)) return { status: 404 };
    if (String(url).includes(c)) return { status: 503 };
    throw new Error('network');
  };
  const result = await liveProductIds('https://example.test', [a, b, c], fetcher);
  assert.deepEqual(result.missing, [b]);
  assert.equal(result.live.size, 0);
  assert.equal(result.unknown.length, 2);
});
