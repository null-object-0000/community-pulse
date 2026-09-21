import { createConnection } from 'mysql2/promise';

export function splitSql(sql) {
  const result = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    if (sql[index] === "'") {
      if (quoted && sql[index + 1] === "'") index += 1;
      else quoted = !quoted;
    } else if (sql[index] === ';' && !quoted) {
      const statement = sql.slice(start, index).trim();
      if (statement) result.push(statement);
      start = index + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/import') return new Response('Not found', { status: 404 });
    if (request.headers.get('authorization') !== `Bearer ${env.IMPORT_TOKEN}`) return new Response('Unauthorized', { status: 401 });
    const statements = splitSql(await request.text());
    const connection = await createConnection({
      host: env.HYPERDRIVE_WRITE.host, port: env.HYPERDRIVE_WRITE.port,
      user: env.HYPERDRIVE_WRITE.user, password: env.HYPERDRIVE_WRITE.password,
      database: env.HYPERDRIVE_WRITE.database, disableEval: true,
    });
    try {
      await connection.beginTransaction();
      const rows = [];
      for (const statement of statements) {
        const [result] = await connection.query(statement);
        // SELECT 的 result 是行数组，写入的 result 是 ResultSetHeader（对象）。顺带把行带回去，
        // 是为了让加工流水线的**状态读也走这条主库连接** —— 见下面关于 Hyperdrive 缓存的注释。
        if (Array.isArray(result)) rows.push(...result);
      }
      await connection.commit();
      // `rows` 是新增字段，旧调用方（upload-mysql.js）只看 HTTP 状态，不受影响。
      //
      // 为什么要让读也走这里：Hyperdrive **按 SQL 文本缓存查询结果**（实测约十分钟）。加工流水线
      // 的「读本 run 的既有状态」每轮 SQL 文本完全相同，于是第一轮在空表时读出的空结果被缓存，
      // 后续每一轮续跑都读到「没有状态」，把整天的产品重新发一遍请求（2026-09-21 实测白付 627 次）。
      // 主库连接不带这层缓存，状态读必须用它。
      return Response.json({ ok: true, statements: statements.length, rows });
    } catch (error) {
      await connection.rollback();
      return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    } finally {
      await connection.end();
    }
  },
};
