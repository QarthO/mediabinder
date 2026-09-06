import { Effect, Layer, Logger, ManagedRuntime, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability"
import { driveToken } from "@/lib/drive.server"
import {
  readThumbnail,
  ThumbnailError,
  ThumbnailSource,
  Thumbnails,
} from "./thumbnails"

const FileThumbnail = Schema.Struct({
  thumbnailLink: Schema.optional(Schema.String),
})
const SourceLive = Layer.succeed(ThumbnailSource, {
  load: Effect.fn("thumbnails.google")(function* (key: string) {
    const [userId, driveId] = key.split(":")
    const token = yield* Effect.tryPromise({
      try: () => driveToken(undefined, userId),
      catch: () =>
        new ThumbnailError({
          status: 401,
          message: "Reconnect Google Drive in settings.",
        }),
    }).pipe(Effect.withSpan("thumbnails.token"))
    const file = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveId)}?fields=thumbnailLink&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` }, signal }
        )
        if (!response.ok) {
          await response.body?.cancel()
          throw new ThumbnailError({
            status: response.status === 404 ? 404 : 502,
            message: "Google could not look up this thumbnail. Try again.",
          })
        }
        return Schema.decodeUnknownSync(FileThumbnail)(await response.json())
      },
      catch: (cause) =>
        cause instanceof ThumbnailError
          ? cause
          : new ThumbnailError({
              status: 502,
              message: "Thumbnail lookup failed. Try again.",
            }),
    }).pipe(Effect.withSpan("thumbnails.lookup"))
    if (!file.thumbnailLink)
      return yield* new ThumbnailError({
        status: 404,
        message: "No thumbnail available.",
      })
    const url = yield* Effect.try({
      try: () => new URL(file.thumbnailLink!),
      catch: () =>
        new ThumbnailError({ status: 502, message: "Invalid thumbnail URL." }),
    })
    if (
      url.protocol !== "https:" ||
      !["googleusercontent.com", "google.com"].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
      )
    )
      return yield* new ThumbnailError({
        status: 502,
        message: "Invalid thumbnail URL.",
      })
    return yield* readThumbnail(
      file.thumbnailLink.replace(/=s\d+$/, "=s640"),
      token
    )
  }),
})
const tracing = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  ? OtlpTracer.layer({
      url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      resource: { serviceName: "mediabinder" },
    }).pipe(
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer)
    )
  : Layer.empty
const runtime = ManagedRuntime.make(
  Thumbnails.layer.pipe(
    Layer.provide(SourceLive),
    Layer.provideMerge(Layer.merge(Logger.layer([Logger.consoleJson]), tracing))
  )
)
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    void runtime.dispose()
  })

// The route authenticates and checks ownership/availability before calling this cache.
export function thumbnailResponse(
  userId: string,
  driveId: string,
  request: Request
) {
  return runtime.runPromise(
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
      Effect.catchTag("ThumbnailError", (error) =>
        Effect.succeed(
          new Response(error.message, {
            status: error.status,
            headers: { "Cache-Control": "no-store" },
          })
        )
      )
    ),
    { signal: request.signal }
  )
}
