import { Cause, Clock, Effect, Metric, Option } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import type { RowDataPacket } from "mysql2/promise"
import { Database } from "@/effect/database"
import * as Drive from "@/effect/drive-api.server"
import { DRIVE_API, driveRequest } from "@/effect/drive-http.server"
import { DriveApiError } from "@/effect/errors"
import { isExpectedAppError } from "@/observability/error-policy"
import * as Telemetry from "@/telemetry"
import { sniffVideoCodec, UNKNOWN_VIDEO_CODEC } from "./iso-bmff"
import { ISO_BMFF_VIDEO_TYPES } from "./media-formats"

// Records each video's codec in the background, so the viewer knows whether
// the browser can play it before downloading anything. A sync only saves the
// files (and clears the codec of one whose bytes changed); the Drive worker
// finds the videos with no codec and reads them here. Per file this is one
// round trip in the common case: the file's first 64 KiB and last 1 MiB are
// read at once, which hold `moov` wherever it is (see `iso-bmff.ts`). The
// media itself is never downloaded.
//
// This is per-file work, so it is counted, not spanned: only a worker pass
// that did some gets a span. Nothing here carries a file ID or name; the
// codec attribute is a fourcc from a fixed list.

const codecChecks = Metric.counter("mediabinder.worker.codec_checks", {
  description:
    "Video codec lookups by the Drive worker: `recorded` a codec, `unknown` (the file can't be read, remembered until it changes) or `failed` (a Drive hiccup, retried later)",
  attributes: { unit: "{file}" },
  incremental: true,
})

const codecsFound = Metric.counter("mediabinder.worker.video_codecs", {
  description:
    "Video codecs recorded by the Drive worker, by sample-entry fourcc (`other` for any not listed)",
  attributes: { unit: "{file}" },
  incremental: true,
})

// A fourcc comes out of an untrusted file, so only these become attribute
// values; anything else would let a file mint new metric series.
const KNOWN_CODECS = new Set([
  "avc1",
  "avc3",
  "hvc1",
  "hev1",
  "dvh1",
  "dvhe",
  "av01",
  "vp09",
  "mp4v",
  "apcn",
  "apch",
  "apcs",
  "apco",
  "ap4h",
  "ap4x",
  "jpeg",
])

// Files read at once, and how many are probed before their results are saved:
// small saves keep progress visible and a restart cheap.
const CONCURRENCY = 12
const CHUNK = 36
// A worker pass stops starting chunks after this long, so due syncs and watch
// renewals, which wait behind it, are never held up for long.
const BATCH = 200
const PASS_BUDGET_MS = 20_000
// A file or person that failed is left alone this long, in memory: a restart
// simply tries again.
const RETRY_AFTER_MS = 10 * 60_000
const FILE_TIMEOUT = "20 seconds"
const REQUEST_TIMEOUT = "15 seconds"

// Drive answers these for a file it will never let us read; the same request
// would fail again, so the file is remembered as unreadable.
const PERMANENT = new Set([400, 403, 404, 416])

const readRange = (token: string, driveId: string, fileSize: number) =>
  Effect.fnUntraced(function* (
    start: number,
    length: number
  ): Effect.fn.Return<Uint8Array, DriveApiError> {
    const operation = "files.download"
    const response = yield* driveRequest(
      operation,
      HttpClientRequest.get(
        `${DRIVE_API}/files/${encodeURIComponent(driveId)}`,
        {
          urlParams: { alt: "media", supportsAllDrives: "true" },
          headers: {
            Authorization: `Bearer ${token}`,
            Range: `bytes=${start}-${start + length - 1}`,
          },
        }
      ),
      { timeout: REQUEST_TIMEOUT }
    )
    // A 200 is the whole file: fine for a small one, never worth reading for a
    // large one that ignored the range.
    const wholeFile =
      response.status === 200 && start === 0 && length >= fileSize
    if (response.status !== 206 && !wholeFile) {
      const body = HttpClientResponse.toWeb(response)
      if (Option.isSome(body))
        yield* Effect.tryPromise(
          () => body.value.body?.cancel() ?? Promise.resolve()
        ).pipe(Effect.ignore)
      return yield* new DriveApiError({ operation, status: response.status })
    }
    const buffer = yield* response.arrayBuffer.pipe(
      Effect.mapError((cause) => new DriveApiError({ operation, cause }))
    )
    return new Uint8Array(buffer, 0, Math.min(buffer.byteLength, length))
  })

type Check =
  | { outcome: "recorded" | "unknown"; codec: string }
  | { outcome: "failed" }

const check = (token: string, driveId: string, size: number) =>
  sniffVideoCodec(size, readRange(token, driveId, size)).pipe(
    Effect.timeout(FILE_TIMEOUT),
    Effect.map((sniff): Check =>
      sniff.found
        ? { outcome: "recorded", codec: sniff.codec }
        : { outcome: "unknown", codec: UNKNOWN_VIDEO_CODEC }
    ),
    Effect.catchCause((cause): Effect.Effect<Check> => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      const error = Cause.squash(cause)
      if (error instanceof DriveApiError)
        return Effect.succeed(
          error.status !== undefined && PERMANENT.has(error.status)
            ? { outcome: "unknown", codec: UNKNOWN_VIDEO_CODEC }
            : { outcome: "failed" }
        )
      // A timeout is a slow Drive, not a bad file. Anything else is a bug:
      // report it, and keep the sync going.
      return Cause.isTimeoutError(error)
        ? Effect.succeed({ outcome: "failed" })
        : Telemetry.logException(cause, {
            operation: "DriveWorker.checkCodecs",
          }).pipe(Effect.as({ outcome: "failed" }))
    }),
    Effect.tap((result) =>
      Effect.all(
        [
          Metric.update(
            Metric.withAttributes(codecChecks, { outcome: result.outcome }),
            1
          ),
          result.outcome === "recorded"
            ? Metric.update(
                Metric.withAttributes(codecsFound, {
                  codec: KNOWN_CODECS.has(result.codec)
                    ? result.codec
                    : "other",
                }),
                1
              )
            : Effect.void,
        ],
        { discard: true }
      )
    )
  )

const types = ISO_BMFF_VIDEO_TYPES
const typeList = types.map(() => "?").join(",")
// What "waiting for a codec" means: an available ISO-BMFF video with none.
const PENDING = `mime_type IN (${typeList}) AND video_codec IS NULL AND available=TRUE`

export type PendingFile = {
  id: string
  user_id: string
  drive_id: string
  size: number
}

// Retry times by media ID and by user ID, for what failed transiently.
const failedFiles = new Map<string, number>()
const failedUsers = new Map<string, number>()

const forget = (until: Map<string, number>, now: number) => {
  for (const [key, time] of until) if (time <= now) until.delete(key)
}

/**
 * How many of the user's videos are waiting for a codec, for the sync
 * toast's progress. An index on the MIME type and codec makes it a short scan.
 */
export const pendingCount = Effect.fn("VideoCodecs.pending")(function* (
  userId: string
) {
  yield* Effect.annotateCurrentSpan("mediabinder.user_id", userId)
  const database = yield* Database
  const [row] = yield* database.queryRows<{ n: number } & RowDataPacket>(
    "videoCodecs.pending",
    `SELECT COUNT(*) AS n FROM media WHERE user_id=? AND ${PENDING}`,
    [userId, ...types]
  )
  return Number(row?.n ?? 0)
})

/**
 * The next videos for the worker to read, up to one batch: available,
 * ISO-BMFF, no codec, whose owner isn't syncing right now (the sync is about
 * to rewrite their rows) and that didn't just fail. Not traced: the worker's
 * idle check.
 */
export const pendingFiles = Effect.fnUntraced(function* () {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  forget(failedFiles, now)
  forget(failedUsers, now)
  const users = [...failedUsers.keys()]
  const files = [...failedFiles.keys()].slice(0, 1000)
  const rows = yield* database.queryRows<PendingFile & RowDataPacket>(
    "videoCodecs.pendingFiles",
    `SELECT id,user_id,drive_id,size FROM media WHERE ${PENDING}
     AND IS_USED_LOCK(CONCAT('drive:',user_id)) IS NULL${
       users.length
         ? ` AND user_id NOT IN (${users.map(() => "?").join(",")})`
         : ""
     }${
       files.length ? ` AND id NOT IN (${files.map(() => "?").join(",")})` : ""
     }
     ORDER BY user_id LIMIT ?`,
    [...types, ...users, ...files, BATCH]
  )
  return rows.map((row) => ({ ...row, size: Number(row.size) }))
})

type Saved = { id: string; size: number; codec: string }

// One statement per codec and chunk. Matching the size as well as the ID
// leaves a row alone that a sync rewrote while it was being read, and the
// NULL check makes a repeat harmless. Nothing else is locked.
const save = Effect.fnUntraced(function* (saved: ReadonlyArray<Saved>) {
  const database = yield* Database
  const byCodec = new Map<string, Saved[]>()
  for (const file of saved)
    byCodec.set(file.codec, [...(byCodec.get(file.codec) ?? []), file])
  for (const [codec, list] of byCodec)
    for (let index = 0; index < list.length; index += 500) {
      const chunk = list.slice(index, index + 500)
      yield* database.execute(
        "videoCodecs.save",
        `UPDATE media SET video_codec=? WHERE video_codec IS NULL AND (id,size) IN (${chunk.map(() => "(?,?)").join(",")})`,
        [codec, ...chunk.flatMap((file) => [file.id, file.size])]
      )
    }
})

/**
 * One batch of the worker's codec work: reads the codec of the videos that
 * have none and stores it. Returns how many files it took up. Only a batch
 * that has files is spanned (as `DriveWorker.checkCodecs`), so an idle worker
 * exports no traces.
 *
 * Reads the codec of each file and stores it, a chunk at a time. Files of one
 * person share a token: the service account in shared-folder mode, their own
 * Google access otherwise. A person whose token can't be had, or a file that
 * failed in a Drive hiccup, is left for later; a file that can't be parsed is
 * stored as `unknown`. Stops starting chunks once the pass's time is used.
 */
const checkPending = Effect.fn("DriveWorker.checkCodecs")(function* (
  files: ReadonlyArray<PendingFile>
) {
  const started = yield* Clock.currentTimeMillis
  const byUser = new Map<string, PendingFile[]>()
  for (const file of files)
    byUser.set(file.user_id, [...(byUser.get(file.user_id) ?? []), file])
  const totals = { recorded: 0, unknown: 0, failed: 0, skipped: 0 }
  for (const [userId, list] of byUser) {
    const token = yield* Drive.readToken(userId).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        Clock.currentTimeMillis.pipe(
          Effect.tap((now) =>
            Effect.sync(() => failedUsers.set(userId, now + RETRY_AFTER_MS))
          ),
          Effect.andThen(
            isExpectedAppError(error)
              ? Effect.logWarning("Video codec checks skipped a user").pipe(
                  Effect.annotateLogs({
                    "mediabinder.user_id": userId,
                    "error.type":
                      error instanceof Error ? error.name : typeof error,
                  })
                )
              : Telemetry.logException(Cause.fail(error), {
                  operation: "DriveWorker.checkCodecs",
                  attributes: { "mediabinder.user_id": userId },
                })
          ),
          Effect.as(Option.none<string>())
        )
      )
    )
    if (Option.isNone(token)) {
      totals.skipped += list.length
      continue
    }
    for (let index = 0; index < list.length; index += CHUNK) {
      const now = yield* Clock.currentTimeMillis
      if (now - started > PASS_BUDGET_MS) {
        totals.skipped += list.length - index
        break
      }
      const results = yield* Effect.forEach(
        list.slice(index, index + CHUNK),
        (file) =>
          check(token.value, file.drive_id, file.size).pipe(
            Effect.map((result) => ({ file, result }))
          ),
        { concurrency: CONCURRENCY }
      )
      const saved: Saved[] = []
      for (const { file, result } of results) {
        if (result.outcome === "failed") {
          totals.failed++
          failedFiles.set(file.id, now + RETRY_AFTER_MS)
        } else {
          totals[result.outcome]++
          saved.push({ id: file.id, size: file.size, codec: result.codec })
        }
      }
      yield* save(saved)
    }
  }
  yield* Effect.annotateCurrentSpan({
    "mediabinder.worker.codec.files": files.length,
    "mediabinder.worker.codec.users": byUser.size,
    "mediabinder.worker.codec.recorded": totals.recorded,
    "mediabinder.worker.codec.unknown": totals.unknown,
    "mediabinder.worker.codec.failed": totals.failed,
    "mediabinder.worker.codec.skipped": totals.skipped,
  })
  return files.length
})

export const checkCodecs = Effect.gen(function* () {
  const files = yield* pendingFiles()
  if (files.length === 0) return 0
  return yield* checkPending(files).pipe(Effect.withTracerEnabled(true))
})
