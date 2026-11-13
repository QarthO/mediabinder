import { expect } from "vite-plus/test"
import { layer } from "@effect/vitest"
import type { RowDataPacket } from "mysql2/promise"
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"

import { describeMysql, resetDatabase, TestDatabase } from "@/test/database"
import { Database } from "@/effect/database"
import { LockBusyError, NotFoundError } from "@/effect/errors"
import {
  CATALOG_LOCK,
  driveLockName,
  requireAccessible,
  transaction,
  withUserLock,
} from "./catalog.server"

class Boom extends Schema.TaggedError<Boom>()("Boom", {}) {}

// Locks belong to the server, so the lock names these tests contend on must
// not collide with a parallel worker's: only the drive lock's user varies.
const user = `lock-test-${process.env.DB_NAME}`

describeMysql("catalog locks", () => {
  layer(TestDatabase, { timeout: "120 seconds" })("transaction", (it) => {
    const holder = (name: string) =>
      Effect.gen(function* () {
        const database = yield* Database
        const [state] = yield* database.queryRows<
          RowDataPacket & { holder: unknown }
        >("test.state", "SELECT IS_USED_LOCK(?) AS holder", [name])
        return state?.holder
      })

    // The catalog lock is server-wide, so a suite running in another worker
    // may hold it for a moment. A leaked lock stays held, so wait for it. The
    // pause is a real timer: `it.effect` runs on a TestClock that never
    // advances.
    const awaitCatalogFree = Effect.gen(function* () {
      let current = yield* holder(CATALOG_LOCK)
      for (let attempt = 0; current !== null && attempt < 200; attempt++) {
        yield* Effect.promise(
          () => new Promise((resolve) => setTimeout(resolve, 50))
        )
        current = yield* holder(CATALOG_LOCK)
      }
      return current
    })

    it.effect("rolls back on failure and releases the catalog lock", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const database = yield* Database
        const exit = yield* Effect.exit(
          transaction((session) =>
            session
              .execute(
                "INSERT INTO catalog_tag(name,color) VALUES ('rolled-back','#000000')"
              )
              .pipe(Effect.andThen(Effect.fail(new Boom())))
          )
        )
        expect(Exit.isFailure(exit)).toBe(true)
        const tags = yield* database.queryRows(
          "test.tags",
          "SELECT name FROM catalog_tag"
        )
        expect(tags).toHaveLength(0)
        // Not merely free to the same pooled connection: nobody holds it.
        expect(yield* awaitCatalogFree).toBeNull()
        // And a later transaction commits.
        yield* transaction((session) =>
          session.execute(
            "INSERT INTO catalog_tag(name,color) VALUES ('kept','#000000')"
          )
        )
        expect(
          yield* database.queryRows("test.tags", "SELECT name FROM catalog_tag")
        ).toHaveLength(1)
        expect(yield* awaitCatalogFree).toBeNull()
      })
    )

    it.effect("runs on the connection that holds the lock", () =>
      Effect.gen(function* () {
        const seen = yield* transaction((session) =>
          session
            .queryRows<RowDataPacket & { holder: unknown; me: unknown }>(
              "SELECT IS_USED_LOCK(?) AS holder, CONNECTION_ID() AS me",
              [CATALOG_LOCK]
            )
            .pipe(Effect.map(([row]) => row))
        )
        expect(seen?.holder).toBe(seen?.me)
      })
    )

    it.effect(
      "a held Drive lock does not block it on the same connection",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const result = yield* withUserLock(user, (locked) =>
            transaction(
              (session) =>
                session
                  .queryRows<RowDataPacket & { holder: unknown }>(
                    "SELECT IS_USED_LOCK(?) AS holder",
                    [driveLockName(user)]
                  )
                  .pipe(Effect.map(([row]) => row?.holder)),
              locked
            )
          )
          expect(result).not.toBeNull()
          expect(yield* awaitCatalogFree).toBeNull()
          expect(yield* holder(driveLockName(user))).toBeNull()
        })
    )
  })

  layer(TestDatabase, { timeout: "120 seconds" })(
    "Drive.withUserLock",
    (it) => {
      it.effect("fails fast while a sync holds the lock, then frees it", () =>
        Effect.gen(function* () {
          const held = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const fiber = yield* withUserLock(user, () =>
            Deferred.succeed(held, undefined).pipe(
              Effect.andThen(Deferred.await(release))
            )
          ).pipe(Effect.forkChild)
          yield* Deferred.await(held)
          const busy = yield* withUserLock(user, () => Effect.void).pipe(
            Effect.flip
          )
          expect(busy).toBeInstanceOf(LockBusyError)
          expect((busy as LockBusyError).lock).toBe(`drive:${user}`)
          // Another user's sync is not excluded.
          yield* withUserLock(`${user}-other`, () => Effect.void)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(fiber)
          yield* withUserLock(user, () => Effect.void)
        })
      )
    }
  )

  layer(TestDatabase, { timeout: "120 seconds" })("requireAccessible", (it) => {
    it.effect("fails with NotFoundError for an item the user can't see", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const error = yield* transaction((session) =>
          requireAccessible(session, "nobody", "media", "missing")
        ).pipe(Effect.flip)
        expect(error).toBeInstanceOf(NotFoundError)
      })
    )
  })
})
