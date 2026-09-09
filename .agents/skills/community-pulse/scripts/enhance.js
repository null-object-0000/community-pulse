#!/usr/bin/env node
/**
 * community-pulse LLM 增强: 对日报 md 中的描述做翻译/归纳
 *  - 纯英文描述 → 翻译成中文
 *  - 超长描述 (>100字) → 归纳成凝练中文摘要 (≤100字)
 *  - 短中文描述 → 原样保留
 *
 * 用法:
 *   node enhance.js --md input.md --out output.md
 *   node enhance.js --md input.md --out output.md --dry-run   # 只打印计划不调LLM
 *
 * 依赖: 本机 LLM 端点 (OpenAI 兼容), 环境变量 COMMUNITY_PULSE_LLM_BASE / ..._KEY
 *       默认 http://127.0.0.1:18640/v1 (Hermes 同款)
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.COMMUNITY_PULSE_LLM_BASE || 'http://127.0.0.1:18640/v1';
const MODEL = process.env.COMMUNITY_PULSE_LLM_MODEL || 'flowlet-pro';
const KEY = process.env.COMMUNITY_PULSE_LLM_KEY || process.env.HERMES_CUSTOM_127_0_0_1_18640_API_KEY || '';
const MAX_LEN = 100; // 超过此长度 → 归纳

function isPureEnglish(s) {
  if (!s || !s.trim()) return false;
  const cn = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (s.match(/[a-zA-Z]/g) || []).length;
  return cn === 0 && letters > 20 && s.trim().length > 25;
}

async function llm(prompt) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 1500, // 推理模型思考+输出共享预算; 实测 1500 全通过, 256K 超端点上限会全失败
        }),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      const d = await res.json();
      const content = (d.choices[0]?.message?.content || '').trim();
      if (content) return content; // 成功
      console.error(`  尝试${attempt}: 返回空, 重试`);
    } catch (e) {
      console.error(`  尝试${attempt}: ${e.message}`);
    }
  }
  return ''; // 3次都失败
}

// 处理一条描述: 返回 { orig, enhanced, action }
function clampSummary(value) {
  const clean = String(value || '').replace(/^(?:摘要|翻译)\s*[：:]\s*/i, '').trim();
  if (clean.length <= MAX_LEN) return clean;
  const prefix = clean.slice(0, MAX_LEN);
  const boundary = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('！'), prefix.lastIndexOf('；'), prefix.lastIndexOf('？'));
  return boundary >= 35 ? prefix.slice(0, boundary + 1) : `${clean.slice(0, MAX_LEN - 1).trimEnd()}…`;
}

async function enhance(summary, idx, section) {
  const s = (summary || '').trim();
  if (!s) return { orig: s, enhanced: s, action: 'skip' };
  if (/^Product Hunt\b/i.test(section || '')) {
    const prompt = `根据下面 Product Hunt 官方完整描述，用中文归纳这个产品具体做什么。保留最有区分度的功能、形态或使用方式，不要照抄宣传语，不添加原文没有的信息，≤${MAX_LEN}字，只输出摘要：\n\n${s}`;
    const out = await llm(prompt);
    return { orig: s, enhanced: clampSummary(out), action: 'summarize-translate' };
  }
  if (isPureEnglish(s)) {
    const prompt = `把下面这段 GitHub 项目/工具的英文描述翻译成简洁中文（保留关键信息，≤${MAX_LEN}字，不要解释）：\n\n${s}`;
    const out = await llm(prompt);
    return { orig: s, enhanced: clampSummary(out), action: 'translate' };
  }
  if (s.length > MAX_LEN) {
    const prompt = `把下面这段中文描述归纳成简洁摘要（保留核心信息，≤${MAX_LEN}字，不要解释不要寒暄）：\n\n${s}`;
    const out = await llm(prompt);
    return { orig: s, enhanced: clampSummary(out), action: 'summarize' };
  }
  return { orig: s, enhanced: s, action: 'keep' };
}

// 从 md 提取需要处理的条目 (### 标题行 + > 引用描述)
function extractItems(md) {
  const lines = md.split('\n');
  const items = [];
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (t.startsWith('## ')) section = t.replace(/^##\s+/, '').replace(/（\d+\s*条）\s*$/, '');
    if (t.startsWith('### ')) {
      const title = t.replace(/^###\s+/, '');
      let desc = '';
      if (i + 1 < lines.length && lines[i + 1].startsWith('> ')) {
        desc = lines[i + 1].slice(2);
      }
      items.push({ idx: i, title, desc, section });
    }
  }
  return items;
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const inFile = getArg('--md');
  const outFile = getArg('--out');
  const dry = args.includes('--dry-run');
  if (!inFile || !outFile) { console.error('用法: node enhance.js --md in.md --out out.md [--dry-run]'); process.exit(1); }

  const md = fs.readFileSync(inFile, 'utf8');
  const items = extractItems(md);
  console.error(`共 ${items.length} 条, 开始处理...`);

  let changed = 0;
  let working = md; // 累计修改的工作副本
  const CONCURRENCY = parseInt(process.env.ENHANCE_CONCURRENCY || '5', 10); // 并发数
  // 分批并发处理: 每批 CONCURRENCY 条并行调 LLM, 完成后统一写回
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(it =>
      it.desc ? enhance(it.desc, it.idx, it.section).then(r => ({ it, r })) : Promise.resolve({ it, r: { action: 'skip', enhanced: '', orig: '' } })
    ));
    for (const { it, r } of results) {
      if (r.action !== 'keep' && r.action !== 'skip') {
        if (!r.enhanced) {
          console.error(`[空返回,保留原文] ${it.title.slice(0, 30)}`);
          continue;
        }
        console.error(`[${r.action}] ${it.title.slice(0, 30)} (${it.desc.length}→${r.enhanced.length}字)`);
        if (!dry) {
          const descLine = it.idx + 1;
          const lines = working.split('\n');
          lines[descLine] = `> ${r.enhanced}`;
          working = lines.join('\n');
        }
        changed++;
      } else {
        console.error(`[keep] ${it.title.slice(0, 30)}`);
      }
    }
  }
  if (!dry) fs.writeFileSync(outFile, working); // 最终写一次(增强结果)
  console.error(`完成: ${changed} 条被增强`);
}

main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
