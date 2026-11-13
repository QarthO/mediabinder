import { expect } from "vite-plus/test"
import { layer } from "@effect/vitest"
import type { RowDataPacket } from "mysql2/promise"
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"

import mysql from "mysql2/promise"
import { databaseOptions } from "@/lib/config"
import { describeMysql, resetDatabase, TestDatabase } from "@/test/database"
import { Database } from "./database"
import { LockBusyError } from "./errors"

class Boom extends Schema.TaggedError<Boom>()("Boom", {}) {}

// Locks belong to the server, not the database, so parallel workers need
// names of their own.
const lock = `test-lock-${process.env.DB_NAME}`

describeMysql("database", () => {
  layer(TestDatabase)("named locks", (it) => {
    // Holds the lock until `release` completes; `held` says it is taken.
    const hold = Effect.fnUntraced(function* (
      body: Effect.Effect<void, Boom> = Effect.void
    ) {
      const database = yield* Database
      const held = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fiber = yield* database
        .withNamedLock("test.hold", lock, { timeoutSeconds: 5 }, () =>
          Deferred.succeed(held, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(body)
          )
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(held)
      return { fiber, release }
    })
    // MySQL 8 locks are re-entrant per session, so a leaked lock can look
    // free to a later caller that lands on the same pooled connection. Ask
    // the server who holds it instead.
    const isFree = Effect.gen(function* () {
      const database = yield* Database
      const [state] = yield* database.queryRows<
        RowDataPacket & { holder: unknown }
      >("test.state", "SELECT IS_USED_LOCK(?) AS holder", [lock])
      return state?.holder === null
    })

    it.effect("excludes a second holder until the first finishes", () =>
      Effect.gen(function* () {
        const { fiber, release } = yield* hold()
        const busy = yield* Database.use((database) =>
          database
            .withNamedLock(
              "test.try",
              lock,
              { timeoutSeconds: 0 },
              () => Effect.void
            )
            .pipe(Effect.flip)
        )
        expect(busy).toBeInstanceOf(LockBusyError)
        expect(yield* isFree).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(fiber)
        expect(yield* isFree).toBe(true)
      })
    )

    it.effect("is released when the body fails", () =>
      Effect.gen(function* () {
        const { fiber, release } = yield* hold(Effect.fail(new Boom()))
        yield* Deferred.succeed(release, undefined)
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
        expect(yield* isFree).toBe(true)
      })
    )

    it.effect("is released when the body is interrupted", () =>
      Effect.gen(function* () {
        const { fiber } = yield* hold()
        yield* Fiber.interrupt(fiber)
        expect(yield* isFree).toBe(true)
      })
    )

    it.effect("transactions on the lock's connection commit or roll back", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const database = yield* Database
        yield* database.execute(
          "test.create",
          "CREATE TABLE IF NOT EXISTS lock_probe (id INT PRIMARY KEY)"
        )
        const insert = (id: number) =>
          database.withNamedLock(
            "test.tx",
            lock,
            { timeoutSeconds: 5 },
            (session) =>
              session.transaction(
                session
                  .execute("INSERT INTO lock_probe (id) VALUES (?)", [id])
                  .pipe(
                    Effect.andThen(
                      id === 2 ? Effect.fail(new Boom()) : Effect.void
                    )
                  )
              )
          )
        yield* insert(1)
        yield* Effect.flip(insert(2))
        const found = yield* database.queryRows<RowDataPacket & { id: number }>(
          "test.read",
          "SELECT id FROM lock_probe"
        )
        expect(found.map((row) => row.id)).toEqual([1])
      })
    )
  })

  layer(TestDatabase)("row shapes", (it) => {
    it.effect("return DATETIME as the strings the mysql2 pool returns", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const database = yield* Database
        yield* database.execute(
          "test.create",
          "CREATE TABLE IF NOT EXISTS datetime_probe (id INT PRIMARY KEY, at DATETIME(3) NOT NULL)"
        )
        // A Date is written as UTC whatever the process zone (the tests run
        // in New York), and the stored text is what comes back.
        yield* database.execute(
          "test.insert",
          "INSERT INTO datetime_probe (id, at) VALUES (1, ?), (2, '2024-03-10 02:30:00.123')",
          [new Date("2024-01-02T03:04:05.678Z")]
        )
        const sql = "SELECT id, at FROM datetime_probe ORDER BY id"
        const viaDatabase = yield* database.queryRows("test.read", sql)
        expect(viaDatabase.map((row) => ({ ...row }))).toEqual([
          { id: 1, at: "2024-01-02 03:04:05.678" },
          { id: 2, at: "2024-03-10 02:30:00.123" },
        ])
        // Better Auth's pool is configured the same way.
        const viaPool = yield* Effect.promise(async () => {
          const pool = mysql.createPool({
            ...databaseOptions(),
            timezone: "Z",
            dateStrings: true,
          })
          try {
            return (await pool.execute(sql))[0]
          } finally {
            await pool.end()
          }
        })
        expect(viaPool).toEqual(viaDatabase.map((row) => ({ ...row })))
      })
    )
  })
})
