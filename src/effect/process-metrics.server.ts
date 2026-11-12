import { Effect, Layer, Metric } from "effect"

// What this process spends, read from the process itself, so web and the Drive
// worker each report their own under their service name. Like every metric
// they are recorded always and leave the process only when OTEL_METRICS_EXPORTER
// includes `otlp`. Ported from Kiln's hearth-metrics.ts.
const memoryGauge = (name: string, description: string) =>
  Metric.gauge(`mediabinder.process.memory.${name}`, {
    description: `${description}, in bytes`,
    attributes: { unit: "By" },
  })

const rss = memoryGauge("rss", "Process resident set")
const heapUsed = memoryGauge("heap_used", "V8 heap in use")
const external = memoryGauge("external", "Memory outside V8")

const cpuTime = Metric.counter("mediabinder.process.cpu.time", {
  description: "CPU time the process used; its rate is cores in use",
  attributes: { unit: "s" },
  incremental: true,
})

const sampleInterval = "15 seconds"

/**
 * Samples memory and CPU every fifteen seconds for as long as the runtime
 * lives. The sampler belongs to the layer's scope, so disposing the runtime
 * stops it.
 */
export const ProcessMetricsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    let cpu = process.cpuUsage()
    yield* Effect.suspend(() => {
      const memory = process.memoryUsage()
      const previous = cpu
      cpu = process.cpuUsage()
      const spent = cpu.user - previous.user + cpu.system - previous.system
      return Effect.all(
        [
          Metric.update(rss, memory.rss),
          Metric.update(heapUsed, memory.heapUsed),
          Metric.update(external, memory.external),
          Metric.update(cpuTime, spent / 1e6),
        ],
        { discard: true }
      )
    }).pipe(
      Effect.andThen(Effect.sleep(sampleInterval)),
      Effect.forever,
      Effect.forkScoped
    )
  })
)
