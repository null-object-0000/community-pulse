#!/usr/bin/env node
// No remote writes. Run --repair on the enhancement host to compensate missed jobs.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepare, validate } = require('./enhance-report');
const BASE = path.resolve(__dirname, '../知识/大家都在做什么');
function enhancementDue(date, now, lookback = 3) {
  const deadline = Date.parse(`${date}T04:00:00Z`) + 86400000;
  return deadline <= now.getTime() && deadline >= now.getTime() - lookback * 86400000;
}
function pendingDates(now = new Date(), lookback = 3) {
  return fs.readdirSync(path.join(BASE, 'raw')).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map(n => n.slice(0, 10))
    .filter(date => {
      // Beijing noon the following day: permits the morning collector/enhancer to finish.
      if (!enhancementDue(date, now, lookback)) return false;
      try {
        const job = prepare(date);
        validate(job.report, fs.readFileSync(job.final, 'utf8'), date);
        return false;
      } catch { return true; }
    });
}
if (require.main === module) {
  const pending = pendingDates();
  for (const date of pending) {
    console.error(`Enhancement overdue: ${date}; run node scripts/enhance-report.js --date ${date}`);
    if (process.argv.includes('--repair')) {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'enhance-report.js'), '--date', date], { stdio: 'inherit' });
      if (result.status !== 0) process.exitCode = 1;
    }
  }
  if (pending.length && !process.argv.includes('--repair')) process.exitCode = 1;
}
module.exports = { pendingDates, enhancementDue };
