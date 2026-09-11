#!/usr/bin/env node
/**
 * One-off offline backfill: copy Product Hunt launch media (`thumbnail` → `logo`,
 * `media` → `images`) from source-raw into already generated raw 日报.
 *
 * Why: the official-featured projection gained `thumbnail`/`media` after the
 * historical 日报 already existed (see `capture_producthunt_raw.js
 * --refresh-featured`). Running collect.js again for every past date would also
 * rewrite unrelated fields, so this script touches nothing but the media fields
 * on Product Hunt items.
 *
 * The mapping is byte-identical to `productHuntItems()` in source_raw_items.js:
 * `logo` is `thumbnail.url`, `images` is the deduplicated `media[].url` list
 * without the mark, and `image` stays the first gallery image (legacy avatar
 * fallback) or the mark when there is no gallery.
 *
 * Offline: reads `知识/大家都在做什么/source-raw/producthunt/*.json` and
 * `知识/大家都在做什么/raw/*.json`, never the source site.
 *
 * Usage:
 *   node scripts/backfill_producthunt_media.js
 *   node scripts/backfill_producthunt_media.js --start 2026-01-01 --end 2026-09-10
 *   node scripts/backfill_producthunt_media.js --dry-run
 */
const fs = require('fs');
const path = require('path');

const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const SOURCE_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw', 'producthunt');
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

function mediaByPost(document) {
  const media = new Map();
  for (const post of document.officialFeatured?.records || []) {
    const logo = typeof post.thumbnail?.url === 'string' ? post.thumbnail.url.trim() : '';
    const images = [...new Set((Array.isArray(post.media) ? post.media : [])
      .map((entry) => (entry && typeof entry.url === 'string' ? entry.url.trim() : ''))
      .filter((url) => url && url !== logo))];
    media.set(String(post.id), { logo, images });
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
  let unprojected = 0;
  for (const date of dates) {
    const rawFile = path.join(RAW_ROOT, `${date}.json`);
    if (!fs.existsSync(rawFile)) {
      console.log(`${date}: no raw report, skipped`);
      continue;
    }
    const document = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, `${date}.json`), 'utf8'));
    const fields = document.officialFeatured?.capture?.sourceFields || [];
    if (!fields.includes('thumbnail')) {
      unprojected += 1;
      console.log(`${date}: source-raw has no media projection, skipped`);
      continue;
    }
    const original = fs.readFileSync(rawFile, 'utf8');
    const report = JSON.parse(original);
    const media = mediaByPost(document);
    let changed = 0;
    for (const source of report.results || []) {
      if (source.sourceId !== 'producthunt') continue;
      for (const item of source.items || []) {
        const entry = media.get(String(item.externalId));
        if (!entry) {
          missing += 1;
          console.warn(`${date}: ${item.externalId || item.title} has no source-raw record`);
          continue;
        }
        records += 1;
        const next = { logo: entry.logo, images: entry.images, image: entry.images[0] || entry.logo };
        if (item.logo === next.logo && JSON.stringify(item.images || []) === JSON.stringify(next.images)
          && (item.image || '') === next.image) continue;
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
  console.log(JSON.stringify({
    dates: dates.length,
    updatedReports: updated,
    updatedItems: records,
    missingRecords: missing,
    daysWithoutProjection: unprojected,
    dryRun: options.dryRun,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
