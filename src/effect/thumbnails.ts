import { createHash } from "node:crypto"
import {
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Schema,
  Semaphore,
} from "effect"

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
    get: Effect.fn("thumbnails.get")(
      function* (key: string) {
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
      },
      Effect.tapError((error) =>
        Effect.logWarning("thumbnail failed", {
          status: error.status,
          message: error.message,
        })
      ),
      Effect.withLogSpan("thumbnail")
    ),
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

export const readThumbnail = Effect.fn("thumbnails.download")(function* (
  url: string,
  token: string
) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new ThumbnailError({
          status: response.status === 404 ? 404 : 502,
          message: "Google could not provide this thumbnail. Try again.",
        })
      }
      const contentType =
        response.headers.get("content-type")?.split(";")[0] ?? ""
      if (
        !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
          contentType
        )
      ) {
        await response.body?.cancel()
        throw new ThumbnailError({
          status: 502,
          message: "Google returned an invalid thumbnail.",
        })
      }
      const reader = response.body?.getReader()
      if (!reader)
        throw new ThumbnailError({
          status: 502,
          message: "Google returned an empty thumbnail.",
        })
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_THUMBNAIL_BYTES)
            throw new ThumbnailError({
              status: 502,
              message: "Thumbnail exceeds the size limit.",
            })
          chunks.push(value)
        }
      } finally {
        await reader.cancel()
        reader.releaseLock()
      }
      const bytes = new Uint8Array(size)
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
    },
    catch: (cause) =>
      cause instanceof ThumbnailError
        ? cause
        : new ThumbnailError({
            status: 502,
            message: "Thumbnail download failed. Try again.",
          }),
  })
})
