#!/usr/bin/env node
/**
 * 把 `data/catalog/mysql-import/` 里的增量包经**临时 Worker 通道**写进生产产品库。
 *
 * **写入通道复用 `createChannelDb`**（与 `apply-sql.js`、`enrich-products.js`、`export-queue.js`
 * 同一个入口），不再自己 `wrangler deploy` + 裸 `curl`。这不是省事，是唯一能正确处理
 * 「刚部署的临时 Worker 路由还没生效」的方式：
 *
 *   2026-10-09 实测（原实现）：`wrangler deploy` 1.2 秒就报出地址 → 立刻 POST → Cloudflare 用
 *   HTML **404** 答（请求根本没到我们的 Worker）→ 裸 curl 的 `--retry 5 --retry-delay 2` 在
 *   10 秒内全撞 404 → `Uploaded 0/7 MySQL chunks` → 整步失败 → **当天的日报因排在其后而没被
 *   推送，整期丢失**。这不是偶发：2026-09-30 ~ 10-09 的 12 次日更里 4 次失败，失败点都在这条
 *   通道上（写库 / 生成快照）。
 *
 *   `createChannelDb` 的 `waitForRoute()` 正是为此存在：部署后用 `SELECT 1` 探测，最多 10 次、
 *   退避到 8 秒（约 60 秒预算）；`withReconnect()` 处理**中途失联**（临时 Worker 漂移后被删），
 *   且只在「响应体不是 JSON」时重试 —— 那时事务必然没提交，重试安全；Worker 自己答的 JSON
 *   错误（`ok:false`，例如 SQL 报错）绝不重试，否则会掩盖真问题。
 *
 * **分块上传 + 断点续传保留**：每个 chunk 一个请求（Worker 把它放进同一个事务），
 * `.uploaded.json` 记录已成功的文件，重跑时跳过 —— 通道稳定后这些仍然有用（半途失败不必从头）。
 *
 * 幂等：写入全是 upsert，重复应用同一份 SQL 不会写坏数据。
 */
const fs = require('fs');
const path = require('path');
const { createChannelDb } = require('./mysql-channel.js');

const ROOT = path.resolve(__dirname, '..', '..');
const directory = path.resolve(process.argv.find((arg) => arg.startsWith('--dir='))?.slice(6)
  || path.join(ROOT, 'data', 'catalog', 'mysql-import'));
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
const progressFile = path.join(directory, '.uploaded.json');
const progress = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, 'utf8')) : { files: [] };
const completed = new Set(progress.files || []);

async function main() {
  const db = createChannelDb({ log: (message) => console.log(`[upload] ${message}`) });
  try {
    // 结构迁移排在数据之前：`0004_dynamic_product_pages.sql` 建的是后面 upsert 要写的表/列。
    // 它幂等，重复执行安全。走同一条通道，于是共享 `waitForRoute` 的路由等待。
    const detailMigration = path.join(ROOT, 'migrations', 'mysql', '0004_dynamic_product_pages.sql');
    await db.execute(fs.readFileSync(detailMigration, 'utf8'));
    console.log('[upload] 结构迁移已应用');

    for (const [index, entry] of manifest.files.entries()) {
      if (completed.has(entry.name)) continue;
      console.log(`[${index + 1}/${manifest.files.length}] ${entry.name}: ${entry.rows} rows`);
      await db.execute(fs.readFileSync(path.join(directory, entry.name), 'utf8'));
      completed.add(entry.name);
      fs.writeFileSync(progressFile, `${JSON.stringify({ files: [...completed] }, null, 2)}\n`);
    }
  } finally {
    // 删掉临时 Worker；删除失败不该盖住真正的错误，所以放 finally 里、异常继续向外抛。
    await db.close();
  }
  console.log(`Uploaded ${completed.size}/${manifest.files.length} MySQL chunks.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
