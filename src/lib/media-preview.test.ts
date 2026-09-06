import assert from "node:assert/strict"
import { test } from "node:test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type { Media } from "./types"
import {
  createMediaPreviewIntent,
  MAX_CACHED_PREVIEWS,
  prefetchMediaPreview,
  prioritizeMediaPreview,
  previewQuery,
} from "./media-preview"

const photo = (id: string): Media => ({
  id, drive_id: id, mime_type: "image/jpeg", available: true, size: 3,
  sha256: null, uploaded_at: "2026-09-06T00:00:00Z",
} as Media)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const imageResponse = () => new Response(new Uint8Array([1, 2, 3]), {
  headers: { "content-type": "image/jpeg" },
})

test("hover and opening share one photo request; preview downloads run at concurrency two", async (t) => {
  const client = new QueryClient()
  t.after(() => client.clear())
  let calls = 0, active = 0, peak = 0
  t.mock.method(globalThis, "fetch", async () => {
    calls++
    active++
    peak = Math.max(peak, active)
    await delay(10)
    active--
    return imageResponse()
  })
  prefetchMediaPreview(client, photo("one"))
  const results = await Promise.all([
    client.fetchQuery(previewQuery(client, photo("one"))),
    client.fetchQuery(previewQuery(client, photo("two"))),
    client.fetchQuery(previewQuery(client, photo("three"))),
  ])
  assert.equal(calls, 3)
  assert.equal(peak, 2)
  assert.equal(results[0].size, 3)
  await client.fetchQuery(previewQuery(client, photo("one")))
  assert.equal(calls, 3)
})

test("speculative photo cache is bounded and videos/large images never prefetch", async (t) => {
  const client = new QueryClient()
  t.after(() => client.clear())
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return imageResponse() })
  for (let i = 0; i < MAX_CACHED_PREVIEWS + 3; i++) {
    const media = photo(String(i))
    prefetchMediaPreview(client, media)
    await client.fetchQuery(previewQuery(client, media))
    assert.ok(client.getQueryCache().getAll().length <= MAX_CACHED_PREVIEWS)
  }
  const before = calls
  prefetchMediaPreview(client, { ...photo("video"), mime_type: "video/mp4" })
  prefetchMediaPreview(client, { ...photo("huge"), size: 9 * 1024 * 1024 })
  prefetchMediaPreview(client, { ...photo("missing"), available: false })
  await delay(0)
  assert.equal(calls, before)
})

test("prefetch eviction preserves the photo currently displayed by an observer", async (t) => {
  const client = new QueryClient()
  t.mock.method(globalThis, "fetch", async () => imageResponse())
  const options = previewQuery(client, photo("open"))
  await client.fetchQuery(options)
  const observer = new QueryObserver(client, options)
  const unsubscribe = observer.subscribe(() => {})
  t.after(() => {
    unsubscribe()
    client.clear()
  })
  for (let i = 0; i < MAX_CACHED_PREVIEWS + 2; i++) {
    const media = photo(String(i))
    prefetchMediaPreview(client, media)
    await client.fetchQuery(previewQuery(client, media))
  }
  assert.ok(client.getQueryData(options.queryKey) instanceof Blob)
  assert.equal(client.getQueryCache().getAll().length, MAX_CACHED_PREVIEWS)
})

test("intent waits for dwell and skips touch, canceled intent and save-data", async (t) => {
  const client = new QueryClient()
  t.after(() => client.clear())
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  const connection = { saveData: false, effectiveType: "4g" }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true, value: { connection },
  })
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor)
    else Reflect.deleteProperty(globalThis, "navigator")
  })
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return imageResponse() })
  const intent = createMediaPreviewIntent(client, 10)
  t.after(intent.cancel)
  const handlers = intent.handlers(photo("one"))
  handlers.onPointerEnter({ pointerType: "touch" })
  await delay(20)
  assert.equal(calls, 0)
  handlers.onPointerEnter({ pointerType: "mouse" })
  handlers.onPointerLeave()
  await delay(20)
  assert.equal(calls, 0)
  connection.saveData = true
  handlers.onFocus()
  await delay(20)
  assert.equal(calls, 0)
  connection.saveData = false
  handlers.onFocus()
  assert.equal(calls, 0)
  await delay(20)
  assert.equal(calls, 1)
})

test("a failed prefetch is not retried by repeated hover", async (t) => {
  const client = new QueryClient()
  t.after(() => client.clear())
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("offline") })
  prefetchMediaPreview(client, photo("one"))
  await assert.rejects(client.fetchQuery(previewQuery(client, photo("one"))))
  prefetchMediaPreview(client, photo("one"))
  await delay(0)
  assert.equal(calls, 1)
})

test("opening a failed hover does not retry the Blob request before native fallback", async (t) => {
  const client = new QueryClient()
  let unsubscribe = () => {}
  t.after(() => {
    unsubscribe()
    client.clear()
  })
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => {
    calls++
    throw new Error("offline")
  })
  const media = photo("failed-open")
  const options = previewQuery(client, media)
  prefetchMediaPreview(client, media)
  await assert.rejects(client.fetchQuery(options))
  const observer = new QueryObserver(client, options)
  unsubscribe = observer.subscribe(() => {})
  await delay(0)
  assert.equal(calls, 1)
  assert.equal(observer.getCurrentResult().isError, true)
  assert.equal(observer.getCurrentResult().isFetching, false)
})

test("opening a queued hover cancels other speculation and starts immediately", async (t) => {
  const client = new QueryClient()
  let unsubscribe = () => {}
  t.after(() => {
    unsubscribe()
    client.clear()
  })
  const started: string[] = []
  const aborted: string[] = []
  let active = 0, peak = 0
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    const id = String(url).split("/").at(-1)!
    started.push(id)
    active++
    peak = Math.max(peak, active)
    if (id === "clicked") {
      active--
      return imageResponse()
    }
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => {
        active--
        aborted.push(id)
        reject(new Error("aborted"))
      }, { once: true })
    })
  })
  prefetchMediaPreview(client, photo("hover-a"))
  prefetchMediaPreview(client, photo("hover-b"))
  await delay(0)
  const media = photo("clicked")
  prefetchMediaPreview(client, media)
  await delay(0)
  assert.deepEqual(started, ["hover-a", "hover-b"])

  const options = previewQuery(client, media)
  const observer = new QueryObserver(client, options)
  unsubscribe = observer.subscribe(() => {})
  prioritizeMediaPreview(client, media)
  const result = await client.fetchQuery(options)
  assert.deepEqual(started, ["hover-a", "hover-b", "clicked"])
  assert.deepEqual(aborted.sort(), ["hover-a", "hover-b"])
  assert.equal(result.size, 3)
  assert.ok(peak <= 2)
})
