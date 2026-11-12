import { describe, expect } from "vite-plus/test"
import { it } from "@effect/vitest"
import {
  ConfigProvider,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Tracer,
} from "effect"
import {
  errorFingerprint,
  sampledTracer,
  spanPromise,
  withActiveParent,
} from "./index"

describe("errorFingerprint", () => {
  it("groups the same failure across ids and numbers, and no other", () => {
    const base = { type: "Error", message: "Drive file 123 failed after 30s" }
    expect(errorFingerprint(base, "Drive.get")).toBe(
      errorFingerprint(
        { type: "Error", message: "Drive file 987654 failed after 5s" },
        "Drive.get"
      )
    )
    expect(
      errorFingerprint(
        {
          type: "Error",
          message:
            "No row 7f9c2ba4-1c0e-4a52-9d1e-2b6f0c5a8e11 or 0123456789abcdef",
        },
        "x"
      )
    ).toBe(
      errorFingerprint(
        {
          type: "Error",
          message:
            "No row 00000000-0000-4000-8000-000000000000 or fedcba9876543210",
        },
        "x"
      )
    )
    expect(errorFingerprint(base, "Drive.post")).not.toBe(
      errorFingerprint(base, "Drive.get")
    )
    expect(
      errorFingerprint({ ...base, type: "TypeError" }, "Drive.get")
    ).not.toBe(errorFingerprint(base, "Drive.get"))
    expect(errorFingerprint(base, "Drive.get")).toMatch(/^[0-9a-f]{8}$/)
  })
})

// A recording tracer under the sampler, with no network involved.
const recorder = (ratio: number) => {
  const spans: Array<Tracer.NativeSpan> = []
  const base = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  const layer = Layer.effect(Tracer.Tracer, sampledTracer).pipe(
    Layer.provide(Layer.succeed(Tracer.Tracer, base)),
    Layer.provide(
      ConfigProvider.layerAdd(
        ConfigProvider.fromUnknown({ OTEL_TRACES_SAMPLER_ARG: String(ratio) })
      )
    )
  )
  return { spans, layer }
}

describe("sampler", () => {
  it.effect("children inherit the root's decision", () =>
    Effect.gen(function* () {
      for (const [ratio, expected] of [
        [0, false],
        [1, true],
      ] as const) {
        const { spans, layer } = recorder(ratio)
        yield* Effect.void.pipe(
          Effect.withSpan("child"),
          Effect.withSpan("root"),
          Effect.provide(layer)
        )
        expect(spans.map((span) => [span.name, span.sampled])).toEqual([
          ["root", expected],
          ["child", expected],
        ])
      }
    })
  )

  it.effect("an Effect started from traced promise code is a child span", () =>
    Effect.gen(function* () {
      const { spans, layer } = recorder(1)
      // As in the app: one runtime serves the request and the promise code
      // that calls back into it.
      const runtime = ManagedRuntime.make(layer)
      yield* Effect.promise(() =>
        runtime.runPromise(
          withActiveParent(
            spanPromise("Outer.promise", () =>
              runtime.runPromise(
                withActiveParent(
                  Effect.void.pipe(Effect.withSpan("Inner.effect"))
                )
              )
            )
          )
        )
      )
      yield* Effect.promise(() => runtime.dispose())
      const outer = spans.find((span) => span.name === "Outer.promise")
      const inner = spans.find((span) => span.name === "Inner.effect")
      expect(outer).toBeDefined()
      expect(Option.getOrUndefined(inner!.parent)).toBe(outer)
      expect(inner?.traceId).toBe(outer?.traceId)
    })
  )
})
