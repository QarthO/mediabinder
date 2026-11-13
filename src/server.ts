import {
  createServerEntry,
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server"

import { closeAuthPool } from "./lib/auth.server"
import { disposeAppRuntime } from "./effect/runtime.server"

// The same handler TanStack Start would generate; the entry only adds
// `shutdown`, so the built server can be stopped from outside (see
// scripts/serve.mjs).
export default createServerEntry({
  fetch: createStartHandler(defaultStreamHandler),
})

/**
 * Flushes the last telemetry batch and closes the database connections.
 * Call it once the server has stopped taking requests. Safe to call twice.
 */
export const shutdown = (() => {
  let stopping: Promise<void> | undefined
  return () =>
    (stopping ??= disposeAppRuntime().then(
      () => closeAuthPool(),
      () => closeAuthPool()
    ))
})()
