import { Effect } from "effect"

// Finds a video's codec by reading as little of an ISO base media file (MP4,
// QuickTime, M4V, 3GPP) as possible. The top-level boxes are walked by header
// alone, skipping `mdat`, until `moov` turns up, wherever it is. Only `moov` is
// then read, and its video track's first sample entry names the codec.
//
// Pure and independent of where bytes come from: `read` is given an offset and
// a length and returns up to that many bytes, so the same walk serves Drive
// range requests and in-memory buffers. Everything it reads is untrusted, so
// every size is checked against its enclosing region and nothing here throws.

/** `moov` is metadata; a bigger one is not worth fetching. */
export const MAX_MOOV_BYTES = 16 * 1024 * 1024
/** Top-level box headers read before giving up on finding `moov`. */
export const MAX_BOX_HEADERS = 64

/** Stored when a file can't be read, so it isn't retried on every sync. */
export const UNKNOWN_VIDEO_CODEC = "unknown"

export type CodecReader<E> = (
  start: number,
  length: number
) => Effect.Effect<Uint8Array, E>

export type CodecSniff =
  | { readonly found: true; readonly codec: string }
  | {
      readonly found: false
      readonly reason:
        | "no-moov"
        | "moov-too-large"
        | "malformed"
        | "too-many-boxes"
        | "no-video-track"
    }

type Header = { type: string; headerSize: number; size: number }

const fourcc = (bytes: Uint8Array, at: number) =>
  String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])

// `bytes` starts at a box; `remaining` is how far the enclosing region extends
// from there, which is what a size of 0 ("to the end") means.
function parseHeader(bytes: Uint8Array, remaining: number): Header | undefined {
  if (bytes.length < 8) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = fourcc(bytes, 4)
  const declared = view.getUint32(0)
  let headerSize = 8
  let size = declared
  if (declared === 1) {
    if (bytes.length < 16) return undefined
    const wide = view.getBigUint64(8)
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
    headerSize = 16
    size = Number(wide)
  } else if (declared === 0) size = remaining
  return size < headerSize ? undefined : { type, headerSize, size }
}

type Box = { type: string; body: Uint8Array }

// The boxes laid end to end in `region`. A box that overruns the region or
// has an impossible size ends the list: what was read before it still counts.
function children(region: Uint8Array): Box[] {
  const boxes: Box[] = []
  let at = 0
  while (at + 8 <= region.length) {
    const header = parseHeader(region.subarray(at), region.length - at)
    if (!header || at + header.size > region.length) break
    boxes.push({
      type: header.type,
      body: region.subarray(at + header.headerSize, at + header.size),
    })
    at += header.size
  }
  return boxes
}

const child = (box: Box, type: string) =>
  children(box.body).find((candidate) => candidate.type === type)

const printable = /^[\x20-\x7e]{4}$/

// A track is video when its `hdlr` says so; its codec is the format of the
// first sample description in `stsd`.
function trackCodec(track: Box): string | undefined {
  const media = child(track, "mdia")
  if (!media) return undefined
  const handler = child(media, "hdlr")
  // hdlr: version/flags (4), pre_defined (4), handler type (4)
  if (
    !handler ||
    handler.body.length < 12 ||
    fourcc(handler.body, 8) !== "vide"
  )
    return undefined
  const info = child(media, "minf")
  const sampleTable = info && child(info, "stbl")
  const table = sampleTable && child(sampleTable, "stsd")
  // stsd: version/flags (4), entry count (4), then entries of size (4), format (4)
  if (!table || table.body.length < 16) return undefined
  const format = fourcc(table.body, 12)
  return printable.test(format) && format.trim() !== ""
    ? format.trim()
    : undefined
}

function videoCodec(moovBody: Uint8Array): CodecSniff {
  for (const box of children(moovBody)) {
    if (box.type !== "trak") continue
    const codec = trackCodec(box)
    if (codec) return { found: true, codec }
  }
  return { found: false, reason: "no-video-track" }
}

const failed = (reason: Extract<CodecSniff, { found: false }>["reason"]) =>
  ({ found: false, reason }) as const

/**
 * The codec of the first video track of a file `size` bytes long. Reads a
 * 16-byte header per top-level box until `moov`, then `moov` itself (at most
 * `MAX_MOOV_BYTES`). Fails only with what `read` fails with; a file that is
 * not readable as ISO base media is a `found: false` result.
 */
export const sniffVideoCodec = Effect.fnUntraced(function* <E>(
  size: number,
  read: CodecReader<E>
): Effect.fn.Return<CodecSniff, E> {
  if (!Number.isSafeInteger(size) || size < 8) return failed("malformed")
  let offset = 0
  for (let boxes = 0; boxes < MAX_BOX_HEADERS; boxes++) {
    if (offset >= size) return failed("no-moov")
    const head = yield* read(offset, Math.min(16, size - offset))
    const header = parseHeader(head, size - offset)
    if (!header) return failed("malformed")
    if (header.type === "moov") {
      if (header.size > MAX_MOOV_BYTES) return failed("moov-too-large")
      if (offset + header.size > size) return failed("malformed")
      const moov = yield* read(offset, header.size)
      if (moov.length !== header.size) return failed("malformed")
      return videoCodec(moov.subarray(header.headerSize))
    }
    offset += header.size
  }
  return failed("too-many-boxes")
})
