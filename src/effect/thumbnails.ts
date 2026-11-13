import { createHash } from "node:crypto"
import {
  Cache,
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  Schema,
  Semaphore,
} from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { driveRequest } from "./drive-http.server"

export class ThumbnailError extends Schema.TaggedError<ThumbnailError>()(
  "ThumbnailError",
  {
    status: Schema.Int,
    message: Schema.String,
  }
) {}
export interface ThumbnailData {
  bytes: Uint8Array<ArrayBuffer>
  contentType: string
  etag: string
}
export class ThumbnailSource extends Context.Service<
  ThumbnailSource,
  {
    load: (key: string) => Effect.Effect<ThumbnailData, ThumbnailError>
  }
>()("mediabinder/ThumbnailSource") {}

// Google's 640 px thumbnails measure about 40 KiB (81 KiB the largest seen in
// production), so 256 entries hold about 10 MiB; the 512 KiB cap bounds the
// worst case at 128 MiB. A library view asks for 20-30 thumbnails at once,
// and each load takes about a third of a second, so 16 run concurrently.
export const MAX_THUMBNAIL_BYTES = 512 * 1024
// Thumbnails are the hottest path, a few dozen per library view: they are
// counted and timed here instead of traced or logged one by one.
const requests = Metric.counter("mediabinder.thumbnail.requests", {
  description:
    "Thumbnail requests, by whether the server's cache held (or was already loading) the thumbnail, and outcome",
  attributes: { unit: "{request}" },
  incremental: true,
})

const serveDuration = Metric.histogram("mediabinder.thumbnail.duration", {
  description:
    "Time to answer from the server's thumbnail cache, including waiting for a load slot and loading from Google on a miss",
  attributes: { unit: "s" },
  boundaries: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25],
})

export const makeThumbnailCache = Effect.fn("makeThumbnailCache")(function* (
  load: (key: string) => Effect.Effect<ThumbnailData, ThumbnailError>,
  options = {
    capacity: 256,
    concurrency: 16,
    ttl: "15 minutes" as Duration.Input,
  }
) {
  const semaphore = yield* Semaphore.make(options.concurrency)
  const cache = yield* Cache.makeWith(
    (key: string) =>
      load(key).pipe(
        Effect.timeout("25 seconds"),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new ThumbnailError({
              status: 504,
              message: "Thumbnail request timed out. Try again.",
            })
          )
        ),
        Semaphore.withPermits(semaphore, 1)
      ),
    {
      capacity: options.capacity,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? options.ttl : "0 seconds"),
    }
  )
  return {
    get: Effect.fn("Thumbnail.cacheGet")(function* (key: string) {
      // A hit includes joining a load another request already started.
      const state = (yield* Cache.has(cache, key)) ? "hit" : "miss"
      const [duration, exit] = yield* Cache.get(cache, key).pipe(
        Effect.exit,
        Effect.timed
      )
      const attributes = {
        cache: state,
        outcome: Exit.isSuccess(exit)
          ? "served"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "cancelled"
            : "failed",
      }
      yield* Effect.all(
        [
          Metric.update(Metric.withAttributes(requests, attributes), 1),
          Metric.update(
            Metric.withAttributes(serveDuration, attributes),
            Duration.toSeconds(duration)
          ),
        ],
        { discard: true }
      )
      const thumbnail = yield* exit
      return { ...thumbnail, ms: Duration.toMillis(duration), cache: state }
    }),
  }
})

export class Thumbnails extends Context.Service<
  Thumbnails,
  Effect.Success<ReturnType<typeof makeThumbnailCache>>
>()("mediabinder/Thumbnails") {
  static readonly layer = Layer.effect(
    Thumbnails,
    Effect.gen(function* () {
      const source = yield* ThumbnailSource
      return yield* makeThumbnailCache(source.load)
    })
  )
}

export const readThumbnail = Effect.fn("Thumbnail.download")(function* (
  url: string,
  token: string
) {
  const fail = (status: number, message: string) =>
    new ThumbnailError({ status, message })
  const response = yield* driveRequest(
    "thumbnail.download",
    HttpClientRequest.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).pipe(
    Effect.mapError(() => fail(502, "Thumbnail download failed. Try again."))
  )
  // The body is read here, a chunk at a time, to stop at the size limit.
  const source = Option.getOrThrow(HttpClientResponse.toWeb(response))
  const discard = Effect.tryPromise(
    () => source.body?.cancel() ?? Promise.resolve()
  ).pipe(Effect.ignore)
  if (!response.status || response.status < 200 || response.status >= 300) {
    yield* discard
    return yield* fail(
      response.status === 404 ? 404 : 502,
      "Google could not provide this thumbnail. Try again."
    )
  }
  const contentType = source.headers.get("content-type")?.split(";")[0] ?? ""
  if (
    !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
      contentType
    )
  ) {
    yield* discard
    return yield* fail(502, "Google returned an invalid thumbnail.")
  }
  const reader = source.body?.getReader()
  if (!reader) return yield* fail(502, "Google returned an empty thumbnail.")
  const chunks = yield* Effect.tryPromise({
    try: async () => {
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_THUMBNAIL_BYTES)
          throw fail(502, "Thumbnail exceeds the size limit.")
        chunks.push(value)
      }
      return chunks
    },
    catch: (cause) =>
      cause instanceof ThumbnailError
        ? cause
        : fail(502, "Thumbnail download failed. Try again."),
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise(() => reader.cancel()).pipe(
        Effect.ignore,
        Effect.andThen(Effect.sync(() => reader.releaseLock()))
      )
    )
  )
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return {
    bytes,
    contentType,
    etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
  }
})
