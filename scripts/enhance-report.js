#!/usr/bin/env node
/** Local, resumable enhancement only. Never pulls, pushes or sends messages. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { admitReport } = require('../.agents/skills/community-pulse/scripts/issue-admission');
const { removalQueues, rewriteFinalMarkdown } = require('./backfill_report_dedupe');
const { applyEnhancedMarkdown } = require('./enhanced-report');
const ROOT = path.resolve(__dirname, '..');
function prepare(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Expected --date YYYY-MM-DD');
  const base = path.join(ROOT, '知识', '大家都在做什么');
  const raw = JSON.parse(fs.readFileSync(path.join(base, 'raw', `${date}.json`), 'utf8'));
  if ((raw.results || []).some(s => s.error)) throw new Error('Raw has failed sources');
  const admitted = admitReport(raw);
  const removed = new Set(raw.results.flatMap(s => s.items).filter(i =>
    admitted.admission.decisions.some(d => d.status === 'excluded' && d.sourceId === i.sourceId && d.externalId === i.externalId)));
  const markdown = rewriteFinalMarkdown(fs.readFileSync(path.join(base, 'raw', `${date}.md`), 'utf8'), removalQueues(raw.results, removed));
  return { report: admitted, markdown, final: path.join(base, 'final', `${date}.md`) };
}
function validate(report, markdown, date) {
  const result = applyEnhancedMarkdown(report, markdown, date);
  if (result.presentation.summarySource !== 'llm-final') throw new Error(`Incomplete enhancement: ${JSON.stringify(result.presentation)}`);
  return result.presentation;
}
function main() {
  const args = process.argv.slice(2);
  const date = args[args.indexOf('--date') + 1];
  const job = prepare(date);
  if (fs.existsSync(job.final)) {
    console.log(JSON.stringify({ date, status: 'already_complete', ...validate(job.report, fs.readFileSync(job.final, 'utf8'), date) }));
    return;
  }
  const staging = path.join(ROOT, '.scratch', 'enhancement');
  fs.mkdirSync(staging, { recursive: true });
  const input = path.join(staging, `${date}.md`);
  fs.writeFileSync(input, job.markdown);
  const output = path.join(staging, `${date}.final.md`);
  const child = spawnSync(process.execPath, [path.join(ROOT, '.agents/skills/community-pulse/scripts/enhance.js'), '--md', input, '--out', output], { stdio: 'inherit' });
  if (child.status !== 0) throw new Error(`Enhancement failed (${child.status}); checkpoint retained, rerun same command`);
  const markdown = fs.readFileSync(output, 'utf8');
  const presentation = validate(job.report, markdown, date);
  fs.mkdirSync(path.dirname(job.final), { recursive: true });
  fs.writeFileSync(job.final, markdown, { flag: 'wx' });
  console.log(JSON.stringify({ date, status: 'complete', ...presentation, final: job.final }));
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(`FATAL ${error.message}`); process.exitCode = 1; }
}
module.exports = { prepare, validate };
