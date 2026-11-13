import { Effect, Metric, Option } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { isExpectedAppError } from "@/observability/error-policy"
import * as Telemetry from "@/telemetry"
import * as Drive from "./drive-api.server"
import { canRelabelAsMp4 } from "@/lib/media-formats"
import { DRIVE_API, driveRequest } from "./drive-http.server"
import { renderImage } from "./thumbnail-source.server"

// Formats the browser couldn't use as stored: served as MP4 or as Google's
// JPEG. The kind is the only attribute, never an ID or a name.
const fallbacks = Metric.counter("mediabinder.viewer.fallbacks", {
  description:
    "Originals served through a viewer fallback: relabelled as MP4 or rendered by Google as a JPEG",
  attributes: { unit: "{request}" },
  incremental: true,
})
const countFallback = (kind: "mp4" | "rendered") =>
  Metric.update(Metric.withAttributes(fallbacks, { kind }), 1)

const unavailable = () =>
  new Response("Drive preview unavailable. Reconnect in settings and retry.", {
    status: 502,
  })

// Keep the native response stream alive after headers are returned. The incoming
// request signal owns the download lifetime, including browser cancellation.
export const stream = Effect.fn("Media.stream")(
  function* (
    request: Request,
    media: { drive_id: string; mime_type: string },
    // `mp4` serves a QuickTime-family video as `video/mp4`. It applies only
    // to those types: the label is a security boundary, so any other type
    // keeps its stored one.
    options: { as?: "mp4" } = {}
  ) {
    const token = yield* Drive.readToken(undefined, request.headers)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    }
    const range = request.headers.get("range")
    if (range) {
      if (!/^bytes=\d*-\d*$/.test(range))
        return new Response("Invalid range.", { status: 416 })
      headers.Range = range
    }
    const upstream = yield* driveRequest(
      "files.download",
      HttpClientRequest.get(
        `${DRIVE_API}/files/${encodeURIComponent(media.drive_id)}`,
        {
          urlParams: { alt: "media", supportsAllDrives: "true" },
          headers,
        }
      ),
      { signal: request.signal }
    )
    yield* Effect.annotateCurrentSpan({
      "http.response.status_code": upstream.status,
    })
    // The body goes to the browser as Google's own stream, not re-read here.
    const source = Option.getOrThrow(HttpClientResponse.toWeb(upstream))
    const succeeded = upstream.status >= 200 && upstream.status < 300
    if (!succeeded && upstream.status !== 416) {
      yield* Effect.tryPromise(
        () => source.body?.cancel() ?? Promise.resolve()
      ).pipe(Effect.ignore)
      return new Response(
        "Drive preview unavailable. Try reconnecting in settings.",
        { status: upstream.status === 404 ? 404 : 502 }
      )
    }
    const responseHeaders = new Headers({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type":
        options.as === "mp4" && canRelabelAsMp4(media.mime_type)
          ? "video/mp4"
          : media.mime_type,
    })
    for (const key of ["content-length", "content-range", "accept-ranges"]) {
      const value = source.headers.get(key)
      if (value) responseHeaders.set(key, value)
    }
    // A player asks for many ranges of one video: count the opening request.
    if (
      options.as === "mp4" &&
      canRelabelAsMp4(media.mime_type) &&
      (!range || range.startsWith("bytes=0-"))
    )
      yield* countFallback("mp4")
    return new Response(source.body, {
      status: source.status,
      headers: responseHeaders,
    })
  },
  Effect.catch((error) =>
    // A person who has to reconnect Google is an outcome, not a fault: log it
    // at a warning and keep the error log for what nobody expected.
    (isExpectedAppError(error)
      ? Effect.logWarning("Drive media unavailable", { reason: error._tag })
      : Telemetry.logException(error, { operation: "Media.stream" })
    ).pipe(Effect.as(unavailable()))
  )
)

// A JPEG of an image the browser couldn't display, rendered by Google.
export const render = Effect.fn("Media.render")(
  function* (request: Request, media: { drive_id: string }) {
    const token = yield* Drive.readToken(undefined, request.headers)
    yield* countFallback("rendered")
    const image = yield* renderImage(media.drive_id, token)
    const etag = image.etag
    const headers = new Headers({
      "Cache-Control": "private, max-age=300, must-revalidate",
      Vary: "Cookie",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": image.contentType,
    })
    if (request.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers })
    headers.set("Content-Length", String(image.bytes.byteLength))
    return new Response(image.bytes, { headers })
  },
  Effect.catchTag("ThumbnailError", (error) =>
    Effect.logWarning("Rendered preview failed", { status: error.status }).pipe(
      Effect.as(
        new Response(error.message, {
          status: error.status,
          headers: { "Cache-Control": "no-store" },
        })
      )
    )
  ),
  Effect.catch((error) =>
    (isExpectedAppError(error)
      ? Effect.logWarning("Drive media unavailable", { reason: error._tag })
      : Telemetry.logException(error, { operation: "Media.render" })
    ).pipe(Effect.as(unavailable()))
  )
)
