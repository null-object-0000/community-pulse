/**
 * 临时只读查询 Worker。
 *
 * 本机直连阿里云 RDS 的 3306 会被公司出口在 TLS 握手阶段重置（2026-09-14 与 09-18 各实测一次），
 * 所以查询生产产品库只能经 Cloudflare Hyperdrive —— 与 `worker/catalog-import.mjs` 同一个模式，
 * 区别是这里**只绑 HYPERDRIVE_READ**，读账号本身也没有写权限，所以这个入口在构造上就写不了数据。
 *
 * 由 `scripts/catalog/live-query.js` 临时部署、用完立刻删除；令牌是每次随机生成的。
 */
import { createConnection } from 'mysql2/promise';

// 只放行单条 SELECT：这个入口只用于核对（`source_items` 到底有没有数据、旧地址对应哪个 product_id），
// 不承担任何写入职责 —— 写走 `worker/catalog-import.mjs`。
const WRITE_KEYWORDS = /\b(?:insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|call|load\s+data)\b/i;

export function assertReadOnly(sql) {
  const text = String(sql || '').trim();
  if (!/^select\b/i.test(text)) throw new Error('only SELECT is allowed');
  if (text.includes(';')) throw new Error('only a single statement is allowed');
  if (WRITE_KEYWORDS.test(text)) throw new Error('write keywords are not allowed');
  return text;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/query') return new Response('Not found', { status: 404 });
    if (request.headers.get('authorization') !== `Bearer ${env.READ_TOKEN}`) return new Response('Unauthorized', { status: 401 });
    let sql;
    try {
      sql = assertReadOnly(await request.text());
    } catch (error) {
      return Response.json({ ok: false, error: error.message }, { status: 400 });
    }
    const connection = await createConnection({
      host: env.HYPERDRIVE_READ.host, port: env.HYPERDRIVE_READ.port,
      user: env.HYPERDRIVE_READ.user, password: env.HYPERDRIVE_READ.password,
      database: env.HYPERDRIVE_READ.database, disableEval: true,
    });
    try {
      const [rows] = await connection.query({ sql, timeout: 60000 });
      return Response.json({ ok: true, rows });
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    } finally {
      await connection.end();
    }
  },
};
