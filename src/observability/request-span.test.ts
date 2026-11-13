import { describe, expect, it } from "vite-plus/test"
import { isUntracedRequest, requestSpanName } from "./request-span"

describe("requestSpanName", () => {
  it("collapses set and media IDs but keeps route and auth words", () => {
    const uuid = "7f9c2ba4-1c0e-4a52-9d1e-2b6f0c5a8e11"
    expect(requestSpanName("GET", `/api/media/${uuid}`)).toBe(
      "GET /api/media/:id"
    )
    expect(requestSpanName("GET", `/sets/${uuid}`)).toBe("GET /sets/:id")
    expect(requestSpanName("GET", "/api/media/12345")).toBe(
      "GET /api/media/:id"
    )
    expect(requestSpanName("GET", "/api/auth/callback/google")).toBe(
      "GET /api/auth/callback/google"
    )
    expect(requestSpanName("POST", "/api/auth/sign-in/social")).toBe(
      "POST /api/auth/sign-in/social"
    )
    expect(requestSpanName("POST", "/api/library")).toBe("POST /api/library")
  })

  it("names server functions by file and function", () => {
    expect(
      requestSpanName("GET", "/_serverFn/abc123def456", {
        filename: "/app/src/lib/api.ts",
        name: "loadLibrary",
      })
    ).toBe("api.ts:loadLibrary")
  })
})

describe("isUntracedRequest", () => {
  const url = (path: string) => new URL(path, "http://localhost")
  it("skips the health probe, built assets and thumbnails, not pages or originals", () => {
    expect(isUntracedRequest(url("/api/health"))).toBe(true)
    expect(isUntracedRequest(url("/assets/index-abc.js"))).toBe(true)
    expect(isUntracedRequest(url("/api/library"))).toBe(false)
    expect(isUntracedRequest(url("/media"))).toBe(false)
    expect(isUntracedRequest(url("/api/media/abc?thumbnail"))).toBe(true)
    expect(isUntracedRequest(url("/api/media/abc"))).toBe(false)
  })
})
