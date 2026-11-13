import { Effect, Option } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { isExpectedAppError } from "@/observability/error-policy"
import * as Telemetry from "@/telemetry"
import * as Drive from "./drive-api.server"
import { DRIVE_API, driveRequest } from "./drive-http.server"

const unavailable = () =>
  new Response("Drive preview unavailable. Reconnect in settings and retry.", {
    status: 502,
  })

// Keep the native response stream alive after headers are returned. The incoming
// request signal owns the download lifetime, including browser cancellation.
export const stream = Effect.fn("Media.stream")(
  function* (request: Request, media: { drive_id: string; mime_type: string }) {
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
      "Content-Type": media.mime_type,
    })
    for (const key of ["content-length", "content-range", "accept-ranges"]) {
      const value = source.headers.get(key)
      if (value) responseHeaders.set(key, value)
    }
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
