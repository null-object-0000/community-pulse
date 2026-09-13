const test = require('node:test');
const assert = require('node:assert/strict');

const { extractExternalUrls } = require('../.agents/skills/community-pulse/scripts/source_raw_items.js');
const { dedupe } = require('../.agents/skills/community-pulse/scripts/collect.js');

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
