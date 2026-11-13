import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import type { RowDataPacket } from "mysql2/promise"
import { Database } from "@/effect/database"
import type { DatabaseSession, LockedSession } from "@/effect/database"
import { DatabaseError, LockBusyError, NotFoundError } from "@/effect/errors"
import { runTracedAppEffect } from "@/effect/runtime.server"
import {
  legacyConnection,
  legacySession,
  lockedSessionOf,
  type LegacyConnection,
  type SessionConnection,
} from "./database.server"
import { SYNC_BUSY_MESSAGE } from "./http-errors"
import type { DriveFile } from "./drive.server"

// MySQL named locks are server-wide, so these names also exclude other
// containers, including ones of earlier releases. Never change them.
export const CATALOG_LOCK = "mediabinder-catalog"
export const driveLockName = (userId: string) => `drive:${userId}`

/**
 * Serializes catalog merges and edits: holds the catalog lock (waiting up to
 * 30 s) and runs `body` in a transaction on the same connection, which
 * commits when it succeeds and rolls back when it fails. Google scans happen
 * before this short lock.
 *
 * Pass the Drive lock's session as `existing` to use its connection rather
 * than reserve another; then the lock is released but the connection stays
 * the caller's.
 */
export const transaction = Effect.fn("Catalog.transaction")(function* <
  TResult,
  TError,
  TRequirements,
>(
  body: (
    session: DatabaseSession
  ) => Effect.Effect<TResult, TError, TRequirements>,
  existing?: LockedSession
): Effect.fn.Return<
  TResult,
  DatabaseError | LockBusyError | TError,
  TRequirements | Database
> {
  if (existing)
    return yield* Effect.acquireUseRelease(
      existing
        .queryRows<RowDataPacket>("SELECT GET_LOCK(?,30) AS acquired", [
          CATALOG_LOCK,
        ])
        .pipe(
          Effect.flatMap(([row]) =>
            row?.acquired === 1
              ? Effect.void
              : Effect.fail(
                  new LockBusyError({
                    operation: "catalog.transaction",
                    lock: CATALOG_LOCK,
                  })
                )
          )
        ),
      () => existing.transaction(body(existing)),
      () =>
        Effect.ignore(
          existing.queryRows("SELECT RELEASE_LOCK(?)", [CATALOG_LOCK])
        )
    )
  const database = yield* Database
  return yield* database.withNamedLock(
    "catalog.transaction",
    CATALOG_LOCK,
    { timeoutSeconds: 30 },
    (session) => session.transaction(body(session))
  )
})

/**
 * Holds one user's sync lock for the whole of `use`, on one reserved
 * connection. Fails at once with `LockBusyError` if a sync already holds it
 * (this process, another container or an older release).
 */
export const withUserLock = Effect.fn("Drive.withUserLock")(function* <
  TResult,
  TError,
  TRequirements,
>(
  userId: string,
  use: (session: LockedSession) => Effect.Effect<TResult, TError, TRequirements>
): Effect.fn.Return<
  TResult,
  DatabaseError | LockBusyError | TError,
  TRequirements | Database
> {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
  const database = yield* Database
  return yield* database.withNamedLock(
    "drive.withUserLock",
    driveLockName(userId),
    { timeoutSeconds: 0 },
    use
  )
})

/** Fails with NotFoundError unless the user can see the media item or set. */
export const requireAccessible = Effect.fn("Catalog.requireAccessible")(
  function* (
    session: DatabaseSession,
    userId: string,
    kind: "media" | "set",
    target: string
  ) {
    const sql =
      kind === "media"
        ? "SELECT catalog_id AS id FROM media WHERE catalog_id=? AND user_id=? AND available=TRUE LIMIT 1"
        : `SELECT s.id FROM media_set s WHERE s.id=? AND (s.user_id=? OR EXISTS(SELECT 1 FROM catalog_set_member sm JOIN media m ON m.catalog_id=sm.catalog_id WHERE sm.set_id=s.id AND m.user_id=? AND m.available=TRUE))`
    const items = yield* session.queryRows(
      sql,
      kind === "media" ? [target, userId] : [target, userId, userId]
    )
    if (!items.length) return yield* new NotFoundError({ resource: "Item" })
  }
)

export const markEntryCataloged = Effect.fn("Catalog.markCataloged")(function* (
  session: DatabaseSession,
  target: string
) {
  yield* session.execute(
    "UPDATE catalog SET cataloged_at=COALESCE(cataloged_at,NOW(3)) WHERE id=?",
    [target]
  )
})

// Merge metadata conservatively. A previously curated entry wins the name/date;
// tags, memberships and posts are combined. Old entries retain their metadata.
const merge = Effect.fnUntraced(function* (
  session: DatabaseSession,
  ids: string[]
) {
  const entries = yield* session.queryRows<RowDataPacket>(
    `SELECT * FROM catalog WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY cataloged_at IS NULL,cataloged_at,id`,
    ids
  )
  const winner = entries[0]
  let tags: string[] = winner.tags
  for (const entry of entries.slice(1)) {
    tags = [...new Set([...tags, ...entry.tags])]
    yield* session.execute("UPDATE media SET catalog_id=? WHERE catalog_id=?", [
      winner.id,
      entry.id,
    ])
    yield* session.execute(
      "INSERT IGNORE INTO catalog_set_member(set_id,catalog_id) SELECT set_id,? FROM catalog_set_member WHERE catalog_id=?",
      [winner.id, entry.id]
    )
    yield* session.execute(
      "DELETE FROM catalog_set_member WHERE catalog_id=?",
      [entry.id]
    )
    yield* session.execute("UPDATE post SET catalog_id=? WHERE catalog_id=?", [
      winner.id,
      entry.id,
    ])
    yield* session.execute(
      "UPDATE catalog_identity SET catalog_id=? WHERE catalog_id=?",
      [winner.id, entry.id]
    )
    yield* session.execute("UPDATE catalog SET merged_into=? WHERE id=?", [
      winner.id,
      entry.id,
    ])
  }
  yield* session.execute("UPDATE catalog SET tags=? WHERE id=?", [
    JSON.stringify(tags),
    winner.id,
  ])
  return winner.id as string
})

/** Finds or creates the catalog entry for a Drive file, merging duplicates. */
export const resolve = Effect.fn("Catalog.resolve")(function* (
  session: DatabaseSession,
  file: DriveFile
) {
  const checksum = Schema.decodeUnknownOption(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
  )(file.sha256Checksum?.toLowerCase())
  const sha = checksum._tag === "Some" ? checksum.value : undefined
  const hashKey = sha ? `sha256:${sha}` : null
  const driveKey = `drive:${file.id}`
  const matches = yield* session.queryRows<RowDataPacket>(
    `SELECT DISTINCT c.* FROM catalog c WHERE c.merged_into IS NULL AND (
      c.id IN (SELECT catalog_id FROM catalog_identity WHERE identity_key IN (?,?)) OR
      c.id IN (SELECT catalog_id FROM media WHERE BINARY drive_id=BINARY ?))`,
    [driveKey, hashKey ?? driveKey, file.id]
  )
  // Replacing a Drive file's bytes creates a new entry, rather than giving new
  // content the old file's curation. Missing checksums never match other files.
  const candidates = matches.filter(
    (c) => !hashKey || !c.sha256 || c.sha256 === sha
  )
  let target: string
  if (candidates.length)
    target = yield* merge(
      session,
      candidates.map((c) => c.id)
    )
  else {
    target = randomUUID()
    const captured = file.imageMediaMetadata?.time
      ?.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3")
      .replace(" ", "T")
    const created =
      captured && !Number.isNaN(Date.parse(captured))
        ? new Date(captured)
        : new Date(file.createdTime)
    yield* session.execute(
      "INSERT INTO catalog(id,display_name,tags,created_at,sha256) VALUES (?,?,?,?,?)",
      [
        target,
        file.name.replace(/\.[^.]+$/, ""),
        "[]",
        created,
        hashKey ? sha! : null,
      ]
    )
  }
  if (hashKey)
    yield* session.execute("UPDATE catalog SET sha256=? WHERE id=?", [
      sha!,
      target,
    ])
  for (const key of [driveKey, ...(hashKey ? [hashKey] : [])])
    yield* session.execute(
      "INSERT INTO catalog_identity(identity_key,catalog_id) VALUES (?,?) ON DUPLICATE KEY UPDATE catalog_id=VALUES(catalog_id)",
      [key, target]
    )
  return target
})

// Facades for callers that still hold a mysql2 connection: library.server.ts
// mutations, drive.server.ts sync and reconcile, and the shared-catalog test.
// Remove each with its last caller (layers 16 and 18-19).

const promiseWork = <TResult>(work: () => Promise<TResult>) =>
  Effect.tryPromise({ try: work, catch: (error) => error }).pipe(
    // mysql2 statements can't be cancelled; let them finish before the
    // transaction rolls back or the lock is released.
    Effect.uninterruptible
  )

export function catalogTransaction<A>(
  work: (connection: LegacyConnection) => Promise<A>,
  existing?: SessionConnection<LockedSession>
) {
  return runTracedAppEffect(
    transaction(
      (session) => promiseWork(() => work(legacyConnection(session))),
      existing && lockedSessionOf(existing)
    )
  )
}

export function accessible(
  connection: LegacyConnection,
  userId: string,
  kind: "media" | "set",
  target: string
) {
  return runTracedAppEffect(
    requireAccessible(
      legacySession("catalog.requireAccessible", connection),
      userId,
      kind,
      target
    )
  )
}

export function markCataloged(connection: LegacyConnection, target: string) {
  return runTracedAppEffect(
    markEntryCataloged(
      legacySession("catalog.markCataloged", connection),
      target
    )
  )
}

export function resolveCatalog(connection: LegacyConnection, file: DriveFile) {
  return runTracedAppEffect(
    resolve(legacySession("catalog.resolve", connection), file)
  )
}

// A busy lock keeps today's message for callers that match on it: the manual
// sync (which joins the running one) and the worker's recorded error.
export function withDriveLock<A>(
  userId: string,
  work: (connection: SessionConnection<LockedSession>) => Promise<A>
) {
  return runTracedAppEffect(
    withUserLock(userId, (session) =>
      promiseWork(() => work(legacyConnection(session)))
    ).pipe(
      Effect.catch((error) =>
        Effect.fail(
          error instanceof LockBusyError ? new Error(SYNC_BUSY_MESSAGE) : error
        )
      )
    )
  )
}
