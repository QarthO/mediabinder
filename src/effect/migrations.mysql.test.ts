import { readdirSync } from "node:fs"
import { expect } from "vite-plus/test"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import {
  describeMysql,
  testDatabaseClient,
  testDatabaseService,
} from "@/test/database"
import { migrate } from "./migrations"

const files = readdirSync(new URL("../../migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort()

// Dropped and rebuilt, so this file owns the worker's database.
const Fresh = testDatabaseService.pipe(
  Layer.provideMerge(testDatabaseClient(process.env.DB_NAME ?? "", true))
)

describeMysql("migrations", () => {
  it.layer(Fresh)("on a new database", (it) => {
    it.effect("apply every file once, and applying again changes nothing", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        expect(yield* migrate()).toBe(files.length)
        const ledger = () =>
          sql<{ name: string; applied_at: string }>`
              SELECT name, CAST(applied_at AS CHAR) AS applied_at
              FROM schema_migration ORDER BY name`
        const first = yield* ledger()
        expect(first.map((row) => row.name)).toEqual(files)
        // Application and Better Auth tables both exist.
        const tables = yield* sql<{ name: string }>`
            SELECT table_name AS name FROM information_schema.tables
            WHERE table_schema = DATABASE()`
        expect(tables.map((row) => row.name)).toEqual(
          expect.arrayContaining(["media", "media_set", "user", "session"])
        )

        expect(yield* migrate()).toBe(0)
        expect(yield* ledger()).toEqual(first)
      })
    )
  })
})
