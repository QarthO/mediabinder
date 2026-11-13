// The OpenTelemetry runtime for the browser. Loaded lazily by
// browser-telemetry.ts; never import it statically.
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  Tracer,
} from "effect"
import { FetchHttpClient } from "effect/http"
import {
  OtlpExporter,
  OtlpLogger,
  OtlpSerialization,
  OtlpTracer,
} from "effect/observability"

import { isExpectedAppError } from "@/observability/error-policy"
import { logExceptionDetails } from "@/telemetry"
import { routeTemplate, scrubException } from "./browser-privacy"
import type { ScrubbedException } from "./browser-privacy"
import type { BrowserSpan, BrowserTelemetryRuntime } from "./browser-telemetry"

const nowNanos = (at = performance.now()) =>
  BigInt(Math.round((performance.timeOrigin + at) * 1e6))

// What a failed span exports in place of its error. Effect's exporter writes
// the error's message and stack into the span's status and an `exception`
// event, and a message can quote a name or what the person typed, so the span
// gets the scrubbed type, status and frames only.
class ScrubbedSpanError extends Error {
  constructor(scrubbed: ScrubbedException) {
    super(scrubbed.message)
    this.name = scrubbed.type
    this.stack = [`${scrubbed.type}: ${scrubbed.message}`, scrubbed.stacktrace]
      .filter(Boolean)
      .join("\n")
  }
}

const scrubbingTracer = (tracer: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const span = tracer.span(options)
      const end = span.end.bind(span)
      ;(span as { end: Tracer.Span["end"] }).end = (endTime, exit) =>
        end(
          endTime,
          Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
            ? Exit.fail(
                new ScrubbedSpanError(scrubException(Cause.squash(exit.cause)))
              )
            : exit
        )
      return span
    },
    context: tracer.context,
  })

/** Starts exporting browser traces and error logs through the proxy. */
export async function createBrowserTelemetry(): Promise<BrowserTelemetryRuntime> {
  const endpoint = (signal: "logs" | "traces") =>
    new URL(`/api/telemetry/v1/${signal}`, window.location.origin).toString()
  // The proxy overwrites the resource; this is for the payload's own sake.
  const resource = { serviceName: "mediabinder-browser" }
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.effect(
        Tracer.Tracer,
        // Batches stay under the 64 KiB limit for keepalive requests, so
        // spans still leave the page while it unloads.
        OtlpTracer.make({
          url: endpoint("traces"),
          resource,
          maxBatchSize: 50,
        }).pipe(Effect.map(scrubbingTracer))
      ),
      Logger.layer(
        [OtlpLogger.make({ url: endpoint("logs"), resource, maxBatchSize: 5 })],
        { mergeWithExisting: false }
      )
    ).pipe(
      Layer.provideMerge(OtlpExporter.layerFlusher),
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(
        Layer.succeed(FetchHttpClient.RequestInit, { keepalive: true })
      )
    )
  )
  const tracer = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* Tracer.Tracer
    })
  )
  const spans = new WeakMap<BrowserSpan, Tracer.Span>()

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return
    runtime.runFork(
      Effect.gen(function* () {
        const flusher = yield* OtlpExporter.Flusher
        yield* flusher.flush
      })
    )
  })

  return {
    runPromise: (effect, options) => runtime.runPromise(effect, options),
    report: (cause, context) => {
      if (isExpectedAppError(cause)) return
      const exception = scrubException(cause)
      runtime.runFork(
        logExceptionDetails(exception, {
          operation: context.operation,
          attributes: {
            "url.path": routeTemplate(window.location.pathname),
            "http.response.status_code": exception.status,
          },
        })
      )
    },
    startSpan: (name, options) => {
      const parent = options?.parent ? spans.get(options.parent) : undefined
      const span = tracer.span({
        name,
        parent: parent ? Option.some(parent) : Option.none(),
        annotations: Context.empty(),
        links: [],
        startTime: nowNanos(options?.startedAt),
        kind: "internal",
        root: parent === undefined,
        sampled: true,
      })
      for (const [key, value] of Object.entries(options?.attributes ?? {}))
        span.attribute(key, value)
      let ended = false
      const handle: BrowserSpan = {
        setAttribute: (key, value) => span.attribute(key, value),
        end: (error, endedAt) => {
          if (ended) return
          ended = true
          span.end(
            nowNanos(endedAt),
            error === undefined ? Exit.void : Exit.fail(error)
          )
        },
      }
      spans.set(handle, span)
      return handle
    },
  }
}
