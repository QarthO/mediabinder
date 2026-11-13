import type { RowDataPacket } from "mysql2/promise"
import { Cause, Clock, Effect, Metric } from "effect"
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import { Database } from "@/effect/database"
import * as Drive from "@/effect/drive-api.server"
import { DriveApiError, LockBusyError } from "@/effect/errors"
import { driveWebhookUrl as webhookUrl } from "./config"
import { sync } from "./drive.server"
import { revokeLegacy } from "./google-grants.server"
import { SYNC_BUSY_MESSAGE } from "./http-errors"

export { driveWebhookUrl as webhookUrl } from "./config"

// MySQL named locks are server-wide: one Drive worker runs at a time across
// every container and release. Never change the name.
export const DRIVE_WORKER_LOCK = "mediabinder-drive-worker"

const DAY = 86_400_000

const renewals = Metric.counter("mediabinder.drive.watch.renewals", {
  description: "Watch registration checks the Drive worker made, by outcome",
  attributes: { unit: "{renewal}" },
  incremental: true,
})

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

const QUEUE_SYNC =
  "INSERT INTO drive_sync_state(user_id,requested) VALUES (?,1) ON DUPLICATE KEY UPDATE requested=requested+1,next_attempt=LEAST(next_attempt,NOW(3))"

export const queueSync = Effect.fn("DriveWebhook.queueSync")(function* (
  userId: string
) {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
  const database = yield* Database
  yield* database.execute("driveWebhook.queueSync", QUEUE_SYNC, [userId])
})

const STATES = [
  "sync",
  "change",
  "update",
  "add",
  "remove",
  "trash",
  "untrash",
  "exists",
  "not_exists",
]

type Channel = {
  user_id: string
  token_hash: string
  resource_id: string | null
  last_message: string
} & RowDataPacket

/**
 * Handles one push notification from Google and answers with the status code
 * to send back. The channel token is the only authentication: it is compared
 * with the stored hash in constant time, and a notification queues a sync only
 * for a live channel whose token and resource match. Nothing is written for
 * a refused notification.
 */
export const receive = Effect.fn("DriveWebhook.receive")(function* (
  headers: Headers
) {
  const id = headers.get("x-goog-channel-id") ?? ""
  const token = headers.get("x-goog-channel-token") ?? ""
  const message = headers.get("x-goog-message-number") ?? ""
  const resource = headers.get("x-goog-resource-id") ?? ""
  const state = headers.get("x-goog-resource-state") ?? ""
  if (
    id.length > 64 ||
    token.length > 256 ||
    !/^\d{1,65}$/.test(message) ||
    !resource ||
    !STATES.includes(state)
  )
    return yield* answered(400)
  const database = yield* Database
  const status = yield* database.transaction("driveWebhook.receive", (tx) =>
    Effect.gen(function* () {
      const [channel] = yield* tx.queryRows<Channel>(
        "SELECT * FROM drive_watch WHERE id=? AND expires_at>NOW(3) FOR UPDATE",
        [id]
      )
      // Refusals have written nothing, so committing the transaction that
      // only held the row lock is the same as rolling it back.
      if (
        !channel ||
        !timingSafeEqual(
          Buffer.from(hash(token)),
          Buffer.from(channel.token_hash)
        ) ||
        (channel.resource_id && channel.resource_id !== resource)
      )
        return 403
      // Google's initial handshake may arrive before the watch request returns its resource ID.
      if (state === "sync") return 204
      if (!channel.resource_id) return 503
      if (BigInt(message) <= BigInt(channel.last_message)) return 204
      yield* tx.execute("UPDATE drive_watch SET last_message=? WHERE id=?", [
        message,
        id,
      ])
      yield* tx.execute(QUEUE_SYNC, [channel.user_id])
      return 204
    })
  )
  return yield* answered(status)
})

const answered = (status: number) =>
  Effect.as(
    Effect.annotateCurrentSpan("http.response.status_code", status),
    status
  )

const stopWatch = Effect.fnUntraced(function* (
  token: string,
  channel: { id: string; resource_id: string | null }
) {
  const database = yield* Database
  // Stopping is best effort: the channel is dropped here either way, and
  // Google lets an unwanted one expire.
  if (channel.resource_id)
    yield* Drive.post(token, "channels/stop", {
      id: channel.id,
      resourceId: channel.resource_id,
    }).pipe(Effect.ignore)
  yield* database.execute(
    "driveWebhook.deleteWatch",
    "DELETE FROM drive_watch WHERE id=?",
    [channel.id]
  )
})

type WatchChannel = {
  id: string
  scope: string
  resource_id: string | null
  callback_url: string
  expires_at: string
} & RowDataPacket

/**
 * Brings the user's Google watch channels in line with their linked folders:
 * one per Drive scope, replaced once less than a day is left, dropped when
 * no folder needs it.
 */
export const maintainWatches = Effect.fn("DriveWebhook.maintainWatches")(
  function* (userId: string) {
    yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
    const database = yield* Database
    const callback = webhookUrl()
    const sources = yield* database.queryRows<
      { folder_id: string } & RowDataPacket
    >(
      "driveWebhook.sources",
      "SELECT folder_id FROM drive_folder WHERE user_id=?",
      [userId]
    )
    if (!callback) return
    const token = yield* Drive.readToken(userId)
    const scopes = new Set<string>()
    if (sources.length) scopes.add("")
    for (const source of sources) {
      const folder = yield* Drive.json<{ driveId?: string }>(
        token,
        `files/${source.folder_id}`,
        { fields: "driveId", supportsAllDrives: "true" }
      )
      if (folder.driveId) scopes.add(folder.driveId)
    }
    const channels = yield* database.queryRows<WatchChannel>(
      "driveWebhook.channels",
      "SELECT id,scope,resource_id,callback_url,expires_at FROM drive_watch WHERE user_id=?",
      [userId]
    )
    for (const scope of scopes) {
      const now = yield* Clock.currentTimeMillis
      if (
        channels.some(
          (channel) =>
            channel.scope === scope &&
            channel.resource_id &&
            channel.callback_url === callback &&
            Date.parse(channel.expires_at.replace(" ", "T") + "Z") > now + DAY
        )
      )
        continue
      const params = {
        supportsAllDrives: "true",
        ...(scope ? { driveId: scope } : {}),
      }
      const start = yield* Drive.json<{ startPageToken: string }>(
        token,
        "changes/startPageToken",
        params
      )
      const id = randomUUID(),
        secret = randomBytes(32).toString("hex")
      yield* database.execute(
        "driveWebhook.insertWatch",
        "INSERT INTO drive_watch(id,user_id,scope,token_hash,callback_url,expires_at) VALUES (?,?,?,?,?,?)",
        [id, userId, scope, hash(secret), callback, new Date(now + 7 * DAY)]
      )
      yield* Effect.gen(function* () {
        const result = yield* Drive.post<{
          resourceId: string
          expiration: string
        }>(
          token,
          "changes/watch",
          {
            id,
            type: "web_hook",
            address: callback,
            token: secret,
            expiration: String(now + 7 * DAY),
          },
          {
            ...params,
            includeItemsFromAllDrives: "true",
            pageToken: start.startPageToken,
          }
        )
        if (!result.resourceId || !Number.isFinite(Number(result.expiration)))
          return yield* new DriveApiError({
            operation: "changes.watch",
            userMessage: "Google returned an invalid watch registration.",
          })
        yield* database.execute(
          "driveWebhook.activateWatch",
          "UPDATE drive_watch SET resource_id=?,expires_at=? WHERE id=?",
          [result.resourceId, new Date(Number(result.expiration)), id]
        )
        // A full reconciliation after registration covers the gap around the initial handshake.
        yield* queueSync(userId)
        for (const old of channels.filter((channel) => channel.scope === scope))
          yield* stopWatch(token, old)
      }).pipe(
        // A registration that didn't complete leaves no half-made channel,
        // whether it failed or the worker was stopped.
        Effect.onError(() =>
          Effect.ignore(
            database.execute(
              "driveWebhook.deleteWatch",
              "DELETE FROM drive_watch WHERE id=?",
              [id]
            )
          )
        )
      )
    }
    for (const old of channels.filter((channel) => !scopes.has(channel.scope)))
      yield* stopWatch(token, old)
  }
)

// Carries on after a failure, which `handler` may note. Only a stop is passed
// on: the interrupted job is then still due for the next worker.
const recover = <A, E, R, B, R2>(
  effect: Effect.Effect<A, E, R>,
  handler: (error: unknown) => Effect.Effect<B, never, R2>
) =>
  Effect.catchCause(effect, (cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause)
      : handler(Cause.squash(cause))
  )

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message.slice(0, 1000) : fallback

type SyncJob = {
  user_id: string
  requested: number
  attempts: number
} & RowDataPacket

/** Users whose sync was requested and is due. Not traced: the worker's idle check. */
export const dueSyncJobs = Effect.fnUntraced(function* (userId?: string) {
  const database = yield* Database
  return yield* database.queryRows<SyncJob>(
    "driveWorker.dueSyncJobs",
    "SELECT user_id,requested,attempts FROM drive_sync_state WHERE requested>completed AND next_attempt<=NOW(3)" +
      (userId ? " AND user_id=?" : "") +
      " LIMIT 20",
    userId ? [userId] : []
  )
})

const syncJob = Effect.fn("DriveWorker.syncUser")(function* (job: SyncJob) {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", job.user_id)
  const database = yield* Database
  yield* Effect.gen(function* () {
    const sources = yield* database.queryRows(
      "driveWorker.sources",
      "SELECT folder_id FROM drive_folder WHERE user_id=?",
      [job.user_id]
    )
    if (sources.length) yield* sync(job.user_id)
    yield* database.execute(
      "driveWorker.syncSucceeded",
      "UPDATE drive_sync_state SET completed=?,attempts=0,last_error=NULL WHERE user_id=?",
      [job.requested, job.user_id]
    )
  }).pipe(
    // Recorded so the person sees it and the job is retried with a backoff,
    // then failed again so the span shows it.
    Effect.tapCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void
      const error = Cause.squash(cause)
      const delay = Math.min(3600, 10 * 2 ** Math.min(job.attempts, 9))
      return Effect.asVoid(
        database.execute(
          "driveWorker.syncFailed",
          "UPDATE drive_sync_state SET attempts=attempts+1,last_error=?,next_attempt=DATE_ADD(NOW(3),INTERVAL ? SECOND) WHERE user_id=?",
          [
            // The user's own sync lock being busy has always read as this.
            error instanceof LockBusyError && error.lock.startsWith("drive:")
              ? SYNC_BUSY_MESSAGE
              : errorText(error, "Sync failed"),
            delay,
            job.user_id,
          ]
        )
      )
    })
  )
})

/**
 * Runs the due sync jobs, up to twenty. One user's failure doesn't stop the
 * others; it is kept in drive_sync_state.last_error for that user. Returns
 * how many jobs it ran.
 */
export const processSyncJobs = Effect.fn("DriveWorker.processSyncJobs")(
  function* (userId?: string) {
    const jobs = yield* dueSyncJobs(userId)
    for (const job of jobs) yield* recover(syncJob(job), () => Effect.void)
    return jobs.length
  }
)

/**
 * Users whose watch channels are due a check. Not traced: the worker's idle
 * check. It also makes sure every user with a folder has a row to schedule.
 */
export const dueWatchRenewals = Effect.fnUntraced(function* () {
  if (!webhookUrl()) return []
  const database = yield* Database
  yield* database.execute(
    "driveWorker.scheduleRenewals",
    "INSERT IGNORE INTO drive_sync_state(user_id) SELECT DISTINCT user_id FROM drive_folder"
  )
  return yield* database.queryRows<{ user_id: string } & RowDataPacket>(
    "driveWorker.dueRenewals",
    "SELECT user_id FROM drive_sync_state WHERE watch_next_check<=NOW(3) LIMIT 20"
  )
})

const renewWatch = Effect.fn("DriveWorker.renewWatch")(function* (
  userId: string
) {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
  const database = yield* Database
  yield* maintainWatches(userId).pipe(
    Effect.andThen(
      database.execute(
        "driveWorker.renewalSucceeded",
        "UPDATE drive_sync_state SET watch_next_check=DATE_ADD(NOW(3),INTERVAL 6 HOUR),watch_error=NULL WHERE user_id=?",
        [userId]
      )
    ),
    Effect.tap(() =>
      Metric.update(
        Metric.withAttributes(renewals, { outcome: "succeeded" }),
        1
      )
    ),
    Effect.tapCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void
      return Metric.update(
        Metric.withAttributes(renewals, { outcome: "failed" }),
        1
      ).pipe(
        Effect.andThen(
          database.execute(
            "driveWorker.renewalFailed",
            "UPDATE drive_sync_state SET watch_next_check=DATE_ADD(NOW(3),INTERVAL 10 MINUTE),watch_error=? WHERE user_id=?",
            [
              errorText(Cause.squash(cause), "Watch registration failed"),
              userId,
            ]
          )
        ),
        Effect.asVoid
      )
    })
  )
})

/**
 * Checks the watch channels of the users that are due, up to twenty. A
 * failure is kept in drive_sync_state.watch_error and retried in ten minutes.
 * Returns how many users it checked.
 */
export const processWatchRenewals = Effect.fn(
  "DriveWorker.processWatchRenewals"
)(function* () {
  const users = yield* dueWatchRenewals()
  for (const user of users)
    yield* recover(renewWatch(user.user_id), () => Effect.void)
  return users.length
})

/**
 * One pass of the Drive worker: under the worker lock, drops old grants,
 * renews watches, then runs due syncs. Returns `worked` when it found
 * something to do, `idle` when not, or when another worker holds the lock.
 *
 * It checks for work untraced and spans only a pass that has some, as the
 * `DriveWorker.pass` span, so an idle worker exports no traces. Each job
 * inside gets its own span.
 */
export const pass = Effect.gen(function* () {
  const database = yield* Database
  return yield* database.withNamedLock(
    "driveWorker.lock",
    DRIVE_WORKER_LOCK,
    { timeoutSeconds: 0 },
    () =>
      Effect.gen(function* () {
        // Housekeeping only: never let it hold up watches or syncs.
        const revoked = yield* recover(revokeLegacy(), (error) =>
          Effect.logWarning("Old Google grant cleanup failed").pipe(
            Effect.annotateLogs("error", errorText(error, "Unknown error")),
            Effect.as(0)
          )
        )
        if (revoked)
          yield* Effect.logInfo(
            `Revoked ${revoked} old full-Drive Google grant(s).`
          )
        const renewing = yield* dueWatchRenewals()
        const syncing = yield* dueSyncJobs()
        if (renewing.length === 0 && syncing.length === 0)
          return revoked ? ("worked" as const) : ("idle" as const)
        // Selected again inside: renewals queue syncs that are due at once.
        yield* Effect.gen(function* () {
          yield* processWatchRenewals()
          yield* processSyncJobs()
        }).pipe(
          Effect.withSpan("DriveWorker.pass"),
          Effect.withTracerEnabled(true)
        )
        return "worked" as const
      })
  )
}).pipe(
  // Another worker is running the pass: nothing for this one to do.
  Effect.catchTag("LockBusyError", () => Effect.succeed("idle" as const)),
  Effect.withTracerEnabled(false)
)
