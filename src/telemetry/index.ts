/**
 * OpenTelemetry export for MediaBinder, configured only through the standard
 * OTEL_* environment variables so any OTLP backend works:
 *
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`: nothing
 *   is exported without an endpoint. `OTEL_EXPORTER_OTLP_{TRACES,LOGS,METRICS}_ENDPOINT`
 *   override it per signal and are used as given (a full URL).
 * - `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER`: a
 *   signal is exported only when its variable includes `otlp`. Traces and
 *   logs default to `otlp`; metrics default to off. `none` turns one off.
 * - `OTEL_TRACES_SAMPLER_ARG`: share of traces kept (default 1)
 * - `OTEL_RESOURCE_ATTRIBUTES`, e.g. `deployment.environment.name=production`
 * - `OTEL_SDK_DISABLED`
 *
 * Header values are URI-decoded, so `=` inside a value is written `%3D`. Only
 * the environment is read, never build-time defines, because the worker and
 * migration scripts run under tsx rather than Vite.
 *
 * Errors are exported as error logs carrying `exception.*` attributes and a
 * stable `error.fingerprint`, so they can be grouped without span events.
 *
 * Ported from Kiln's packages/telemetry. Kiln's `otlpTarget`, which forwards
 * browser-sent signals, is left out; a browser layer may need it later.
 */
import type { AsyncLocalStorage } from "node:async_hooks"

import {
  Cause,
  Config,
  ConfigProvider,
  Effect,
  Layer,
  Option,
  Predicate,
  Tracer,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { Otlp, OtlpSerialization } from "effect/observability"

export interface TelemetryResource {
  readonly serviceName: string
  readonly serviceVersion?: string | undefined
  readonly attributes?: Record<string, unknown> | undefined
}

export interface ErrorContext {
  /** Stable name of the failing operation; part of the fingerprint. */
  readonly operation?: string | undefined
  readonly attributes?:
    | Readonly<Record<string, string | number | boolean | null | undefined>>
    | undefined
}

export interface ExceptionDetails {
  readonly type: string
  readonly message: string
  readonly stacktrace: string
}

// MediaBinder is a small single-tenant app: traffic is low enough that
// keeping every trace is cheap, and sampling would only hide the one slow
// request someone is looking for. Kiln serves many tenants and keeps 5%.
// Set OTEL_TRACES_SAMPLER_ARG to sample less.
const defaultSampleRatio = 1
const maxCauseDepth = 3

// The span of the Effect currently evaluating, visible to promise code it
// calls. Effects started from that code use it as their parent, so one
// request stays one trace across runtime boundaries. Created on first use.
let activeSpan: AsyncLocalStorage<Tracer.AnySpan> | undefined
const spanStorage = () =>
  (activeSpan ??= new (process.getBuiltinModule(
    "node:async_hooks"
  ).AsyncLocalStorage)<Tracer.AnySpan>())

/**
 * Exports traces, logs and metrics over OTLP. Without an endpoint this
 * provides nothing and Effect keeps its defaults. Invalid configuration
 * disables telemetry instead of failing the runtime.
 */
export const layer = (resource: TelemetryResource): Layer.Layer<never> =>
  Layer.effect(Tracer.Tracer, sampledTracer).pipe(
    Layer.provideMerge(
      Otlp.layerFromConfig({ resource, loggerMergeWithExisting: true })
    ),
    Layer.provide(OtlpSerialization.layerProtobuf),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(configDefaults),
    Layer.catchCause((cause) => {
      console.error(
        "Telemetry is disabled because its OTEL_* configuration is invalid",
        Cause.pretty(cause)
      )
      return Layer.empty
    })
  )

export const sampleRatio = Config.Number("OTEL_TRACES_SAMPLER_ARG").pipe(
  Config.map((value) =>
    Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : defaultSampleRatio
  ),
  Config.withDefault(defaultSampleRatio)
)

// Traces and logs export whenever an endpoint is set. Metrics stay opt-in
// because some OTLP backends reject them.
const configDefaults = ConfigProvider.layerAdd(
  ConfigProvider.fromUnknown({
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
  })
)

/**
 * Wraps a tracer so only roots are sampled and the active span is visible to
 * promise code. Exported for tests; `layer` uses it.
 */
export const sampledTracer = Effect.gen(function* () {
  const tracer = yield* Tracer.Tracer
  if (tracer === Tracer.nativeTracer) return tracer
  const storage = spanStorage()
  const ratio = yield* sampleRatio
  return Tracer.make({
    span(options) {
      // Decide once per trace; child spans inherit `sampled` from the root.
      // A span without a parent starts a trace even when not marked `root`.
      const root = options.root || Option.isNone(options.parent)
      return tracer.span(
        root && options.sampled
          ? { ...options, sampled: Math.random() < ratio }
          : options
      )
    },
    context(primitive, fiber) {
      const span = fiber.cache.span
      return span === undefined
        ? primitive["~effect/Effect/evaluate"](fiber)
        : storage.run(span, () => primitive["~effect/Effect/evaluate"](fiber))
    },
  })
}).pipe(Effect.orDie)

/** Nests an effect started from promise code under the active span there. */
export const withActiveParent = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => {
  const parent = activeSpan?.getStore()
  return parent === undefined
    ? effect
    : (Effect.withParentSpan(effect, parent) as Effect.Effect<A, E, R>)
}

/** Runs promise code inside a span, so effects it starts nest under it. */
export const spanPromise = <A>(
  name: string,
  run: (span: Tracer.Span) => Promise<A>,
  options?: Tracer.SpanOptions
): Effect.Effect<A, unknown> =>
  Effect.currentSpan.pipe(
    Effect.orDie,
    Effect.flatMap((span) =>
      Effect.tryPromise({ try: () => run(span), catch: (cause) => cause })
    ),
    Effect.withSpan(name, options)
  )

/** Logs an error with its exception details and fingerprint. */
export const logException = (
  cause: unknown,
  context: ErrorContext = {}
): Effect.Effect<void> => {
  const exception = describeException(cause)
  const annotations: Record<string, unknown> = {
    "exception.type": exception.type,
    "exception.message": exception.message,
    "exception.stacktrace": exception.stacktrace,
    "error.fingerprint": errorFingerprint(exception, context.operation),
  }
  if (context.operation)
    annotations["mediabinder.operation"] = context.operation
  for (const [key, value] of Object.entries(context.attributes ?? {})) {
    if (value !== undefined && value !== null) annotations[key] = value
  }
  return Effect.logError(exception.message).pipe(
    Effect.annotateLogs(annotations)
  )
}

export function describeException(cause: unknown): ExceptionDetails {
  const error = Cause.isCause(cause) ? Cause.squash(cause) : cause
  const type = exceptionType(error)
  const message = exceptionMessage(error)
  return { type, message, stacktrace: stacktrace(error, type, message, 0) }
}

/**
 * Groups occurrences of the same error: the type, the message with
 * identifiers and numbers removed, and the operation. Stack frames are left
 * out because bundled code changes them every release.
 */
export function errorFingerprint(
  exception: Pick<ExceptionDetails, "type" | "message">,
  operation?: string
): string {
  const message = exception.message
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
      "<id>"
    )
    .replace(/\b[0-9a-f]{12,}\b/giu, "<id>")
    .replace(/\d+/gu, "<n>")
    .slice(0, 300)
  return fnv1a(`${exception.type}\n${message}\n${operation ?? ""}`)
}

function exceptionType(error: unknown): string {
  if (Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)) {
    return error._tag
  }
  if (error instanceof Error) return error.name
  return Predicate.isString(error) ? "Error" : typeof error
}

function exceptionMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (Predicate.isString(error)) return error
  if (
    Predicate.hasProperty(error, "message") &&
    Predicate.isString(error.message)
  ) {
    return error.message
  }
  return String(error)
}

function stacktrace(
  error: unknown,
  type: string,
  message: string,
  depth: number
): string {
  const own =
    error instanceof Error && error.stack ? error.stack : `${type}: ${message}`
  if (
    depth >= maxCauseDepth ||
    !(error instanceof Error) ||
    error.cause === undefined
  ) {
    return own
  }
  const cause = error.cause
  const causeType = exceptionType(cause)
  const causeMessage = exceptionMessage(cause)
  return `${own}\nCaused by: ${stacktrace(cause, causeType, causeMessage, depth + 1)}`
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}
