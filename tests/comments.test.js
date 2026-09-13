const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../scripts/render-site.js');

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
