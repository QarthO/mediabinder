import { Effect } from "effect"
import { driveToken } from "@/lib/drive.server"

// Keep the native response stream alive after headers are returned. The incoming
// request signal owns the download lifetime, including browser cancellation.
export const mediaResponse = Effect.fn("drive.media")(
  function* (request: Request, media: { drive_id: string; mime_type: string }) {
    const token = yield* Effect.tryPromise(() => driveToken(request.headers))
    const headers = new Headers({ Authorization: `Bearer ${token}` })
    const range = request.headers.get("range")
    if (range) {
      if (!/^bytes=\d*-\d*$/.test(range))
        return new Response("Invalid range.", { status: 416 })
      headers.set("Range", range)
    }
    const upstream = yield* Effect.tryPromise(() =>
      fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(media.drive_id)}?alt=media&supportsAllDrives=true`,
        { headers, signal: request.signal }
      )
    )
    yield* Effect.annotateCurrentSpan({
      "http.response.status_code": upstream.status,
    })
    if (!upstream.ok && upstream.status !== 416) {
      yield* Effect.tryPromise(
        () => upstream.body?.cancel() ?? Promise.resolve()
      )
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
      const value = upstream.headers.get(key)
      if (value) responseHeaders.set(key, value)
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    })
  },
  Effect.catch(() =>
    Effect.succeed(
      new Response(
        "Drive preview unavailable. Reconnect in settings and retry.",
        { status: 502 }
      )
    )
  )
)
