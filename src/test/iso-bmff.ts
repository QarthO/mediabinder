import { Effect } from "effect"

// Synthetic ISO base media files for tests: just enough boxes to be walked.

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))

export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const u32 = (value: number) => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

/** A box with a 32-bit size. `size` overrides the real one (0 means "to the end"). */
export const box = (type: string, body: Uint8Array, size?: number) =>
  concat(u32(size ?? 8 + body.length), ascii(type), body)

/** A box with the 64-bit `largesize` form. */
export const wideBox = (type: string, body: Uint8Array, size?: number) => {
  const large = new Uint8Array(8)
  new DataView(large.buffer).setBigUint64(0, BigInt(size ?? 16 + body.length))
  return concat(u32(1), ascii(type), large, body)
}

const fullBox = (type: string, ...body: Uint8Array[]) =>
  box(type, concat(new Uint8Array(4), ...body))

/** A `trak` whose handler is `handler` and whose first sample entry is `format`. */
export const track = (handler: string, format: string) =>
  box(
    "trak",
    concat(
      box("tkhd", new Uint8Array(84)),
      box(
        "mdia",
        concat(
          fullBox(
            "hdlr",
            new Uint8Array(4),
            ascii(handler),
            new Uint8Array(13)
          ),
          box(
            "minf",
            box(
              "stbl",
              fullBox("stsd", u32(1), box(format, new Uint8Array(78)))
            )
          )
        )
      )
    )
  )

export const moov = (...tracks: Uint8Array[]) =>
  box("moov", concat(fullBox("mvhd", new Uint8Array(96)), ...tracks))

export const ftyp = box("ftyp", ascii("isom\0\0\0\0isom"))

/** A reader over a buffer, counting what it hands out. */
export const memoryReader = (file: Uint8Array) => {
  const reads: { start: number; length: number }[] = []
  return {
    reads,
    read: (start: number, length: number) =>
      Effect.sync(() => {
        reads.push({ start, length })
        return file.subarray(start, start + length)
      }),
  }
}
