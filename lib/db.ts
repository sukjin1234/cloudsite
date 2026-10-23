import mysql, {
  type ExecuteValues,
  type ResultSetHeader,
  type RowDataPacket
} from "mysql2/promise";

let pool: mysql.Pool | null = null;

function getPool() {
  if (pool) {
    return pool;
  }

  const host = process.env.MYSQL_HOST;
  const user = process.env.MYSQL_USER;
  const database = process.env.MYSQL_DATABASE;
  if (!host || !user || !database) {
    throw new Error("MySQL 환경 변수를 설정하세요.");
  }

  pool = mysql.createPool({
    charset: "utf8mb4",
    connectionLimit: 10,
    database,
    host,
    password: process.env.MYSQL_PASSWORD ?? "",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    supportBigNumbers: true,
    user,
    waitForConnections: true
  });
  return pool;
}

export async function query<T extends RowDataPacket>(sql: string, values: ExecuteValues[] = []) {
  const [rows] = await getPool().execute<T[]>(sql, values);
  return rows;
}

export async function execute(sql: string, values: ExecuteValues[] = []) {
  const [result] = await getPool().execute<ResultSetHeader>(sql, values);
  return result;
}
