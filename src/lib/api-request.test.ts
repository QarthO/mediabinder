import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { requestLibrary } from "./api-request"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("requestLibrary", () => {
  it("preserves payloads, server errors, auth redirects and cancellation", async () => {
    const redirects: string[] = []
    vi.stubGlobal("window", {
      location: {
        origin: "https://mediabinder.test",
        assign: (url: string) => redirects.push(url),
      },
    })
    const requests: { url: string; method?: string; body?: string }[] = []
    let status = 200
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      url: unknown,
      init?: RequestInit
    ) => {
      requests.push({
        url: String(url),
        method: init?.method,
        body: init?.body ? await new Response(init.body).text() : undefined,
      })
      return Response.json(
        status === 200 ? { ok: true } : { error: "Folder is unavailable." },
        { status }
      )
    }) as typeof fetch)

    expect(await requestLibrary({})).toEqual({ ok: true })
    const body = { action: "create_set", data: { name: "Summer" } }
    await requestLibrary({ method: "POST", body })
    expect(requests[0].url).toBe("https://mediabinder.test/api/library")
    expect(requests[0].method).toBe("GET")
    expect(requests[1].method).toBe("POST")
    expect(requests[1].body).toBe(JSON.stringify(body))
    status = 400
    await expect(requestLibrary({ method: "POST", body })).rejects.toThrow(
      /Folder is unavailable/
    )
    status = 401
    await expect(requestLibrary({})).rejects.toThrow(/Sign in to continue/)
    expect(redirects).toEqual(["/"])
    const before = requests.length
    const controller = new AbortController()
    controller.abort()
    expect(() => requestLibrary({ signal: controller.signal })).toThrow()
    expect(requests.length).toBe(before)
  })
})
