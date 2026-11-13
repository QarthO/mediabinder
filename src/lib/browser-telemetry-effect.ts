// The Effect side of browser telemetry. Kept apart from browser-telemetry.ts
// so the initial bundle, which imports that module, does not import `effect`.
import { Effect, Option } from "effect"

import {
  browserTelemetryRuntime,
  browserTraceSampleRatio,
} from "./browser-telemetry"
import { keepBrowserTrace } from "./browser-trace-sampling"

/**
 * Runs an effect on the telemetry runtime when it is running, so its spans
 * are exported, and on the default runtime otherwise.
 */
export function runBrowserEffect<A, E>(
  effect: Effect.Effect<A, E>,
  options?: { signal?: AbortSignal }
): Promise<A> {
  const runtime = browserTelemetryRuntime()
  return runtime
    ? runtime.runPromise(effect, options)
    : Effect.runPromise(effect, options)
}

/**
 * The W3C `traceparent` for work the server does within the current effect's
 * span. Its sampled flag follows `keepBrowserTrace`, as the server's proxy
 * does for the browser's own spans of the trace, so the two halves are kept or
 * dropped together. Undefined outside `runBrowserEffect` or while telemetry is
 * off.
 */
export const currentBrowserTraceparent: Effect.Effect<string | undefined> =
  Effect.gen(function* () {
    if (!browserTelemetryRuntime()) return undefined
    const ratio = browserTraceSampleRatio()
    if (ratio === undefined) return undefined
    const span = yield* Effect.option(Effect.currentSpan)
    if (Option.isNone(span)) return undefined
    const { traceId, spanId } = span.value
    return `00-${traceId}-${spanId}-${keepBrowserTrace(traceId, ratio) ? "01" : "00"}`
  })
