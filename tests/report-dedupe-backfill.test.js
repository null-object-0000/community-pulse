const test = require('node:test');
const assert = require('node:assert/strict');
const { removalQueues, rewriteFinalMarkdown } = require('../scripts/backfill_report_dedupe.js');

test('final backfill removes the older occurrence when duplicate headings are identical', () => {
  const older = { title: 'Same Product', author: 'maker', externalId: 'old' };
  const newer = { title: 'Same Product', author: 'maker', externalId: 'new' };
  const results = [{ sourceName: 'Feed', items: [older, newer] }];
  const markdown = `# Report

## Feed（2 条）

### Same Product 👤 maker
> old description

🔗 [投稿页](https://example.com/old)

### Same Product 👤 maker
> new description

🔗 [投稿页](https://example.com/new)
`;
  const output = rewriteFinalMarkdown(markdown, removalQueues(results, new Set([older])));
  assert.match(output, /^## Feed（1 条）$/m);
  assert.doesNotMatch(output, /example\.com\/old/);
  assert.match(output, /example\.com\/new/);
});
