import assert from "node:assert/strict"
import { test } from "node:test"
import { requestLibrary } from "./api-request"

test("lazy library requests preserve payloads, server errors, auth redirects and cancellation", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  const redirects: string[] = []
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "https://mediabinder.test", assign: (url: string) => redirects.push(url) } },
  })
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor)
    else Reflect.deleteProperty(globalThis, "window")
  })
  const requests: { url: string; method?: string; body?: string }[] = []
  let status = 200
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? await new Response(init.body).text() : undefined,
    })
    return Response.json(status === 200 ? { ok: true } : { error: "Folder is unavailable." }, { status })
  })
  assert.deepEqual(await requestLibrary({}), { ok: true })
  const body = { action: "create_set", data: { name: "Summer" } }
  await requestLibrary({ method: "POST", body })
  assert.equal(requests[0].url, "https://mediabinder.test/api/library")
  assert.equal(requests[0].method, "GET")
  assert.equal(requests[1].method, "POST")
  assert.equal(requests[1].body, JSON.stringify(body))
  status = 400
  await assert.rejects(requestLibrary({ method: "POST", body }), /Folder is unavailable/)
  status = 401
  await assert.rejects(requestLibrary({}), /Sign in to continue/)
  assert.deepEqual(redirects, ["/"])
  const before = requests.length
  const controller = new AbortController()
  controller.abort()
  assert.throws(() => requestLibrary({ signal: controller.signal }))
  assert.equal(requests.length, before)
})
