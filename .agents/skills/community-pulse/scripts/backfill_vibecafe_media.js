#!/usr/bin/env node
/**
 * One-off offline backfill: copy VibeCafé product media (`logoUrl` → `logo`,
 * `imageUrls` → `images`) from source-raw into already generated raw 日报.
 *
 * Why: `logo` (product mark) and `images` (software screenshots, 1-9 of them)
 * were normalized only after the daily reports existed. Running collect.js again
 * for every past date would also rewrite unrelated producthunt fields, so this
 * script touches nothing but the two VibeCafé media fields on VibeCafé items.
 *
 * Offline: reads ` Knowledge/大家都在做什么/source-raw/vibecafe/*.json` and
 * `知识/大家都在做什么/raw/*.json`, never the source site.
 *
 * Usage:
 *   node scripts/backfill_vibecafe_media.js
 *   node scripts/backfill_vibecafe_media.js --start 2026-06-02 --end 2026-09-10
 *   node scripts/backfill_vibecafe_media.js --dry-run
 */
const fs = require('fs');
const path = require('path');

const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const SOURCE_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw', 'vibecafe');
const RAW_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'raw');

function parseArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  return {
    start: value('--start'),
    end: value('--end'),
    dryRun: argv.includes('--dry-run'),
  };
}

function mediaByProduct(document) {
  const media = new Map();
  for (const product of document.records || []) {
    const images = [...new Set((Array.isArray(product.imageUrls) ? product.imageUrls : [])
      .filter((url) => typeof url === 'string' && url.trim())
      .map((url) => url.trim()))];
    media.set(product.id, {
      logo: typeof product.logoUrl === 'string' ? product.logoUrl.trim() : '',
      images,
    });
  }
  return media;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dates = fs.readdirSync(SOURCE_ROOT)
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter(Boolean)
    .filter((date) => (!options.start || date >= options.start) && (!options.end || date <= options.end))
    .sort();

  let updated = 0;
  let records = 0;
  let missing = 0;
  for (const date of dates) {
    const rawFile = path.join(RAW_ROOT, `${date}.json`);
    if (!fs.existsSync(rawFile)) {
      console.log(`${date}: no raw report, skipped`);
      continue;
    }
    const original = fs.readFileSync(rawFile, 'utf8');
    const report = JSON.parse(original);
    const media = mediaByProduct(JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, `${date}.json`), 'utf8')));
    let changed = 0;
    for (const source of report.results || []) {
      if (source.sourceId !== 'vibecafe') continue;
      for (const item of source.items || []) {
        const entry = media.get(item.externalId);
        if (!entry) {
          missing += 1;
          console.warn(`${date}: ${item.externalId || item.title} has no source-raw record`);
          continue;
        }
        records += 1;
        // `image` stays the first screenshot (legacy avatar fallback); only fill it when empty.
        const next = { logo: entry.logo, images: entry.images, image: item.image || entry.images[0] || entry.logo };
        if (item.logo === next.logo && JSON.stringify(item.images || []) === JSON.stringify(next.images) && item.image === next.image) continue;
        item.logo = next.logo;
        item.images = next.images;
        if (next.image) item.image = next.image;
        changed += 1;
      }
    }
    if (!changed) continue;
    updated += 1;
    if (options.dryRun) {
      console.log(`${date}: would update ${changed} items`);
      continue;
    }
    const pretty = original.includes('\n');
    fs.writeFileSync(rawFile, JSON.stringify(report, null, pretty ? 2 : 0));
    console.log(`${date}: updated ${changed} items`);
  }
  console.log(JSON.stringify({ dates: dates.length, updatedReports: updated, updatedItems: records, missingRecords: missing, dryRun: options.dryRun }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
