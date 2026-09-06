import { runServer } from "@/effect/runtime.server"
import { createFileRoute } from "@tanstack/react-router"
import { requireSession } from "@/lib/auth.server"
import { rows } from "@/lib/database.server"
import { thumbnailResponse } from "@/effect/thumbnails.server"
import { mediaResponse } from "@/effect/media.server"
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
          "SELECT drive_id,mime_type,available FROM media WHERE catalog_id=? AND user_id=? AND available=TRUE ORDER BY uploaded_at DESC,id LIMIT 1",
          [params.id, session.user.id]
        )
        if (!media?.available)
          return new Response("File unavailable.", { status: 404 })
        if (new URL(request.url).searchParams.has("thumbnail"))
          return thumbnailResponse(session.user.id, media.drive_id, request)
        return runServer(mediaResponse(request, media), request.signal)
      },
    },
  },
})
