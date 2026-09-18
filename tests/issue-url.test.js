const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { extractExternalUrls, issueItems, loadItems } = require('../.agents/skills/community-pulse/scripts/source_raw_items.js');
const { dedupe, descriptionSimilarity } = require('../.agents/skills/community-pulse/scripts/collect.js');

const WEEKLY = { id: 'weekly-issues', max_items: Infinity };
const ISSUE_URL = 'https://github.com/ruanyf/weekly/issues/1';

/** 用一份最小 Issue 记录跑投稿标准化，返回归一化后的行与准入决定。 */
function submit(body, title = '【开源自荐】示例项目') {
  const decisions = [];
  const records = [{
    number: 1, title, body, html_url: ISSUE_URL,
    user: { login: 'submitter', html_url: 'https://github.com/submitter' },
    created_at: '2026-01-01T00:00:00Z', comments: 0,
  }];
  const [item] = issueItems({ records }, WEEKLY, { onAdmission: decision => decisions.push(decision) });
  return { item, decisions };
}

test('plain-text issue URLs stop before Chinese prose punctuation', () => {
  const body = 'MakeBingoCards（https://makebingocards.com/）。它是一个工具，演示：https://example.com/demo。文档：https://docs.example.com/：说明';
  assert.deepEqual(extractExternalUrls(body), [
    'https://makebingocards.com/',
    'https://example.com/demo',
    'https://docs.example.com/',
  ]);
});

test('duplicate submissions with a Chinese-wrapped and a plain website URL collapse', () => {
  const [wrapped] = extractExternalUrls('项目（https://makebingocards.com/）。它是一个工具');
  const results = [{
    sourceId: 'weekly-issues',
    sourceName: '科技爱好者周刊投稿',
    items: [
      { sourceId: 'weekly-issues', externalId: '11649', author: 'lionchain100-alt', title: '旧投稿', url: wrapped, publishedAt: '2026-09-12T11:12:12Z' },
      { sourceId: 'weekly-issues', externalId: '11650', author: 'lionchain100-alt', title: '新投稿', url: 'https://makebingocards.com/', publishedAt: '2026-09-12T11:16:45Z' },
    ],
  }];
  const output = dedupe(results);
  assert.deepEqual(output[0].items.map(item => item.externalId), ['11650']);
});

test('same product title and highly similar descriptions collapse when submissions omit the product URL', () => {
  const base = '基于多智能体架构与自主决策机制，输入自然语言指令，AI 自动完成从目标侦察到漏洞验证的完整渗透测试流程。多智能体协同完成信息收集、攻击与报告。';
  const newer = `${base}\n<img src="https://example.com/screenshot.png">`;
  assert.ok(descriptionSimilarity(base, newer) >= 0.85);
  const results = [{
    sourceId: 'weekly-issues',
    sourceName: '科技爱好者周刊投稿',
    items: [
      { sourceId: 'weekly-issues', externalId: '11658', author: 'Tangruwo', title: '「开源自荐」RuwoScan - 基于Agentic 架构的自动化AI漏洞扫描工具', url: 'https://github.com/ruanyf/weekly/issues/11658', issueUrl: 'https://github.com/ruanyf/weekly/issues/11658', summary: base, publishedAt: '2026-09-13T04:35:25Z' },
      { sourceId: 'weekly-issues', externalId: '11659', author: 'Tangruwo', title: '「开源自荐」RuwoScan - 基于Agentic 架构的自动化AI漏洞扫描工具', url: 'https://github.com/ruanyf/weekly/issues/11659', issueUrl: 'https://github.com/ruanyf/weekly/issues/11659', summary: newer, publishedAt: '2026-09-13T04:36:48Z' },
    ],
  }];
  const output = dedupe(results);
  assert.deepEqual(output[0].items.map(item => item.externalId), ['11659']);
});

test('same title with materially different descriptions remains separate', () => {
  const results = [{
    sourceId: 'weekly-issues', sourceName: '科技爱好者周刊投稿', items: [
      { sourceId: 'weekly-issues', externalId: '1', author: 'one', title: 'Workbench', url: 'https://example.com/one', summary: '这是一个用于自动化安全测试和漏洞验证的多智能体工具，支持从目标侦察到报告生成的完整流程。', publishedAt: '2026-09-13T01:00:00Z' },
      { sourceId: 'weekly-issues', externalId: '2', author: 'two', title: 'Workbench', url: 'https://example.com/two', summary: '这是一个给摄影师使用的桌面照片管理软件，支持批量调色、相册分类、客户交付和云端备份。', publishedAt: '2026-09-13T02:00:00Z' },
    ],
  }];
  assert.equal(dedupe(results)[0].items.length, 2);
});

test('duplicate occurrences sharing one externalId still keep the newest occurrence', () => {
  const description = '这是一段足够长的产品描述，用于确保两个来源行的内容能够进入去重比较流程，并在相同外部编号时仅删除旧行。';
  const results = [{
    sourceId: 'chinese-indie-dev', sourceName: '中国独立开发者', items: [
      { sourceId: 'chinese-indie-dev', externalId: 'same-id', title: 'Same Product', author: '', url: 'https://same.example', summary: description, publishedAt: '2026-01-30T00:00:00Z' },
      { sourceId: 'chinese-indie-dev', externalId: 'same-id', title: 'Same Product', author: 'newer', url: 'https://same.example', summary: description, publishedAt: '2026-01-30T01:00:00Z' },
    ],
  }];
  const output = dedupe(results);
  assert.equal(output[0].items.length, 1);
  assert.equal(output[0].items[0].author, 'newer');
});

// 投稿实体识别：正文里常先提到依赖仓库、参考项目或上游，只取「第一个 github.com 链接」
// 会把产品并进别人的仓库（2026-09-18 走查：全量 5,847 行投稿里 18 行的仓库身份是错的）。
test('an explicit 项目地址 field wins over an earlier link in the body', () => {
  const { item } = submit([
    '本项目是 https://github.com/dzhng/deep-research 的可视化版本，并做了一些改进。',
    '仓库地址：https://github.com/AnotiaWang/deep-research-web-ui',
  ].join('\n'));
  assert.equal(item.githubUrl, 'https://github.com/AnotiaWang/deep-research-web-ui');
  assert.equal(item.url, 'https://github.com/AnotiaWang/deep-research-web-ui');
});

test('a 官方 field pointing at the upstream does not hijack a fork submission', () => {
  const { item } = submit([
    'fork 谷歌官方仓库进行了翻译。',
    '中文版 gemini-cli：https://github.com/jiweiyeah/gemini-cli-chinese',
    '官方：https://github.com/google-gemini/gemini-cli',
  ].join('\n'));
  assert.equal(item.githubUrl, 'https://github.com/jiweiyeah/gemini-cli-chinese');
});

test('an address label on its own line takes the URL from the next labelled line', () => {
  const { item } = submit([
    '1. [唐煊《 ugly-avatar 》](https://github.com/txstc55/ugly-avatar)：方法基于该项目',
    '开源地址：  ',
    'Github：https://github.com/xingxingc/stray_avatar',
  ].join('\n'));
  assert.equal(item.githubUrl, 'https://github.com/xingxingc/stray_avatar');
});

test('a 项目地址 subpage resolves to the repository root', () => {
  const releases = submit('项目地址：https://github.com/MathsionYang/CodexChat-/releases');
  assert.equal(releases.item.githubUrl, 'https://github.com/MathsionYang/CodexChat-');
  const tree = submit('开源地址: https://github.com/yenche123/liubai/tree/cool/liubai-frontends/liubai-weixin');
  assert.equal(tree.item.githubUrl, 'https://github.com/yenche123/liubai');
});

test('conflicting explicit project addresses are flagged instead of guessed', () => {
  const { item, decisions } = submit([
    '【开源自荐】医学计算器/相似病例/去隐私化 skills',
    '项目地址：https://github.com/JuneYaooo/clinical-calculator',
    '项目地址：https://github.com/JuneYaooo/find-similar-medical-cases',
  ].join('\n'));
  const decision = decisions.find(d => d.reason === 'multiple_project_addresses');
  assert.equal(decision.status, 'review');
  assert.equal(item.githubUrl, undefined);
  assert.equal(item.url, ISSUE_URL);
});

test('the ambiguity marker never reaches the published item', () => {
  // issueItems 挂的内部标记必须由 loadItems 消费掉：留在行里会跟着 raw/*.json 和产品库走。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-ambiguity-'));
  const body = [
    '【开源自荐】医学计算器/相似病例/去隐私化 skills',
    '项目地址：https://github.com/JuneYaooo/clinical-calculator',
    '项目地址：https://github.com/JuneYaooo/find-similar-medical-cases',
  ].join('\n');
  fs.mkdirSync(path.join(root, 'weekly-issues'), { recursive: true });
  fs.writeFileSync(path.join(root, 'weekly-issues', '2026-01-01.json'), JSON.stringify({
    schemaVersion: 1, sourceId: 'weekly-issues', targetDate: '2026-01-01', complete: true, status: 'ok',
    records: [{ number: 1, title: '【开源自荐】示例项目', body, html_url: ISSUE_URL, user: { login: 'submitter' }, created_at: '2026-01-01T00:00:00Z', comments: 0 }],
  }));
  const loaded = loadItems(WEEKLY, { date: '2026-01-01', rawRoot: root });
  assert.equal(loaded.items[0].repositoryAmbiguous, undefined);
  assert.equal(loaded.items[0].githubUrl, undefined);
  assert.equal(loaded.sourceRaw.admissionDecisions.find(d => d.reason === 'multiple_project_addresses').status, 'review');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a declared website beats a github org page when no repository is identifiable', () => {
  const { item } = submit([
    '访问[Broxy官网](https://broxy.dev)即可立即体验功能',
    '项目地址：https://github.com/broxy-dev',
    '官网：https://broxy.dev',
  ].join('\n'));
  assert.equal(item.githubUrl, undefined);
  assert.equal(item.url, 'https://broxy.dev');
});

test('address examples inside HTML comments are not treated as the project address', () => {
  const { item } = submit([
    '<!-- 项目地址：https://github.com/example/placeholder -->',
    '项目地址：https://github.com/real/project',
  ].join('\n'));
  assert.equal(item.githubUrl, 'https://github.com/real/project');
});

