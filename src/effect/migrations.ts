import { readFile, readdir } from "node:fs/promises"
import { getMigrations } from "better-auth/db/migration"
import { Duration, Effect, Predicate, Schedule } from "effect"
import { Database } from "./database"
import { DatabaseError, MigrationError } from "./errors"

const directory = new URL("../../migrations/", import.meta.url)

const ledger =
  "CREATE TABLE IF NOT EXISTS schema_migration (name VARCHAR(255) PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))"

// Driver codes for a MySQL that is still starting or briefly unreachable.
const retryableCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST",
  "ER_CON_COUNT_ERROR",
])

function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof DatabaseError)) return false
  // SqlError { reason: ConnectionError | UnknownError { cause: mysql2 error } }
  const reason = Predicate.hasProperty(error.cause, "reason")
    ? error.cause.reason
    : undefined
  if (
    Predicate.hasProperty(reason, "_tag") &&
    reason._tag === "ConnectionError"
  )
    return true
  const cause = Predicate.hasProperty(reason, "cause")
    ? reason.cause
    : undefined
  return (
    Predicate.hasProperty(cause, "code") &&
    typeof cause.code === "string" &&
    retryableCodes.has(cause.code)
  )
}

/**
 * Brings the schema up to date: Better Auth's tables first, then each
 * `migrations/*.sql` file in name order that `schema_migration` doesn't list.
 * Holds `mediabinder-migrate` (shared with older containers, so a rolling
 * deploy never migrates twice at once) on the connection that runs the SQL.
 * Waits up to a minute for MySQL to accept connections.
 */
export const migrate = Effect.fn("Database.migrate")(
  function* () {
    const database = yield* Database
    return yield* database.withNamedLock(
      "migrate.lock",
      "mediabinder-migrate",
      { timeoutSeconds: 60 },
      Effect.fnUntraced(function* (session) {
        yield* Effect.tryPromise({
          // Loaded here: importing Better Auth validates the app's URL and
          // secrets, which tests that never migrate don't have.
          try: async () => {
            const { auth } = await import("@/lib/auth.server")
            return (await getMigrations(auth.options)).runMigrations()
          },
          catch: (cause) =>
            new MigrationError({
              message: "Better Auth migration failed",
              cause,
            }),
        }).pipe(Effect.withSpan("Database.migrate.auth"))
        yield* session.script(ledger)
        const names = yield* Effect.tryPromise({
          try: async () =>
            (await readdir(directory)).filter((n) => n.endsWith(".sql")).sort(),
          catch: (cause) =>
            new MigrationError({ message: "Could not read migrations", cause }),
        })
        let applied = 0
        for (const name of names) {
          const done = yield* session.queryRows(
            "SELECT name FROM schema_migration WHERE name=?",
            [name]
          )
          if (done.length) continue
          yield* applyOne(session, name)
          applied++
        }
        yield* Effect.log(
          `Database ready (${applied} application migrations applied)`
        )
        return applied
      })
    )
  },
  // MySQL can still be starting alongside the app.
  Effect.retry({
    schedule: Schedule.spaced(Duration.seconds(2)),
    times: 30,
    while: isConnectionFailure,
  })
)

// The file runs as one multi-statement call, so `;` inside a string or
// comment is no problem. DDL commits implicitly, so the ledger row is written
// only once the whole file has run; files must be safe to run again.
const applyOne = Effect.fn("Database.migrate.file")(function* (
  session: Parameters<Parameters<Database["Service"]["withNamedLock"]>[3]>[0],
  name: string
) {
  yield* Effect.annotateCurrentSpan("migration", name)
  yield* Effect.log(`Applying migration ${name}`)
  const sql = yield* Effect.tryPromise({
    try: () => readFile(new URL(name, directory), "utf8"),
    catch: (cause) =>
      new MigrationError({ message: `Could not read ${name}`, cause }),
  })
  yield* session
    .script(sql)
    .pipe(
      Effect.mapError(
        (cause) =>
          new MigrationError({ message: `Migration ${name} failed`, cause })
      )
    )
  yield* session.execute("INSERT INTO schema_migration (name) VALUES (?)", [
    name,
  ])
})
