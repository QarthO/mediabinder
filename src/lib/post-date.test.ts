import { describe, expect, it } from "vite-plus/test"

import { postLink } from "@/lib/post-date"

// A fixed clock after every example below.
const now = Date.UTC(2026, 10, 12)

describe("postLink", () => {
  it.each([
    // "Four more years", posted 2012-11-07 04:16 UTC (Nov 6 evening in the US).
    ["https://twitter.com/BarackObama/status/266031293945503744", "2012-11-07"],
    ["https://x.com/elonmusk/status/1585841080431321088", "2022-10-28"],
    [
      "https://mobile.twitter.com/u/status/1357536414276210691?s=20",
      "2021-02-05",
    ],
    // The TID from the atproto specification: 1688137381887007 microseconds.
    ["https://bsky.app/profile/example.com/post/3jzfcijpj2z2a", "2023-06-30"],
    // Published 2020-07-29 02:06:17 UTC.
    ["https://www.tiktok.com/@billnye/video/6854717870488702213", "2020-07-29"],
    // Published 2020-10-08 21:12:34 UTC.
    ["https://www.instagram.com/p/CGGOHDXhhK-/", "2020-10-08"],
    ["https://www.instagram.com/reel/CGGOHDXhhK-/", "2020-10-08"],
    ["https://www.instagram.com/reels/CGGOHDXhhK-/", "2020-10-08"],
    // Zuckerberg's prelaunch post, dated 3 July 2023 on Threads.
    ["https://www.threads.com/@zuck/post/CuP48CiS5sx", "2023-07-03"],
    ["https://www.threads.net/@zuck/post/CuP48CiS5sx", "2023-07-03"],
    // The example snowflake in Discord's documentation, 2016-04-30 11:18 UTC.
    ["https://discord.com/channels/1/2/175928847299117063", "2016-04-30"],
  ])("reads %s", (link, date) => {
    expect(postLink(link, now)?.date).toBe(date)
  })

  it("returns the ID as it appears in the link", () => {
    expect(postLink("https://x.com/a/status/266031293945503744", now)).toEqual({
      date: "2012-11-07",
      externalId: "266031293945503744",
    })
  })

  it("uses the UTC calendar date, as the date field does", () => {
    // Last and first milliseconds of 2020-10-08 UTC, in a zone behind UTC.
    const id = (ms: number) => String(BigInt(ms - 1288834974657) << 22n)
    const link = (ms: number) => `https://x.com/a/status/${id(ms)}`
    expect(
      postLink(link(Date.UTC(2020, 9, 8, 23, 59, 59, 999)), now)?.date
    ).toBe("2020-10-08")
    expect(postLink(link(Date.UTC(2020, 9, 9, 0, 0, 0, 0)), now)?.date).toBe(
      "2020-10-09"
    )
  })

  it.each([
    [
      "a lookalike host",
      "https://x.com.evil.example/a/status/266031293945503744",
    ],
    ["a prefixed host", "https://notx.com/a/status/266031293945503744"],
    [
      "a userinfo trick",
      "https://x.com@evil.example/a/status/266031293945503744",
    ],
    ["another scheme", "ftp://x.com/a/status/266031293945503744"],
    ["a wrong path", "https://x.com/a/likes/266031293945503744"],
    ["a malformed ID", "https://x.com/a/status/26603129394550374x"],
    ["an ID that is too long", "https://x.com/a/status/12345678901234567890"],
    ["a pre-snowflake ID", "https://x.com/jack/status/20"],
    ["a malformed TID", "https://bsky.app/profile/a/post/zzzzzzzzzzzzz"],
    ["a short TID", "https://bsky.app/profile/a/post/3jzfcijpj2z2"],
    ["a TikTok ID before launch", "https://www.tiktok.com/@a/video/1"],
    [
      "an Instagram code with bad characters",
      "https://www.instagram.com/p/CGGOHDXh+K-/",
    ],
    [
      "an Instagram code too long to be a media ID",
      "https://www.instagram.com/p/CGGOHDXhhK-CGGOHDXhhK-/",
    ],
    [
      "a Threads post dated before Threads",
      "https://www.threads.net/@a/post/CGGOHDXhhK-",
    ],
    ["a Discord link without a message", "https://discord.com/channels/1/2"],
    ["an unknown host", "https://example.com/@a/status/266031293945503744"],
    ["a Mastodon-style link", "https://mastodon.social/@a/110000000000000000"],
    ["text that is not a link", "not a link"],
  ])("ignores %s", (_, link) => {
    expect(postLink(link, now)).toBeUndefined()
  })

  it("ignores a date more than a day in the future", () => {
    const link = "https://x.com/a/status/266031293945503744"
    const posted = Date.UTC(2012, 10, 7, 4, 16)
    expect(postLink(link, posted - 2 * 86_400_000)).toBeUndefined()
    expect(postLink(link, posted - 3_600_000)?.date).toBe("2012-11-07")
  })
})
