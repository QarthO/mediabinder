import { runAppEffect, runAppEffectUntraced } from "@/effect/runtime.server"
import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { requireSession } from "@/lib/auth.server"
import { Database } from "@/effect/database"
import { errorResponse } from "@/lib/http-errors"
import { thumbnailResponse } from "@/effect/thumbnails.server"
import * as Media from "@/effect/media.server"
import { canRelabelAsMp4 } from "@/lib/media-formats"
export const Route = createFileRoute("/api/media/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        const query = new URL(request.url).searchParams
        const thumbnail = query.has("thumbnail")
        // Viewer fallbacks. `?as=mp4` relabels a QuickTime-family video and
        // `?rendered` asks Google for a JPEG of an image. Anything the file's
        // type doesn't allow is a 400, not ignored: a quiet fallback to the
        // stored type would hide a client bug, and neither option may widen
        // what a file is served as.
        const as = query.get("as")
        const rendered = query.has("rendered")
        const program = Effect.gen(function* () {
          const session = yield* requireSession(request.headers)
          const database = yield* Database
          const [media] = yield* database.queryRows<
            {
              drive_id: string
              mime_type: string
              available: number
            } & RowDataPacket
          >(
            "media.lookup",
            "SELECT drive_id,mime_type,available FROM media WHERE catalog_id=? AND user_id=? AND available=TRUE ORDER BY uploaded_at DESC,id LIMIT 1",
            [params.id, session.user.id]
          )
          if (!media?.available)
            return new Response("File unavailable.", { status: 404 })
          if (thumbnail)
            return yield* Effect.promise(() =>
              thumbnailResponse(session.user.id, media.drive_id, request)
            )
          if (rendered) {
            if (as !== null || !media.mime_type.startsWith("image/"))
              return new Response("Not available for this file.", {
                status: 400,
              })
            return yield* Media.render(request, media)
          }
          if (as !== null) {
            if (as !== "mp4" || !canRelabelAsMp4(media.mime_type))
              return new Response("Not available for this file.", {
                status: 400,
              })
            return yield* Media.stream(request, media, { as })
          }
          return yield* Media.stream(request, media)
        }).pipe(
          Effect.catchTag("AuthenticationError", (error) =>
            Effect.succeed(errorResponse(error))
          )
        )
        // A library view loads dozens of thumbnails, so they are metrics,
        // not traces (see src/effect/thumbnails.ts).
        return thumbnail
          ? runAppEffectUntraced(program, { signal: request.signal })
          : runAppEffect("Media.get", program, { signal: request.signal })
      },
    },
  },
})
