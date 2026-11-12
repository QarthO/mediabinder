import { reportAppError } from "@/effect/runtime.server"
import { createFileRoute } from "@tanstack/react-router"
import { receiveDriveNotification } from "@/lib/drive-webhook.server"
export const Route = createFileRoute("/api/drive/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          return new Response(null, {
            status: await receiveDriveNotification(request.headers),
          })
        } catch (cause) {
          reportAppError(cause, { operation: "Drive.webhook" })
          return new Response(null, { status: 503 })
        }
      },
    },
  },
})
