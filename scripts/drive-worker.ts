import { Cause, Effect, Fiber, Metric, Schedule } from "effect"
import {
  disposeAppRuntime,
  forkAppWorker,
  reportAppError,
} from "../src/effect/runtime.server"
import { driveWebhookUrl } from "../src/lib/config"
import { closeAuthPool } from "../src/lib/auth.server"
import { pass } from "../src/lib/drive-webhook.server"

// The worker's telemetry is its own service. The app runtime is built on
// first use, after this line.
process.env.MEDIABINDER_SERVICE_NAME = "mediabinder-worker"

const passes = Metric.counter("mediabinder.worker.passes", {
  description:
    "Passes the Drive worker made, by outcome: it worked, found nothing, or failed",
  attributes: { unit: "{pass}" },
  incremental: true,
})
const count = (outcome: "worked" | "idle" | "failed") =>
  Metric.update(Metric.withAttributes(passes, { outcome }), 1)

// A pass fails again every ten seconds while MySQL is down; only a failure
// that differs from the last one is reported, until a pass succeeds.
let lastFailure: string | null = null

const runPass = pass.pipe(
  Effect.tap((outcome) => {
    lastFailure = null
    return count(outcome)
  }),
  Effect.catchCause((cause) => {
    // A stop is not a failure.
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
    const error = Cause.squash(cause)
    const message = error instanceof Error ? error.message : String(error)
    return Effect.sync(() => {
      if (message === lastFailure) return
      lastFailure = message
      reportAppError(cause, { operation: "DriveWorker.pass" })
    }).pipe(Effect.andThen(count("failed")))
  })
)

// The loop has no span of its own; the passes that find work do. The next
// pass starts ten seconds after the last one ended.
const program = Effect.logInfo(
  `Drive worker started; webhook registration ${driveWebhookUrl() ? "enabled" : "disabled"}`
).pipe(
  Effect.andThen(runPass.pipe(Effect.repeat(Schedule.spaced("10 seconds"))))
)

const worker = forkAppWorker(program)

// Stopping fits inside scripts/start.ts's 25 s kill deadline and compose's
// 45 s stop_grace_period: interrupting the loop releases the lock connection
// and leaves a running sync's row to read as interrupted; then telemetry is
// flushed.
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  setTimeout(() => process.exit(1), 20_000).unref()
  void Effect.runPromise(Fiber.interrupt(worker))
    .then(() => disposeAppRuntime())
    .then(() => closeAuthPool())
    .then(
      () => process.exit(0),
      () => process.exit(1)
    )
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)

// The loop only ends by being stopped. If it ever dies, the supervisor
// restarts the container.
void Effect.runPromise(Fiber.await(worker)).then(() => {
  if (stopping) return
  console.error("The Drive worker stopped unexpectedly.")
  process.exit(1)
})
