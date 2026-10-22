#!/usr/bin/env node
/**
 * App Store 榜单快照采集（需求侧基建 ①）。
 *
 * 为什么存在：榜单排名是"需求正在形成"的唯一客观证据，而**历史不可回补** —— Apple 只给此刻的
 * 榜单。所以它必须每天跑，而且要**两层都存**：
 *   1) demand/appstore-rankings/<日期>.json       归一化（rank/appId/name/...），供分析直接用
 *   2) demand/appstore-rankings/raw/<日期>.json.gz  原始 feed 全量（含我们此刻还没用到的字段）
 * 只存归一化是个错误（v1 犯过）：排名不可回补，被丢弃的字段——分类、价格档位、描述、评分——
 * 同样不可回补，而"以后可能需要"是常态。原始层压缩后约 25KB/天，值得留。
 *
 * 数据源：App Store 官方旧版 RSS，免费、无需 key：
 *   https://itunes.apple.com/<region>/rss/<chart>/limit=<n>/genre=<g>/json
 *
 * 同日重跑覆盖（保留最新一次 + capturedAt）。全部 feed 失败才退出码非 0。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REGIONS = ['cn', 'us'];
const CHARTS = ['topfreeapplications', 'toppaidapplications'];
const GENRES = [
  { id: '6007', name: '效率' },
  { id: '6002', name: '工具' },
  { id: '6026', name: '开发者工具' },
];
const LIMIT = 50;
const PARSER_VERSION = 2;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'demand', 'appstore-rankings');
const RAW_DIR = path.join(OUT_DIR, 'raw');

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
    const msg = String((err && err.message) || err);
    // 403 是限流：短退避重试只会让封得更久，只重试一次且等 30 秒
    if (msg.includes('403')) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 30000));
        return fetchJson(url, attempt + 1);
      }
      throw err;
    }
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
  const rawFeeds = [];
  let ok = 0;
  let failed = 0;

  for (const region of REGIONS) {
    for (const chart of CHARTS) {
      for (const genre of GENRES) {
        const url = `https://itunes.apple.com/${region}/rss/${chart}/limit=${LIMIT}/genre=${genre.id}/json`;
        const key = `${region}/${chart}/${genre.id}`;
        const started = Date.now();
        try {
          const feed = await fetchJson(url);
          const entries = normalize(feed, region, chart, genre);
          charts.push({ region, chart, genreId: genre.id, genreName: genre.name, count: entries.length, entries });
          rawFeeds.push({ key, url, ok: true, ms: Date.now() - started, body: feed });
          ok += 1;
          process.stdout.write(`  ✓ ${key}  ${entries.length} 条  ${Date.now() - started}ms\n`);
        } catch (err) {
          charts.push({ region, chart, genreId: genre.id, genreName: genre.name, count: 0, entries: [], note: String(err.message || err) });
          rawFeeds.push({ key, url, ok: false, ms: Date.now() - started, error: String(err.message || err) });
          failed += 1;
          process.stdout.write(`  ✗ ${key}  ${err.message || err}\n`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  // 全失败时不许覆盖既有快照 —— 一次限流不该把已经抓到的历史数据抹掉
  if (ok === 0) {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `${date}.json`), 'utf8')); } catch { /* 没有既存文件 */ }
    if (prev && ((prev.counts || {}).entries || 0) > 0) {
      process.stderr.write(`  本次 0 个 feed 成功，保留既有快照（${prev.counts.entries} 条）不覆盖\n`);
      process.exit(1);
    }
  }

  fs.mkdirSync(RAW_DIR, { recursive: true });
  const base = {
    date,
    capturedAt,
    parserVersion: PARSER_VERSION,
    source: 'itunes-legacy-rss',
    params: { regions: REGIONS, charts: CHARTS, genres: GENRES.map((g) => g.id), limit: LIMIT },
    coverage: {
      note: '只覆盖 App Store 官方榜单的 Top50 × 3 分类 × 2 地区 × 每日一次快照；榜外应用与日内变化不在其中，分析时必须声明',
    },
  };

  const normalized = {
    ...base,
    counts: { charts: charts.length, ok, failed, entries: charts.reduce((n, c) => n + c.count, 0) },
    charts,
  };
  const normalizedFile = path.join(OUT_DIR, `${date}.json`);
  fs.writeFileSync(normalizedFile, JSON.stringify(normalized, null, 1) + '\n');

  const raw = { ...base, counts: { feeds: rawFeeds.length, ok, failed }, feeds: rawFeeds };
  const rawFile = path.join(RAW_DIR, `${date}.json.gz`);
  fs.writeFileSync(rawFile, zlib.gzipSync(Buffer.from(JSON.stringify(raw)), { level: 9 }));

  const kb = (p) => (fs.statSync(p).size / 1024).toFixed(1);
  process.stdout.write(
    `\n  归一化 → ${path.relative(ROOT, normalizedFile)}（${kb(normalizedFile)}KB）\n` +
    `  原始层 → ${path.relative(ROOT, rawFile)}（${kb(rawFile)}KB）\n` +
    `  成功 ${ok} / 失败 ${failed}\n`
  );

  if (ok === 0) {
    process.stderr.write('  所有 feed 都失败\n');
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
