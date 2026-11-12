import { randomUUID } from "node:crypto"
import type { RowDataPacket } from "mysql2/promise"
import { Effect, Fiber, Semaphore } from "effect"
import { Database } from "@/effect/database"
import type { DatabaseSession } from "@/effect/database"
import type { DatabaseError } from "@/effect/errors"
import { publicErrorMessage } from "./http-errors"
import type { SyncRun } from "./types"

export type SyncProgress = Pick<
  SyncRun,
  "phase" | "folders_scanned" | "files_found" | "files_saved" | "files_total"
>

const columns =
  "run_id,origin,status,phase,folders_scanned,files_found,files_saved,files_total,item_count,error,started_at,finished_at"

// The newest run per user. The Drive lock is held for the whole run, so a
// "running" row without that lock means the process stopped mid-sync.
// IS_USED_LOCK answers for the whole server, whichever connection asks.
export const status = Effect.fn("SyncProgress.status")(function* (
  userId: string
): Effect.fn.Return<SyncRun | null, DatabaseError, Database> {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
  const database = yield* Database
  const [run] = yield* database.queryRows<
    SyncRun & { held: number } & RowDataPacket
  >(
    "syncProgress.status",
    `SELECT ${columns},IS_USED_LOCK(?) IS NOT NULL AS held FROM drive_sync_run WHERE user_id=?`,
    [`drive:${userId}`, userId]
  )
  if (!run) return null
  const { held, ...current } = run
  if (current.status === "running" && !Number(held))
    return {
      ...current,
      status: "failed",
      error: "Sync was interrupted. Run it again.",
    }
  return current
})

// A run someone asked to watch is shown to them, even if a webhook started it.
export const claim = Effect.fn("SyncProgress.claim")(function* (
  userId: string
) {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
  const database = yield* Database
  yield* database.execute(
    "syncProgress.claim",
    "UPDATE drive_sync_run SET origin='manual' WHERE user_id=? AND status='running'",
    [userId]
  )
})

/** A started run: report progress as it comes, then succeed or fail once. */
export interface SyncRunHandle {
  readonly started: SyncRun
  /** Records progress; written to the row shortly after, never waited for. */
  readonly report: (progress: Partial<SyncProgress>) => Effect.Effect<void>
  readonly succeed: (count: number) => Effect.Effect<void>
  readonly fail: (error: unknown) => Effect.Effect<void>
}

// Progress rows are written outside the catalog transaction so that other
// requests can read them while the sync is still uncommitted: through the
// `Database` service's own pool, not `connection`. Progress updates are best
// effort and never awaited: a sync already holds a connection, so waiting for
// another one could deadlock when the pool is exhausted. The final status
// uses the sync's own `connection` once its transaction has ended, and late
// progress updates cannot overwrite a finished run.
export const start = Effect.fn("SyncProgress.start")(function* (
  connection: DatabaseSession,
  userId: string,
  origin: SyncRun["origin"]
): Effect.fn.Return<SyncRunHandle, DatabaseError, Database> {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
  const database = yield* Database
  const runId = randomUUID()
  yield* connection.execute(
    `INSERT INTO drive_sync_run(user_id,run_id,origin,status,phase,folders_scanned,files_found,files_saved,files_total,item_count,error,started_at,updated_at,finished_at)
    VALUES (?,?,?,'running','scanning',0,0,0,0,NULL,NULL,NOW(3),NOW(3),NULL)
    ON DUPLICATE KEY UPDATE run_id=VALUES(run_id),origin=VALUES(origin),status='running',phase='scanning',folders_scanned=0,files_found=0,files_saved=0,files_total=0,item_count=NULL,error=NULL,started_at=NOW(3),updated_at=NOW(3),finished_at=NULL`,
    [userId, runId, origin]
  )
  const [started] = yield* connection.queryRows<SyncRun & RowDataPacket>(
    `SELECT ${columns} FROM drive_sync_run WHERE user_id=?`,
    [userId]
  )
  let latest: SyncProgress = {
    phase: "scanning",
    folders_scanned: 0,
    files_found: 0,
    files_saved: 0,
    files_total: 0,
  }
  let written = latest
  let timer: Fiber.Fiber<void> | undefined
  // One write at a time, in order, so an older snapshot never lands last.
  const writing = Semaphore.makeUnsafe(1)
  const flush = Effect.suspend(() => {
    timer = undefined
    if (written === latest) return Effect.void
    const next = (written = latest)
    return database
      .execute(
        "syncProgress.report",
        "UPDATE drive_sync_run SET phase=?,folders_scanned=?,files_found=?,files_saved=?,files_total=?,updated_at=NOW(3) WHERE user_id=? AND run_id=? AND status='running'",
        [
          next.phase,
          next.folders_scanned,
          next.files_found,
          next.files_saved,
          next.files_total,
          userId,
          runId,
        ]
      )
      .pipe(Effect.ignore, writing.withPermits(1))
  })
  // Write at most a few times per second; the browser polls once a second.
  const report = (progress: Partial<SyncProgress>) =>
    Effect.suspend(() => {
      latest = { ...latest, ...progress }
      if (timer) return Effect.void
      return Effect.sleep("250 millis").pipe(
        Effect.andThen(flush),
        Effect.forkDetach,
        Effect.map((fiber) => {
          timer = fiber
        })
      )
    })
  const finish = (
    runStatus: "succeeded" | "failed",
    detail: { count?: number; error?: unknown }
  ) =>
    Effect.suspend(() => {
      const pending = timer
      timer = undefined
      return (pending ? Fiber.interrupt(pending) : Effect.void).pipe(
        Effect.andThen(
          connection.execute(
            "UPDATE drive_sync_run SET status=?,phase='done',folders_scanned=?,files_found=?,files_saved=?,files_total=?,item_count=?,error=?,updated_at=NOW(3),finished_at=NOW(3) WHERE user_id=? AND run_id=?",
            [
              runStatus,
              latest.folders_scanned,
              latest.files_found,
              latest.files_saved,
              latest.files_total,
              detail.count ?? null,
              runStatus === "failed"
                ? publicErrorMessage(
                    detail.error,
                    "Sync failed. Please try again."
                  )
                : null,
              userId,
              runId,
            ]
          )
        ),
        Effect.ignore
      )
    })
  return {
    started: { ...started } as SyncRun,
    report,
    succeed: (count) => finish("succeeded", { count }),
    fail: (error) => finish("failed", { error }),
  }
})
