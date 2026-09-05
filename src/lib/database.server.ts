import mysql, { type RowDataPacket } from "mysql2/promise"
export const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  connectionLimit: 8,
  timezone: "Z",
  dateStrings: true,
})
export async function rows<T>(
  sql: string,
  values: (string | number | boolean | Date | null)[] = []
): Promise<T[]> {
  const [result] = await pool.execute<RowDataPacket[]>(sql, values)
  return result as T[]
}
