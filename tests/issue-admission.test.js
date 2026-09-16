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
test('ambiguous recruitment stays in review; software and non-issue sources are not keyword-deleted', () => {
  const decide = title => issueAdmission({ title, sourceId: 'weekly-issues' });
  assert.equal(decide('招聘').status, 'review');
  assert.equal(decide('【开源自荐】OpenJobAutofill：网申表单自动填写插件').status, 'accepted');
  assert.equal(decide('招聘平台正在招聘工程师').status, 'review');
  assert.equal(decide('AI-Native 工程师招聘面试官手册').status, 'review');
  assert.equal(issueAdmission({ title: '招聘工程师', sourceId: 'github-trending-cn' }).status, 'accepted');
});
test('source normalization excludes before source limits and records the exact reason', () => {
  const { loadItems } = require('../.agents/skills/community-pulse/scripts/source_raw_items');
  const r = loadItems({ id: 'weekly-issues', max_items: 100 }, { date: '2026-09-15', observedDate: '2026-09-15', maxItems: Infinity });
  assert.ok(!r.items.some(i => i.externalId === '11707'));
  assert.ok(r.items.some(i => i.externalId === '11714'));
  assert.equal(r.sourceRaw.admissionDecisions.find(d => d.externalId === '11707').reason, 'recruitment_advertisement');
});
