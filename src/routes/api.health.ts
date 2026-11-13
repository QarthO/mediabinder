import { Effect } from "effect"
import { reportAppError, runAppEffectUntraced } from "@/effect/runtime.server"
import { Database } from "@/effect/database"
import { createFileRoute } from "@tanstack/react-router"
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        try {
          // Docker probes this every 30 seconds; a trace per probe would bury
          // real requests, as the request middleware's exclusion intends.
          await runAppEffectUntraced(
            Effect.gen(function* () {
              const database = yield* Database
              return yield* database.queryRows("health.ping", "SELECT 1")
            }).pipe(Effect.timeout("3 seconds"))
          )
          return Response.json({
            status: "ok",
            commit: import.meta.env.VITE_MEDIABINDER_BUILD_SHA ?? "",
          })
        } catch (cause) {
          reportAppError(cause, { operation: "Health.check" })
          return Response.json({ status: "unavailable" }, { status: 503 })
        }
      },
    },
  },
})
