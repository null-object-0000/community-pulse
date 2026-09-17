const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { issueImages, MAX_IMAGES } = require('../.agents/skills/community-pulse/scripts/issue-media.js');
const { loadItems } = require('../.agents/skills/community-pulse/scripts/source_raw_items.js');
const D = require('../web/shared.js');

const ATTACHMENT = 'https://github.com/user-attachments/assets/7eed5195-656b-44c6-bb31-6804f6dec935';
const BLOB = 'https://github.com/hellokaton/text-polish-chrome-extension/blob/main/screenshots/Snipaste_1.jpg?raw=true';
const RAW = 'https://raw.githubusercontent.com/owner/repo/main/docs/shot.png';

// ------------------------------------------------------------ 地址白名单（唯一口径）

test('only GitHub attachment and repository image shapes are hotlinkable', () => {
  // 三种确定是图片的 GitHub 位置
  assert.equal(D.hotlinkable(ATTACHMENT), ATTACHMENT);
  assert.equal(D.hotlinkable(BLOB), BLOB);
  assert.equal(D.hotlinkable(RAW), RAW);
  // 平台自带媒体照旧
  assert.equal(D.hotlinkable('https://ph-files.imgix.net/abc.png'), 'https://ph-files.imgix.net/abc.png');
  // github.com 不是图床：仓库页、用户页、issue 页都不能当图片
  assert.equal(D.hotlinkable('https://github.com/guokaigdg/naive-icons'), '');
  assert.equal(D.hotlinkable('https://github.com/owner/repo/blob/main/README.md'), '');
  // blob 直出必须带 raw，否则 GitHub 返回的是 HTML 页面
  assert.equal(D.hotlinkable('https://github.com/owner/repo/blob/main/shot.png'), '');
  // 仓库里非图片的后缀不放行，raw 域名同理
  assert.equal(D.hotlinkable('https://raw.githubusercontent.com/owner/repo/main/notes.txt'), '');
  // 白名单以外的图床仍然拦住
  assert.equal(D.hotlinkable('https://i.imgur.com/abc.png'), '');
  assert.equal(D.hotlinkable('javascript:alert(1)'), '');
});

// ------------------------------------------------------------ 正文插图提取

test('issue images keep document order across <img> and markdown, deduped and capped', () => {
  const body = [
    `<img width="3612" height="1898" alt="Image" src="${ATTACHMENT}" />`,
    '',
    `![第二张](${RAW})`,
    `<img src='${ATTACHMENT}' />`,
    `![](<${BLOB}>)`,
  ].join('\n');
  assert.deepEqual(issueImages(body), [ATTACHMENT, RAW, BLOB]);

  const many = Array.from({ length: 12 }, (_, index) => `<img src="https://raw.githubusercontent.com/o/r/main/${index}.png">`).join('\n');
  assert.equal(issueImages(many).length, MAX_IMAGES);
});

test('badges and unrenderable hosts never become product images', () => {
  const body = [
    '<img src="https://img.shields.io/github/stars/owner/repo.svg">',
    '<img src="https://raw.githubusercontent.com/owner/repo/main/assets/badge.svg">',
    '<img src="https://github.com/owner/repo/actions/workflows/ci.yml/badge.svg">',
    '<img src="https://i.imgur.com/abc.png">',
    '<img src="https://cdn.jsdelivr.net/gh/o/r@main/shot.png">',
    '<img src="data:image/png;base64,AAAA">',
    '<img src="/relative/shot.png">',
    '<img alt="没有 src">',
    `<img src="${RAW}">`,
  ].join('\n');
  assert.deepEqual(issueImages(body), [RAW]);
});

test('image URLs are entity-decoded and non-image attributes are ignored', () => {
  const body = '<img alt="a &amp; b" data-src="https://i.imgur.com/x.png" src="https://raw.githubusercontent.com/o/r/main/a&amp;b.png" width="10">';
  assert.deepEqual(issueImages(body), ['https://raw.githubusercontent.com/o/r/main/a&b.png']);
});

// ------------------------------------------------------------ 与日报行的接线

function writeIssues(date, records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-issue-media-'));
  fs.mkdirSync(path.join(root, 'weekly-issues'), { recursive: true });
  fs.writeFileSync(path.join(root, 'weekly-issues', `${date}.json`), JSON.stringify({
    schemaVersion: 1, sourceId: 'weekly-issues', targetDate: date, complete: true, status: 'ok', records,
  }));
  return root;
}

test('a submission row carries the body illustration and never shows the <img> as its description', () => {
  const date = '2026-09-16';
  const root = writeIssues(date, [{
    number: 11740,
    title: '【开源自荐】别再用 emoji 凑数：Naive Icons 让你 vibe coding 界面来点活人感',
    html_url: 'https://github.com/ruanyf/weekly/issues/11740',
    created_at: `${date}T04:56:16Z`,
    comments: 0,
    user: { login: 'guokaigdg', html_url: 'https://github.com/guokaigdg' },
    body: `<img width="3612" height="1898" alt="Image" src="${ATTACHMENT}" />\n\n\n- Naive Icons（ [animal-island-ui](https://github.com/guokaigdg/animal-island-ui)  作者新项目 ）\n- 地址: https://github.com/guokaigdg/naive-icons \n- Naive Icons 正式开源，手绘风 React SVG 图标库，零依赖、开箱即用，MIT 可商用。\n`,
  }]);
  const { items } = loadItems({ id: 'weekly-issues', max_items: 10 }, { rawRoot: root, date });
  assert.equal(items.length, 1);
  const [item] = items;
  assert.deepEqual(item.images, [ATTACHMENT]);
  assert.equal(item.image, ATTACHMENT);
  assert.ok(!/<img|src="/.test(item.summary), `summary leaked markup: ${item.summary}`);
  assert.equal(item.summary, 'Naive Icons（ animal-island-ui 作者新项目 ）');
  // 正文原样保留，回填与复核都还能看到作者写的东西
  assert.ok(item.content.includes(ATTACHMENT));
});

test('rows without servable illustrations carry no image fields at all', () => {
  const date = '2026-09-16';
  const root = writeIssues(date, [{
    number: 2,
    title: '【工具自荐】某工具',
    html_url: 'https://github.com/ruanyf/weekly/issues/2',
    created_at: `${date}T01:00:00Z`,
    comments: 0,
    user: { login: 'someone' },
    body: '<img src="https://i.imgur.com/abc.png">\n\n一个把命令行输出变好看的终端工具，支持主题与插件。\n',
  }]);
  const { items } = loadItems({ id: 'weekly-issues', max_items: 10 }, { rawRoot: root, date });
  const [item] = items;
  assert.equal(item.images, undefined);
  assert.equal(item.image, undefined);
  assert.equal(item.summary, '一个把命令行输出变好看的终端工具，支持主题与插件。');
});