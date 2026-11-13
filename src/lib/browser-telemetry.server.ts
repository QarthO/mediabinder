import { Clock, Effect, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { sourceCommit } from "@/effect/runtime.server"
import { otlpTarget, sampleRatio } from "@/telemetry"
import { requireSession } from "./auth.server"
import { keepBrowserTrace } from "./browser-trace-sampling"
import { appUrl } from "./config"
import { errorResponse } from "./http-errors"

const maximumBodyBytes = 256 * 1024
const requestsPerMinute = 120
const upstreamTimeout = "10 seconds"

/**
 * The share of browser traces kept, or None while no OTLP endpoint is
 * configured. None is the signal that browser telemetry is off: the page then
 * gets no `<meta>`, loads no telemetry code and sends nothing.
 */
export const browserTraceSampleRatio = Effect.fnUntraced(function* () {
  const traces = yield* otlpTarget("traces")
  const logs = yield* otlpTarget("logs")
  return Option.isNone(traces) && Option.isNone(logs)
    ? Option.none<number>()
    : Option.some(yield* sampleRatio)
})

// Loose structures: the checks are on the shape and size, not on every OTLP
// field, and unknown fields pass through to the backend untouched.
const Rest = [Schema.Record(Schema.String, Schema.Unknown)] as const
const Attributes = Schema.Array(Schema.Unknown).check(Schema.isMaxLength(64))
const looseStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), Rest)
const Span = looseStruct({
  traceId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/iu)),
  attributes: Schema.optionalKey(Attributes),
})
const LogRecord = looseStruct({ attributes: Schema.optionalKey(Attributes) })
const TracesPayload = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      scopeSpans: Schema.Array(
        looseStruct({
          spans: Schema.Array(Span).check(Schema.isMaxLength(500)),
        })
      ).check(Schema.isMaxLength(16)),
    })
  ).check(Schema.isMaxLength(4)),
})
const LogsPayload = Schema.Struct({
  resourceLogs: Schema.Array(
    Schema.Struct({
      scopeLogs: Schema.Array(
        looseStruct({
          logRecords: Schema.Array(LogRecord).check(Schema.isMaxLength(100)),
        })
      ).check(Schema.isMaxLength(16)),
    })
  ).check(Schema.isMaxLength(4)),
})

// Per process and per user. Telemetry batches are small and frequent; this
// only stops one session from using the proxy as an amplifier.
const windows = new Map<string, { start: number; count: number }>()

/** True while `key` is within `limit` requests per `windowMs`. */
export function withinRateLimit(
  buckets: Map<string, { start: number; count: number }>,
  key: string,
  limit: number,
  windowMs: number,
  now: number
): boolean {
  if (buckets.size > 1000) {
    for (const [name, bucket] of buckets)
      if (now - bucket.start >= windowMs) buckets.delete(name)
  }
  const bucket = buckets.get(key)
  if (!bucket || now - bucket.start >= windowMs) {
    buckets.set(key, { start: now, count: 1 })
    return true
  }
  bucket.count += 1
  return bucket.count <= limit
}

/** The body as text, or null once it exceeds `limit` bytes. */
export const readLimitedText = (request: Request, limit: number) =>
  Effect.tryPromise(async () => {
    if (Number(request.headers.get("content-length")) > limit) return null
    const reader = request.body?.getReader()
    if (!reader) return ""
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString("utf8")
  })

const resource = () => ({
  attributes: [
    { key: "service.name", value: { stringValue: "mediabinder-browser" } },
    ...(sourceCommit
      ? [{ key: "service.version", value: { stringValue: sourceCommit } }]
      : []),
  ],
})

const status = (code: number) => new Response(null, { status: code })

/**
 * Forwards OTLP JSON from a signed-in browser to the configured backend. The
 * browser cannot name itself as another service, traces are sampled here by
 * trace ID (the same function the browser and the request middleware use),
 * and the backend credentials never leave the server. Always answers 204
 * once the request is accepted: a backend that is down is the server's
 * warning, not the browser's error.
 */
export const forwardBrowserTelemetry = Effect.fnUntraced(
  function* (request: Request, signal: string) {
    if (signal !== "traces" && signal !== "logs") return status(404)
    // A missing MEDIABINDER_URL is a defect, as in libraryPost.
    const origin = yield* Effect.sync(() => appUrl())
    if (request.headers.get("origin") !== origin) return status(403)
    const session = yield* requireSession(request.headers)
    const now = yield* Clock.currentTimeMillis
    if (
      !withinRateLimit(windows, session.user.id, requestsPerMinute, 60_000, now)
    )
      return status(429)

    const body = yield* readLimitedText(request, maximumBodyBytes).pipe(
      Effect.option
    )
    if (Option.isNone(body)) return status(400)
    if (body.value === null) return status(413)
    const payload = yield* Effect.try(
      () => JSON.parse(body.value!) as unknown
    ).pipe(Effect.option)
    if (Option.isNone(payload)) return status(400)

    const target = yield* otlpTarget(signal)
    let forwarded: unknown
    if (signal === "traces") {
      const traces = Schema.decodeUnknownOption(TracesPayload)(payload.value)
      if (Option.isNone(traces)) return status(400)
      if (Option.isNone(target)) return status(204)
      const ratio = target.value.sampleRatio
      const resourceSpans = traces.value.resourceSpans
        .map((entry) => ({
          resource: resource(),
          scopeSpans: entry.scopeSpans
            .map((scope) => ({
              ...scope,
              spans: scope.spans.filter((span) =>
                keepBrowserTrace(span.traceId, ratio)
              ),
            }))
            .filter((scope) => scope.spans.length > 0),
        }))
        .filter((entry) => entry.scopeSpans.length > 0)
      if (resourceSpans.length === 0) return status(204)
      forwarded = { resourceSpans }
    } else {
      const logs = Schema.decodeUnknownOption(LogsPayload)(payload.value)
      if (Option.isNone(logs)) return status(400)
      if (Option.isNone(target)) return status(204)
      forwarded = {
        resourceLogs: logs.value.resourceLogs.map((entry) => ({
          ...entry,
          resource: resource(),
        })),
      }
    }

    const { url, headers } = target.value
    yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyJson(forwarded),
      Effect.flatMap((upstream) =>
        Effect.flatMap(HttpClient.HttpClient, (client) =>
          client.execute(upstream)
        )
      ),
      Effect.timeout(upstreamTimeout),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.void
          : Effect.logWarning("OTLP backend rejected browser telemetry", {
              signal,
              status: response.status,
            })
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Could not forward browser telemetry", {
          signal,
          reason: cause instanceof Error ? cause.name : "unknown",
        })
      ),
      // This is telemetry's own transport: no client span, and no trace
      // headers added for the backend.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.provide(FetchHttpClient.layer)
    )
    return status(204)
  },
  (self) =>
    self.pipe(
      Effect.catchTag("AuthenticationError", (error) =>
        Effect.succeed(errorResponse(error))
      )
    )
)
