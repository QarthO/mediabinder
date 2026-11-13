import { disposeAppRuntime, runAppEffect } from "../src/effect/runtime.server"
import { migrate } from "../src/effect/migrations"

// Runs on the app runtime, then disposes it so telemetry flushes before exit.
try {
  await runAppEffect("Migrations.run", migrate())
} catch (error) {
  console.error("Migrations failed:", error)
  process.exitCode = 1
} finally {
  await disposeAppRuntime()
}
process.exit()
