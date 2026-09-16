const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { issueAdmission, admitReport } = require('../.agents/skills/community-pulse/scripts/issue-admission');
test('real recruitment ad is excluded, Recruit OS and CS-Books survive', () => {
  const report = JSON.parse(fs.readFileSync('知识/大家都在做什么/raw/2026-09-15.json'));
  const result = admitReport(report);
  assert.equal(report.results.flatMap(s => s.items).length, 91);
  const items = result.results.flatMap(s => s.items);
  assert.equal(items.length, 90);
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
