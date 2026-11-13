import { createHash } from "node:crypto"
import {
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
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

// 64 entries × at most 1 MiB each, plus at most six in-flight downloads.
export const MAX_THUMBNAIL_BYTES = 1024 * 1024
export const makeThumbnailCache = Effect.fn("makeThumbnailCache")(function* (
  load: (key: string) => Effect.Effect<ThumbnailData, ThumbnailError>,
  options = {
    capacity: 64,
    concurrency: 6,
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
      const reused = yield* Cache.has(cache, key)
      const [duration, thumbnail] = yield* Cache.get(cache, key).pipe(
        Effect.timed
      )
      const ms = Duration.toMillis(duration)
      yield* Effect.logInfo("thumbnail served", {
        cache: reused ? "hit-or-shared" : "miss",
        durationMs: Math.round(ms),
        bytes: thumbnail.bytes.byteLength,
      })
      return { ...thumbnail, ms, cache: reused ? "hit-or-shared" : "miss" }
    }, Effect.withLogSpan("thumbnail")),
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
