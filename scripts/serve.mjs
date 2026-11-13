import { fileURLToPath } from "node:url"

import { serve } from "srvx/node"
import { loggerMiddleware } from "srvx/log"
import { staticMiddleware } from "srvx/static"
import app from "../dist/server/server.js"

const HEALTH_PATH = "/api/health"
const logRequest = loggerMiddleware()

if (!app || typeof app.fetch !== "function") {
  throw new Error("The production server handler could not be loaded")
}

const server = serve({
  fetch: app.fetch,
  error(error) {
    console.error(error)
    return new Response("Internal Server Error", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      status: 500,
    })
  },
  gracefulShutdown: false,
  hostname: process.env.HOST || "0.0.0.0",
  middleware: [
    logUnlessSuccessfulHealthCheck,
    cacheImmutableAssets,
    staticMiddleware({
      dir: fileURLToPath(new URL("../dist/client", import.meta.url)),
    }),
  ],
  port: Number(process.env.PORT || 3100),
})

await server.ready()

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

// Vite hashes everything under /assets, so those files never change in place.
// HTML and API responses come from the app and keep the headers it sets.
async function cacheImmutableAssets(request, next) {
  const response = await next()
  if (
    response.ok &&
    (request.method === "GET" || request.method === "HEAD") &&
    new URL(request.url).pathname.startsWith("/assets/")
  ) {
    response.headers.set("Cache-Control", "public, max-age=31536000, immutable")
  }
  return response
}

// The container health check runs every few seconds; only its failures are worth a line.
async function logUnlessSuccessfulHealthCheck(request, next) {
  if (new URL(request.url).pathname !== HEALTH_PATH) {
    return logRequest(request, next)
  }
  const startedAt = performance.now()
  const response = await next()
  if (!response.ok) {
    const duration = (performance.now() - startedAt).toFixed(2)
    console.error(
      `[${new Date().toLocaleTimeString()}] ${request.method} ${request.url} [${response.status}] (${duration}ms)`
    )
  }
  return response
}
