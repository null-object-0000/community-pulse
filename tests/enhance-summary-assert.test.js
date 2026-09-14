const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SKILL = path.join(__dirname, '..', '.agents', 'skills', 'community-pulse', 'scripts');
const { validateLocalization, translationInput } = require(path.join(SKILL, 'enhance.js'));

const CATEGORY = 'developer-tools';
const TAXONOMY = { useCases: ['software-development'], agentRoles: [], productForms: [], platforms: [], integrations: [] };
const LONG = 'A long enough source description to pass the forty character floor.';

// The enhancer blanks both summaries when the source has no description at all. That is deliberate
// (better empty than invented) and it is what sent 13 Show HN link posts to the English fallback.
test('an empty source description yields empty summaries instead of invented copy', () => {
  const result = validateLocalization(
    { summaryZh: '不应出现', summaryEn: 'should not appear', primaryCategory: CATEGORY, taxonomy: TAXONOMY },
    { title: 'Show HN: T', desc: '', section: 'Hacker News·Show HN' });
  assert.equal(result.summaryZh, '');
  assert.equal(result.summaryEn, '');
  // Classification is independent of the description and must still come through.
  assert.equal(result.primaryCategory, CATEGORY);
  assert.deepEqual(result.taxonomy.useCases, ['software-development']);
});

// The regression the assertion in main() guards: a non-empty source description must produce a
// non-empty summary. Before the guard, this shape passed silently all the way into the daily report.
test('a non-empty source description must not come back with an empty summary', () => {
  const result = validateLocalization(
    { summaryZh: '中文摘要', summaryEn: 'English summary', primaryCategory: CATEGORY, taxonomy: TAXONOMY },
    { title: 'T', desc: LONG, section: 'Hacker News·Show HN' });
  assert.equal(result.summaryZh, '中文摘要');
  assert.ok(String(result.summaryEn).trim().length > 0);
});

test('the guard reads the same description the localizer does', () => {
  // main() decides whether an empty summary is a bug with translationInput(item.desc); if these two
  // ever diverge the guard either fires on legitimate rows or misses the real ones.
  assert.equal(translationInput(LONG), LONG);
  assert.equal(translationInput(''), '');
  // Markdown link syntax and bare URLs are stripped before the length test, same as the prompt input.
  assert.equal(translationInput('[官网](https://example.com/) 真实描述文字'), '官网 真实描述文字');
});
