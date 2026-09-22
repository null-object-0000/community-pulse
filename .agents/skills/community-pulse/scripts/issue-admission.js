/** Offline publication admission; raw evidence is never removed. */
const VERSION = 'issue-admission-v2';
const ISSUE_SOURCES = new Set(['weekly-issues', 'hellogithub-issues']);
// A recruitment *topic* is not a recruitment *advertisement*: a job-hunting tool, an interview
// guide or a post-mortem article all mention 招聘 and must survive. Admission therefore needs a
// positive hiring-post shape, not just a keyword.
const HIRING = /招聘|校招|社招|网申|实习|岗位|诚聘|招收|\bhiring\b|内推/i;
// Submission identity comes from an explicit label, and only as a prefix (a real title may
// mention 自荐 further in). Same for resource identity.
const SELF_LABEL = /^\s*[\[【(（]?\s*(?:文章|网站|项目|工具|产品)?\s*(?:自荐|推荐|投稿)/;
const RESOURCE = /手册|指南|书籍|教程|资源|清单/;
const SOFTWARE = /工具|插件|软件|工作台|开源|系统|平台|助手|Recruit OS|CareerKit|Autofill|Dashboard/i;
// Hiring-post shapes: company/team + batch/post + action, an explicit application channel,
// a bracketed hiring tag (【上海招聘】), or a latin-named company followed by 招聘.
const HIRING_POST = /岗位合集|岗位招人|大量岗位|在招岗位|招聘岗位|诚聘|内推邮箱|内推|简历发送|发送简历|【社招】|【校招】|【招聘】|【全职|应届校招|应届招聘|【[^】]{0,6}(?:招聘|校招|社招|岗位)[^】]{0,6}】|\[[^\]]{0,6}(?:招聘|校招|社招|岗位)[^\]]{0,6}\]|(?:集团|公司|团队|中心)[^，。]{0,20}(?:招聘|校招|社招|岗位|大量)|(?:招聘|校招|社招)[^，。]{0,14}(?:工程师|开发|前端|后端|算法|研发|Java|测试|产品|运营|设计)|(?:工程师|研发|开发|前端|后端|算法)[^，。]{0,6}招聘|[A-Za-z][A-Za-z0-9 .&-]{2,30}[^，。]{0,10}招聘/;

// 纯内容投稿：标题只有「投稿 / 推荐 / 文章 / 言论」这类**内容**标签（没有工具、网站、项目、开源、
// 插件这些产品词），并且正文里没有任何产品地址（行链接只能退回投稿页本身）。
// ruanyf/weekly #11840「【投稿】人工智能与人脑」就是这样一篇长文：标题没有产品名，作者也没贴项目
// 地址，我们却把它当成产品收进了列表。带产品地址的同标签投稿（`【投稿】GuardSSL - …监控工具`）不受影响。
const CONTENT_LABEL = /^\s*[\[【〖(（]\s*(?:文章|内容|言论|随笔|译文|投稿|推荐|分享)\s*[\]】〗)）]/;

// VibeCafé 的「策划中」还只是占位作品（2026-09-21 的「ai集」摘要就是「工作台」两个字、作者 aaa），
// 我们收的是已经冒出来的产品，所以不发布。状态只有详情页拿得到，采集时挂在 `vibecafeStatus` 上。
const VIBECAFE_PLANNING = '策划中';

function issueAdmission(item) {
  const title = String(item.title || '');
  // 这两条与「投稿来源」无关，先判：VibeCafé 不是投稿源，纯内容投稿也可能来自任何投稿源。
  if (item.sourceId === 'vibecafe' && item.vibecafeStatus === VIBECAFE_PLANNING) {
    return { status: 'excluded', reason: 'vibecafe_planning', version: VERSION };
  }
  if (ISSUE_SOURCES.has(item.sourceId) && CONTENT_LABEL.test(title) && item.issueUrl && item.url === item.issueUrl) {
    return { status: 'excluded', reason: 'content_not_product', version: VERSION };
  }
  if (!ISSUE_SOURCES.has(item.sourceId)) return { status: 'accepted', reason: 'not_issue_submission', version: VERSION };
  if (!HIRING.test(title)) return { status: 'accepted', reason: 'no_recruitment_signal', version: VERSION };
  // A self-recommended tool/site and a hiring guide/article are products or content, not ads.
  // But a title that is only a label ("招聘", "26届本科找实习") carries no product identity either,
  // so it must not be waved through by the self-label exemption alone.
  const identified = (SELF_LABEL.test(title) || RESOURCE.test(title) || SOFTWARE.test(title))
    && title.replace(/^\s*[\[【(（]?\s*(?:文章|网站|项目|工具|产品)?\s*(?:自荐|推荐|投稿)\s*[\]】)）]?\s*/, '').trim().length > 4;
  const post = HIRING_POST.test(title);
  if (post && !identified) return { status: 'excluded', reason: 'recruitment_advertisement', version: VERSION };
  if (post && identified) return { status: 'review', reason: 'ambiguous_recruitment_submission', version: VERSION };
  return { status: 'review', reason: 'weak_recruitment_signal', version: VERSION };
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
