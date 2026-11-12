import { randomUUID } from "node:crypto"
import { expect, test } from "vite-plus/test"

import { describeMysql, useTestDatabase } from "@/test/database"
import {
  insertMedia,
  newUser,
  routeHandler,
  stubAccessToken,
  stubGoogle,
  stubSession,
} from "@/test/fixtures"
import { Route } from "@/routes/api.media.$id"

const upstreamBody = () =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
    },
  })

// The media proxy: signed-in owners stream their own files from Drive, with
// ranges honoured and nothing else reachable.
describeMysql("media proxy", () => {
  useTestDatabase()
  const google = stubGoogle()
  stubAccessToken()
  const signIn = stubSession()

  const get = (id: string, init: RequestInit = {}) => {
    const request = new Request(`https://example.com/api/media/${id}`, init)
    const handler = routeHandler<{
      request: Request
      params: { id: string }
    }>(Route, "GET")
    return { request, response: handler({ request, params: { id } }) }
  }

  test("a request without a session is refused", async () => {
    const owner = newUser()
    const id = await insertMedia({ userId: owner.id })
    signIn(null)

    expect((await get(id).response).status).toBe(401)
  })

  test("someone else's media and unavailable media are not found", async () => {
    const owner = newUser()
    const other = newUser()
    const mine = await insertMedia({ userId: owner.id })
    const gone = await insertMedia({ userId: owner.id, available: false })

    signIn(other)
    expect((await get(mine).response).status).toBe(404)
    signIn(owner)
    expect((await get(gone).response).status).toBe(404)
    expect((await get(randomUUID()).response).status).toBe(404)
  })

  test("the owner streams the file with the requested range and locked-down headers", async () => {
    const owner = newUser()
    const id = await insertMedia({ userId: owner.id })
    signIn(owner)
    let upstream:
      | { range: string | null; signal?: AbortSignal | null }
      | undefined
    google((_url, init) => {
      upstream = {
        range: new Headers(init.headers).get("range"),
        signal: init.signal,
      }
      return new Response(upstreamBody(), {
        status: 206,
        headers: { "content-range": "bytes 0-2/300", "content-length": "3" },
      })
    })

    const browser = new AbortController()
    const { response: pending } = get(id, {
      headers: { range: "bytes=0-2" },
      signal: browser.signal,
    })
    const response = await pending

    expect(response.status).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 0-2/300")
    expect(response.headers.get("content-type")).toBe("image/jpeg")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("content-security-policy")).toContain("sandbox")
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]))
    await reader.cancel()
    // Drive saw the same range, and a browser cancelling the request cancels
    // the Drive download too, though it is still streaming after the handler
    // returned.
    expect(upstream?.range).toBe("bytes=0-2")
    expect(upstream?.signal?.aborted).toBe(false)
    browser.abort()
    expect(upstream?.signal?.aborted).toBe(true)
  })

  test("a malformed or multi-range request is rejected without reaching Drive", async () => {
    const owner = newUser()
    const id = await insertMedia({ userId: owner.id })
    signIn(owner)
    // No Drive answer is installed: reaching it would fail the request as a 502.

    for (const range of ["bytes=0-1,3-4", "bytes=abc", "items=0-1"])
      expect((await get(id, { headers: { range } }).response).status).toBe(416)
  })

  test("Drive failures become 404 or 502 and never leak Drive's response", async () => {
    const owner = newUser()
    const id = await insertMedia({ userId: owner.id })
    signIn(owner)

    google(() => new Response("secret upstream detail", { status: 404 }))
    const missing = await get(id).response
    expect(missing.status).toBe(404)
    expect(await missing.text()).not.toContain("secret")

    google(() => new Response("secret upstream detail", { status: 500 }))
    const broken = await get(id).response
    expect(broken.status).toBe(502)
    expect(await broken.text()).not.toContain("secret")

    google(() => {
      throw new Error("transport failure")
    })
    expect((await get(id).response).status).toBe(502)
  })
})
