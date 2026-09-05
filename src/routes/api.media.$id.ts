import { createFileRoute } from "@tanstack/react-router"
import { requireSession } from "@/lib/auth.server"
import { rows } from "@/lib/database.server"
import { driveJson, driveToken } from "@/lib/drive.server"
export const Route = createFileRoute("/api/media/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await requireSession(request.headers)
        const [media] = await rows<{
          drive_id: string
          mime_type: string
          available: number
        }>(
          "SELECT drive_id,mime_type,available FROM media WHERE id=? AND user_id=?",
          [params.id, session.user.id]
        )
        if (!media?.available)
          return new Response("File unavailable.", { status: 404 })
        try {
          const token = await driveToken(request.headers)
          const thumbnail = new URL(request.url).searchParams.has("thumbnail")
          let url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(media.drive_id)}?alt=media&supportsAllDrives=true`
          if (thumbnail) {
            const file = await driveJson<{ thumbnailLink?: string }>(
              token,
              `files/${encodeURIComponent(media.drive_id)}`,
              { fields: "thumbnailLink", supportsAllDrives: "true" }
            )
            if (!file.thumbnailLink)
              return new Response("No thumbnail available.", { status: 404 })
            const thumbUrl = new URL(file.thumbnailLink)
            if (
              thumbUrl.protocol !== "https:" ||
              !["googleusercontent.com", "google.com"].some(
                (host) =>
                  thumbUrl.hostname === host ||
                  thumbUrl.hostname.endsWith(`.${host}`)
              )
            )
              return new Response("Invalid thumbnail.", { status: 502 })
            url = file.thumbnailLink.replace(/=s\d+$/, "=s640")
          }
          const headers = new Headers({ Authorization: `Bearer ${token}` })
          const range = request.headers.get("range")
          if (range && !thumbnail) {
            if (!/^bytes=\d*-\d*$/.test(range))
              return new Response("Invalid range.", { status: 416 })
            headers.set("Range", range)
          }
          const upstream = await fetch(url, {
            headers,
            signal: request.signal,
          })
          const responseHeaders = new Headers({
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Type": thumbnail
              ? (upstream.headers.get("content-type") ?? "image/jpeg")
              : media.mime_type,
          })
          for (const key of [
            "content-length",
            "content-range",
            "accept-ranges",
          ]) {
            const value = upstream.headers.get(key)
            if (value) responseHeaders.set(key, value)
          }
          if (!upstream.ok && upstream.status !== 416) {
            await upstream.body?.cancel()
            return new Response(
              "Drive preview unavailable. Try reconnecting in settings.",
              { status: upstream.status === 404 ? 404 : 502 }
            )
          }
          // Forward the stream with backpressure and cancellation; never buffer entire videos.
          return new Response(upstream.body, {
            status: upstream.status,
            headers: responseHeaders,
          })
        } catch {
          return new Response(
            "Drive preview unavailable. Reconnect in settings and retry.",
            { status: 502 }
          )
        }
      },
    },
  },
})
