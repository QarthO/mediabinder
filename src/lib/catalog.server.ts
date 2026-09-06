import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import type { PoolConnection, RowDataPacket } from "mysql2/promise"
import { pool } from "./database.server"
import { runServer } from "@/effect/runtime.server"
import type { DriveFile } from "./drive.server"

// Serialize catalog merges and edits. Google scans happen before this short lock.
export function catalogTransaction<A>(
  work: (connection: PoolConnection) => Promise<A>,
  existing?: PoolConnection
) {
  return runServer(
    Effect.acquireUseRelease(
      existing
        ? Effect.succeed(existing)
        : Effect.tryPromise(() => pool.getConnection()),
      (connection) =>
        Effect.tryPromise(async () => {
          const [lock] = await connection.query<RowDataPacket[]>(
            "SELECT GET_LOCK('mediabinder-catalog',30) AS acquired"
          )
          if (lock[0].acquired !== 1)
            throw new Error("Catalog is busy. Please retry.")
          await connection.beginTransaction()
          return connection
        }).pipe(
          Effect.flatMap(() =>
            Effect.tryPromise({
              try: () => work(connection),
              catch: (error) => error,
            })
          ),
          Effect.tap(() => Effect.tryPromise(() => connection.commit())),
          Effect.onError(() =>
            Effect.tryPromise(() => connection.rollback()).pipe(Effect.ignore)
          )
        ),
      (connection) =>
        Effect.tryPromise(() =>
          connection.query("SELECT RELEASE_LOCK('mediabinder-catalog')")
        ).pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.sync(() => {
              if (!existing) connection.release()
            })
          )
        )
    )
  )
}

export async function accessible(
  connection: PoolConnection,
  userId: string,
  kind: "media" | "set",
  target: string
) {
  const sql =
    kind === "media"
      ? "SELECT catalog_id AS id FROM media WHERE catalog_id=? AND user_id=? AND available=TRUE LIMIT 1"
      : `SELECT s.id FROM media_set s WHERE s.id=? AND (s.user_id=? OR EXISTS(SELECT 1 FROM catalog_set_member sm JOIN media m ON m.catalog_id=sm.catalog_id WHERE sm.set_id=s.id AND m.user_id=? AND m.available=TRUE))`
  const [items] = await connection.query<RowDataPacket[]>(
    sql,
    kind === "media" ? [target, userId] : [target, userId, userId]
  )
  if (!items.length) throw new Response("Item not found.", { status: 404 })
}

export async function markCataloged(
  connection: PoolConnection,
  target: string
) {
  await connection.execute(
    "UPDATE catalog SET cataloged_at=COALESCE(cataloged_at,NOW(3)) WHERE id=?",
    [target]
  )
}

// Merge metadata conservatively. A previously curated entry wins the name/date;
// tags, memberships and posts are combined. Old entries retain their metadata.
async function merge(connection: PoolConnection, ids: string[]) {
  const [entries] = await connection.query<RowDataPacket[]>(
    `SELECT * FROM catalog WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY cataloged_at IS NULL,cataloged_at,id`,
    ids
  )
  const winner = entries[0]
  for (const entry of entries.slice(1)) {
    winner.tags = [...new Set([...winner.tags, ...entry.tags])]
    await connection.execute(
      "UPDATE media SET catalog_id=? WHERE catalog_id=?",
      [winner.id, entry.id]
    )
    await connection.execute(
      "INSERT IGNORE INTO catalog_set_member(set_id,catalog_id) SELECT set_id,? FROM catalog_set_member WHERE catalog_id=?",
      [winner.id, entry.id]
    )
    await connection.execute(
      "DELETE FROM catalog_set_member WHERE catalog_id=?",
      [entry.id]
    )
    await connection.execute(
      "UPDATE post SET catalog_id=? WHERE catalog_id=?",
      [winner.id, entry.id]
    )
    await connection.execute(
      "UPDATE catalog_identity SET catalog_id=? WHERE catalog_id=?",
      [winner.id, entry.id]
    )
    await connection.execute("UPDATE catalog SET merged_into=? WHERE id=?", [
      winner.id,
      entry.id,
    ])
  }
  await connection.execute("UPDATE catalog SET tags=? WHERE id=?", [
    JSON.stringify(winner.tags),
    winner.id,
  ])
  return winner.id as string
}

export async function resolveCatalog(
  connection: PoolConnection,
  file: DriveFile
) {
  const checksum = Schema.decodeUnknownOption(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
  )(file.sha256Checksum?.toLowerCase())
  const sha = checksum._tag === "Some" ? checksum.value : undefined
  const hashKey = sha ? `sha256:${sha}` : null
  const driveKey = `drive:${file.id}`
  const [matches] = await connection.query<RowDataPacket[]>(
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
    target = await merge(
      connection,
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
    await connection.execute(
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
    await connection.execute("UPDATE catalog SET sha256=? WHERE id=?", [
      sha!,
      target,
    ])
  for (const key of [driveKey, ...(hashKey ? [hashKey] : [])])
    await connection.execute(
      "INSERT INTO catalog_identity(identity_key,catalog_id) VALUES (?,?) ON DUPLICATE KEY UPDATE catalog_id=VALUES(catalog_id)",
      [key, target]
    )
  return target
}

export function withDriveLock<A>(
  userId: string,
  work: (connection: PoolConnection) => Promise<A>
) {
  return runServer(
    Effect.acquireUseRelease(
      Effect.tryPromise(() => pool.getConnection()),
      (connection) =>
        Effect.tryPromise({
          try: async () => {
            const [lock] = await connection.query<RowDataPacket[]>(
              "SELECT GET_LOCK(?,0) AS acquired",
              [`drive:${userId}`]
            )
            if (lock[0].acquired !== 1)
              throw new Error("A sync is already running. Try again shortly.")
            return work(connection)
          },
          catch: (error) => error,
        }),
      (connection) =>
        Effect.tryPromise(() =>
          connection.query("SELECT RELEASE_LOCK(?)", [`drive:${userId}`])
        ).pipe(
          Effect.ignore,
          Effect.andThen(Effect.sync(() => connection.release()))
        )
    )
  )
}
