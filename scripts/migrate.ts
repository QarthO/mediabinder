import { readFile } from "node:fs/promises"
import { getMigrations } from "better-auth/db/migration"
import { auth } from "../src/lib/auth.server"
import { pool } from "../src/lib/database.server"
const connection = await pool.getConnection()
try {
  const [lock] = await connection.query<any[]>(
    "SELECT GET_LOCK('mediabinder-migrate', 60) AS acquired"
  )
  if (lock[0].acquired !== 1)
    throw new Error("Could not acquire migration lock")
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
  const sql = await readFile(
    new URL("../migrations/001-app.sql", import.meta.url),
    "utf8"
  )
  for (const statement of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await connection.query(statement)
  console.log("Database ready")
} finally {
  await connection.query("SELECT RELEASE_LOCK('mediabinder-migrate')")
  connection.release()
  await pool.end()
}
process.exit(0)
