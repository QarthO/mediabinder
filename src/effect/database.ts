import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Redacted,
  Scope,
  ScopedCache,
} from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import type { Connection } from "effect/sql/SqlConnection"
import { isSqlError } from "effect/sql/SqlError"
import type { SqlError } from "effect/sql/SqlError"
import { databaseOptions } from "@/lib/config"
import { DatabaseError, LockBusyError } from "./errors"

type QueryValue = boolean | Buffer | Date | null | number | string

/**
 * Statements that run on one particular connection: a transaction's, or the
 * one holding a named lock.
 */
export interface DatabaseSession {
  readonly execute: (
    sql: string,
    values?: Array<QueryValue>
  ) => Effect.Effect<ResultSetHeader, DatabaseError>
  readonly queryRows: <TRow extends RowDataPacket>(
    sql: string,
    values?: Array<QueryValue>
  ) => Effect.Effect<ReadonlyArray<TRow>, DatabaseError>
}

/**
 * What `withNamedLock` hands to its body. Every statement runs on the
 * connection that holds the lock, so it is the only way to run work "under"
 * the lock; the `Database` service's own methods use other pool connections.
 */
export interface LockedSession extends DatabaseSession {
  /**
   * Runs `body` between BEGIN and COMMIT on the lock's connection, rolling
   * back if it fails or is interrupted. Statements must go through this
   * session, not the service.
   */
  readonly transaction: <TResult, TError, TRequirements>(
    body: Effect.Effect<TResult, TError, TRequirements>
  ) => Effect.Effect<TResult, DatabaseError | TError, TRequirements>
  /**
   * Runs SQL with several statements (migration files) in one text-protocol
   * call. Not for values from users: nothing is bound.
   */
  readonly script: (sql: string) => Effect.Effect<void, DatabaseError>
}

export class Database extends Context.Service<
  Database,
  {
    readonly execute: (
      operation: string,
      sql: string,
      values?: Array<QueryValue>
    ) => Effect.Effect<ResultSetHeader, DatabaseError>
    readonly queryRows: <TRow extends RowDataPacket>(
      operation: string,
      sql: string,
      values?: Array<QueryValue>
    ) => Effect.Effect<ReadonlyArray<TRow>, DatabaseError>
    readonly transaction: <TResult, TError, TRequirements>(
      operation: string,
      run: (
        transaction: DatabaseSession
      ) => Effect.Effect<TResult, TError, TRequirements>
    ) => Effect.Effect<TResult, DatabaseError | TError, TRequirements>
    /**
     * Holds the MySQL `GET_LOCK(name)` for the duration of `use`, on one
     * reserved connection, and releases it when `use` ends however it ends.
     * Fails with `LockBusyError` if the lock isn't free within
     * `timeoutSeconds` (0 tries once). Locks are server-wide, so containers
     * of other releases exclude each other too.
     */
    readonly withNamedLock: <TResult, TError, TRequirements>(
      operation: string,
      name: string,
      options: { readonly timeoutSeconds: number },
      use: (
        session: LockedSession
      ) => Effect.Effect<TResult, TError, TRequirements>
    ) => Effect.Effect<
      TResult,
      DatabaseError | LockBusyError | TError,
      TRequirements
    >
  }
>()("mediabinder/Database") {}

/**
 * Connection settings for the Effect client, from the same DB_* /
 * DATABASE_URL variables as the mysql2 `pool`.
 *
 * `MysqlClient` builds its pool from `poolConfig` spread under its own
 * fields, so `dateStrings` and `timezone` reach mysql2 and DATETIME columns
 * keep coming back as strings, exactly as from `pool`. Its URL mode ignores
 * `poolConfig`, so a DATABASE_URL is split into fields here.
 */
export function databaseClientConfig(
  maxConnections: number,
  options: ReturnType<typeof databaseOptions> = databaseOptions()
): MysqlClient.MysqlClientConfig {
  const poolConfig = {
    connectTimeout: 5_000,
    timezone: "Z",
    dateStrings: true,
  }
  if (options.uri !== undefined) {
    const url = new URL(options.uri)
    const extra: Record<string, unknown> = {}
    // Like mysql2, which reads options such as `ssl` from the query string.
    url.searchParams.forEach((value, key) => {
      try {
        extra[key] = JSON.parse(value)
      } catch {
        extra[key] = value
      }
    })
    return {
      host: decodeURIComponent(url.hostname),
      port: url.port ? Number(url.port) : 3306,
      database: decodeURIComponent(url.pathname.slice(1)),
      username: decodeURIComponent(url.username),
      password: Redacted.make(decodeURIComponent(url.password)),
      maxConnections,
      poolConfig: { ...extra, ...poolConfig },
    }
  }
  return {
    host: options.host,
    port: options.port,
    database: options.database,
    username: options.user,
    password: Redacted.make(options.password),
    maxConnections,
    poolConfig,
  }
}

/**
 * Connections: the legacy mysql2 `pool` (Better Auth and modules not yet
 * converted) allows 8. This client has two pools of its own. Queries and
 * transactions share 4. Lock sessions (`withNamedLock`) come from a separate
 * pool of 8, because a session holds its connection for as long as its lock,
 * which for a Drive sync is the whole run, and a sync waits on queries (its
 * progress writes) before it can finish. Locks sharing the query pool would
 * deadlock once as many syncs ran as it has connections. Each pool opens
 * connections only on demand, so the ceiling for a web process is 20 of
 * MySQL's default 151, and the Drive worker process adds the same again.
 */
const QUERY_POOL_SIZE = 4
const LOCK_POOL_SIZE = 8

const globalDatabase = globalThis as typeof globalThis & {
  mediabinderDatabaseClients?: Record<
    string,
    Effect.Effect<SqlClient.SqlClient, SqlError>
  >
}

// Connects on the first query, so effects that never touch MySQL (thumbnails,
// runtime construction) don't wait on it. A failed connection is retried
// after a second; MysqlClient doesn't end a pool whose first probe fails, so
// retries stay spaced out.
const makeDatabaseClient = (maxConnections: number) =>
  Effect.gen(function* () {
    const reactivity = yield* Reactivity.Reactivity
    const clients = yield* ScopedCache.makeWith({
      lookup: () =>
        Effect.suspend(() =>
          MysqlClient.make(databaseClientConfig(maxConnections))
        ).pipe(Effect.provideService(Reactivity.Reactivity, reactivity)),
      capacity: 1,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? Duration.infinity : Duration.seconds(1),
    })
    return ScopedCache.get(clients, "mysql")
  })

/** The process's MySQL clients, connecting on first use. */
export class DatabaseClient extends Context.Service<
  DatabaseClient,
  {
    readonly client: Effect.Effect<SqlClient.SqlClient, SqlError>
    /** For lock sessions only; see the pool sizes above. */
    readonly lockClient: Effect.Effect<SqlClient.SqlClient, SqlError>
  }
>()("mediabinder/DatabaseClient") {}

export const DatabaseClientLive = Layer.effect(
  DatabaseClient,
  Effect.gen(function* () {
    if (!import.meta.hot)
      return DatabaseClient.of({
        client: yield* makeDatabaseClient(QUERY_POOL_SIZE),
        lockClient: yield* makeDatabaseClient(LOCK_POOL_SIZE),
      })
    // Vite program reloads rebuild the app runtime without disposing the old
    // one, so development keeps one pool of each for the process, like `pool`.
    const clients = (globalDatabase.mediabinderDatabaseClients ??= {
      client: yield* makeDatabaseClient(QUERY_POOL_SIZE).pipe(
        Scope.provide(Scope.makeUnsafe())
      ),
      lockClient: yield* makeDatabaseClient(LOCK_POOL_SIZE).pipe(
        Scope.provide(Scope.makeUnsafe())
      ),
    })
    return DatabaseClient.of({
      client: clients.client,
      lockClient: clients.lockClient,
    })
  })
).pipe(Layer.provide(Reactivity.layer))

export const DatabaseLive = Layer.effect(
  Database,
  Effect.map(DatabaseClient, ({ client, lockClient }) =>
    makeDatabase(client, lockClient)
  )
).pipe(Layer.provideMerge(DatabaseClientLive))

export function makeDatabase(
  client: Effect.Effect<SqlClient.SqlClient, SqlError>,
  lockClient: Effect.Effect<SqlClient.SqlClient, SqlError> = client
) {
  const withClient = <TResult, TError, TRequirements>(
    operation: string,
    use: (
      sql: SqlClient.SqlClient
    ) => Effect.Effect<TResult, TError, TRequirements>
  ) =>
    client.pipe(
      Effect.mapError((cause) => DatabaseError.make({ operation, cause })),
      Effect.flatMap(use)
    )
  // Statements inside `transaction` join its connection through Effect SQL's
  // transaction context, including nested transactions as savepoints.
  const execute = (
    operation: string,
    statement: string,
    values: Array<QueryValue> = []
  ) =>
    withClient(operation, (sql) =>
      databaseQuery(
        operation,
        sql.unsafe(statement, values).raw as Effect.Effect<
          ResultSetHeader,
          SqlError
        >
      )
    )
  // Reads use mysql2's text protocol; MySQL rejects numeric `LIMIT ?` binds
  // in prepared statements.
  const queryRows = <TRow extends RowDataPacket>(
    operation: string,
    statement: string,
    values: Array<QueryValue> = []
  ) =>
    withClient(operation, (sql) =>
      databaseQuery(operation, sql.unsafe<TRow>(statement, values).unprepared)
    )

  // The same two calls on one reserved connection.
  const connectionSession = (
    operation: string,
    connection: Connection
  ): LockedSession => {
    const execute: LockedSession["execute"] = (statement, values = []) =>
      databaseQuery(
        operation,
        connection.executeRaw(statement, values) as Effect.Effect<
          ResultSetHeader,
          SqlError
        >
      )
    const queryRows: LockedSession["queryRows"] = <TRow extends RowDataPacket>(
      statement: string,
      values: Array<QueryValue> = []
    ) =>
      databaseQuery(
        operation,
        connection.executeUnprepared(
          statement,
          values,
          undefined
        ) as Effect.Effect<ReadonlyArray<TRow>, SqlError>
      )
    const control = (statement: string) =>
      databaseQuery(
        operation,
        connection.executeUnprepared(statement, [], undefined)
      )
    return {
      execute,
      queryRows,
      script: (sql) => Effect.asVoid(control(sql)),
      transaction: (body) =>
        control("BEGIN").pipe(
          Effect.andThen(body),
          Effect.tap(control("COMMIT")),
          // Also runs when interrupted; a failed COMMIT is rolled back too.
          Effect.onError(() => Effect.ignore(control("ROLLBACK")))
        ),
    }
  }

  return Database.of({
    execute: (operation, statement, values) =>
      execute(operation, statement, values).pipe(
        Effect.withSpan(`db.${operation}`)
      ),
    queryRows: <TRow extends RowDataPacket>(
      operation: string,
      statement: string,
      values?: Array<QueryValue>
    ) =>
      queryRows<TRow>(operation, statement, values).pipe(
        Effect.withSpan(`db.${operation}`)
      ),
    transaction: (operation, run) =>
      withClient(operation, (sql) =>
        sql
          .withTransaction(
            run({
              execute: (statement, values) =>
                execute(operation, statement, values),
              queryRows: (statement, values) =>
                queryRows(operation, statement, values),
            })
          )
          .pipe(
            Effect.mapError((error) =>
              isSqlError(error)
                ? DatabaseError.make({ operation, cause: error })
                : error
            )
          )
      ).pipe(Effect.withSpan(`db.${operation}`)),
    withNamedLock: (operation, name, { timeoutSeconds }, use) =>
      Effect.gen(function* () {
        const sql = yield* lockClient.pipe(
          Effect.mapError((cause) => DatabaseError.make({ operation, cause }))
        )
        const connection = yield* sql.reserve.pipe(
          Effect.mapError((cause) => DatabaseError.make({ operation, cause }))
        )
        const session = connectionSession(operation, connection)
        const [row] = yield* session.queryRows<RowDataPacket>(
          "SELECT GET_LOCK(?, ?) AS acquired",
          [name, timeoutSeconds]
        )
        // GET_LOCK is NULL on an error, 0 on a timeout.
        if (row?.acquired !== 1)
          return yield* new LockBusyError({ operation, lock: name })
        // Finalizers run last-in-first-out: the lock is released before the
        // connection goes back to the pool.
        yield* Effect.addFinalizer(() =>
          Effect.ignore(session.queryRows("SELECT RELEASE_LOCK(?)", [name]))
        )
        return yield* use(session)
      }).pipe(Effect.scoped, Effect.withSpan(`db.${operation}`)),
  })
}

function databaseQuery<TResult>(
  operation: string,
  query: Effect.Effect<TResult, SqlError>
): Effect.Effect<TResult, DatabaseError> {
  return query.pipe(
    Effect.mapError((cause) => DatabaseError.make({ operation, cause })),
    // mysql2 cannot cancel a running statement. Wait for active driver work
    // to settle before an interrupt can rollback or release its connection.
    Effect.uninterruptible
  )
}
