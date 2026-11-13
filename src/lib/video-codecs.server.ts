import { Cause, Effect, Metric, Option } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import type { RowDataPacket } from "mysql2/promise"
import type { DatabaseSession } from "@/effect/database"
import { DRIVE_API, driveRequest } from "@/effect/drive-http.server"
import { DriveApiError } from "@/effect/errors"
import * as Telemetry from "@/telemetry"
import { sniffVideoCodec, UNKNOWN_VIDEO_CODEC } from "./iso-bmff"
import { isIsoBmffVideo } from "./media-formats"

// Records each video's codec during a Drive sync, so the viewer knows whether
// the browser can play it before downloading anything. Per file this reads a
// few bytes of headers and the file's `moov` box through Drive range
// requests, never the media itself.
//
// This is per-file work, so it is counted, not spanned. Nothing here carries a
// file ID or name; the codec attribute is a fourcc from a fixed list.

const codecChecks = Metric.counter("mediabinder.sync.codec_checks", {
  description:
    "Video codec lookups during Drive syncs: `recorded` a codec, `unknown` (the file can't be read, remembered until it changes) or `failed` (a Drive hiccup, retried next sync)",
  attributes: { unit: "{file}" },
  incremental: true,
})

const codecsFound = Metric.counter("mediabinder.sync.video_codecs", {
  description:
    "Video codecs recorded by Drive syncs, by sample-entry fourcc (`other` for any not listed)",
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

const CONCURRENCY = 4
const FILE_TIMEOUT = "30 seconds"
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
            operation: "Drive.detectCodecs",
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

/** Drive ID to codec; `null` clears a codec that no longer applies. */
export type CodecUpdates = Map<string, string | null>

type ListedFile = {
  id: string
  mimeType: string
  size?: string
  sha256Checksum?: string
}

/**
 * Works out which of the scanned files need their codec read, reads them, and
 * returns what to store. A file needs it when it is an ISO-BMFF video with no
 * codec yet, or whose bytes changed since the stored row (a different size, or
 * a different checksum when both are known). Reads happen here, after the scan
 * and before the catalog transaction, so the transaction never waits on Drive.
 * Nothing here fails the sync: a file that can't be read is stored as
 * `unknown`, and a Drive hiccup leaves it empty to be tried again next sync.
 */
export const detectCodecs = Effect.fn("Drive.detectCodecs")(function* (
  session: DatabaseSession,
  userId: string,
  token: string,
  files: ReadonlyArray<ListedFile>
) {
  const stored = new Map(
    (yield* session.queryRows<RowDataPacket>(
      `SELECT m.drive_id,m.size,m.video_codec,c.sha256 FROM media m
       LEFT JOIN catalog c ON c.id=m.catalog_id
       WHERE m.user_id=? AND (m.mime_type LIKE 'video/%' OR m.video_codec IS NOT NULL)`,
      [userId]
    )).map((row) => [row.drive_id as string, row] as const)
  )
  const updates: CodecUpdates = new Map()
  const pending: { id: string; size: number; hadCodec: boolean }[] = []
  for (const file of files) {
    const row = stored.get(file.id)
    const size = Number(file.size)
    if (!isIsoBmffVideo(file.mimeType) || !(size > 0)) {
      if (row?.video_codec != null) updates.set(file.id, null)
      continue
    }
    const checksum = file.sha256Checksum?.toLowerCase()
    const changed =
      row !== undefined &&
      (Number(row.size) !== size ||
        (Boolean(checksum) && Boolean(row.sha256) && row.sha256 !== checksum))
    if (row && row.video_codec != null && !changed) continue
    pending.push({ id: file.id, size, hadCodec: row?.video_codec != null })
  }
  yield* Effect.annotateCurrentSpan(
    "mediabinder.sync.codec_files",
    pending.length
  )
  yield* Effect.forEach(
    pending,
    (file) =>
      check(token, file.id, file.size).pipe(
        Effect.tap((result) =>
          result.outcome === "failed"
            ? // Content changed but couldn't be read: drop the old codec.
              Effect.sync(() => {
                if (file.hadCodec) updates.set(file.id, null)
              })
            : Effect.sync(() => {
                updates.set(file.id, result.codec)
              })
        )
      ),
    { concurrency: CONCURRENCY, discard: true }
  )
  return updates
})

/** Writes the codecs, one statement per codec and chunk rather than per file. */
export const saveCodecs = Effect.fnUntraced(function* (
  tx: DatabaseSession,
  userId: string,
  updates: CodecUpdates
) {
  const byCodec = new Map<string | null, string[]>()
  for (const [id, codec] of updates)
    byCodec.set(codec, [...(byCodec.get(codec) ?? []), id])
  for (const [codec, ids] of byCodec)
    for (let index = 0; index < ids.length; index += 500) {
      const chunk = ids.slice(index, index + 500)
      yield* tx.execute(
        `UPDATE media SET video_codec=? WHERE user_id=? AND drive_id IN (${chunk.map(() => "?").join(",")})`,
        [codec, userId, ...chunk]
      )
    }
})
