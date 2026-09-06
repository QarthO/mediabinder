import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { MAX_PREVIEW_BYTES, readMediaPreview } from "./media-preview"

test("photo preview rejects oversized streamed bytes and releases the reader", async (t) => {
  let canceled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_PREVIEW_BYTES))
      controller.enqueue(new Uint8Array([1]))
    },
    cancel() { canceled = true },
  })
  t.mock.method(globalThis, "fetch", async () => new Response(body, {
    headers: { "content-type": "image/jpeg" },
  }))
  await assert.rejects(Effect.runPromise(readMediaPreview("/photo")))
  assert.equal(canceled, true)
  assert.equal(body.locked, false)
})

test("photo preview rejects video, SVG and oversized Content-Length before reading", async (t) => {
  const cases: Record<string, string>[] = [
    { "content-type": "video/mp4" },
    { "content-type": "image/svg+xml" },
    { "content-type": "image/jpeg", "content-length": String(MAX_PREVIEW_BYTES + 1) },
  ]
  for (const headers of cases) {
    let canceled = false
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
      cancel() { canceled = true },
    }), { headers }))
    await assert.rejects(Effect.runPromise(readMediaPreview("/photo")))
    assert.equal(canceled, true)
  }
})

test("photo preview interruption reaches the fetch signal and releases its reader", async (t) => {
  const controller = new AbortController()
  let fetched!: () => void
  const started = new Promise<void>((resolve) => { fetched = resolve })
  let body!: ReadableStream<Uint8Array>
  let requestSignal!: AbortSignal
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requestSignal = init.signal!
    body = new ReadableStream({
      start(stream) {
        requestSignal.addEventListener("abort", () => stream.error(new Error("aborted")), { once: true })
      },
    })
    fetched()
    return new Response(body, { headers: { "content-type": "image/jpeg" } })
  })
  const result = Effect.runPromise(readMediaPreview("/photo"), { signal: controller.signal })
  await started
  controller.abort()
  await assert.rejects(result)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(requestSignal.aborted, true)
  assert.equal(body.locked, false)
})
