import {
  Cause,
  Effect,
  Exit,
  Layer,
  Logger,
  ManagedRuntime,
  Result,
} from "effect"
import type { Fiber, Tracer } from "effect"
import { isExpectedAppError } from "@/observability/error-policy"
import * as Telemetry from "@/telemetry"
import { Database, DatabaseLive } from "./database"
import { ProcessMetricsLive } from "./process-metrics.server"
import { ThumbnailSourceLive } from "./thumbnail-source.server"
import { Thumbnails } from "./thumbnails"

// Vite replaces this at build time. The worker and migration scripts run
// under tsx, where `import.meta.env` doesn't exist, so they fall back to the
// environment (Coolify sets SOURCE_COMMIT).
const sourceCommit =
  Result.getOrElse(
    Result.try(() => import.meta.env.VITE_MEDIABINDER_SOURCE_SHA),
    () => undefined
  ) ||
  process.env.SOURCE_COMMIT ||
  process.env.COMMIT_SHA ||
  undefined

// package.json carries no version, so the commit identifies the release.
// The Drive worker is its own process with its own telemetry identity: it sets
// MEDIABINDER_SERVICE_NAME before the runtime's first use, which is when this
// layer is built (the runtime is lazy), not when the module loads.
const TelemetryLive = Layer.unwrap(
  Effect.sync(() =>
    Telemetry.layer({
      serviceName: process.env.MEDIABINDER_SERVICE_NAME || "mediabinder",
      serviceVersion: sourceCommit,
      attributes: sourceCommit ? { "vcs.ref.head.revision": sourceCommit } : {},
    })
  )
)

/** What every effect run on MediaBinder's runtime may use. */
export type AppServices = Thumbnails | Database

// JSON lines on stdout stay the readable `docker logs` format. Telemetry is
// provided with this layer so its OTLP logger merges with it.
const ConsoleLogLive = Logger.layer([Logger.consoleJson])
const AppLive = Layer.mergeAll(
  Thumbnails.layer.pipe(Layer.provide(ThumbnailSourceLive)),
  // Connects on first query, so a MySQL outage doesn't stop this runtime
  // from building: thumbnails and /api/health still work.
  DatabaseLive,
  TelemetryLive,
  ProcessMetricsLive
).pipe(Layer.provideMerge(ConsoleLogLive))
const runtime = ManagedRuntime.make(AppLive)

async function runInActiveTrace<TResult, TError>(
  effect: Effect.Effect<TResult, TError, AppServices>,
  options?: { signal?: AbortSignal }
): Promise<TResult> {
  const exit = await runtime.runPromiseExit(
    Telemetry.withActiveParent(effect),
    options
  )
  if (Exit.isSuccess(exit)) return exit.value
  // Stopped only because whoever asked gave up, as a browser does when it
  // leaves the page: an abort, which isn't reported, rather than a failure.
  // Anything that went wrong as well is still thrown and reported.
  if (options?.signal?.aborted && Cause.hasInterruptsOnly(exit.cause)) {
    throw new DOMException("The request was aborted", "AbortError")
  }
  throw Cause.squash(exit.cause)
}

export function runAppEffect<TResult, TError>(
  name: string,
  effect: Effect.Effect<TResult, TError, AppServices>,
  options?: { signal?: AbortSignal }
): Promise<TResult> {
  return runInActiveTrace(Effect.withSpan(effect, name), options)
}

/**
 * Runs an effect that opens its own span, an `Effect.fn("Area.operation")`,
 * under the span active in the caller's trace. For facades over converted
 * modules: `runAppEffect` would add a second span with the same name.
 */
export function runTracedAppEffect<TResult, TError>(
  effect: Effect.Effect<TResult, TError, AppServices>,
  options?: { signal?: AbortSignal }
): Promise<TResult> {
  return runInActiveTrace(effect, options)
}

/**
 * Runs a check too frequent to trace, such as a health probe or a worker's
 * idle poll.
 */
export function runAppEffectUntraced<TResult, TError>(
  effect: Effect.Effect<TResult, TError, AppServices>
): Promise<TResult> {
  return runtime.runPromise(Effect.withTracerEnabled(effect, false))
}

/**
 * Starts a long-lived worker on the runtime, such as the Drive worker's loop.
 * It gets no span of its own: the work it does is spanned job by job. Disposing
 * the runtime doesn't interrupt it, so interrupt the fiber first.
 */
export function forkAppWorker<TResult, TError>(
  effect: Effect.Effect<TResult, TError, AppServices>
): Fiber.Fiber<TResult, TError> {
  return runtime.runFork(effect)
}

export function forkAppEffect<TResult, TError>(
  name: string,
  effect: Effect.Effect<TResult, TError, AppServices>
): Fiber.Fiber<TResult, unknown> {
  return runtime.runFork(effect.pipe(Effect.withSpan(name)))
}

/**
 * Forks work a request starts but doesn't wait for into that request's
 * trace.
 */
export function forkAppEffectInTrace<TResult, TError>(
  name: string,
  effect: Effect.Effect<TResult, TError, AppServices>
): Fiber.Fiber<TResult, unknown> {
  return runtime.runFork(
    Telemetry.withActiveParent(effect.pipe(Effect.withSpan(name)))
  )
}

/** Traces promise code; effects it runs become child spans. */
export function traceAppPromise<TResult>(
  name: string,
  run: (span: Tracer.Span) => Promise<TResult>,
  attributes?: Record<string, unknown>
): Promise<TResult> {
  return runtime.runPromise(
    Telemetry.withActiveParent(
      Telemetry.spanPromise(name, run, attributes ? { attributes } : undefined)
    )
  )
}

/**
 * Exports an unexpected error as an error log. Expected outcomes such as a
 * rejected request or a missing thumbnail are skipped.
 */
export function reportAppError(
  cause: unknown,
  context?: Telemetry.ErrorContext
): void {
  if (isExpectedAppError(cause)) return
  runtime.runFork(
    Telemetry.withActiveParent(Telemetry.logException(cause, context))
  )
}

/**
 * Exports a log line from code outside an effect. Logs aren't sampled, so
 * rare events are always kept, unlike their traces.
 */
export function logAppEvent(
  level: "info" | "warning",
  message: string,
  annotations: Readonly<Record<string, string | number | boolean | null>>
): void {
  const log = level === "info" ? Effect.logInfo : Effect.logWarning
  runtime.runFork(log(message).pipe(Effect.annotateLogs(annotations)))
}

export async function disposeAppRuntime(): Promise<void> {
  await runtime.dispose()
}

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    void disposeAppRuntime()
  })
