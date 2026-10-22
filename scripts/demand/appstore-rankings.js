#!/usr/bin/env node
/**
 * App Store 榜单快照采集（需求侧基建 ①）。
 *
 * 为什么存在：榜单排名是"需求正在形成"的唯一客观证据，而**历史不可回补** —— Apple 只给此刻的
 * 榜单，今天不抓，今天的数据就永久没了。所以它必须每天跑，且只保存归一化结果（原始 feed 只反映
 * 此刻，留着没用还占地方）。
 *
 * 数据源：App Store 官方旧版 RSS，免费、无需 key：
 *   https://itunes.apple.com/<region>/rss/<chart>/limit=<n>/genre=<g>/json
 *
 * 输出：demand/appstore-rankings/<YYYY-MM-DD>.json（北京日），同日重跑会覆盖（保留最新一次）。
 * 退出码：全部 feed 都失败才非 0（部分失败只记 note，不让整条 workflow 红）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REGIONS = ['cn', 'us'];
const CHARTS = ['topfreeapplications', 'toppaidapplications'];
const GENRES = [
  { id: '6007', name: '效率' },
  { id: '6002', name: '工具' },
  { id: '6026', name: '开发者工具' },
];
const LIMIT = 50;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const OUT_DIR = path.join(__dirname, '..', '..', 'demand', 'appstore-rankings');

function beijingDate() {
  const now = new Date();
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function fetchJson(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return fetchJson(url, attempt + 1);
    }
    throw err;
  }
}

function label(node, key) {
  const v = node && node[key];
  if (!v) return '';
  return typeof v === 'object' ? v.label || '' : String(v);
}

function normalize(feed, region, chart, genre) {
  const entries = (feed && feed.feed && feed.feed.entry) || [];
  return entries.map((e, i) => ({
    rank: i + 1,
    appId: (e.id && e.id.attributes && e.id.attributes['im:id']) || '',
    name: label(e, 'im:name'),
    artist: label(e, 'im:artist'),
    price: label(e, 'im:price') || '',
    genre: label(e, 'category'),
  })).filter((x) => x.appId);
}

async function main() {
  const date = beijingDate();
  const capturedAt = new Date().toISOString();
  const charts = [];
  let ok = 0;
  let failed = 0;

  for (const region of REGIONS) {
    for (const chart of CHARTS) {
      for (const genre of GENRES) {
        const url = `https://itunes.apple.com/${region}/rss/${chart}/limit=${LIMIT}/genre=${genre.id}/json`;
        const key = `${region}/${chart}/${genre.id}`;
        try {
          const feed = await fetchJson(url);
          const entries = normalize(feed, region, chart, genre);
          charts.push({ region, chart, genreId: genre.id, genreName: genre.name, count: entries.length, entries });
          ok += 1;
          process.stdout.write(`  ✓ ${key}  ${entries.length} 条\n`);
        } catch (err) {
          charts.push({ region, chart, genreId: genre.id, genreName: genre.name, count: 0, entries: [], note: String(err.message || err) });
          failed += 1;
          process.stdout.write(`  ✗ ${key}  ${err.message || err}\n`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${date}.json`);
  const payload = {
    date,
    capturedAt,
    source: 'itunes-legacy-rss',
    params: { regions: REGIONS, charts: CHARTS, genres: GENRES.map((g) => g.id), limit: LIMIT },
    counts: { charts: charts.length, ok, failed, entries: charts.reduce((n, c) => n + c.count, 0) },
    charts,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 1) + '\n');
  const size = fs.statSync(file).size;
  process.stdout.write(`\n  写入 ${path.relative(process.cwd(), file)}（${(size / 1024).toFixed(1)}KB）成功 ${ok} / 失败 ${failed}\n`);

  if (ok === 0) {
    process.stderr.write('  所有 feed 都失败\n');
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
