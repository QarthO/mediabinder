import { readFile, readdir } from "node:fs/promises"
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
  await connection.query(
    "CREATE TABLE IF NOT EXISTS schema_migration (name VARCHAR(255) PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))"
  )
  const directory = new URL("../migrations/", import.meta.url)
  for (const name of (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const [applied] = await connection.query<any[]>(
      "SELECT name FROM schema_migration WHERE name=?",
      [name]
    )
    if (applied.length) continue
    const sql = await readFile(new URL(name, directory), "utf8")
    for (const statement of sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await connection.query(statement)
    await connection.execute("INSERT INTO schema_migration (name) VALUES (?)", [
      name,
    ])
  }
  console.log("Database ready")
} finally {
  await connection.query("SELECT RELEASE_LOCK('mediabinder-migrate')")
  connection.release()
  await pool.end()
}
process.exit(0)
