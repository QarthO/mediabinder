import { createServer } from "node:http"
import type { Server } from "node:http"
import { Effect } from "effect"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test"
import { AuthenticationError } from "@/effect/errors"

vi.mock("./auth.server", () => ({
  requireSession: (headers: Headers) =>
    headers.get("cookie") === "session"
      ? Effect.succeed({ user: { id: headers.get("x-user") ?? "user-1" } })
      : Effect.fail(new AuthenticationError()),
}))
vi.mock("@/effect/runtime.server", () => ({ sourceCommit: "abc123" }))

const { forwardBrowserTelemetry, withinRateLimit } =
  await import("./browser-telemetry.server")

const origin = "http://localhost:3100"
const kept = "00000000000000000000000000000001"
const dropped = "ffffffff000000000000000000000002"

let backend: Server
let upstreamStatus = 200
let received: { url: string; headers: Record<string, unknown>; body: any }[]

beforeAll(async () => {
  backend = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      received.push({
        url: request.url ?? "",
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      })
      response.statusCode = upstreamStatus
      response.end()
    })
  })
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve))
  const { port } = backend.address() as { port: number }
  process.env.MEDIABINDER_URL = origin
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`
  process.env.OTEL_EXPORTER_OTLP_HEADERS =
    "authorization=Bearer%20server-secret"
  process.env.OTEL_TRACES_SAMPLER_ARG = "0.5"
})
afterAll(() => {
  backend.close()
  for (const name of [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_TRACES_SAMPLER_ARG",
  ])
    delete process.env[name]
})
beforeEach(() => {
  received = []
  upstreamStatus = 200
})

const post = (
  signal: string,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  Effect.runPromise(
    forwardBrowserTelemetry(
      new Request(`${origin}/api/telemetry/v1/${signal}`, {
        method: "POST",
        headers: { origin, cookie: "session", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      signal
    )
  ).then((response) => response.status)

const spansOf = (...traceIds: string[]) => ({
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "kiln-web" } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "effect" },
          spans: traceIds.map((traceId) => ({
            traceId,
            spanId: "0000000000000001",
            name: "Library.request",
          })),
        },
      ],
    },
  ],
})

describe("browser telemetry proxy", () => {
  it("refuses other origins, signed-out callers, oversized and malformed bodies", async () => {
    const body = spansOf(kept)
    expect(await post("traces", body, { origin: "https://evil.test" })).toBe(
      403
    )
    expect(await post("traces", body, { cookie: "" })).toBe(401)
    expect(await post("nope", body)).toBe(404)
    expect(await post("traces", "x".repeat(300_000))).toBe(413)
    expect(
      await post("traces", "{}", { "content-length": String(300_000) })
    ).toBe(413)
    expect(await post("traces", "not json")).toBe(400)
    expect(await post("traces", { resourceSpans: "no" })).toBe(400)
    expect(
      await post("traces", {
        resourceSpans: [
          {
            scopeSpans: Array.from({ length: 17 }, () => ({ spans: [] })),
          },
        ],
      })
    ).toBe(400)
    expect(await post("logs", { resourceLogs: [{ scopeLogs: [{}] }] })).toBe(
      400
    )
    expect(received).toEqual([])
  })

  it("rewrites the resource, keeps sampled traces and adds server credentials", async () => {
    expect(await post("traces", spansOf(kept, dropped))).toBe(204)
    expect(received).toHaveLength(1)
    const [request] = received
    expect(request.url).toBe("/v1/traces")
    expect(request.headers.authorization).toBe("Bearer server-secret")
    const [resourceSpans] = request.body.resourceSpans
    expect(resourceSpans.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "mediabinder-browser" } },
      { key: "service.version", value: { stringValue: "abc123" } },
    ])
    expect(resourceSpans.scopeSpans[0].scope).toEqual({ name: "effect" })
    expect(
      resourceSpans.scopeSpans[0].spans.map((span: any) => span.traceId)
    ).toEqual([kept])

    // Only unsampled traces: nothing to forward.
    received = []
    expect(await post("traces", spansOf(dropped))).toBe(204)
    expect(received).toEqual([])
  })

  it("forwards logs under the same resource and still answers 204 when the backend fails", async () => {
    upstreamStatus = 500
    expect(
      await post("logs", {
        resourceLogs: [
          {
            resource: { attributes: [] },
            scopeLogs: [{ logRecords: [{ body: { stringValue: "x" } }] }],
          },
        ],
      })
    ).toBe(204)
    expect(received[0].url).toBe("/v1/logs")
    expect(
      received[0].body.resourceLogs[0].resource.attributes[0].value
    ).toEqual({ stringValue: "mediabinder-browser" })
  })

  it("limits each user to a fixed number of requests per window", () => {
    const buckets = new Map<string, { start: number; count: number }>()
    const results = Array.from({ length: 4 }, () =>
      withinRateLimit(buckets, "a", 3, 60_000, 1000)
    )
    expect(results).toEqual([true, true, true, false])
    expect(withinRateLimit(buckets, "b", 3, 60_000, 1000)).toBe(true)
    expect(withinRateLimit(buckets, "a", 3, 60_000, 61_001)).toBe(true)
  })
})
