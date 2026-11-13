import { runAppEffect } from "@/effect/runtime.server"
import { createFileRoute } from "@tanstack/react-router"
import { forwardBrowserTelemetry } from "@/lib/browser-telemetry.server"

export const Route = createFileRoute("/api/telemetry/v1/$signal")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        runAppEffect(
          "BrowserTelemetry.forward",
          forwardBrowserTelemetry(request, params.signal),
          { signal: request.signal }
        ),
    },
  },
})
