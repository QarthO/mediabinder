import { disposeAppRuntime, runAppEffect } from "../src/effect/runtime.server"
import { migrate } from "../src/effect/migrations"

// Runs on the app runtime, then disposes it so telemetry flushes before exit.
try {
  await runAppEffect("Migrations.run", migrate())
  // A dev stack gets its developer and prelinked folder; this is a no-op
  // unless MEDIABINDER_ENVIRONMENT=dev outside a production NODE_ENV.
  const { developmentBypassEnabled } = await import("../src/lib/config")
  if (developmentBypassEnabled()) {
    const { prepare } = await import("../src/lib/development.server")
    await runAppEffect("Development.prepareStack", prepare())
  }
} catch (error) {
  console.error("Migrations failed:", error)
  process.exitCode = 1
} finally {
  await disposeAppRuntime()
}
process.exit()
