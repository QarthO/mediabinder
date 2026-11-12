import { randomUUID } from "node:crypto"
import type { PoolConnection, RowDataPacket } from "mysql2/promise"
import { pool, rows } from "./database.server"
import { publicErrorMessage } from "./library-http"
import type { SyncRun } from "./types"

export type SyncProgress = Pick<
  SyncRun,
  "phase" | "folders_scanned" | "files_found" | "files_saved" | "files_total"
>

const columns =
  "run_id,origin,status,phase,folders_scanned,files_found,files_saved,files_total,item_count,error,started_at,finished_at"

// The newest run per user. The Drive lock is held for the whole run, so a
// "running" row without that lock means the process stopped mid-sync.
export async function syncStatus(userId: string): Promise<SyncRun | null> {
  const [run] = await rows<SyncRun & { held: number }>(
    `SELECT ${columns},IS_USED_LOCK(?) IS NOT NULL AS held FROM drive_sync_run WHERE user_id=?`,
    [`drive:${userId}`, userId]
  )
  if (!run) return null
  const { held, ...status } = run
  if (status.status === "running" && !Number(held))
    return {
      ...status,
      status: "failed",
      error: "Sync was interrupted. Run it again.",
    }
  return status
}

// A run someone asked to watch is shown to them, even if a webhook started it.
export async function claimSyncRun(userId: string) {
  await pool.execute(
    "UPDATE drive_sync_run SET origin='manual' WHERE user_id=? AND status='running'",
    [userId]
  )
}

// Progress rows are written outside the catalog transaction so that other
// requests can read them while the sync is still uncommitted. Progress updates
// are best effort and never awaited: a sync already holds a pool connection,
// so waiting for another one could deadlock when the pool is exhausted. The
// final status uses the sync's own connection once its transaction has ended,
// and late progress updates cannot overwrite a finished run.
export async function startSyncRun(
  connection: PoolConnection,
  userId: string,
  origin: SyncRun["origin"]
) {
  const runId = randomUUID()
  await connection.execute<RowDataPacket[]>(
    `INSERT INTO drive_sync_run(user_id,run_id,origin,status,phase,folders_scanned,files_found,files_saved,files_total,item_count,error,started_at,updated_at,finished_at)
    VALUES (?,?,?,'running','scanning',0,0,0,0,NULL,NULL,NOW(3),NOW(3),NULL)
    ON DUPLICATE KEY UPDATE run_id=VALUES(run_id),origin=VALUES(origin),status='running',phase='scanning',folders_scanned=0,files_found=0,files_saved=0,files_total=0,item_count=NULL,error=NULL,started_at=NOW(3),updated_at=NOW(3),finished_at=NULL`,
    [userId, runId, origin]
  )
  const [[started]] = await connection.query<(SyncRun & RowDataPacket)[]>(
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
  let writing: Promise<unknown> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  // Write at most a few times per second; the browser polls once a second.
  const flush = () => {
    timer = undefined
    if (written === latest) return
    const next = (written = latest)
    writing = writing
      .then(() =>
        pool.execute(
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
      )
      .catch(() => undefined)
    return writing
  }
  const finish = async (
    status: "succeeded" | "failed",
    detail: { count?: number; error?: unknown }
  ) => {
    clearTimeout(timer)
    await connection
      .execute(
        "UPDATE drive_sync_run SET status=?,phase='done',folders_scanned=?,files_found=?,files_saved=?,files_total=?,item_count=?,error=?,updated_at=NOW(3),finished_at=NOW(3) WHERE user_id=? AND run_id=?",
        [
          status,
          latest.folders_scanned,
          latest.files_found,
          latest.files_saved,
          latest.files_total,
          detail.count ?? null,
          status === "failed"
            ? publicErrorMessage(detail.error, "Sync failed. Please try again.")
            : null,
          userId,
          runId,
        ]
      )
      .catch(() => undefined)
  }
  return {
    started: { ...started } as SyncRun,
    report(progress: Partial<SyncProgress>) {
      latest = { ...latest, ...progress }
      timer ??= setTimeout(flush, 250)
    },
    succeed: (count: number) => finish("succeeded", { count }),
    fail: (error: unknown) => finish("failed", { error }),
  }
}
