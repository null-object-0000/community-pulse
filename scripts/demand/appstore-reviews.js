#!/usr/bin/env node
/**
 * App Store 差评抓取（公开 RSS，零依赖，Node >= 18 全局 fetch）
 *
 * 输入：榜单快照 JSON（{date, charts:[{region,chart,genreId,genreName,entries:[{rank,appId,name,...}]}]}）
 * 处理：每个 chart 取前 N 名（默认 20）→ 按 appId 全局去重（region 跟首次出现的 chart 走）
 *       抓 customerreviews RSS（page=1..P），过滤 im:rating <= 2 且 updated 在最近 D 天内
 * 输出：
 *   <outdir>/reviews-<date>.jsonl   一条差评一行
 *   <outdir>/apps-<date>.json       覆盖到的 app 汇总（含 rateLimited / failures）
 *
 * 用法：
 *   node appstore-reviews.js --snapshot demand/appstore-rankings/2026-10-22.json --outdir /path/to/out
 *   node appstore-reviews.js --snapshot X --outdir Y --interval 2500 --max-requests 150
 *
 * 限流策略（itunes.apple.com 对本机 IP 会限流，直连与代理表现一致）：
 *   - 默认并发 1、请求起始间隔 2500ms、整轮最多 150 个请求（含重试），到量即停
 *   - 403 视为限流：不重试、记录并跳过该 app；若第一个请求就 403，立刻整体停下
 *   - 广度优先：先给所有 app 抓第 1 页，还有预算再补第 2/3 页，最大化覆盖的 app 数
 *
 * 幂等：每次运行覆盖当天的两个输出文件（先写 .tmp 再 rename）。
 * 约束：只读公开 RSS，不登录、不抓 HTML；单个 app 失败只记录并继续。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------- CLI ----------
function parseArgs(argv) {
  const out = {
    snapshot: null,
    outdir: null,
    top: 20,
    pages: 3,
    days: 90,
    concurrency: 1,
    intervalMs: 2500,
    maxRequests: 150,
    retries: 0,
    timeoutMs: 30000,
    maxRating: 2,
    date: null,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`缺少 ${a} 的参数值`);
      return v;
    };
    switch (a) {
      case '--snapshot': out.snapshot = next(); break;
      case '--outdir': out.outdir = next(); break;
      case '--top': out.top = parseInt(next(), 10); break;
      case '--pages': out.pages = parseInt(next(), 10); break;
      case '--days': out.days = parseInt(next(), 10); break;
      case '--concurrency': out.concurrency = parseInt(next(), 10); break;
      case '--interval': out.intervalMs = parseInt(next(), 10); break;
      case '--max-requests': out.maxRequests = parseInt(next(), 10); break;
      case '--retries': out.retries = parseInt(next(), 10); break;
      case '--timeout': out.timeoutMs = parseInt(next(), 10) * 1000; break;
      case '--max-rating': out.maxRating = parseInt(next(), 10); break;
      case '--date': out.date = next(); break;
      case '--quiet': out.quiet = true; break;
      case '-h':
      case '--help':
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数：${a}`);
    }
  }
  if (!out.snapshot) throw new Error('必须提供 --snapshot <榜单快照路径>');
  if (!out.outdir) throw new Error('必须提供 --outdir <输出目录>');
  if (!(out.top > 0) || !(out.pages > 0) || !(out.concurrency > 0) || !(out.maxRequests > 0)) {
    throw new Error('--top / --pages / --concurrency / --max-requests 必须为正整数');
  }
  return out;
}

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(opts, ...args) {
  if (!opts.quiet) console.error(...args);
}

/** 取 label 字段（RSS JSON 的每个字段通常是 {label: ...}） */
function label(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v.label === 'string') return v.label;
  if (typeof v.label === 'number') return String(v.label);
  return '';
}

function normalizeEntries(feed) {
  const e = feed && feed.entry;
  if (!e) return [];
  return Array.isArray(e) ? e : [e];
}

/** 从快照构建去重后的 app 列表（保持 chart 顺序、chart 内 rank 顺序） */
function buildAppList(snapshot, top) {
  const apps = new Map();
  for (const chart of snapshot.charts || []) {
    const entries = (chart.entries || []).slice(0, top);
    for (const e of entries) {
      if (e == null || e.appId == null) continue;
      const appId = String(e.appId);
      let rec = apps.get(appId);
      if (!rec) {
        rec = {
          appId,
          appName: e.name || '',
          region: chart.region,
          genreId: String(chart.genreId || ''),
          genreName: chart.genreName || '',
          charts: [],
        };
        apps.set(appId, rec);
      }
      rec.charts.push({ chart: `${chart.chart}/${chart.genreId}`, rank: e.rank });
    }
  }
  return [...apps.values()];
}

/**
 * 请求闸门：全局限速 + 请求预算。
 * 403 一律不重试（Apple 用它表示限流；硬重试只会让限流窗口变长）。
 */
function makeGate(opts) {
  const state = {
    nextAt: 0,
    made: 0,
    streak403: 0,
    rateLimited: false,
    budgetExhausted: false,
    stopped: false,
    stopReason: null,
  };
  return {
    state,
    get made() { return state.made; },
    get rateLimited() { return state.rateLimited; },
    get stopped() { return state.stopped; },
    /** 预留一个请求额度；额度用完返回 false */
    async take() {
      if (state.budgetExhausted || state.stopped) return false;
      if (state.made >= opts.maxRequests) {
        state.budgetExhausted = true;
        return false;
      }
      const now = Date.now();
      const at = Math.max(now, state.nextAt);
      state.nextAt = at + opts.intervalMs;
      const wait = at - now;
      if (wait > 0) await sleep(wait);
      state.made++;
      return true;
    },
    onSuccess() {
      state.streak403 = 0;
    },
    on403() {
      state.rateLimited = true;
      state.streak403++;
      // 第一个请求就 403 → 直接收手；连续 3 次 403 → 已进入限流窗口，继续打只会烧预算
      if (state.made <= 1) {
        state.stopped = true;
        state.stopReason = '首个请求即 403';
      } else if (state.streak403 >= 3) {
        state.stopped = true;
        state.stopReason = '连续 3 次 403（限流窗口）';
      }
    },
  };
}

async function fetchJson(url, opts, gate) {
  let lastErr = null;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (!(await gate.take())) {
      const err = new Error('请求预算已用完');
      err.budget = true;
      throw err;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { 'user-agent': 'CommunityPulse/1.0 (App Store review research)' },
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        // 403 = 限流，不重试；429/5xx 才考虑重试（默认 retries=0，即也不重试）
        err.retryable = res.status === 429 || res.status >= 500;
        if (res.status === 403) gate.on403();
        throw err;
      }
      if (!text.trim()) {
        const err = new Error('empty body');
        err.status = 200;
        err.retryable = false;
        err.empty = true;
        throw err;
      }
      gate.onSuccess();
      return JSON.parse(text);
    } catch (err) {
      if (err.budget) throw err;
      lastErr = err;
      if (err.retryable !== true || attempt === opts.retries) break;
      await sleep(1000 * (attempt + 1) + Math.floor(Math.random() * 300));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('unknown fetch error');
}

function reasonOf(err) {
  if (err.budget) return 'budget exhausted（预算用完，未请求）';
  if (err.empty) return 'empty body（该 app 无评价返回）';
  if (err.status === 403) return 'HTTP 403（限流，未重试）';
  if (err.status) return `HTTP ${err.status}`;
  if (err.name === 'AbortError') return 'timeout 30s';
  return err.message || 'unknown error';
}

/**
 * 抓单个 app 的一页。返回 {entries, error}
 * page>1 时由调用方判断是否值得继续。
 */
async function fetchPage(app, page, opts, gate) {
  const url =
    `https://itunes.apple.com/${app.region}/rss/customerreviews/` +
    `page=${page}/id=${encodeURIComponent(app.appId)}/sortby=mostrecent/json`;
  try {
    const data = await fetchJson(url, opts, gate);
    return { entries: normalizeEntries(data.feed), error: null };
  } catch (err) {
    return { entries: [], error: reasonOf(err) };
  }
}

function writeJsonl(file, rows) {
  const tmp = `${file}.tmp`;
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}

function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- main ----------
async function main() {
  const opts = parseArgs(process.argv);
  const t0 = Date.now();

  const snapshotPath = path.resolve(opts.snapshot);
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const date = opts.date || snapshot.date;
  if (!date) throw new Error('快照里没有 date，且未提供 --date');

  const apps = buildAppList(snapshot, opts.top);
  // 防呆：快照可能正在被重写（entries 暂时为空），不能拿它写出空结果
  const totalEntries = (snapshot.charts || []).reduce((s, c) => s + ((c.entries || []).length), 0);
  if (apps.length === 0) {
    throw new Error(`快照前 ${opts.top} 名没有解析出任何 app（charts=${(snapshot.charts || []).length}, entries=${totalEntries}）——文件可能正在被改写，请稍后重跑`);
  }

  const cutoffMs = Date.now() - opts.days * 86400 * 1000;
  fs.mkdirSync(path.resolve(opts.outdir), { recursive: true });
  const reviewsFile = path.join(path.resolve(opts.outdir), `reviews-${date}.jsonl`);
  const appsFile = path.join(path.resolve(opts.outdir), `apps-${date}.json`);

  log(opts, `[start] snapshot=${snapshotPath} charts=${(snapshot.charts || []).length} apps=${apps.length} top=${opts.top} pages<=${opts.pages} interval=${opts.intervalMs}ms maxReq=${opts.maxRequests}`);

  const gate = makeGate(opts);
  const state = new Map(); // appId -> {reviews, seenAll, pagesFetched, ratingsSeen, error, stopped}
  for (const a of apps) {
    state.set(a.appId, { reviews: [], seenAll: new Set(), seenRev: new Set(), pagesFetched: 0, ratingsSeen: 0, error: null, done: false });
  }

  // 广度优先：先所有 app 的第 1 页，再第 2/3 页
  const tasks = [];
  for (let page = 1; page <= opts.pages; page++) {
    for (const app of apps) tasks.push({ app, page });
  }

  let processed = 0;
  for (let ti = 0; ti < tasks.length; ti++) {
    const { app, page } = tasks[ti];
    if (gate.stopped) {
      // 首个请求就 403：静默 60s 再试一次（只试一次，避免硬撑）
      if (gate.state.stopReason === '首个请求即 403' && !gate.state.cooledDown) {
        gate.state.cooledDown = true;
        log(opts, '[cool] 首个请求 403，静默 60s 后重试同一个 app');
        await sleep(60000);
        gate.state.stopped = false;
        gate.state.stopReason = null;
        gate.state.streak403 = 0;
        ti--; // 重跑当前任务
        continue;
      }
      break;
    }
    if (gate.state.budgetExhausted) break;
    const st = state.get(app.appId);
    if (st.done) continue;          // 该 app 已失败/到底
    if (page > 1 && st.pagesFetched !== page - 1) continue; // 上一页没抓或不够满

    const { entries, error } = await fetchPage(app, page, opts, gate);
    if (error) {
      if (error.startsWith('budget')) { break; }
      if (page === 1) {
        st.error = error;
        st.done = true;
      } else {
        st.error = `page${page}: ${error}`;
        st.done = true;
      }
      log(opts, `[fail] ${app.region}/${app.appId} ${app.appName} — ${st.error}`);
      continue;
    }

    st.pagesFetched++;
    let newEntries = 0;
    let added = 0;
    let allOutOfWindow = entries.length > 0;

    for (const e of entries) {
      const eid = label(e.id);
      if (eid) {
        if (!st.seenAll.has(eid)) { st.seenAll.add(eid); newEntries++; }
      } else {
        newEntries++;
      }

      const ratingRaw = label(e['im:rating']);
      if (!ratingRaw) continue;   // entry[0] 这类 app 元信息条目，无评分
      st.ratingsSeen++;

      const ts = Date.parse(label(e.updated));
      if (Number.isFinite(ts) && ts >= cutoffMs) allOutOfWindow = false;
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;

      const rating = parseInt(ratingRaw, 10);
      if (!(rating >= 1 && rating <= opts.maxRating)) continue;

      const rid = eid || `${app.appId}:${ts}:${label(e.title).slice(0, 40)}`;
      const key = `${app.appId}|${rid}`;
      if (st.seenRev.has(key)) continue;
      st.seenRev.add(key);

      st.reviews.push({
        appId: app.appId,
        appName: app.appName,
        region: app.region,
        genreId: app.genreId,
        genreName: app.genreName,
        charts: app.charts,
        rating,
        title: label(e.title).trim(),
        content: label(e.content).trim(),
        version: label(e['im:version']),
        updated: new Date(ts).toISOString(),
      });
      added++;
    }

    processed++;
    if (!opts.quiet) {
      log(opts, `[page] ${app.region}/${app.appId} p${page} entries=${entries.length} +${added}neg (req=${gate.made}/${opts.maxRequests})`);
    }

    if (entries.length === 0) st.done = true;               // 空页 → 到底
    else if (newEntries === 0) st.done = true;              // 重复页 → 到底
    else if (allOutOfWindow) st.done = true;                // 全部早于时间窗 → 后面更早
    else if (entries.length < 50) st.done = true;           // 不满一页 → 最后一页
    else if (page >= opts.pages) st.done = true;
  }

  // ---- 汇总 ----
  const perApp = [];
  const failures = [];
  const allReviews = [];
  for (const app of apps) {
    const st = state.get(app.appId);
    const attempted = st.pagesFetched > 0 || !!st.error;
    if (st.error) {
      failures.push({
        appId: app.appId,
        appName: app.appName,
        region: app.region,
        reason: st.error,
      });
    } else if (!attempted) {
      failures.push({
        appId: app.appId,
        appName: app.appName,
        region: app.region,
        reason: gate.rateLimited ? 'skipped：因限流提前收手，未请求' : 'skipped：请求预算用完，未请求',
      });
    }
    allReviews.push(...st.reviews);
    perApp.push({
      appId: app.appId,
      appName: app.appName,
      region: app.region,
      genreName: app.genreName,
      charts: app.charts,
      reviewsFetched: st.ratingsSeen,
      negatives: st.reviews.length,
      pagesFetched: st.pagesFetched,
      ...(attempted ? {} : { skipped: true }),
      ...(st.error ? { error: st.error } : {}),
    });
  }

  writeJsonl(reviewsFile, allReviews);
  const emptyNote =
    allReviews.length === 0
      ? '本次没有抓到任何评价：itunes.apple.com 对本机出口 IP 限流（HTTP 403，直连与代理同一出口）。限流窗口解除后重跑同一条命令即可覆盖本文件。'
      : undefined;
  writeJson(appsFile, {
    capturedAt: new Date().toISOString(),
    date,
    appCount: perApp.length,
    reviewCount: allReviews.length,
    rateLimited: gate.rateLimited,
    requestsMade: gate.made,
    maxRequests: opts.maxRequests,
    intervalMs: opts.intervalMs,
    ...(emptyNote ? { note: emptyNote } : {}),
    failures,
    apps: perApp,
  });

  const byRegion = {};
  const byRating = { 1: 0, 2: 0 };
  for (const r of allReviews) {
    byRegion[r.region] = (byRegion[r.region] || 0) + 1;
    byRating[r.rating] = (byRating[r.rating] || 0) + 1;
  }
  const ratingsTotal = perApp.reduce((s, a) => s + a.reviewsFetched, 0);
  const summary = {
    date,
    appsTotal: perApp.length,
    appsAttempted: perApp.filter((a) => !a.skipped).length,
    appsWithNegatives: perApp.filter((a) => a.negatives > 0).length,
    pagesFetched: perApp.reduce((s, a) => s + a.pagesFetched, 0),
    requestsMade: gate.made,
    maxRequests: opts.maxRequests,
    rateLimited: gate.rateLimited,
    stopReason: gate.state.stopReason,
    stoppedEarly: gate.stopped || gate.state.budgetExhausted,
    ratingsSeen: ratingsTotal,
    negatives: allReviews.length,
    negativeRate: ratingsTotal ? +((allReviews.length / ratingsTotal) * 100).toFixed(1) : 0,
    byRating,
    byRegion,
    elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
    failures,
    reviewsFile,
    appsFile,
  };
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main !== module) {
  module.exports = { parseArgs, buildAppList, label, normalizeEntries };
} else {
  main().catch((err) => {
    console.error('[fatal]', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
