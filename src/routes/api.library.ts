import { createFileRoute } from "@tanstack/react-router"
import { requireSession } from "@/lib/auth.server"
import { library, mutate } from "@/lib/library.server"
import { ZodError } from "zod"
export const Route = createFileRoute("/api/library")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await requireSession(request.headers)
        return Response.json(await library(session.user), {
          headers: { "Cache-Control": "no-store" },
        })
      },
      POST: async ({ request }) => {
        if (
          request.headers.get("origin") !==
          new URL(process.env.BETTER_AUTH_URL!).origin
        )
          return new Response("Invalid origin.", { status: 403 })
        const session = await requireSession(request.headers)
        if (Number(request.headers.get("content-length")) > 65536)
          return new Response("Request too large.", { status: 413 })
        try {
          const { action, data } = await request.json()
          return Response.json(
            await mutate(action, data, session.user.id, request.headers),
            { headers: { "Cache-Control": "no-store" } }
          )
        } catch (error) {
          if (error instanceof Response) return error
          if (error instanceof ZodError)
            return Response.json(
              {
                error: error.issues[0]?.message ?? "Check the entered values.",
              },
              { status: 400 }
            )
          console.error("Library action failed:", error)
          const message =
            error instanceof Error &&
            /^(Google |Reconnect |Choose |A sync |The source |This file)/.test(
              error.message
            )
              ? error.message
              : "Could not save this change. Please try again."
          return Response.json({ error: message }, { status: 400 })
        }
      },
    },
  },
})
