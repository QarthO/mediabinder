import { describe, expect, it } from "vite-plus/test"
import { routeTemplate, scrubException } from "./browser-privacy"

describe("routeTemplate", () => {
  it("exports route templates, never the IDs or paths behind them", () => {
    expect(routeTemplate("/sets/8f2c6a1e-aaaa-bbbb-cccc-0123456789ab")).toBe(
      "/sets/:id"
    )
    expect(routeTemplate("/api/media/12345")).toBe("/api/media/:id")
    expect(routeTemplate("/media/")).toBe("/media")
    expect(routeTemplate("/settings")).toBe("/settings")
    expect(routeTemplate("/api/library")).toBe("/api/library")
    // A path nobody planned for might embed a name.
    expect(routeTemplate("/holiday%20photos")).toBe("/:other")
    expect(routeTemplate("/sets/a/b")).toBe("/:other")
  })
})

describe("scrubException", () => {
  it("drops the message, which may quote a media name or typed text", () => {
    const error = new Error("Could not rename 'holiday-2024.jpg'\nsecond line")
    const scrubbed = scrubException(error)
    expect(scrubbed.type).toBe("Error")
    expect(JSON.stringify(scrubbed)).not.toContain("holiday")
    expect(JSON.stringify(scrubbed)).not.toContain("second line")
  })

  it("keeps the tag and status of a tagged error, not its text", () => {
    const scrubbed = scrubException({
      _tag: "NetworkError",
      status: 400,
      message: "Tag 'Private trip' already exists.",
    })
    expect(scrubbed).toMatchObject({
      type: "NetworkError",
      message: "NetworkError (status 400)",
      status: 400,
    })
    expect(JSON.stringify(scrubbed)).not.toContain("Private")
  })

  it("keeps only stack frames, not message lines that mimic them", () => {
    const error = new Error("boom")
    error.stack = [
      "Error: boom 'secret name'",
      "    at render (http://app.test/assets/index-1.js:10:20)",
      "a line of the message, not a frame",
    ].join("\n")
    expect(scrubException(error).stacktrace).toBe(
      "at render (http://app.test/assets/index-1.js:10:20)"
    )
  })

  it("never lets free text become the type", () => {
    const named = new Error("x")
    named.name = "Could not rename holiday.jpg"
    expect(scrubException(named).type).toBe("Error")
    expect(scrubException("holiday.jpg").type).toBe("Error")
  })
})
