import { createHash } from "node:crypto"
import { expect, test } from "vite-plus/test"

import { runAppEffect } from "@/effect/runtime.server"
import { describeMysql, useTestDatabase } from "@/test/database"
import {
  act,
  execute,
  insertFolder,
  insertUser,
  library,
  rows,
  stubAccessToken,
  stubGoogle,
  syncDrive,
} from "@/test/fixtures"
import { box, concat, ftyp, moov, track } from "@/test/iso-bmff"
import { TAIL_BYTES } from "./iso-bmff"
import { checkCodecs } from "./video-codecs.server"

type Served = {
  name: string
  mimeType: string
  bytes: Uint8Array
  // How Drive answers a range: normally with the bytes; 503 for a hiccup.
  status?: number
}

const mp4 = (format: string, mediaBytes = 2000) =>
  concat(
    ftyp,
    box("mdat", new Uint8Array(mediaBytes)),
    moov(track("vide", format))
  )
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

// Video codecs: a sync only saves the files, and the Drive worker reads each
// video's container afterwards. Google is stubbed at `fetch`: folder listings
// and byte-range reads.
describeMysql("video codecs", () => {
  useTestDatabase()
  const google = stubGoogle()
  stubAccessToken()

  let files: Record<string, Served> = {}
  let reads: Record<string, number> = {}
  const serve = () =>
    google((url, init) => {
      const id = decodeURIComponent(url.pathname.split("/").pop()!)
      if (url.pathname.endsWith("/files")) {
        return Response.json({
          files: Object.entries(files).map(([fileId, file]) => ({
            id: fileId,
            name: file.name,
            mimeType: file.mimeType,
            createdTime: "2026-09-01T00:00:00Z",
            size: String(file.bytes.length),
            sha256Checksum: sha(file.bytes),
            parents: ["root"],
          })),
        })
      }
      const file = files[id]
      reads[id] = (reads[id] ?? 0) + 1
      if (!file || url.searchParams.get("alt") !== "media")
        return new Response(null, { status: 404 })
      if (file.status) return new Response(null, { status: file.status })
      const [, from, to] =
        /^bytes=(\d+)-(\d+)$/.exec(
          new Headers(init.headers).get("range") ?? ""
        ) ?? []
      const slice = file.bytes.slice(Number(from), Number(to) + 1)
      return new Response(slice, { status: 206 })
    })

  const setup = async (initial: Record<string, Served>) => {
    const user = await insertUser()
    await insertFolder(user.id, "root")
    files = initial
    reads = {}
    serve()
    return user
  }
  const codecs = async (userId: string) =>
    Object.fromEntries(
      (
        await rows<{ drive_id: string; video_codec: string | null }>(
          "SELECT drive_id,video_codec FROM media WHERE user_id=?",
          [userId]
        )
      ).map((row) => [row.drive_id, row.video_codec])
    )
  const totalReads = () => Object.values(reads).reduce((n, v) => n + v, 0)
  // One batch of the worker's codec work, how many files it took up. (A whole
  // `pass` takes a server-wide lock that drive-webhook's suite uses too.)
  const work = () => runAppEffect("test", checkCodecs)
  const pending = async (user: { id: string }) =>
    (
      (await act(user, "sync-status", {})) as {
        codecs_pending: number
      } | null
    )?.codecs_pending

  test("a sync saves videos without reading them, and the worker fills in their codecs", async () => {
    const user = await setup({
      hevc: { name: "a.mov", mimeType: "video/quicktime", bytes: mp4("hvc1") },
      h264: { name: "b.mp4", mimeType: "video/mp4", bytes: mp4("avc1") },
      photo: {
        name: "c.jpg",
        mimeType: "image/jpeg",
        bytes: new Uint8Array(30).fill(1),
      },
      webm: {
        name: "d.webm",
        mimeType: "video/webm",
        bytes: new Uint8Array(31).fill(2),
      },
    })
    await syncDrive(user.id)
    expect(totalReads()).toBe(0)
    expect(await codecs(user.id)).toEqual({
      hevc: null,
      h264: null,
      photo: null,
      webm: null,
    })
    // Only the two ISO-BMFF videos are waiting.
    expect(await pending(user)).toBe(2)

    expect(await work()).toBe(2)
    expect(await codecs(user.id)).toEqual({
      hevc: "hvc1",
      h264: "avc1",
      photo: null,
      webm: null,
    })
    expect(reads.photo).toBeUndefined()
    expect(reads.webm).toBeUndefined()
    expect(await pending(user)).toBe(0)
    const byName = Object.fromEntries(
      (await library(user)).media.map((m) => [m.raw_name, m.video_codec])
    )
    expect(byName).toEqual({
      "a.mov": "hvc1",
      "b.mp4": "avc1",
      "c.jpg": null,
      "d.webm": null,
    })

    // Nothing is left, so another pass reads nothing.
    const before = totalReads()
    expect(await work()).toBe(0)
    expect(totalReads()).toBe(before)
  })

  test("a large QuickTime file with moov at the end takes two reads", async () => {
    const user = await setup({
      clip: {
        name: "a.mov",
        mimeType: "video/quicktime",
        bytes: mp4("hvc1", 3 * TAIL_BYTES),
      },
    })
    await syncDrive(user.id)
    await work()
    expect(await codecs(user.id)).toEqual({ clip: "hvc1" })
    expect(reads.clip).toBe(2)
  })

  test("a file that can't be parsed is stored as unknown and isn't read again", async () => {
    const user = await setup({
      broken: {
        name: "a.mp4",
        mimeType: "video/mp4",
        bytes: Uint8Array.from({ length: 600 }, (_, i) => (i * 31) % 253),
      },
      gone: {
        name: "c.mp4",
        mimeType: "video/mp4",
        bytes: mp4("avc1"),
        status: 404,
      },
      good: { name: "b.mp4", mimeType: "video/mp4", bytes: mp4("avc1") },
    })
    await expect(syncDrive(user.id)).resolves.toEqual({ count: 3 })
    await work()
    expect(await codecs(user.id)).toEqual({
      broken: "unknown",
      gone: "unknown",
      good: "avc1",
    })
    const first = totalReads()
    expect(await work()).toBe(0)
    expect(totalReads()).toBe(first)
  })

  test("a Drive hiccup leaves the codec empty without failing the pass or repeating at once", async () => {
    const user = await setup({
      clip: {
        name: "a.mov",
        mimeType: "video/quicktime",
        bytes: mp4("hvc1"),
        status: 503,
      },
      good: { name: "b.mp4", mimeType: "video/mp4", bytes: mp4("avc1") },
    })
    await syncDrive(user.id)
    await expect(work()).resolves.toBe(2)
    expect(await codecs(user.id)).toEqual({ clip: null, good: "avc1" })
    expect(await pending(user)).toBe(1)

    // The failed file is left alone for a while rather than hit every pass.
    const before = totalReads()
    expect(await work()).toBe(0)
    expect(totalReads()).toBe(before)
  })

  test("a changed file is checked again, an unchanged one is not", async () => {
    const user = await setup({
      clip: { name: "a.mov", mimeType: "video/quicktime", bytes: mp4("hvc1") },
      same: { name: "b.mp4", mimeType: "video/mp4", bytes: mp4("avc1") },
    })
    await syncDrive(user.id)
    await work()
    expect(await codecs(user.id)).toEqual({ clip: "hvc1", same: "avc1" })

    // An unchanged library keeps its codecs and has nothing to read.
    const first = totalReads()
    await syncDrive(user.id)
    expect(await codecs(user.id)).toEqual({ clip: "hvc1", same: "avc1" })
    expect(await work()).toBe(0)
    expect(totalReads()).toBe(first)

    // Different bytes and size: the codec is cleared, then read again.
    files.clip.bytes = mp4("avc1", 3000)
    await syncDrive(user.id)
    expect(await codecs(user.id)).toEqual({ clip: null, same: "avc1" })
    expect(await pending(user)).toBe(1)
    await work()
    expect(await codecs(user.id)).toEqual({ clip: "avc1", same: "avc1" })

    // Same size, different checksum counts as a change too.
    files.clip.bytes = mp4("hev1", 3000)
    await syncDrive(user.id)
    expect((await codecs(user.id)).clip).toBeNull()
    await work()
    expect((await codecs(user.id)).clip).toBe("hev1")
  })

  test("a codec read for a file a sync has since changed isn't stored", async () => {
    const user = await setup({
      clip: { name: "a.mov", mimeType: "video/quicktime", bytes: mp4("hvc1") },
    })
    await syncDrive(user.id)
    // A sync rewrites the row (a new size) while the worker is reading it.
    let rewritten = false
    google(async (url, init) => {
      if (!rewritten && url.searchParams.get("alt") === "media") {
        rewritten = true
        await execute("UPDATE media SET size=size+1 WHERE user_id=?", [user.id])
      }
      const [, from, to] =
        /^bytes=(\d+)-(\d+)$/.exec(
          new Headers(init.headers).get("range") ?? ""
        ) ?? []
      return new Response(
        files.clip.bytes.slice(Number(from), Number(to) + 1),
        { status: 206 }
      )
    })
    await work()
    expect((await codecs(user.id)).clip).toBeNull()
    // The next sync sees the file as it is now, and it is read afresh.
    serve()
    await syncDrive(user.id)
    await work()
    expect((await codecs(user.id)).clip).toBe("hvc1")
  })
})
