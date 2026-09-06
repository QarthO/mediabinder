import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect } from "effect"
import { jsonRequest, NetworkError } from "./http"

test("HTTP effects handle JSON, empty watch responses, server errors and cancellation without replaying mutations", async () => {
  const original = globalThis.fetch
  let calls = 0
  let handler: typeof fetch = original
  globalThis.fetch = (...args) => handler(...args)
  await Effect.runPromise(
    Effect.tryPromise(async () => {
      handler = async () => {
        calls++
        return Response.json({ ok: true })
      }
      const options = {
        errorMessage: (status: number) => `Request failed (${status})`,
      }
      assert.deepEqual(
        await Effect.runPromise(jsonRequest("https://example.com", options)),
        { ok: true }
      )
      handler = async () => new Response(null, { status: 204 })
      assert.equal(
        await Effect.runPromise(jsonRequest("https://example.com", options)),
        undefined
      )
      handler = async () => {
        calls++
        return new Response("upstream broke", { status: 502 })
      }
      const error = await Effect.runPromise(
        jsonRequest("https://example.com", {
          ...options,
          method: "POST",
          body: {},
          serverMessage: true,
        }).pipe(Effect.flip)
      )
      assert.ok(error instanceof NetworkError)
      assert.equal(error.message, "Request failed (502)")
      assert.equal(calls, 2)
      let aborted = false
      handler = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true
            reject(new Error("aborted"))
          })
        })
      await Effect.runPromiseExit(
        jsonRequest("https://example.com", options).pipe(
          Effect.timeout("20 millis")
        )
      )
      assert.equal(aborted, true)
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          globalThis.fetch = original
        })
      )
    )
  )
})
