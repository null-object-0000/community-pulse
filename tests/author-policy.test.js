const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const D = require('../web/shared.js');
const { foldAuthorMarkdown } = require('../scripts/author-markdown.js');
const { applyEnhancedMarkdown } = require('../scripts/enhanced-report.js');
const row = (title, summary, author = 'maker') => ({ title, summary, author, sourceId: 'chinese-indie-dev', url: `https://${title}.example.com` });
const report = items => ({ results: [{ sourceId: 'chinese-indie-dev', sourceName: 'Feed', items }] });

test('same author photo-video variants fold without changing rows or product identities', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ ...row(`tool${i}`, '一张全身照生成约 15 秒舞蹈短视频；一次性积分包 $8.88 起'), productId: `prd_${i}` }));
  const r = report(items), before = JSON.stringify(items);
  D.applyAuthorPolicy(r);
  const entries = D.authorEntries(D.reportItems(r));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].related.length, 29);
  assert.equal(JSON.stringify(items.map(({authorDisplay, ...item}) => item)), before);
  assert.equal(D.readerItems(r)[0].authorMoreCount, 29);
  assert.equal(D.readerItems(r).length, 1);
});

test('unrelated tools are capped at three slots; all overflow remains accessible', () => {
  const r = D.applyAuthorPolicy(report(Array.from({ length: 8 }, (_, i) => row(`tool${i}`, `Different purpose ${i}`))));
  const entries = D.authorEntries(D.reportItems(r));
  assert.equal(entries.length, 3);
  assert.equal(entries[2].overflow.length, 5);
  const html = D.renderAuthorFeed(D.reportItems(r), 'en');
  assert.match(html, /More by maker · 5 projects/);
  assert.equal((html.match(/class="feed-item"/g) || []).length, 8);
});

test('same category/price alone, missing authors, and different authors never merge', () => {
  const r = D.applyAuthorPolicy(report([
    row('video', '照片生成舞蹈短视频；$8.88', 'a'),
    row('other-video', '照片生成舞蹈短视频；$8.88', 'b'),
    row('editor', '视频剪辑编辑器；$8.88', 'a'),
    ...Array.from({length: 5}, (_, i) => row(`anon${i}`, '照片生成舞蹈短视频', '')),
  ]));
  const entries = D.authorEntries(D.reportItems(r));
  assert.equal(entries.length, 8);
  assert.ok(entries.every(entry => !entry.related.length && !entry.overflow.length));
});

test('highly similar substantive descriptions can group other tool families', () => {
  const summary = '这是一个面向开发者的数据库监控工具，自动分析查询执行计划并检测慢查询，支持历史性能回放、索引优化建议和团队告警通知。';
  const r = D.applyAuthorPolicy(report([row('a', summary), row('b', summary + '新增邮件通知。'), row('c', '完全不同的小说写作工具。')]));
  assert.equal(D.authorEntries(D.reportItems(r)).length, 2);
});

test('search/filter subsets promote a matching hidden item and can open folds', () => {
  const r = D.applyAuthorPolicy(report(Array.from({length: 6}, (_, i) => row(`tool${i}`, '照片生成舞蹈短视频'))));
  const subset = D.reportItems(r).slice(4);
  const entries = D.authorEntries(subset);
  assert.equal(entries[0].item.title, 'tool4');
  const html = D.renderAuthorFeed(subset, 'zh-CN', { expanded: true });
  assert.match(html, /<details class="author-fold" open>/);
  assert.match(html, /tool5/);
});

test('2026-10-27 repair preserves all enhanced product matches, and Markdown folding is idempotent', () => {
  const r = JSON.parse(fs.readFileSync('知识/大家都在做什么/raw/2026-10-27.json', 'utf8'));
  const md = fs.readFileSync('知识/大家都在做什么/final/2026-10-27.md', 'utf8');
  const enhanced = applyEnhancedMarkdown(r, md, r.date);
  assert.equal(enhanced.presentation.matchedByProductId, 137);
  assert.equal(enhanced.presentation.summarySource, 'mixed');
  assert.equal(enhanced.presentation.matchedByHeading, 2);
  assert.equal(enhanced.presentation.enhancedItemCount, 138);
  assert.equal(D.readerItems(r).length, 110);
  assert.equal((md.match(/^### /gm) || []).length, 139);
  assert.equal(foldAuthorMarkdown(md, r), md);
  const rawMd = fs.readFileSync('知识/大家都在做什么/raw/2026-10-27.md', 'utf8');
  const folded = foldAuthorMarkdown(rawMd, r);
  assert.match(folded, /另 29 项/);
  assert.equal((folded.match(/^### /gm) || []).length, 139);
  assert.match(folded, /## 阮一峰周刊/);
});
