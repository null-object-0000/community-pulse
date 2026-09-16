/** Offline publication admission; raw evidence is never removed. */
const VERSION = 'issue-admission-v1';
const ISSUE_SOURCES = new Set(['weekly-issues', 'hellogithub-issues']);
function issueAdmission(item) {
  const title = String(item.title || '');
  if (!ISSUE_SOURCES.has(item.sourceId)) return { status: 'accepted', reason: 'not_issue_submission', version: VERSION };
  const relevant = /招聘|校招|网申|实习|社招|岗位|诚聘|招收|\bhiring\b/i.test(title);
  if (!relevant) return { status: 'accepted', reason: 'no_recruitment_signal', version: VERSION };
  // Topic keywords alone are not ads. A self-recommendation is not a blanket exemption:
  // require an explicit software/product identity as well.
  const software = /(?:工具|插件|软件|工作台|开源|系统|平台|助手|Recruit OS|CareerKit|Autofill)/i.test(title);
  const resource = /(?:手册|指南|书籍|教程|资源|清单)/.test(title);
  const ad = /(?:校招.*(?:开放网申|网申.*开放|内推)|招聘.*(?:工程师|研发|算法|岗位|长期有效)|(?:工程师|研发|岗位).*招聘|社招.*(?:火热|直推)|诚聘|招聘公告|招聘启事)/i.test(title);
  if (ad && !software && !resource) return { status: 'excluded', reason: 'recruitment_advertisement', version: VERSION };
  if (software && !ad) return { status: 'accepted', reason: 'recruitment_software', version: VERSION };
  return { status: 'review', reason: 'ambiguous_recruitment_submission', version: VERSION };
}
function admitReport(report) {
  const decisions = [];
  const results = (report.results || []).map(source => ({ ...source, items: (source.items || []).flatMap(item => {
    const admission = issueAdmission({ ...item, sourceId: item.sourceId || source.sourceId });
    if (admission.status !== 'accepted') decisions.push({ sourceId: source.sourceId, externalId: item.externalId, title: item.title, ...admission });
    return admission.status === 'excluded' ? [] : [{ ...item, ...(admission.status === 'review' ? { admission } : {}) }];
  }) }));
  return { ...report, results, admission: { version: VERSION, decisions } };
}
module.exports = { VERSION, issueAdmission, admitReport };
