import { createFileRoute } from "@tanstack/react-router"
import { Cause, Effect } from "effect"
import { runAppEffect } from "@/effect/runtime.server"
import { receive } from "@/lib/drive-webhook.server"
import { isExpectedAppError } from "@/observability/error-policy"
import * as Telemetry from "@/telemetry"

export const Route = createFileRoute("/api/drive/webhook")({
  server: {
    handlers: {
      // Google only reads the status: 204 accepted, 400 malformed, 403 not a
      // channel of ours, and 503 for anything that went wrong on our side so
      // that Google retries.
      POST: ({ request }) =>
        runAppEffect(
          "Drive.webhook",
          receive(request.headers).pipe(
            Effect.map((status) => new Response(null, { status })),
            Effect.catchCause((cause) => {
              const error = Cause.squash(cause)
              return (
                isExpectedAppError(error)
                  ? Effect.void
                  : Telemetry.logException(cause, {
                      operation: "Drive.webhook",
                    })
              ).pipe(Effect.as(new Response(null, { status: 503 })))
            })
          )
        ),
    },
  },
})
