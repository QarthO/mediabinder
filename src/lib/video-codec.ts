// What the viewer knows about a video's codec: a friendly name for the Format
// row, and whether this browser can decode it. The codec is the fourcc the
// sync read from the file (see `iso-bmff.ts`).

const CODEC_NAMES: Readonly<Record<string, string>> = {
  avc1: "H.264",
  avc3: "H.264",
  hvc1: "HEVC",
  hev1: "HEVC",
  dvh1: "Dolby Vision",
  dvhe: "Dolby Vision",
  av01: "AV1",
  vp09: "VP9",
  mp4v: "MPEG-4",
  apcn: "ProRes",
  apch: "ProRes",
  apcs: "ProRes",
  apco: "ProRes",
  ap4h: "ProRes",
  ap4x: "ProRes",
  jpeg: "Motion JPEG",
}

const CONTAINER_NAMES: Readonly<Record<string, string>> = {
  "video/mp4": "MP4",
  "video/quicktime": "QuickTime",
  "video/x-m4v": "M4V",
  "video/3gpp": "3GPP",
  "video/3gpp2": "3GPP2",
}

/** "QuickTime · HEVC", or the MIME type when the codec isn't known. */
export function formatLabel(mimeType: string, codec: string | null) {
  const container = CONTAINER_NAMES[mimeType]
  const name = codec ? CODEC_NAMES[codec] : undefined
  return container && name ? `${container} · ${name}` : mimeType
}

// A representative `codecs` string for each fourcc: a high profile and level,
// so that "no" means the codec itself is missing, not just a level.
const CODEC_STRINGS: Readonly<Record<string, string>> = {
  avc1: "avc1.640028",
  avc3: "avc3.640028",
  hvc1: "hvc1.1.6.L93.B0",
  hev1: "hev1.1.6.L93.B0",
  dvh1: "dvh1.08.06",
  dvhe: "dvhe.08.06",
  av01: "av01.0.08M.08",
  vp09: "vp09.00.10.08",
  mp4v: "mp4v.20.9",
  apcn: "apcn",
  apch: "apch",
  apcs: "apcs",
  apco: "apco",
  ap4h: "ap4h",
  ap4x: "ap4x",
}

const answers = new Map<string, boolean | undefined>()

/**
 * Whether this browser can decode a video of this codec: `false` means it
 * can't, so don't download the file to find out; `undefined` means the codec
 * is unknown or not one we can ask about, so just try playing it. A "yes" is
 * a claim, not a promise, which is why playback failures are still handled.
 * Answers are remembered: they don't change within a page's life.
 */
export function canDecodeVideoCodec(codec: string | null): boolean | undefined {
  const string = codec ? CODEC_STRINGS[codec] : undefined
  if (!string || typeof document === "undefined") return undefined
  if (answers.has(string)) return answers.get(string)
  const type = `video/mp4; codecs="${string}"`
  // The <video> element plays natively, so its answer is the one that counts;
  // MediaSource is only a second opinion where the element has none.
  const native = document.createElement("video").canPlayType(type)
  const answer =
    native !== ""
      ? true
      : typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(type)
  answers.set(string, answer)
  return answer
}
