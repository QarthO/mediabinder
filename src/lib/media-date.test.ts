import { describe, expect, it } from "vite-plus/test"
import { mediaDate } from "./media-date"

describe("mediaDate", () => {
  // src/test/global-setup.ts runs tests in America/New_York.
  it("renders SSR upload dates the same in every timezone, then refines to local time after hydration", () => {
    const value = "2026-08-01 01:00:00"
    const now = Date.parse("2026-09-06T12:34:56Z")
    const server = mediaDate(value, null)
    expect(server.label).toBe("Aug 1, 2026")
    expect(server.timestamp).toBe("August 1, 2026 at 1:00:00 AM UTC")
    expect(mediaDate(value, now).label).toBe("Jul 31, 2026")
    expect(mediaDate(value, now).iso).toBe(server.iso)
  })
})
