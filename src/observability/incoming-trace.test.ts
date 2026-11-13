import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vite-plus/test"

const getSession = vi.fn()
vi.mock("@/lib/auth.server", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSession(...args) } },
}))

const { incomingTraceParent } = await import("./incoming-trace.server")

const origin = "http://localhost:3100"
const traceId = "ffffffff000000000000000000000002"
const traceparent = `00-${traceId}-00f067aa0ba902b7-01`

const parentOf = (headers: Record<string, string>) =>
  Effect.runPromise(
    incomingTraceParent(
      new Request(`${origin}/api/library`, { method: "POST", headers })
    )
  )

beforeEach(() => {
  process.env.MEDIABINDER_URL = origin
  process.env.OTEL_TRACES_SAMPLER_ARG = "0.5"
  getSession.mockReset().mockResolvedValue({ user: { id: "u" } })
})

describe("incomingTraceParent", () => {
  it("continues the browser's trace for a signed-in same-origin request", async () => {
    const parent = await parentOf({ origin, traceparent })
    expect(parent).toMatchObject({ traceId, spanId: "00f067aa0ba902b7" })
    // The browser's flag says sampled; the shared function says this trace
    // is dropped, and it is what the proxy applies to the browser's half.
    expect(parent?.sampled).toBe(false)
    const kept = await parentOf({
      origin,
      traceparent: `00-00000000000000000000000000000003-00f067aa0ba902b7-00`,
    })
    expect(kept?.sampled).toBe(true)
  })

  it("accepts a same-origin GET that carries no Origin header", async () => {
    expect(
      await parentOf({ "sec-fetch-site": "same-origin", traceparent })
    ).toBeDefined()
    expect(
      await parentOf({ "sec-fetch-site": "cross-site", traceparent })
    ).toBeUndefined()
  })

  it("ignores a traceparent from another origin, without a session, or malformed", async () => {
    expect(
      await parentOf({ origin: "https://evil.test", traceparent })
    ).toBeUndefined()
    getSession.mockResolvedValue(null)
    expect(await parentOf({ origin, traceparent })).toBeUndefined()
    getSession.mockRejectedValue(new Error("database down"))
    expect(await parentOf({ origin, traceparent })).toBeUndefined()
    getSession.mockResolvedValue({ user: { id: "u" } })
    expect(await parentOf({ origin, traceparent: "garbage" })).toBeUndefined()
    expect(await parentOf({ origin })).toBeUndefined()
  })
})
