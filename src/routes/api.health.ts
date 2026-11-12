import { createFileRoute } from "@tanstack/react-router"
import { pool } from "@/lib/database.server"
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        try {
          await pool.query("SELECT 1")
          return Response.json({
            status: "ok",
            commit: import.meta.env.VITE_MEDIABINDER_BUILD_SHA ?? "",
          })
        } catch {
          return Response.json({ status: "unavailable" }, { status: 503 })
        }
      },
    },
  },
})
