import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { afterAll, beforeAll, beforeEach, describe } from "vite-plus/test"

import { Database, databaseClientConfig, makeDatabase } from "@/effect/database"
import { migrate } from "@/effect/migrations"

// Runs against real MySQL when MEDIABINDER_TEST_MYSQL=1 and DB_* point at a
// server that can create `<DB_NAME>_<worker>` databases (CI does this).
// Otherwise these suites are skipped; `pnpm verify database` refuses to skip
// in CI.
const mysqlEnabled = process.env.MEDIABINDER_TEST_MYSQL === "1"

export const describeMysql = mysqlEnabled ? describe : describe.skip

// An Effect SQL client for a database on the test server, created if missing.
// `fresh` drops it first.
export function testDatabaseClient(database: string, fresh = false) {
  const config = { ...databaseClientConfig(4), database }
  const create = Effect.gen(function* () {
    const sql = yield* MysqlClient.make({ ...config, database: undefined })
    if (fresh) yield* sql`DROP DATABASE IF EXISTS ${sql(database)}`
    yield* sql`CREATE DATABASE IF NOT EXISTS ${sql(database)}`
  }).pipe(Effect.scoped, Effect.provide(Reactivity.layer))
  return Layer.unwrap(Effect.as(create, MysqlClient.layer(config)))
}

/** The `Database` service on an existing test client. */
export const testDatabaseService = Layer.effect(
  Database,
  Effect.map(SqlClient.SqlClient, (sql) => makeDatabase(Effect.succeed(sql)))
)

// A migrated database for the current worker, exposed both as Effect SQL and
// as the `Database` service. Shared by every test in a `layer(...)` block;
// call `resetDatabase` at the start of each test.
export const TestDatabase = Layer.effectDiscard(
  Effect.flatMap(Database, () => migrate())
).pipe(
  Layer.provideMerge(testDatabaseService),
  Layer.provideMerge(testDatabaseClient(process.env.DB_NAME ?? ""))
)

// Empties every table except the migration ledger, so tests see an empty
// database that is still fully migrated.
export const resetDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql<{ name: string }>`
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name <> 'schema_migration'
      `
      yield* sql`SET FOREIGN_KEY_CHECKS = 0`
      for (const table of tables) yield* sql`DELETE FROM ${sql(table.name)}`
      yield* sql`SET FOREIGN_KEY_CHECKS = 1`
    })
  )
})

/**
 * For suites that call the server modules directly (they use their own
 * connection pool, not an Effect layer): migrates the worker's database once,
 * empties it before every test, and closes the pool afterwards. Call it
 * inside `describeMysql`.
 */
export function useTestDatabase() {
  const runtime = ManagedRuntime.make(TestDatabase)
  beforeAll(() => runtime.runPromise(Effect.void))
  beforeEach(() => runtime.runPromise(resetDatabase))
  afterAll(async () => {
    await runtime.dispose()
    const { pool } = await import("@/lib/database.server")
    await pool.end()
  })
}
