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
      for (const statement of statements) await connection.query(statement);
      await connection.commit();
      return Response.json({ ok: true, statements: statements.length });
    } catch (error) {
      await connection.rollback();
      return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    } finally {
      await connection.end();
    }
  },
};
