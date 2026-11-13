import { reportAppError, runAppEffect } from "@/effect/runtime.server"
import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"
import { requireSession } from "@/lib/auth.server"
import { errorResponse } from "@/lib/http-errors"
import { load, mutate } from "@/lib/library.server"
import { libraryPost } from "@/lib/library-http"
export const Route = createFileRoute("/api/library")({
  server: {
    handlers: {
      GET: ({ request }) =>
        runAppEffect(
          "Library.get",
          Effect.gen(function* () {
            const session = yield* requireSession(request.headers)
            const data = yield* load(session.user)
            return Response.json(data, {
              headers: { "Cache-Control": "no-store" },
            })
          }).pipe(
            // Anything else is unexpected: it is thrown, so it is reported
            // and answered with a 500.
            Effect.catchTag("AuthenticationError", (error) =>
              Effect.succeed(errorResponse(error))
            )
          ),
          { signal: request.signal }
        ),
      POST: ({ request }) =>
        runAppEffect(
          "Library.post",
          libraryPost(request, {
            session: requireSession,
            mutate,
            report: reportAppError,
          }),
          { signal: request.signal }
        ),
    },
  },
})
