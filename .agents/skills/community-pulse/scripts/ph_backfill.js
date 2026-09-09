#!/usr/bin/env node
/**
 * Product Hunt 回溯: 按日调 API 拉历史产品, 合并进 raw/*.json
 * 用法: node ph_backfill.js [START] [END]  默认 2026-06-01 ~ 昨天
 * 依赖: PRODUCT_HUNT_TOKEN 环境变量
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROXY = process.env.COMMUNITY_PULSE_PROXY === undefined ? 'http://127.0.0.1:7890' : process.env.COMMUNITY_PULSE_PROXY;
const API = 'https://api.producthunt.com/v2/api/graphql';
const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const RAW = path.join(VAULT, '知识', '大家都在做什么', 'raw');

function ghQL(query) {
  const ph = require('./ph_tokens');
  const tokens = ph.getTokens();
  if (!tokens.length) throw new Error('未设置 PRODUCT_HUNT_TOKEN');
  let lastError;
  for (let round = 0; round < tokens.length; round += 1) {
    const token = ph.nextToken();
    if (!token) break;
    const args = ['-s', '--max-time', '30', '-X', 'POST', API,
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Content-Type: application/json',
      '-H', 'Accept: application/json',
      '-d', JSON.stringify({ query })];
    if (PROXY) args.push('-x', PROXY);
    try {
      const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 35000 });
      const parsed = JSON.parse(out);
      // 限流检测: PH API 返回 { errors: [{ error: 'rate_limit_reached', ... }] }
      if (parsed.errors && parsed.errors.length) {
        const e = parsed.errors[0];
        if (/rate_limit/i.test(e.error || '')) {
          ph.markCooldown(token, 900);
          throw new Error('PH_API_RATE_LIMITED: ' + (e.error_description || '').slice(0, 60));
        }
        throw new Error('PH_API_ERROR: ' + JSON.stringify(e).slice(0, 80));
      }
      return parsed.data;
    } catch (error) {
      const safe = ph.redact(String(error.message || error), tokens);
      lastError = new Error(safe);
      if (/PH_API_RATE_LIMITED/.test(safe)) continue; // 429 → 换下一个 token
      throw lastError;
    }
  }
  throw lastError;
}

function fetchDay(date) {
  // date 是北京时间, PH 的 postedAfter/Before 是 UTC
  const start = new Date(`${date}T00:00:00+08:00`).toISOString();
  const end = new Date(`${date}T23:59:59+08:00`).toISOString();
  const query = `{ posts(order: NEWEST, first: 50, postedAfter: "${start}", postedBefore: "${end}") { edges { node { id name tagline url createdAt description } } } }`;
  const data = ghQL(query);
  const edges = (data.posts && data.posts.edges) || [];
  return edges.map(e => {
    const n = e.node;
    return {
      sourceId: 'producthunt',
      title: n.name || '',
      url: n.url || '',
      author: '',
      authorUrl: '',
      publishedAt: n.createdAt || null,
      summary: n.tagline || '',
      content: n.description || n.tagline || '',
      metrics: {},
      tags: ['producthunt', 'new'],
      externalId: String(n.id),
    };
  });
}

function main() {
  const args = process.argv.slice(2);
  const start = args[0] || '2026-06-01';
  const end = args[1] || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  console.error(`回溯 ${start} ~ ${end}`);

  let merged = 0, total = 0;
  let d = new Date(`${start}T00:00:00+08:00`);
  const endD = new Date(`${end}T23:59:59+08:00`);
  while (d <= endD) {
    const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const jf = path.join(RAW, `${date}.json`);
    if (fs.existsSync(jf)) {
      try {
        const items = fetchDay(date);
        if (items.length) {
          const data = JSON.parse(fs.readFileSync(jf, 'utf8'));
          let found = false;
          for (const r of data.results) {
            if (r.sourceId === 'producthunt') { r.items = items; found = true; break; }
          }
          if (!found) data.results.push({ sourceId: 'producthunt', sourceName: 'Product Hunt 新品', items });
          fs.writeFileSync(jf, JSON.stringify(data));
          merged++; total += items.length;
        }
      } catch (e) {
        if (/PH_API_RATE_LIMITED/.test(e.message)) {
          console.error(`  限流! ${date} 起停止. 等限流窗口重置后重跑 (已合并 ${merged} 天 ${total} 产品)`);
          break;
        }
        console.error(`  FAIL ${date}: ${e.message.slice(0, 60)}`);
      }
    }
    d.setDate(d.getDate() + 1);
    if (merged % 15 === 0 && merged > 0) console.error(`[进度] ${merged} 天, ${total} 产品`);
  }
  console.error(`完成: ${merged} 天, ${total} 产品合并`);
}

main();
