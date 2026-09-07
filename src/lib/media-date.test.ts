import { test } from "node:test"
import assert from "node:assert/strict"
import { mediaDate } from "./media-date"

test("SSR upload dates are stable across timezones and refine to local time after hydration", () => {
  const originalTimezone = process.env.TZ
  const value = "2026-08-01 01:00:00"
  const now = Date.parse("2026-09-06T12:34:56Z")
  try {
    process.env.TZ = "UTC"
    const server = mediaDate(value, null)
    process.env.TZ = "America/New_York"
    assert.deepEqual(mediaDate(value, null), server)
    assert.equal(server.label, "Aug 1, 2026")
    assert.equal(server.timestamp, "August 1, 2026 at 1:00:00 AM UTC")
    assert.equal(mediaDate(value, now).label, "Jul 31, 2026")
    assert.equal(mediaDate(value, now).iso, server.iso)
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ
    else process.env.TZ = originalTimezone
  }
})

test("upload dates switch from relative labels to local dates with full timestamps", () => {
  const now = Date.parse("2026-09-06T12:34:56Z")
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString()
  assert.equal(mediaDate(ago(30), now).label, "Just now")
  assert.equal(mediaDate(ago(300), now).label, "5min ago")
  assert.equal(mediaDate(ago(18000), now).label, "5hr ago")
  assert.equal(mediaDate(ago(86400), now).label, "1 day ago")
  assert.equal(mediaDate(ago(30 * 86400), now).label, "1 month ago")
  const old = new Date(ago(31 * 86400))
  assert.equal(
    mediaDate(old.toISOString(), now).label,
    old.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  )
  const result = mediaDate("2026-09-06 12:34:56.000", now)
  assert.equal(result.iso, "2026-09-06T12:34:56.000Z")
  assert.equal(
    result.timestamp,
    new Date(now).toLocaleString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    })
  )
})
