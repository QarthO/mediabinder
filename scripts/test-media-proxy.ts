import { test, after, mock } from "node:test"
import assert from "node:assert/strict"
import { Effect } from "effect"
import { mediaResponse } from "../src/effect/media.server"
import { auth } from "../src/lib/auth.server"
import { pool } from "../src/lib/database.server"
after(() => pool.end())
test("media proxy preserves ranges and streams without buffering, and handles upstream failures", async () => {
  mock.method(auth.api, "getAccessToken", async () => ({
    accessToken: "fixture",
  }))
  let calls = 0
  const media = { drive_id: "fixture", mime_type: "video/mp4" }
  const request = new Request("https://rien.cloud/api/media/fixture", {
    headers: { range: "bytes=0-2" },
  })
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++
    assert.equal(new Headers(init.headers).get("range"), "bytes=0-2")
    assert.equal(init.signal, request.signal)
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]))
        },
      }),
      {
        status: 206,
        headers: { "content-range": "bytes 0-2/300", "content-length": "3" },
      }
    )
  })
  const response = await Effect.runPromise(mediaResponse(request, media))
  assert.equal(response.status, 206)
  assert.equal(response.headers.get("content-range"), "bytes 0-2/300")
  const reader = response.body!.getReader()
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]))
  await reader.cancel()
  assert.equal(
    (
      await Effect.runPromise(
        mediaResponse(
          new Request(request.url, { headers: { range: "bytes=0-1,3-4" } }),
          media
        )
      )
    ).status,
    416
  )
  assert.equal(calls, 1)
  mock.method(globalThis, "fetch", async () => {
    throw new Error("transport failure")
  })
  assert.equal(
    (await Effect.runPromise(mediaResponse(request, media))).status,
    502
  )
  mock.restoreAll()
})
