const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../scripts/render-site.js');
const P = require('../scripts/projects.js');

const report = { results: [] };

test('daily report comments use one stable discussion key across routes and locales', () => {
  const home = R.reportPage(report, '2026-09-13', 'zh-CN', true);
  const archive = R.reportPage(report, '2026-09-13', 'zh-CN', false);
  const english = R.reportPage(report, '2026-09-13', 'en', false);

  for (const html of [home, archive, english]) {
    assert.match(html, /data-giscus-term="report:2026-09-13"/);
    assert.match(html, /data-giscus-repo="null-object-0000\/devtrends-comments"/);
    assert.doesNotMatch(html, /data-giscus-mapping="pathname"/);
  }
  assert.match(home, /data-giscus-lang="zh-CN"/);
  assert.match(english, /data-giscus-lang="en"/);
});

test('comments client is lazy loaded and keeps the giscus theme in sync', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  assert.match(client, /IntersectionObserver/);
  assert.match(client, /mapping: 'specific'/);
  assert.match(client, /https:\/\/giscus\.app\/client\.js/);
  assert.match(client, /MutationObserver\(syncGiscusTheme\)/);
});

test('archive calendar days show source and discussion counts in both locales', () => {
  const reports = [{ date: '2026-09-13', results: [{ items: [
    { title: 'One', sourceId: 'github-trending' },
    { title: 'Two', sourceId: 'producthunt' },
    { title: 'Three', sourceId: 'producthunt' },
  ] }] }];
  const counts = { 'report:2026-09-13': 3 };
  const chinese = R.archivePage(reports, 'zh-CN', counts);
  const english = R.archivePage(reports, 'en', counts);
  const empty = R.archivePage(reports, 'zh-CN');

  assert.match(chinese, /3 条评论/);
  assert.match(english, /3 comments/);
  assert.match(chinese, /2 个来源/);
  assert.match(english, /2 sources/);
  assert.match(empty, /0 条评论/);
  assert.match(chinese, /class="archive-calendar"/);
  assert.match(chinese, /role="columnheader">周一/);
  assert.match(chinese, /class="archive-day is-outside"/);
  assert.match(chinese, /class="archive-project-count"><svg/);
  assert.match(chinese, /class="archive-source-count"><svg/);
  assert.match(chinese, /archive-comment-count/);
});

test('archive calendar keeps seven columns and becomes a list on phones', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');
  assert.match(styles, /\.archive-calendar \{ display: grid; grid-template-columns: repeat\(7,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?\.archive-calendar \{ display: flex; flex-direction: column-reverse/);
  assert.match(styles, /\.archive-weekdays, \.archive-day\.is-empty, \.archive-day\.is-outside \{ display: none; \}/);
  assert.match(styles, /\.archive-day-meta > span \{ display: inline-flex; align-items: center/);
});

test('project pages have one stable discussion shared by Chinese and English routes', () => {
  const project = {
    key: 'acme/widget', owner: 'Acme', name: 'Widget', fullName: 'Acme/Widget',
    path: '/projects/acme/widget/', url: 'https://github.com/Acme/Widget',
    firstSeen: '2026-09-12', lastSeen: '2026-09-12', snapshotDate: '2026-09-12',
    item: { title: 'Acme/Widget', summary: 'A useful developer widget.', sourceId: 'github-trending' },
    observations: [], topics: [], related: [],
  };
  const chinese = P.projectPage(project, 'zh-CN');
  const english = P.projectPage(project, 'en');

  for (const html of [chinese, english]) {
    assert.match(html, /data-giscus-term="project:acme\/widget"/);
    assert.equal((html.match(/data-giscus-comments/g) || []).length, 1);
  }
  assert.match(chinese, /讨论这个项目/);
  assert.match(english, /Discuss this project/);
});
