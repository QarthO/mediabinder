import { describe, expect, it } from "vite-plus/test"
import { tapPromiseError } from "./promise"

describe("tapPromiseError", () => {
  it("rethrows the very value thrown, so redirects and Responses survive", async () => {
    const thrown = new Response("Sign in", { status: 401 })
    const seen: unknown[] = []
    await expect(
      tapPromiseError(
        () => Promise.reject(thrown),
        (cause) => seen.push(cause)
      )
    ).rejects.toBe(thrown)
    expect(seen).toEqual([thrown])
  })

  it("passes a streaming result through untouched and survives a failing observer", async () => {
    const response = new Response(new ReadableStream({ start() {} }))
    await expect(
      tapPromiseError(
        async () => ({ response }),
        () => {
          throw new Error("unused")
        }
      )
    ).resolves.toEqual({ response })
    const cause = new Error("boom")
    await expect(
      tapPromiseError(
        () => Promise.reject(cause),
        () => {
          throw new Error("observer failed")
        }
      )
    ).rejects.toBe(cause)
  })
})
