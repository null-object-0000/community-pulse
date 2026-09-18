const test = require('node:test');
const assert = require('node:assert/strict');

const { reidentify, replaceLinkLine, classify } = require('../scripts/backfill_issue_entity.js');

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

test('audit categories separate junk addresses from real repository swaps', () => {
  assert.equal(classify({ before: { url: 'https://github.com/user-attachments/assets/abc' }, after: { url: 'https://github.com/a/b' } }), 'junk');
  assert.equal(classify({ before: { url: 'https://chromewebstore.google.com/detail/x/y' }, after: { url: 'https://github.com/a/b' } }), 'junk');
  assert.equal(classify({ before: { url: 'https://github.com/a/b/tree/main/sub' }, after: { url: 'https://github.com/a/b' } }), 'subpage');
  assert.equal(classify({ before: { url: 'https://example.com' }, after: { url: 'https://github.com/a/b' } }), 'website');
  assert.equal(classify({ before: { url: 'https://github.com/a/b', githubUrl: 'https://github.com/a/b' }, after: { url: 'https://github.com/c/d', githubUrl: 'https://github.com/c/d' } }), 'repo-swap');
});
