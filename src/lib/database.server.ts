import mysql, {
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise"
import { Effect } from "effect"
import type { DatabaseSession } from "@/effect/database"
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

/**
 * Lets a converted module run its statements on a legacy mysql2 connection
 * that an unconverted caller holds, such as a transaction's or the one with
 * the Drive lock. Remove it with the last such caller.
 */
export function legacySession(
  operation: string,
  connection: Pick<PoolConnection, "execute" | "query">
): DatabaseSession {
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
