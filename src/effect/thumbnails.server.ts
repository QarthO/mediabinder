import { Effect } from "effect"
import { reportAppError, runAppEffectUntraced } from "./runtime.server"
import { Thumbnails } from "./thumbnails"

// The route authenticates and checks ownership/availability before calling this cache.
export function thumbnailResponse(
  userId: string,
  driveId: string,
  request: Request
) {
  // Untraced: thumbnails are counted and timed as metrics in the cache.
  return runAppEffectUntraced(
    Thumbnails.use((service) => service.get(`${userId}:${driveId}`)).pipe(
      Effect.map((thumbnail) => {
        const headers = new Headers({
          "Content-Type": thumbnail.contentType,
          "Cache-Control": "private, max-age=300, must-revalidate",
          Vary: "Cookie",
          ETag: thumbnail.etag,
          "X-Content-Type-Options": "nosniff",
          "Server-Timing": `thumbnail;dur=${thumbnail.ms.toFixed(1)}, cache;desc="${thumbnail.cache}"`,
        })
        if (request.headers.get("if-none-match") === thumbnail.etag)
          return new Response(null, { status: 304, headers })
        headers.set("Content-Length", String(thumbnail.bytes.byteLength))
        return new Response(thumbnail.bytes, { headers })
      }),
      // One log per failure: unexpected ones (Google unreachable, a bad
      // response) are reported as errors with a fingerprint; expected ones
      // (no thumbnail, Drive access revoked) are a warning.
      Effect.catchTag("ThumbnailError", (error) =>
        (error.status >= 500
          ? Effect.sync(() =>
              reportAppError(error, { operation: "Thumbnail.get" })
            )
          : Effect.logWarning("thumbnail failed", { status: error.status })
        ).pipe(
          Effect.as(
            new Response(error.message, {
              status: error.status,
              headers: { "Cache-Control": "no-store" },
            })
          )
        )
      )
    ),
    { signal: request.signal }
  )
}
