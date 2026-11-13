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
import { MAX_BOX_HEADERS, MAX_MOOV_BYTES, sniffVideoCodec } from "./iso-bmff"

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

  it("finds moov before and after mdat, reading headers instead of the media", async () => {
    const meta = moov(track("vide", "hvc1"))
    const atStart = await sniff(concat(ftyp, meta, mdat(5000)))
    const atEnd = await sniff(concat(ftyp, mdat(5000), meta))
    expect(atStart.result).toEqual({ found: true, codec: "hvc1" })
    expect(atEnd.result).toEqual({ found: true, codec: "hvc1" })
    // The 5000 media bytes are skipped by header, never requested.
    expect(
      atEnd.reads.every(({ length }) => length <= 16 || length === meta.length)
    ).toBe(true)
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
    expect(reads.every(({ length }) => length <= 16)).toBe(true)
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
    const { result, reads } = await sniff(file)
    expect(result).toEqual({ found: false, reason: "too-many-boxes" })
    expect(reads).toHaveLength(MAX_BOX_HEADERS)
  })

  it("passes on what the reader fails with", async () => {
    const outcome = await Effect.runPromise(
      Effect.flip(sniffVideoCodec(1000, () => Effect.fail("range refused")))
    )
    expect(outcome).toBe("range refused")
  })
})
