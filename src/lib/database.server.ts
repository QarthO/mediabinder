import mysql, { type RowDataPacket } from "mysql2/promise"
import { databaseOptions } from "./config"
export const pool = mysql.createPool({
  ...databaseOptions(),
  connectionLimit: 8,
  timezone: "Z",
  dateStrings: true,
})
if (import.meta.hot) import.meta.hot.dispose(() => pool.end())

export async function rows<T>(
  sql: string,
  values: (string | number | boolean | Date | null)[] = []
): Promise<T[]> {
  const [result] = await pool.execute<RowDataPacket[]>(sql, values)
  return result as T[]
}
