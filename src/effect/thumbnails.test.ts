import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
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
test("thumbnail cache shares requests, bounds concurrency, isolates users, expires and retries failures", async () => {
  let calls = 0,
    active = 0,
    peak = 0,
    failed = false
  const load = (key: string) =>
    Effect.tryPromise({
      try: async () => {
        calls++
        active++
        peak = Math.max(peak, active)
        try {
          await new Promise((resolve) => setTimeout(resolve, 5))
          if (key === "failure" && !failed) {
            failed = true
            throw new ThumbnailError({ status: 502, message: "temporary" })
          }
          return thumbnail
        } finally {
          active--
        }
      },
      catch: (cause) => cause as ThumbnailError,
    })
  const cache = await Effect.runPromise(
    makeThumbnailCache(load, { capacity: 2, concurrency: 1, ttl: "60 millis" })
  )
  const get = (key: string) => Effect.runPromise(cache.get(key))
  await Promise.all([get("alice:file"), get("alice:file"), get("bob:file")])
  assert.equal(calls, 2)
  assert.equal(peak, 1)
  await get("alice:file")
  assert.equal(calls, 2)
  await get("third:file") // Bob is least recently used.
  await get("bob:file")
  assert.equal(calls, 4)
  await new Promise((resolve) => setTimeout(resolve, 70))
  await get("bob:file")
  assert.equal(calls, 5)
  await assert.rejects(get("failure"))
  await get("failure")
  assert.equal(calls, 7)
})

test("thumbnail downloads reject oversized and non-image bodies", async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      new Response(new Uint8Array(MAX_THUMBNAIL_BYTES + 1), {
        headers: { "content-type": "image/jpeg" },
      })
    await assert.rejects(
      Effect.runPromise(readThumbnail("https://example.com", "test")),
      /size limit/
    )
    globalThis.fetch = async () =>
      new Response("<html>error</html>", {
        headers: { "content-type": "text/html" },
      })
    await assert.rejects(
      Effect.runPromise(readThumbnail("https://example.com", "test")),
      /invalid thumbnail/
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
