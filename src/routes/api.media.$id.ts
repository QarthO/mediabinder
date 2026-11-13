import { runAppEffect } from "@/effect/runtime.server"
import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { requireSession } from "@/lib/auth.server"
import { Database } from "@/effect/database"
import { errorResponse } from "@/lib/http-errors"
import { thumbnailResponse } from "@/effect/thumbnails.server"
import * as Media from "@/effect/media.server"
export const Route = createFileRoute("/api/media/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        runAppEffect(
          "Media.get",
          Effect.gen(function* () {
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
            if (new URL(request.url).searchParams.has("thumbnail"))
              return yield* Effect.promise(() =>
                thumbnailResponse(session.user.id, media.drive_id, request)
              )
            return yield* Media.stream(request, media)
          }).pipe(
            Effect.catchTag("AuthenticationError", (error) =>
              Effect.succeed(errorResponse(error))
            )
          ),
          { signal: request.signal }
        ),
    },
  },
})
