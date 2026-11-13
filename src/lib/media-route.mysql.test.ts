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

  // `target` is an ID, optionally followed by a query string.
  const get = (target: string, init: RequestInit = {}) => {
    const id = target.split("?")[0]
    const request = new Request(`https://example.com/api/media/${target}`, init)
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
  test("a QuickTime video can be served labelled as MP4, ranges and headers intact", async () => {
    const owner = newUser()
    const id = await insertMedia({
      userId: owner.id,
      mimeType: "video/quicktime",
    })
    signIn(owner)
    let range: string | null = null
    google((_url, init) => {
      range = new Headers(init.headers).get("range")
      return new Response(upstreamBody(), {
        status: 206,
        headers: { "content-range": "bytes 0-2/300", "content-length": "3" },
      })
    })

    const relabelled = await get(`${id}?as=mp4`, {
      headers: { range: "bytes=0-2" },
    }).response
    expect(relabelled.status).toBe(206)
    expect(relabelled.headers.get("content-type")).toBe("video/mp4")
    expect(relabelled.headers.get("content-range")).toBe("bytes 0-2/300")
    expect(relabelled.headers.get("x-content-type-options")).toBe("nosniff")
    expect(relabelled.headers.get("content-security-policy")).toContain(
      "sandbox"
    )
    expect(range).toBe("bytes=0-2")
    await relabelled.body!.cancel()

    // Without the option the stored type is still what the browser is told.
    const plain = await get(id).response
    expect(plain.headers.get("content-type")).toBe("video/quicktime")
    await plain.body!.cancel()
  })

  test("the MP4 label is refused for anything but QuickTime-family videos", async () => {
    const owner = newUser()
    const photo = await insertMedia({ userId: owner.id })
    const clip = await insertMedia({ userId: owner.id, mimeType: "video/webm" })
    const quicktime = await insertMedia({
      userId: owner.id,
      mimeType: "video/quicktime",
    })
    signIn(owner)
    // No Drive answer is installed: reaching it would fail as a 502.

    expect((await get(`${photo}?as=mp4`).response).status).toBe(400)
    expect((await get(`${clip}?as=mp4`).response).status).toBe(400)
    expect((await get(`${quicktime}?as=html`).response).status).toBe(400)
  })

  test("fallback options still need a session and ownership", async () => {
    const owner = newUser()
    const other = newUser()
    const clip = await insertMedia({
      userId: owner.id,
      mimeType: "video/quicktime",
    })
    const photo = await insertMedia({ userId: owner.id })

    signIn(null)
    expect((await get(`${clip}?as=mp4`).response).status).toBe(401)
    expect((await get(`${photo}?rendered`).response).status).toBe(401)
    signIn(other)
    expect((await get(`${clip}?as=mp4`).response).status).toBe(404)
    expect((await get(`${photo}?rendered`).response).status).toBe(404)
  })

  test("an image Google renders is served as a JPEG at the large size", async () => {
    const owner = newUser()
    const id = await insertMedia({ userId: owner.id, mimeType: "image/heic" })
    signIn(owner)
    const requested: string[] = []
    google((url) => {
      requested.push(url.href)
      if (url.hostname === "www.googleapis.com")
        return Response.json({
          thumbnailLink: "https://lh3.googleusercontent.com/abc=s220",
        })
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/jpeg" },
      })
    })

    const response = await get(`${id}?rendered`).response

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/jpeg")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3])
    )
    expect(requested.at(-1)).toBe("https://lh3.googleusercontent.com/abc=s2048")
  })

  test("a rendered image is refused for videos and combined options", async () => {
    const owner = newUser()
    const clip = await insertMedia({
      userId: owner.id,
      mimeType: "video/quicktime",
    })
    const photo = await insertMedia({ userId: owner.id })
    signIn(owner)

    expect((await get(`${clip}?rendered`).response).status).toBe(400)
    expect((await get(`${photo}?rendered&as=mp4`).response).status).toBe(400)
  })

  test("rendered image failures keep Drive's status classes and details private", async () => {
    const owner = newUser()
    const id = await insertMedia({ userId: owner.id, mimeType: "image/heic" })
    signIn(owner)

    google(() => new Response("secret upstream detail", { status: 404 }))
    const missing = await get(`${id}?rendered`).response
    expect(missing.status).toBe(404)
    expect(await missing.text()).not.toContain("secret")

    google(() => Response.json({}))
    expect((await get(`${id}?rendered`).response).status).toBe(404)

    google((url) =>
      url.hostname === "www.googleapis.com"
        ? Response.json({
            thumbnailLink: "https://lh3.googleusercontent.com/abc=s220",
          })
        : new Response("secret upstream detail", { status: 500 })
    )
    const broken = await get(`${id}?rendered`).response
    expect(broken.status).toBe(502)
    expect(await broken.text()).not.toContain("secret")

    google((url) =>
      url.hostname === "www.googleapis.com"
        ? Response.json({
            thumbnailLink: "https://lh3.googleusercontent.com/abc=s220",
          })
        : new Response(new Uint8Array(4 * 1024 * 1024 + 1), {
            headers: { "content-type": "image/jpeg" },
          })
    )
    expect((await get(`${id}?rendered`).response).status).toBe(502)
  })
})
