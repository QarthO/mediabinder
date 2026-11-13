import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type { Media } from "./types"
import {
  createMediaPreviewIntent,
  MAX_CACHED_PREVIEWS,
  prefetchMediaPreview,
  prioritizeMediaPreview,
  previewQuery,
} from "./media-preview"

const photo = (id: string): Media =>
  ({
    id,
    drive_id: id,
    mime_type: "image/jpeg",
    available: true,
    size: 3,
    sha256: null,
    uploaded_at: "2026-09-06T00:00:00Z",
  }) as Media
const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const mockFetch = (implementation: (...args: any[]) => Promise<Response>) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(implementation as never)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const imageResponse = () =>
  new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "image/jpeg" },
  })

describe("media preview", () => {
  it("canceling before the preview runtime loads never starts a download", async () => {
    const client = new QueryClient()
    cleanups.push(() => client.clear())
    let calls = 0
    mockFetch(async () => {
      calls++
      return imageResponse()
    })
    const options = previewQuery(client, photo("canceled-before-import"))
    const rejected = expect(client.fetchQuery(options)).rejects.toThrow()
    await client.cancelQueries({ queryKey: options.queryKey, exact: true })
    await rejected
    await import("./media-preview-download")
    await delay(0)
    expect(calls).toBe(0)
  })

  it("hover and opening share one photo request; preview downloads run at concurrency two", async () => {
    const client = new QueryClient()
    cleanups.push(() => client.clear())
    let calls = 0,
      active = 0,
      peak = 0
    mockFetch(async () => {
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
    expect(calls).toBe(3)
    expect(peak).toBe(2)
    expect(results[0].size).toBe(3)
    await client.fetchQuery(previewQuery(client, photo("one")))
    expect(calls).toBe(3)
  })

  it("speculative photo cache is bounded and videos/large images never prefetch", async () => {
    const client = new QueryClient()
    cleanups.push(() => client.clear())
    let calls = 0
    mockFetch(async () => {
      calls++
      return imageResponse()
    })
    for (let i = 0; i < MAX_CACHED_PREVIEWS + 3; i++) {
      const media = photo(String(i))
      prefetchMediaPreview(client, media)
      await client.fetchQuery(previewQuery(client, media))
      expect(client.getQueryCache().getAll().length).toBeLessThanOrEqual(
        MAX_CACHED_PREVIEWS
      )
    }
    const before = calls
    prefetchMediaPreview(client, { ...photo("video"), mime_type: "video/mp4" })
    prefetchMediaPreview(client, { ...photo("huge"), size: 9 * 1024 * 1024 })
    prefetchMediaPreview(client, { ...photo("missing"), available: false })
    await delay(0)
    expect(calls).toBe(before)
  })

  it("prefetch eviction preserves the photo currently displayed by an observer", async () => {
    const client = new QueryClient()
    mockFetch(async () => imageResponse())
    const options = previewQuery(client, photo("open"))
    await client.fetchQuery(options)
    const observer = new QueryObserver(client, options)
    const unsubscribe = observer.subscribe(() => {})
    cleanups.push(() => {
      unsubscribe()
      client.clear()
    })
    for (let i = 0; i < MAX_CACHED_PREVIEWS + 2; i++) {
      const media = photo(String(i))
      prefetchMediaPreview(client, media)
      await client.fetchQuery(previewQuery(client, media))
    }
    expect(client.getQueryData(options.queryKey)).toBeInstanceOf(Blob)
    expect(client.getQueryCache().getAll().length).toBe(MAX_CACHED_PREVIEWS)
  })

  it("intent waits for dwell and skips touch, canceled intent and save-data", async () => {
    const client = new QueryClient()
    cleanups.push(() => client.clear())
    const connection = { saveData: false, effectiveType: "4g" }
    vi.stubGlobal("navigator", { connection })
    let calls = 0
    mockFetch(async () => {
      calls++
      return imageResponse()
    })
    const intent = createMediaPreviewIntent(client, 10)
    cleanups.push(intent.cancel)
    const handlers = intent.handlers(photo("one"))
    handlers.onPointerEnter({ pointerType: "touch" })
    await delay(20)
    expect(calls).toBe(0)
    handlers.onPointerEnter({ pointerType: "mouse" })
    handlers.onPointerLeave()
    await delay(20)
    expect(calls).toBe(0)
    connection.saveData = true
    handlers.onFocus()
    await delay(20)
    expect(calls).toBe(0)
    connection.saveData = false
    handlers.onFocus()
    expect(calls).toBe(0)
    await delay(20)
    expect(calls).toBe(1)
  })

  it("a failed prefetch is not retried by repeated hover", async () => {
    const client = new QueryClient()
    cleanups.push(() => client.clear())
    let calls = 0
    mockFetch(async () => {
      calls++
      throw new Error("offline")
    })
    prefetchMediaPreview(client, photo("one"))
    await expect(
      client.fetchQuery(previewQuery(client, photo("one")))
    ).rejects.toThrow()
    prefetchMediaPreview(client, photo("one"))
    await delay(0)
    expect(calls).toBe(1)
  })

  it("opening a failed hover does not retry the Blob request before native fallback", async () => {
    const client = new QueryClient()
    let unsubscribe = () => {}
    cleanups.push(() => {
      unsubscribe()
      client.clear()
    })
    let calls = 0
    mockFetch(async () => {
      calls++
      throw new Error("offline")
    })
    const media = photo("failed-open")
    const options = previewQuery(client, media)
    prefetchMediaPreview(client, media)
    await expect(client.fetchQuery(options)).rejects.toThrow()
    const observer = new QueryObserver(client, options)
    unsubscribe = observer.subscribe(() => {})
    await delay(0)
    expect(calls).toBe(1)
    expect(observer.getCurrentResult().isError).toBe(true)
    expect(observer.getCurrentResult().isFetching).toBe(false)
  })

  it("opening a queued hover cancels other speculation and starts immediately", async () => {
    const client = new QueryClient()
    let unsubscribe = () => {}
    cleanups.push(() => {
      unsubscribe()
      client.clear()
    })
    const started: string[] = []
    const aborted: string[] = []
    let active = 0,
      peak = 0
    mockFetch(async (url: unknown, init: RequestInit) => {
      const id = String(url).split("/").at(-1)!
      started.push(id)
      active++
      peak = Math.max(peak, active)
      if (id === "clicked") {
        active--
        return imageResponse()
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => {
            active--
            aborted.push(id)
            reject(new Error("aborted"))
          },
          { once: true }
        )
      })
    })
    prefetchMediaPreview(client, photo("hover-a"))
    prefetchMediaPreview(client, photo("hover-b"))
    await delay(0)
    const media = photo("clicked")
    prefetchMediaPreview(client, media)
    await delay(0)
    expect(started).toEqual(["hover-a", "hover-b"])

    const options = previewQuery(client, media)
    const observer = new QueryObserver(client, options)
    unsubscribe = observer.subscribe(() => {})
    prioritizeMediaPreview(client, media)
    const result = await client.fetchQuery(options)
    expect(started).toEqual(["hover-a", "hover-b", "clicked"])
    expect(aborted.sort()).toEqual(["hover-a", "hover-b"])
    expect(result.size).toBe(3)
    expect(peak).toBeLessThanOrEqual(2)
  })
})
