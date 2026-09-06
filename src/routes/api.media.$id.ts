import { createFileRoute } from "@tanstack/react-router"
import { requireSession } from "@/lib/auth.server"
import { rows } from "@/lib/database.server"
import { thumbnailResponse } from "@/effect/thumbnails.server"
import { driveToken } from "@/lib/drive.server"
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
          if (new URL(request.url).searchParams.has("thumbnail")) {
            return await thumbnailResponse(
              session.user.id,
              media.drive_id,
              request
            )
          }
          const token = await driveToken(request.headers)
          const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(media.drive_id)}?alt=media&supportsAllDrives=true`
          const headers = new Headers({ Authorization: `Bearer ${token}` })
          const range = request.headers.get("range")
          if (range) {
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
            "Content-Type": media.mime_type,
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
