/**
 * Reads a post's date and ID out of its link, in the browser and without any
 * request: many platforms embed a creation time in the post ID. Only exact,
 * allow-listed hosts are recognised, and a decoded time outside the
 * platform's lifetime is discarded, so an unknown link or a misread ID gives
 * nothing instead of a wrong date.
 *
 * Mastodon-style `/@user/<id>` links are not handled: the ID layout is only
 * safe to assume on hosts known to run Mastodon, and any host can serve that
 * path shape.
 */

export type PostLink = {
  /** The calendar date (UTC, `YYYY-MM-DD`) the ID says the post was made. */
  date: string
  /** The platform's own ID for the post, as it appears in the link. */
  externalId: string
}

const DAY = 86_400_000
const BASE64_URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz"

const hosts = (...names: string[]) => new Set(names)

type Decoder = {
  hosts: Set<string>
  /** The ID in the link's path segments, or undefined if not this shape. */
  match: (segments: string[]) => string | undefined
  /** Milliseconds since the Unix epoch, or undefined if the ID is invalid. */
  decode: (id: string) => number | undefined
  /** Earliest plausible creation time, in ms. */
  since: number
}

const digits = /^[0-9]{1,19}$/

function snowflake(id: string, epoch: number, shift: bigint) {
  return digits.test(id)
    ? Number((BigInt(id) >> shift) + BigInt(epoch))
    : undefined
}

function base64Url(code: string) {
  let value = 0n
  for (const char of code)
    value = value * 64n + BigInt(BASE64_URL.indexOf(char))
  return value
}

// Instagram's media ID: 41 bits of milliseconds since an undisclosed epoch
// (estimated from published times), 13 bits of shard, 10 of sequence. The
// shortcode is that 64-bit ID in URL-safe base64. Threads shares the scheme.
const INSTAGRAM_EPOCH = 1314220021721
const shortcode = /^[A-Za-z0-9_-]{6,11}$/
const instagramTime = (code: string) =>
  shortcode.test(code)
    ? Number((base64Url(code) >> 23n) + BigInt(INSTAGRAM_EPOCH))
    : undefined

const decoders: Decoder[] = [
  {
    // Snowflake: 41 bits of ms since 2010-11-04, then 22 bits of worker data.
    hosts: hosts("x.com", "twitter.com", "mobile.twitter.com"),
    match: (s) => (s.length === 3 && s[1] === "status" ? s[2] : undefined),
    decode: (id) => snowflake(id, 1288834974657, 22n),
    since: Date.UTC(2010, 10, 5),
  },
  {
    // TID: top bit 0, 53 bits of microseconds since the Unix epoch, 10 bits
    // of clock ID, in base32-sortable.
    hosts: hosts("bsky.app"),
    match: (s) =>
      s.length === 4 && s[0] === "profile" && s[2] === "post"
        ? s[3]
        : undefined,
    decode: (id) => {
      if (!/^[2-7a-j][2-7a-z]{12}$/.test(id)) return undefined
      let value = 0n
      for (const char of id)
        value = value * 32n + BigInt(TID_ALPHABET.indexOf(char))
      return Number(value >> 10n) / 1000
    },
    since: Date.UTC(2022, 0, 1),
  },
  {
    // The top 32 bits are Unix seconds.
    hosts: hosts("tiktok.com"),
    match: (s) =>
      s.length === 3 && s[0].startsWith("@") && s[1] === "video"
        ? s[2]
        : undefined,
    decode: (id) =>
      digits.test(id) ? Number(BigInt(id) >> 32n) * 1000 : undefined,
    since: Date.UTC(2016, 8, 1),
  },
  {
    hosts: hosts("instagram.com"),
    match: (s) =>
      s.length === 2 && ["p", "reel", "reels"].includes(s[0])
        ? s[1]
        : undefined,
    decode: instagramTime,
    since: Date.UTC(2010, 9, 6),
  },
  {
    hosts: hosts("threads.net", "threads.com"),
    match: (s) =>
      s.length === 3 && s[0].startsWith("@") && s[1] === "post"
        ? s[2]
        : undefined,
    decode: instagramTime,
    since: Date.UTC(2023, 5, 1),
  },
  {
    // Discord message snowflake: ms since 2015-01-01.
    hosts: hosts("discord.com", "ptb.discord.com", "canary.discord.com"),
    match: (s) => (s.length === 4 && s[0] === "channels" ? s[3] : undefined),
    decode: (id) => snowflake(id, 1420070400000, 22n),
    since: Date.UTC(2015, 4, 13),
  },
]

export function postLink(
  link: string,
  now: number = Date.now()
): PostLink | undefined {
  if (!URL.canParse(link.trim())) return undefined
  const url = new URL(link.trim())
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
  const host = url.hostname.toLowerCase().replace(/^www\./, "")
  const segments = url.pathname.split("/").filter(Boolean)
  for (const decoder of decoders) {
    if (!decoder.hosts.has(host)) continue
    const externalId = decoder.match(segments)
    if (!externalId) return undefined
    const time = decoder.decode(externalId)
    if (
      time === undefined ||
      !Number.isFinite(time) ||
      time < decoder.since ||
      time > now + DAY
    )
      return undefined
    return { date: new Date(time).toISOString().slice(0, 10), externalId }
  }
  return undefined
}
