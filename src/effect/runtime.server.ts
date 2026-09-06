import { Effect, Layer, Logger, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability"

export const tracing = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  ? OtlpTracer.layer({
      url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      resource: { serviceName: "mediabinder" },
    }).pipe(
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer)
    )
  : Layer.empty

export const serverRuntime = ManagedRuntime.make(
  Layer.merge(Logger.layer([Logger.consoleJson]), tracing)
)
export function runServer<A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal
) {
  return serverRuntime.runPromise(effect, { signal })
}
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    void serverRuntime.dispose()
  })
