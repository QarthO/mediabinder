import { afterAll, beforeAll, describe, expect, vi } from "vite-plus/test"
import { it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { jsonRequest, NetworkError } from "./http"

const options = {
  errorMessage: (status: number) => `Request failed (${status})`,
}

// The Effect fetch client captures `globalThis.fetch` once, so the stub is
// installed once and each test only swaps what it delegates to.
let handler: typeof fetch
const fetchSpy = vi.fn<typeof fetch>((...args) => handler(...args))
const mockFetch = (implementation: typeof fetch) => {
  fetchSpy.mockClear()
  handler = implementation
  return fetchSpy
}

beforeAll(() => {
  vi.stubGlobal("fetch", fetchSpy)
})
afterAll(() => {
  vi.unstubAllGlobals()
})

describe("jsonRequest", () => {
  it.effect("decodes JSON bodies and empty watch responses", () =>
    Effect.gen(function* () {
      mockFetch(async () => Response.json({ ok: true }))
      expect(yield* jsonRequest("https://example.com", options)).toEqual({
        ok: true,
      })
      mockFetch(async () => new Response(null, { status: 204 }))
      expect(yield* jsonRequest("https://example.com", options)).toBeUndefined()
    })
  )

  it.effect("reports server errors without replaying the mutation", () =>
    Effect.gen(function* () {
      const fetch = mockFetch(
        async () => new Response("upstream broke", { status: 502 })
      )
      const error = yield* jsonRequest("https://example.com", {
        ...options,
        method: "POST",
        body: {},
        serverMessage: true,
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(NetworkError)
      expect(error.message).toBe("Request failed (502)")
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  )

  it.effect("aborts the fetch when the request times out", () =>
    Effect.gen(function* () {
      let aborted = false
      let started!: () => void
      const fetched = new Promise<void>((resolve) => {
        started = resolve
      })
      mockFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true
              reject(new Error("aborted"))
            })
            started()
          })
      )
      const fiber = yield* jsonRequest("https://example.com", options).pipe(
        Effect.flip,
        Effect.forkChild
      )
      yield* Effect.promise(() => fetched)
      yield* TestClock.adjust("30 seconds")
      const error = yield* Fiber.join(fiber)
      expect(error).toBeInstanceOf(NetworkError)
      expect(aborted).toBe(true)
    })
  )
})
