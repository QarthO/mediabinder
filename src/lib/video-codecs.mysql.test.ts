import { createHash } from "node:crypto"
import { expect, test } from "vite-plus/test"

import { describeMysql, useTestDatabase } from "@/test/database"
import {
  insertFolder,
  insertUser,
  library,
  rows,
  stubAccessToken,
  stubGoogle,
  syncDrive,
} from "@/test/fixtures"
import { box, concat, ftyp, moov, track } from "@/test/iso-bmff"

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

// Codec detection during `Drive.sync`, with Google stubbed at `fetch`: folder
// listings and byte-range reads of each file's container.
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

  test("a new video's codec is recorded and shown in the library; other files are left alone", async () => {
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
    expect(await codecs(user.id)).toEqual({
      hevc: "hvc1",
      h264: "avc1",
      photo: null,
      webm: null,
    })
    // Neither the image nor the WebM file was read.
    expect(reads.photo).toBeUndefined()
    expect(reads.webm).toBeUndefined()
    const byName = Object.fromEntries(
      (await library(user)).media.map((m) => [m.raw_name, m.video_codec])
    )
    expect(byName).toEqual({
      "a.mov": "hvc1",
      "b.mp4": "avc1",
      "c.jpg": null,
      "d.webm": null,
    })
  })

  test("an unchanged video is not read again, a changed one is", async () => {
    const user = await setup({
      clip: { name: "a.mov", mimeType: "video/quicktime", bytes: mp4("hvc1") },
    })
    await syncDrive(user.id)
    const first = totalReads()
    expect(first).toBeGreaterThan(0)
    await syncDrive(user.id)
    expect(totalReads()).toBe(first)

    // Different bytes, different size: the codec is read again.
    files.clip.bytes = mp4("avc1", 3000)
    await syncDrive(user.id)
    expect(totalReads()).toBeGreaterThan(first)
    expect((await codecs(user.id)).clip).toBe("avc1")

    // Same size, different checksum counts as a change too.
    const before = totalReads()
    files.clip.bytes = mp4("hev1", 3000)
    await syncDrive(user.id)
    expect(totalReads()).toBeGreaterThan(before)
    expect((await codecs(user.id)).clip).toBe("hev1")
  })

  test("a file that can't be parsed is stored as unknown, doesn't fail the sync and isn't retried", async () => {
    const user = await setup({
      broken: {
        name: "a.mp4",
        mimeType: "video/mp4",
        bytes: Uint8Array.from({ length: 600 }, (_, i) => (i * 31) % 253),
      },
      good: { name: "b.mp4", mimeType: "video/mp4", bytes: mp4("avc1") },
    })
    await expect(syncDrive(user.id)).resolves.toEqual({ count: 2 })
    expect(await codecs(user.id)).toEqual({ broken: "unknown", good: "avc1" })
    const first = totalReads()
    await syncDrive(user.id)
    expect(totalReads()).toBe(first)
  })

  test("a Drive hiccup leaves the codec empty so the next sync tries again", async () => {
    const user = await setup({
      clip: {
        name: "a.mov",
        mimeType: "video/quicktime",
        bytes: mp4("hvc1"),
        status: 503,
      },
    })
    await expect(syncDrive(user.id)).resolves.toEqual({ count: 1 })
    expect(await codecs(user.id)).toEqual({ clip: null })

    delete files.clip.status
    await syncDrive(user.id)
    expect(await codecs(user.id)).toEqual({ clip: "hvc1" })
  })
})
