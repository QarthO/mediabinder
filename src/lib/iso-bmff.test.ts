import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"
import {
  box,
  concat,
  ftyp,
  memoryReader,
  moov,
  track,
  wideBox,
} from "@/test/iso-bmff"
import {
  HEAD_BYTES,
  MAX_BOX_HEADERS,
  MAX_MOOV_BYTES,
  sniffVideoCodec,
  TAIL_BYTES,
} from "./iso-bmff"

const sniff = (file: Uint8Array, size = file.length) => {
  const reader = memoryReader(file)
  return Effect.runPromise(sniffVideoCodec(size, reader.read)).then(
    (result) => ({ result, reads: reader.reads })
  )
}
const mdat = (bytes: number) => box("mdat", new Uint8Array(bytes))

describe("sniffVideoCodec", () => {
  it("reads H.264 and HEVC from the video track's sample entry", async () => {
    for (const format of ["avc1", "hvc1", "dvh1", "av01", "apch"]) {
      const file = concat(ftyp, moov(track("vide", format)), mdat(100))
      expect((await sniff(file)).result).toEqual({ found: true, codec: format })
    }
  })

  it("reads a small file in one request", async () => {
    const file = concat(ftyp, mdat(5000), moov(track("vide", "hvc1")))
    const { result, reads } = await sniff(file)
    expect(result).toEqual({ found: true, codec: "hvc1" })
    expect(reads).toEqual([{ start: 0, length: file.length }])
  })

  it("finds moov at the end of a large file with one parallel round trip", async () => {
    // An iPhone .mov: moov after a media box far bigger than either buffer.
    const meta = moov(track("vide", "hvc1"))
    const file = concat(ftyp, mdat(3 * TAIL_BYTES), meta)
    const { result, reads } = await sniff(file)
    expect(result).toEqual({ found: true, codec: "hvc1" })
    expect(reads).toEqual([
      { start: 0, length: HEAD_BYTES },
      { start: file.length - TAIL_BYTES, length: TAIL_BYTES },
    ])
  })

  it("finds moov at the start of a large file without another request", async () => {
    const file = concat(ftyp, moov(track("vide", "avc1")), mdat(3 * TAIL_BYTES))
    const { result, reads } = await sniff(file)
    expect(result).toEqual({ found: true, codec: "avc1" })
    expect(reads).toHaveLength(2)
  })

  it("reads moov on its own when it spans the buffers", async () => {
    const pad = (bytes: number) =>
      box(
        "moov",
        concat(
          moov(track("vide", "hev1")).subarray(8),
          box("free", new Uint8Array(bytes))
        )
      )
    // Starts in the head, runs past it, and the tail is far away.
    const inHead = concat(ftyp, pad(HEAD_BYTES * 2), mdat(3 * TAIL_BYTES))
    const first = await sniff(inHead)
    expect(first.result).toEqual({ found: true, codec: "hev1" })
    expect(first.reads).toHaveLength(3)
    expect(first.reads[2]).toEqual({
      start: ftyp.length,
      length: HEAD_BYTES * 2 + pad(0).length,
    })
    // Starts before the tail and runs into it.
    const inTail = concat(ftyp, mdat(3 * TAIL_BYTES), pad(TAIL_BYTES + 100))
    const second = await sniff(inTail)
    expect(second.result).toEqual({ found: true, codec: "hev1" })
    expect(second.reads).toHaveLength(4)
    // A header in neither buffer: a 16-byte read finds it, one more reads moov.
    expect(second.reads[2].length).toBe(16)
    expect(second.reads[3].length).toBe(TAIL_BYTES + 100 + pad(0).length)
  })

  it("walks past a 64-bit mdat size and a free box", async () => {
    const file = concat(
      ftyp,
      box("free", new Uint8Array(20)),
      wideBox("mdat", new Uint8Array(300)),
      moov(track("vide", "avc1"))
    )
    expect((await sniff(file)).result).toEqual({ found: true, codec: "avc1" })
  })

  it("handles 64-bit sizes in a file too big to hold", async () => {
    // 5 GiB: only the two ends exist, as a sparse reader serves them.
    const meta = moov(track("vide", "hvc1"))
    const size = 5 * 1024 ** 3
    const head = concat(
      ftyp,
      wideBox("mdat", new Uint8Array(0), size - ftyp.length - meta.length)
    )
    const reads: number[] = []
    const result = await Effect.runPromise(
      sniffVideoCodec(size, (start, length) =>
        Effect.sync(() => {
          reads.push(start)
          const out = new Uint8Array(length)
          if (start === 0) out.set(head)
          else out.set(meta, length - meta.length)
          return out
        })
      )
    )
    expect(result).toEqual({ found: true, codec: "hvc1" })
    expect(reads).toEqual([0, size - TAIL_BYTES])
  })

  it("finds a size-0 moov in the tail of a large file", async () => {
    const meta = moov(track("vide", "hev1"))
    const file = concat(
      ftyp,
      mdat(2 * TAIL_BYTES),
      box("moov", meta.subarray(8), 0)
    )
    const { result, reads } = await sniff(file)
    expect(result).toEqual({ found: true, codec: "hev1" })
    expect(reads).toHaveLength(2)
  })

  it("treats a size-0 last box as running to the end of the file", async () => {
    // moov itself may be the last box and declare size 0.
    const meta = moov(track("vide", "hev1"))
    const open = concat(ftyp, mdat(64), box("moov", meta.subarray(8), 0))
    expect((await sniff(open)).result).toEqual({ found: true, codec: "hev1" })
    // A size-0 mdat swallows the rest: there is no moov behind it.
    const swallowed = concat(ftyp, box("mdat", new Uint8Array(200), 0), meta)
    expect((await sniff(swallowed)).result).toEqual({
      found: false,
      reason: "no-moov",
    })
  })

  it("picks the video track, not the first track", async () => {
    const file = concat(
      ftyp,
      moov(track("soun", "mp4a"), track("vide", "hvc1")),
      mdat(10)
    )
    expect((await sniff(file)).result).toEqual({ found: true, codec: "hvc1" })
  })

  it("reports audio-only files and files without moov", async () => {
    expect(
      (await sniff(concat(ftyp, moov(track("soun", "mp4a")), mdat(10)))).result
    ).toEqual({ found: false, reason: "no-video-track" })
    expect((await sniff(concat(ftyp, mdat(100)))).result).toEqual({
      found: false,
      reason: "no-moov",
    })
  })

  it("refuses a moov over the cap without reading it", async () => {
    const header = box("moov", new Uint8Array(0), MAX_MOOV_BYTES + 1)
    const { result, reads } = await sniff(
      concat(ftyp, header),
      ftyp.length + MAX_MOOV_BYTES + 1
    )
    expect(result).toEqual({ found: false, reason: "moov-too-large" })
    // Only the two buffers were read; the oversized moov never was.
    expect(reads.every(({ length }) => length <= TAIL_BYTES)).toBe(true)
  })

  it("survives truncated and garbage data", async () => {
    const meta = moov(track("vide", "avc1"))
    const garbage = Uint8Array.from({ length: 4096 }, (_, i) => (i * 37) % 251)
    const cases = [
      concat(ftyp, meta.subarray(0, meta.length - 10)), // moov cut short
      concat(ftyp, new Uint8Array(3)), // a header that stops early
      garbage,
      new Uint8Array(40), // zero-size boxes of type "\0\0\0\0"
      concat(ftyp, box("mdat", new Uint8Array(0), 4)), // size below the header
    ]
    for (const file of cases) {
      const { result } = await sniff(file)
      expect(result.found).toBe(false)
    }
    // Garbage inside moov is skipped, not trusted.
    const broken = concat(ftyp, box("moov", garbage))
    expect((await sniff(broken)).result.found).toBe(false)
  })

  it("stops after a bounded number of headers", async () => {
    const file = concat(
      ...Array.from({ length: MAX_BOX_HEADERS + 5 }, () =>
        box("free", new Uint8Array(0))
      ),
      moov(track("vide", "avc1"))
    )
    const { result } = await sniff(file)
    expect(result).toEqual({ found: false, reason: "too-many-boxes" })
  })

  it("passes on what the reader fails with", async () => {
    const outcome = await Effect.runPromise(
      Effect.flip(sniffVideoCodec(1000, () => Effect.fail("range refused")))
    )
    expect(outcome).toBe("range refused")
  })
})
