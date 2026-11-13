import { afterEach, describe, expect, vi } from "vite-plus/test"
import { it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import {
  makeThumbnailCache,
  MAX_THUMBNAIL_BYTES,
  readThumbnail,
  ThumbnailError,
} from "./thumbnails"

const thumbnail = {
  bytes: new Uint8Array([1, 2, 3]),
  contentType: "image/jpeg",
  etag: '"test"',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("thumbnail cache", () => {
  it.effect(
    "shares requests, bounds concurrency, expires entries and retries failures",
    () =>
      Effect.gen(function* () {
        let calls = 0,
          active = 0,
          peak = 0,
          failed = false
        const load = (key: string) =>
          Effect.gen(function* () {
            calls++
            active++
            peak = Math.max(peak, active)
            yield* Effect.sleep("5 millis")
            if (key === "failure" && !failed) {
              failed = true
              return yield* new ThumbnailError({
                status: 502,
                message: "temporary",
              })
            }
            return thumbnail
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active--
              })
            )
          )
        const cache = yield* makeThumbnailCache(load, {
          capacity: 2,
          concurrency: 1,
          ttl: "60 millis",
        })
        // Starts the requests, lets the clock run their loads, and returns.
        const get = Effect.fnUntraced(function* (...keys: string[]) {
          const fiber = yield* Effect.forkChild(
            Effect.all(
              keys.map((key) => cache.get(key)),
              { concurrency: "unbounded", mode: "result" }
            )
          )
          yield* TestClock.adjust("20 millis")
          return yield* Fiber.join(fiber)
        })

        yield* get("alice:file", "alice:file", "bob:file")
        expect(calls).toBe(2)
        expect(peak).toBe(1)
        yield* get("alice:file")
        expect(calls).toBe(2)
        yield* get("third:file") // Bob is least recently used.
        yield* get("bob:file")
        expect(calls).toBe(4)
        yield* TestClock.adjust("70 millis")
        yield* get("bob:file")
        expect(calls).toBe(5)
        const [first] = yield* get("failure")
        expect(first._tag).toBe("Failure")
        const [second] = yield* get("failure")
        expect(second._tag).toBe("Success")
        expect(calls).toBe(7)
      })
  )
})

describe("readThumbnail", () => {
  it.effect("rejects oversized and non-image bodies", () =>
    Effect.gen(function* () {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Uint8Array(MAX_THUMBNAIL_BYTES + 1), {
            headers: { "content-type": "image/jpeg" },
          })
      )
      const oversized = yield* readThumbnail(
        "https://example.com",
        "test"
      ).pipe(Effect.flip)
      expect(oversized.message).toMatch(/size limit/)
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response("<html>error</html>", {
            headers: { "content-type": "text/html" },
          })
      )
      const invalid = yield* readThumbnail("https://example.com", "test").pipe(
        Effect.flip
      )
      expect(invalid.message).toMatch(/invalid thumbnail/)
    })
  )
})
