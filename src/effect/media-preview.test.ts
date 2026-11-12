import { afterEach, describe, expect, vi } from "vite-plus/test"
import { it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import {
  MAX_PREVIEW_BYTES,
  PreviewError,
  readMediaPreview,
} from "./media-preview"

const mockFetch = (implementation: (...args: any[]) => Promise<Response>) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(implementation as never)

afterEach(() => {
  vi.restoreAllMocks()
})

describe("readMediaPreview", () => {
  it.effect("rejects oversized streamed bytes and releases the reader", () =>
    Effect.gen(function* () {
      let canceled = false
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_PREVIEW_BYTES))
          controller.enqueue(new Uint8Array([1]))
        },
        cancel() {
          canceled = true
        },
      })
      mockFetch(
        async () =>
          new Response(body, { headers: { "content-type": "image/jpeg" } })
      )
      const error = yield* readMediaPreview("/photo").pipe(Effect.flip)
      expect(error).toBeInstanceOf(PreviewError)
      expect(canceled).toBe(true)
      expect(body.locked).toBe(false)
    })
  )

  it.effect(
    "rejects video, SVG and oversized Content-Length before reading",
    () =>
      Effect.gen(function* () {
        const cases: Record<string, string>[] = [
          { "content-type": "video/mp4" },
          { "content-type": "image/svg+xml" },
          {
            "content-type": "image/jpeg",
            "content-length": String(MAX_PREVIEW_BYTES + 1),
          },
        ]
        for (const headers of cases) {
          let canceled = false
          mockFetch(
            async () =>
              new Response(
                new ReadableStream({
                  cancel() {
                    canceled = true
                  },
                }),
                { headers }
              )
          )
          const error = yield* readMediaPreview("/photo").pipe(Effect.flip)
          expect(error).toBeInstanceOf(PreviewError)
          expect(canceled).toBe(true)
        }
      })
  )

  it.effect(
    "carries interruption to the fetch signal and releases the reader",
    () =>
      Effect.gen(function* () {
        let started!: () => void
        const fetched = new Promise<void>((resolve) => {
          started = resolve
        })
        let body!: ReadableStream<Uint8Array>
        let requestSignal!: AbortSignal
        mockFetch(async (_url: unknown, init: RequestInit) => {
          requestSignal = init.signal!
          body = new ReadableStream({
            start(stream) {
              requestSignal.addEventListener(
                "abort",
                () => stream.error(new Error("aborted")),
                { once: true }
              )
            },
          })
          started()
          return new Response(body, {
            headers: { "content-type": "image/jpeg" },
          })
        })
        const fiber = yield* Effect.forkChild(readMediaPreview("/photo"))
        yield* Effect.promise(() => fetched)
        yield* Fiber.interrupt(fiber)
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 0)))
        expect(requestSignal.aborted).toBe(true)
        expect(body.locked).toBe(false)
      })
  )
})
