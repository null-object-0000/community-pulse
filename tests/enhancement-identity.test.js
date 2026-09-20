const test = require('node:test');
const assert = require('node:assert/strict');

const { renderMarkdown, productIdOf } = require('../.agents/skills/community-pulse/scripts/collect.js');
const { extractItems, productIdsForItems, normalizeRecords, metadataComment, PROMPT_VERSION } = require('../.agents/skills/community-pulse/scripts/enhance.js');
const { applyEnhancedMarkdown, itemProductId } = require('../scripts/enhanced-report.js');
const { identityFor, productId } = require('../scripts/catalog/identity.js');

/** 一份最小日报 JSON + 它渲染出来的 markdown（两者由同一次 collect 产出）。 */
function fixture() {
  const results = [{
    sourceId: 'weekly-issues',
    sourceName: '科技爱好者周刊·用户投稿',
    items: [
      { sourceId: 'weekly-issues', externalId: '1', title: '【开源自荐】Alpha', author: 'ann', url: 'https://github.com/owner/alpha', summary: 'Alpha 的原始描述，长度足够参与摘要比较。', productId: 'prd_alpha' },
      // 同名同作者：旧的「标题 + 作者」匹配只能靠顺序兜，顺序一变就串行。
      { sourceId: 'weekly-issues', externalId: '2', title: '【开源自荐】Alpha', author: 'ann', url: 'https://github.com/owner/alpha-two', summary: 'Alpha Two 的原始描述，长度同样足够。', productId: 'prd_alpha_two' },
      { sourceId: 'weekly-issues', externalId: '3', title: 'Beta', author: 'bob', url: 'https://beta.example', summary: 'Beta 的原始描述，长度足够参与比较。', productId: 'prd_beta' },
    ],
  }];
  return { report: { date: '2026-09-19', results }, markdown: renderMarkdown(results, '2026-09-19') };
}

function finalMarkdown(report, records) {
  // 模拟 enhance.js 的产物：把 `> 描述` 换成中文摘要，并在其后加一行隐藏元数据。
  const lines = renderMarkdown(report.results, report.date).split('\n');
  const output = [];
  let cursor = 0;
  for (const line of lines) {
    if (line.startsWith('### ')) {
      const record = records[cursor++];
      output.push(line);
      if (record?.summaryZh) output.push(`> ${record.summaryZh}`);
      if (record) output.push(metadataComment(record));
      continue;
    }
    if (line.startsWith('> ')) continue; // 原始描述被摘要替换
    output.push(line);
  }
  return output.join('\n');
}

const localized = (productId, summaryZh, extra = {}) => ({
  schemaVersion: 3, sourceHash: `hash-${productId}`, productId, promptVersion: PROMPT_VERSION, model: 'test',
  titleEn: 'Alpha', summaryZh, summaryEn: 'English summary.', primaryCategory: 'software-development',
  taxonomy: { useCases: ['software-development'], agentRoles: [], productForms: [], platforms: [], integrations: [] },
  ...extra,
});

test('markdown 条目按「来源分区 + 顺序」对齐到原始 JSON 的 productId', () => {
  const { report, markdown } = fixture();
  const items = extractItems(markdown);
  const ids = productIdsForItems(items, report);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(item => ids.get(item.idx)), ['prd_alpha', 'prd_alpha_two', 'prd_beta']);
});

test('同名同作者的两条不会串行（旧实现只能靠顺序兜）', () => {
  const { report, markdown } = fixture();
  const items = extractItems(markdown);
  const ids = productIdsForItems(items, report);
  const duplicated = items.filter(item => item.title === '【开源自荐】Alpha');
  assert.equal(duplicated.length, 2);
  assert.notEqual(ids.get(duplicated[0].idx), ids.get(duplicated[1].idx));
});

test('标题被清理过也能匹配：按 productId 而不是标题', () => {
  const { report } = fixture();
  const records = [localized('prd_alpha', 'Alpha 的中文摘要。'), localized('prd_alpha_two', 'Alpha Two 的中文摘要。'), localized('prd_beta', 'Beta 的中文摘要。')];
  const markdown = finalMarkdown(report, records);
  // 模拟 09-18 那次标题清理：raw 侧的标题少了标签，final 侧还是原标题。
  const drifted = JSON.parse(JSON.stringify(report));
  drifted.results[0].items[0].title = 'Alpha';
  const enhanced = applyEnhancedMarkdown(drifted, markdown, '2026-09-19');
  assert.equal(enhanced.results[0].items[0].summaryZh, 'Alpha 的中文摘要。');
  assert.equal(enhanced.results[0].items[0].summarySource, 'llm-final');
  assert.equal(enhanced.presentation.matchedByProductId, 3);
  assert.equal(enhanced.presentation.matchedByHeading, 0);
  assert.equal(enhanced.presentation.summarySource, 'llm-final');
});

test('同名两条各自拿到自己的摘要，而不是按标题撞在一起', () => {
  const { report } = fixture();
  const records = [localized('prd_alpha', '第一条的摘要。'), localized('prd_alpha_two', '第二条的摘要。'), localized('prd_beta', 'Beta 的摘要。')];
  const enhanced = applyEnhancedMarkdown(report, finalMarkdown(report, records), '2026-09-19');
  assert.deepEqual(enhanced.results[0].items.map(item => item.summaryZh), ['第一条的摘要。', '第二条的摘要。', 'Beta 的摘要。']);
});

test('历史 final 没有 productId 时退回标题匹配，并计入 matchedByHeading', () => {
  const { report } = fixture();
  const legacy = [
    { schemaVersion: 3, sourceHash: 'h1', titleEn: 'Alpha', summaryZh: '旧记录的中文摘要。', summaryEn: 'English.', primaryCategory: 'software-development', taxonomy: { useCases: ['software-development'] } },
    { schemaVersion: 3, sourceHash: 'h2', titleEn: 'Alpha', summaryZh: '旧记录第二条。', summaryEn: 'English.', primaryCategory: 'software-development', taxonomy: { useCases: ['software-development'] } },
    { schemaVersion: 3, sourceHash: 'h3', titleEn: 'Beta', summaryZh: '旧记录第三条。', summaryEn: 'English.', primaryCategory: 'software-development', taxonomy: { useCases: ['software-development'] } },
  ];
  const enhanced = applyEnhancedMarkdown(report, finalMarkdown(report, legacy), '2026-09-19');
  assert.equal(enhanced.presentation.matchedByHeading, 3);
  assert.equal(enhanced.presentation.matchedByProductId, 0);
  assert.deepEqual(enhanced.results[0].items.map(item => item.summaryZh), ['旧记录的中文摘要。', '旧记录第二条。', '旧记录第三条。']);
});

test('续跑恢复的老记录会被补齐 productId 与加工版本，不必重跑 LLM', () => {
  const { report, markdown } = fixture();
  const items = extractItems(markdown);
  const ids = productIdsForItems(items, report);
  const cached = new Map([[items[0].idx, { schemaVersion: 3, sourceHash: 'old', summaryZh: '缓存摘要。' }]]);
  normalizeRecords(items, cached, ids);
  assert.equal(cached.get(items[0].idx).productId, 'prd_alpha');
  assert.equal(cached.get(items[0].idx).promptVersion, PROMPT_VERSION);
});

test('日报行、增强消费端、产品库导入用的是同一份身份实现', () => {
  const item = { sourceId: 'showhn', externalId: '1', url: 'https://github.com/Owner/Repo', title: 'x' };
  assert.equal(itemProductId(item), productId(identityFor(item)));
  assert.equal(productIdOf(item), productId(identityFor(item)));
  // 显式带 productId 的行以它为准（已发布日报固定其版本，不被后来的规则改写）。
  assert.equal(itemProductId({ ...item, productId: 'prd_published' }), 'prd_published');
});

// 契约门禁：带发布记录（`publication`）的日报属于新契约，任何一行都不能与导入链算出的身份不一致。
// 仓库里 2026-09-20 之前的历史日报没有发布记录，属于「已发布即固定」的历史，不在这个断言范围内。
test('新契约下的日报行必须与导入链算出的产品身份一致', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const rawDir = path.join(__dirname, '..', '知识', '大家都在做什么', 'raw');
  const dates = fs.readdirSync(rawDir).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map(name => name.slice(0, 10)).sort();
  const withPublication = dates.filter((date) => {
    const report = JSON.parse(fs.readFileSync(path.join(rawDir, `${date}.json`), 'utf8'));
    return Boolean(report.publication);
  });
  if (!withPublication.length) return; // 下一期日报起生效
  const { checkReportIdentity } = require('../scripts/catalog/check-report-identity.js');
  for (const date of withPublication) {
    const result = checkReportIdentity(date);
    assert.deepEqual(result.mismatched, [], `${date}: 日报行与产品库身份漂移`);
  }
});
