import { serve } from "srvx/node"
import { serveStatic } from "srvx/static"
import app from "../dist/server/server.js"
const server = serve({
  fetch: app.fetch,
  gracefulShutdown: false,
  port: Number(process.env.PORT || 3100),
  hostname: process.env.HOST || "0.0.0.0",
  middleware: [
    serveStatic({ dir: new URL("../dist/client/", import.meta.url).pathname }),
  ],
})

let stopping = false
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    if (stopping) return
    stopping = true
    const deadline = setTimeout(() => process.exit(1), 10_000)
    deadline.unref()
    // Drain HTTP requests, then exit so idle database connections cannot keep the child alive.
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1)
    )
  })
}
