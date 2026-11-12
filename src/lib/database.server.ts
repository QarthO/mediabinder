import mysql, {
  type FieldPacket,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise"
import { Effect } from "effect"
import type { DatabaseSession, LockedSession } from "@/effect/database"
import { DatabaseError } from "@/effect/errors"
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

/** The two mysql2 calls the unconverted modules make on a connection. */
export type LegacyConnection = Pick<PoolConnection, "execute" | "query">

const sessionOf = Symbol("mediabinder/legacyConnection/session")

/**
 * A `LegacyConnection` that runs on a lock session of the Database service:
 * what `catalogTransaction` and `withDriveLock` hand their Promise callers.
 */
export interface SessionConnection<
  TSession extends DatabaseSession = DatabaseSession,
> extends LegacyConnection {
  readonly [sessionOf]: TSession
}

/** The lock session behind a connection from `legacyConnection`. */
export const lockedSessionOf = (connection: SessionConnection<LockedSession>) =>
  connection[sessionOf]

/**
 * Presents a Database lock session or transaction as a mysql2 connection, for
 * unconverted callers. Remove it with the last such caller.
 */
export function legacyConnection<TSession extends DatabaseSession>(
  session: TSession
): SessionConnection<TSession> {
  const result = async <TResult>(
    use: Effect.Effect<TResult, DatabaseError>
  ): Promise<[TResult, FieldPacket[]]> => [await Effect.runPromise(use), []]
  const connection = {
    execute: (sql: string, values?: unknown[]) =>
      result(session.execute(sql, values as never)),
    query: (sql: string, values?: unknown[]) =>
      result(session.queryRows(sql, values as never)),
    [sessionOf]: session,
  }
  return connection as unknown as SessionConnection<TSession>
}

/**
 * Lets a converted module run its statements on a legacy mysql2 connection
 * that an unconverted caller holds, such as a transaction's or the one with
 * the Drive lock. Remove it with the last such caller.
 *
 * A connection from `legacyConnection` runs on its own session, so the
 * statements stay on the connection that holds the lock.
 */
export function legacySession(
  operation: string,
  connection: LegacyConnection
): DatabaseSession {
  if (sessionOf in connection)
    return (connection as SessionConnection)[sessionOf]
  const run = <TResult>(use: () => Promise<TResult>) =>
    Effect.tryPromise({
      try: use,
      catch: (cause) => DatabaseError.make({ operation, cause }),
    }).pipe(Effect.uninterruptible)
  return {
    execute: (sql, values = []) =>
      run(
        async () => (await connection.execute<ResultSetHeader>(sql, values))[0]
      ),
    queryRows: <TRow extends RowDataPacket>(
      sql: string,
      values: Parameters<DatabaseSession["execute"]>[1] = []
    ) =>
      run(
        async () =>
          (
            await connection.query<TRow[]>(sql, values)
          )[0] as ReadonlyArray<TRow>
      ),
  }
}
