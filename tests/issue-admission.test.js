const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { issueAdmission, admitReport } = require('../.agents/skills/community-pulse/scripts/issue-admission');
test('real recruitment ad is excluded, Recruit OS and CS-Books survive', () => {
  const report = JSON.parse(fs.readFileSync('知识/大家都在做什么/raw/2026-09-15.json'));
  const result = admitReport(report);
  assert.equal(report.results.flatMap(s => s.items).length, 91);
  const items = result.results.flatMap(s => s.items);
  // 91 → 88：一条招聘广告 + 两条 VibeCafé「策划中」作品（indietools.work、小小魔塔）。
  assert.equal(items.length, 88);
  assert.ok(!items.some(i => i.externalId === '11707'));
  assert.ok(items.some(i => i.externalId === '11714'));
  assert.ok(items.some(i => i.title.includes('CS-Books')));
  assert.equal(result.admission.decisions.find(i => i.externalId === '11707').reason, 'recruitment_advertisement');
});
test('hiring-post shapes are excluded end to end, while hiring-adjacent products are not', () => {
  const decide = title => issueAdmission({ title, sourceId: 'weekly-issues' });
  for (const title of [
    '拼多多集团-PDD｜「2027届校招正式批」已开放网申，研发同学新增免笔试福利！',
    '【社招】滴滴风控开发',
    '【全职深圳】Web3币圈大量岗位招人，前端/测试/后端/产品，外企待遇，竞争力薪酬',
    '阿联酋Center技术服务中心2025岗位合集',
    '淘天集团交易终端团队2026应届校招',
    'Autowise.ai【社招-web前端】自动驾驶业务【base-杭州】',
    '【上海招聘】 Speak | AI iOS / 全栈工程师 | 上海',
    'TD Synnex 北京/成都招聘',
    '洋钱罐招聘 后端研发/架构师',
  ]) assert.equal(decide(title).status, 'excluded', `${title} 应判为招聘广告`);
  // Products about hiring, guides and articles must never be keyword-deleted.
  assert.equal(decide('[开源自荐] Recruit OS：让所有的面试官会面试，把“感觉不错”追问到证据').status, 'accepted');
  for (const title of [
    '【开源自荐】OpenJobAutofill：网申表单自动填写插件',
    'AI-Native 工程师招聘面试官手册',
    '[文章自荐] 2025年AI Agent岗位市场调研：基于101个职位的数据分析',
    '【文章自荐】拼多多校招笔试算法题：一行公式搞定“多多的魔术盒子”',
    '【网站自荐】找远程工作的神器：根据简历个性化推荐远程岗位，全部支持国内远程',
  ]) assert.notEqual(decide(title).status, 'excluded', `${title} 不该被删`);
});
test('ambiguous recruitment stays in review; software and non-issue sources are not keyword-deleted', () => {
  const decide = title => issueAdmission({ title, sourceId: 'weekly-issues' });
  assert.equal(decide('招聘').status, 'review');
  assert.equal(decide('26届本科找实习').status, 'review');
  assert.equal(decide('硅谷多模态AI初创招聘 ---- to C娱乐方向').status, 'review');
  assert.equal(decide('招聘平台正在招聘工程师').status, 'review');
  assert.equal(issueAdmission({ title: '招聘工程师', sourceId: 'github-trending-cn' }).status, 'accepted');
});
test('source normalization excludes before source limits and records the exact reason', () => {
  const { loadItems } = require('../.agents/skills/community-pulse/scripts/source_raw_items');
  const r = loadItems({ id: 'weekly-issues', max_items: 100 }, { date: '2026-09-15', observedDate: '2026-09-15', maxItems: Infinity });
  assert.ok(!r.items.some(i => i.externalId === '11707'));
  assert.ok(r.items.some(i => i.externalId === '11714'));
  assert.equal(r.sourceRaw.admissionDecisions.find(d => d.externalId === '11707').reason, 'recruitment_advertisement');
});

// VibeCafé 的「策划中」作品只是占位，不进列表也不进产品库。状态只有详情页拿得到，采集时挂在
// `vibecafeStatus` 上（历史行由 scripts/backfill_vibecafe_status.js 回填）。
test('VibeCafé planning-stage works are excluded, published ones are not', () => {
  const planning = issueAdmission({ sourceId: 'vibecafe', title: 'ai集', vibecafeStatus: '策划中' });
  assert.equal(planning.status, 'excluded');
  assert.equal(planning.reason, 'vibecafe_planning');
  assert.equal(issueAdmission({ sourceId: 'vibecafe', title: 'IGPuller', vibecafeStatus: '已发布' }).status, 'accepted');
  // 状态拿不到（2026-09-03…09-06 的采集没有详情页）时放行，不猜。
  assert.equal(issueAdmission({ sourceId: 'vibecafe', title: '旧作品' }).status, 'accepted');
});

// 纯内容投稿：标题只有内容标签、正文里没有任何产品地址。ruanyf/weekly #11840 的
// 「【投稿】人工智能与人脑」是一篇长文，却被当成产品收进了列表。
test('a content submission with no product address is excluded, a labelled product is not', () => {
  const article = issueAdmission({
    sourceId: 'weekly-issues', title: '【投稿】人工智能与人脑',
    url: 'https://github.com/ruanyf/weekly/issues/11840', issueUrl: 'https://github.com/ruanyf/weekly/issues/11840',
  });
  assert.equal(article.status, 'excluded');
  assert.equal(article.reason, 'content_not_product');
  // 同样带「投稿」标签、但有项目地址的投稿照收。
  assert.equal(issueAdmission({
    sourceId: 'weekly-issues', title: '【投稿】GuardSSL - 现代化 SSL 证书监控与安全分析工具',
    url: 'https://github.com/guardssl/guardssl', issueUrl: 'https://github.com/ruanyf/weekly/issues/8846',
  }).status, 'accepted');
});

// 一个产品在列表里只出现一次：VibeCafé 两位作者各贴了一次 a2agent.me，externalId 不同、
// 标题不同，collect.js 的源内去重按「作者 + URL」分组，两条都留了下来。
test('rows that resolve to the same product collapse to the newest one', () => {
  const D = require('../web/shared.js');
  const older = { sourceId: 'vibecafe', externalId: 'cmuavcqe700000agm4xubfmo2', productId: 'prd_a2agent', title: 'Affordable LLM API Gateway · A2Agent', publishedAt: '2026-09-21T06:33:24.127Z', summary: 'GLM, Kimi, DeepSeek, Qwen, MiniMax, and more through one OpenAI-compatible API. Pay-as-you-goAccess' };
  const newer = { sourceId: 'vibecafe', externalId: 'cmuavelg100000agmkrjg1foc', productId: 'prd_a2agent', title: 'A2Agent--Access multiple LLMs via a single OpenAI-compatible API.', publishedAt: '2026-09-21T06:34:51.025Z', summary: 'Access GLM, Kimi, DeepSeek, Qwen, MiniMax, and more through one OpenAI-compatible API. Pay-as-you-go' };
  const other = { sourceId: 'vibecafe', externalId: 'x', productId: 'prd_other', title: '别的产品', publishedAt: '2026-09-21T05:00:00Z', summary: '别的' };
  const report = { results: [{ sourceId: 'vibecafe', sourceName: 'VibeCafé', items: [older, newer, other] }] };
  const collapsed = D.collapseProductDuplicates(report);
  assert.deepEqual(collapsed.results[0].items.map(i => i.externalId), [newer.externalId, 'x']);
  // 没有 productId 的历史行原样保留，不猜。
  const legacy = { results: [{ sourceId: 'x', items: [{ externalId: 'a', title: 'A' }, { externalId: 'b', title: 'B' }] }] };
  assert.equal(D.collapseProductDuplicates(legacy).results[0].items.length, 2);
});
