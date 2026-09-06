import { runServer } from "@/effect/runtime.server"
import { createFileRoute } from "@tanstack/react-router"
import { requireSession } from "@/lib/auth.server"
import { library, mutate } from "@/lib/library.server"
import { libraryPost } from "@/lib/library-http"
export const Route = createFileRoute("/api/library")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await requireSession(request.headers)
        return Response.json(await library(session.user), {
          headers: { "Cache-Control": "no-store" },
        })
      },
      POST: ({ request }) =>
        runServer(
          libraryPost(request, { session: requireSession, mutate }),
          request.signal
        ),
    },
  },
})
