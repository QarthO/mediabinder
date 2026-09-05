import { serve } from "srvx/node"
import { serveStatic } from "srvx/static"
import app from "../dist/server/server.js"
serve({
  fetch: app.fetch,
  port: Number(process.env.PORT || 3100),
  hostname: process.env.HOST || "0.0.0.0",
  middleware: [
    serveStatic({ dir: new URL("../dist/client/", import.meta.url).pathname }),
  ],
})
