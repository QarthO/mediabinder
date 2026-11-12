import { describe, expect, it } from "vite-plus/test"
import { mediaDate } from "./media-date"

describe("mediaDate", () => {
  it("renders SSR upload dates the same in every timezone, then refines to local time after hydration", () => {
    const originalTimezone = process.env.TZ
    const value = "2026-08-01 01:00:00"
    const now = Date.parse("2026-09-06T12:34:56Z")
    try {
      process.env.TZ = "UTC"
      const server = mediaDate(value, null)
      process.env.TZ = "America/New_York"
      expect(mediaDate(value, null)).toEqual(server)
      expect(server.label).toBe("Aug 1, 2026")
      expect(server.timestamp).toBe("August 1, 2026 at 1:00:00 AM UTC")
      expect(mediaDate(value, now).label).toBe("Jul 31, 2026")
      expect(mediaDate(value, now).iso).toBe(server.iso)
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ
      else process.env.TZ = originalTimezone
    }
  })
})
