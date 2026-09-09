#!/usr/bin/env node
/**
 * community-pulse GitHub 仓库信息补全 (enrichment)
 *
 * 对 item 里 URL 是 github.com/owner/repo 的条目, 调 GitHub API 补仓库基础信息:
 *   stars / forks / language / license / description / createdAt / updatedAt / archived / openIssues
 *
 * 用法:
 *   node enrich_github.js --file in.json --out out.json   # 对 collect.js 产物 JSON 补全 (原地字段 github)
 *   node enrich_github.js --file in.json --inplace        # 原地写回
 *
 * 依赖 gh CLI (已认证, 走 GH_TOKEN; Actions runner 内置 token, 5000/hr)。
 * 未认证时 gh api 会 401 → 自动降级: 单条失败跳过, 记录到 stats。
 *
 * 环境变量:
 *   ENRICH_GITHUB=0   关闭补全 (回溯历史数据时建议关, 省配额; 默认开启)
 *   GH_REPO_CACHE=... 缓存文件路径 (默认不缓存)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---- GitHub URL 解析 ----
// 从任意 url 提取 github.com/owner/repo (去 utm 参数 / 尾部标点 / tree/commit/blob 等路径)
function parseGitHubUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  // 去查询参数 (utm 等)
  s = s.replace(/\?.*$/, '');
  // 去尾部斜杠/标点
  s = s.replace(/[),。.）\s]+$/, '');
  // 支持 github.com/owner/repo 前缀的各种形式
  const m = s.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (!m) return null;
  // 过滤: 纯 owner 页 (github.com/owner) / 组织页 / 无效名
  const owner = m[1];
  const repo = m[2];
  if (!owner || !repo) return null;
  // repo 名不能是常见非仓库路径 (issues/pulls/topics/marketplace/features 等)
  const NON_REPO = new Set(['issues', 'pulls', 'topics', 'marketplace', 'features', 'collections', 'sponsors', 'about', 'settings', 'login', 'signup', 'search', 'notifications', 'explore', 'trending', 'events', 'orgs', 'users', 'pricing', 'docs', 'contact', 'new', 'codespaces', 'packages', 'gists', 'enterprise', 'site']);
  if (NON_REPO.has(repo.toLowerCase())) return null;
  // 过滤 GitHub 系统 owner (user-attachments = 附件图片, 不是真实仓库)
  const SYS_OWNERS = new Set(['user-attachments', 'github', 'octocat', 'contact']);
  if (SYS_OWNERS.has(owner.toLowerCase())) return null;
  return { owner, repo, fullName: `${owner}/${repo}` };
}

// ---- GitHub API (走 gh CLI, 认证+限流自动处理) ----
function ghRepoInfo(owner, repo) {
  const out = execFileSync('gh', ['api', `repos/${owner}/${repo}`, '--jq', '{stargazers_count, forks_count, language, license: .license.spdx_id, description, created_at, updated_at, archived, open_issues_count, html_url}'], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 5 * 1024 * 1024,
  });
  return JSON.parse(out);
}

// 数字格式化: 1234 → 1.2k, 12000 → 12k
function fmtNum(n) {
  if (n == null || isNaN(n)) return null;
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// ---- 缓存 ----
function makeCache(file) {
  let map = null;
  if (file && fs.existsSync(file)) {
    try { map = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))); } catch { map = null; }
  }
  if (!map) map = new Map();
  return {
    get: (k) => map.get(k),
    set: (k, v) => map.set(k, v),
    save() { if (file) fs.writeFileSync(file, JSON.stringify(Object.fromEntries(map), null, 2)); },
  };
}

// ---- 主流程 ----
async function main() {
  const args = process.argv.slice(2);
  const getArg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const inFile = getArg('--file');
  const outFile = getArg('--out');
  const inplace = args.includes('--inplace');
  if (!inFile) { console.error('用法: node enrich_github.js --file in.json [--out out.json | --inplace]'); process.exit(1); }

  if (process.env.ENRICH_GITHUB === '0') {
    console.error('[enrich] ENRICH_GITHUB=0 已禁用');
    process.exit(0);
  }

  const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const cache = makeCache(getArg('--cache') || process.env.GH_REPO_CACHE);

  const stats = { total: 0, githubUrl: 0, fetched: 0, failed: 0, skipped: 0, cached: 0 };
  const failures = [];

  for (const r of (data.results || [])) {
    for (const it of (r.items || [])) {
      stats.total++;
      let gh = parseGitHubUrl(it.url);
      if (!gh) {
        // VibeCafé 等: item 里可能预置了 github.url (详情页挖的)
        const pre = it.github && it.github.url;
        if (pre) gh = parseGitHubUrl(pre);
      }
      if (!gh) { stats.skipped++; continue; }
      stats.githubUrl++;

      const cacheKey = gh.fullName.toLowerCase();
      let info = cache.get(cacheKey);
      if (info) {
        stats.cached++;
      } else {
        try {
          info = ghRepoInfo(gh.owner, gh.repo);
          cache.set(cacheKey, info);
          stats.fetched++;
        } catch (e) {
          stats.failed++;
          failures.push({ fullName: gh.fullName, error: String(e.message || e).slice(0, 120) });
          console.error(`[enrich:fail] ${gh.fullName}: ${e.message}`);
          // 失败的不写 github 字段 (保留原 url), 避免假数据
          continue;
        }
      }

      it.github = {
        url: info.html_url || `https://github.com/${gh.fullName}`,
        fullName: gh.fullName,
        owner: gh.owner,
        repo: gh.repo,
        stars: info.stargazers_count ?? null,
        forks: info.forks_count ?? null,
        language: info.language || '',
        license: info.license || '',
        description: info.description || '',
        createdAt: info.created_at || null,
        updatedAt: info.updated_at || null,
        archived: !!info.archived,
        openIssues: info.open_issues_count ?? null,
      };
    }
  }

  cache.save();

  const out = outFile || inFile;
  fs.writeFileSync(out, JSON.stringify(data, null, 2));
  console.error(`[enrich] 完成: 总${stats.total} 含GitHub URL ${stats.githubUrl} 抓取${stats.fetched} 缓存${stats.cached} 失败${stats.failed} 跳过${stats.skipped}`);
  if (failures.length) console.error(`[enrich] 失败明细: ${failures.map(f => `${f.fullName}(${f.error})`).join('; ')}`);
  if (outFile) console.log(`written to ${outFile}`);
}

main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
