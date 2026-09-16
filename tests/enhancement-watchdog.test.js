const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { enhancementDue } = require('../scripts/check-enhancement');
const { prepare, validate } = require('../scripts/enhance-report');
test('watchdog permits the morning jobs and only alerts on recent overdue reports', () => {
  assert.equal(enhancementDue('2026-09-15', new Date('2026-09-16T03:59:00Z')), false);
  assert.equal(enhancementDue('2026-09-15', new Date('2026-09-16T04:00:00Z')), true);
  assert.equal(enhancementDue('2026-09-15', new Date('2026-09-20T04:01:00Z')), false);
});
test('complete existing final validates; missing enhancement is a hard failure', () => {
  const job = prepare('2026-09-14');
  assert.equal(validate(job.report, fs.readFileSync(job.final, 'utf8'), '2026-09-14').summarySource, 'llm-final');
  assert.throws(() => validate(job.report, '', '2026-09-14'), /Incomplete enhancement/);
});
