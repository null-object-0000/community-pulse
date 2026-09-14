export function mysqlAdapter(connection) {
  return {
    prepare(sql) {
      let bindings = [];
      return {
        bind(...values) {
          bindings = values;
          return this;
        },
        async all() {
          const [rows] = await connection.query(sql, bindings);
          return { results: rows };
        },
      };
    },
  };
}

export async function openMysql(binding) {
  const { createConnection } = await import('mysql2/promise');
  const connection = await createConnection({
    host: binding.host,
    port: binding.port,
    user: binding.user,
    password: binding.password,
    database: binding.database,
    dateStrings: true,
    supportBigNumbers: true,
    disableEval: true,
  });
  return { db: mysqlAdapter(connection), close: () => connection.end() };
}
