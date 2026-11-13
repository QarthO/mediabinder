import { Effect, Layer, Schema } from "effect"
import { HttpClientRequest } from "effect/http"
import * as Drive from "./drive-api.server"
import { DRIVE_API, driveJsonRequest } from "./drive-http.server"
import { readThumbnail, ThumbnailError, ThumbnailSource } from "./thumbnails"

// A 2048 px JPEG from Google runs about 1 MB, so rendered previews get eight
// times the thumbnail limit.
const MAX_RENDERED_BYTES = 4 * 1024 * 1024

const FileThumbnail = Schema.Struct({
  thumbnailLink: Schema.optionalKey(Schema.String),
})

// Asks Drive for a file's thumbnail link. A refusal or a bad answer is the
// thumbnail's failure alone: 404 stays 404, everything else is a bad gateway.
const lookup = Effect.fn("Thumbnail.lookup")(function* (
  driveId: string,
  token: string
) {
  const { status, body } = yield* driveJsonRequest(
    "files.get",
    HttpClientRequest.get(`${DRIVE_API}/files/${encodeURIComponent(driveId)}`, {
      urlParams: { fields: "thumbnailLink", supportsAllDrives: "true" },
      headers: { Authorization: `Bearer ${token}` },
    })
  ).pipe(
    Effect.mapError(
      () =>
        new ThumbnailError({
          status: 502,
          message: "Thumbnail lookup failed. Try again.",
        })
    )
  )
  yield* Effect.annotateCurrentSpan({ "http.response.status_code": status })
  if (status < 200 || status >= 300)
    return yield* new ThumbnailError({
      status: status === 404 ? 404 : 502,
      message: "Google could not look up this thumbnail. Try again.",
    })
  return yield* Schema.decodeUnknownEffect(FileThumbnail)(body).pipe(
    Effect.mapError(
      () =>
        new ThumbnailError({
          status: 502,
          message: "Thumbnail lookup failed. Try again.",
        })
    )
  )
})

// The file's thumbnail link, checked to point at Google, with the size
// parameter (`=s220`) replaced by the longest side to ask for.
const sizedThumbnailLink = Effect.fn("Thumbnail.link")(function* (
  driveId: string,
  token: string,
  size: number
) {
  const file = yield* lookup(driveId, token)
  if (!file.thumbnailLink)
    return yield* new ThumbnailError({
      status: 404,
      message: "No thumbnail available.",
    })
  const link = file.thumbnailLink
  const url = yield* Effect.try({
    try: () => new URL(link),
    catch: () =>
      new ThumbnailError({ status: 502, message: "Invalid thumbnail URL." }),
  })
  if (
    url.protocol !== "https:" ||
    !["googleusercontent.com", "google.com"].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
    )
  )
    return yield* new ThumbnailError({
      status: 502,
      message: "Invalid thumbnail URL.",
    })
  return link.replace(/=s\d+$/, `=s${size}`)
})

export const ThumbnailSourceLive = Layer.succeed(ThumbnailSource, {
  load: Effect.fn("Thumbnail.load")(function* (key: string) {
    const [userId, driveId] = key.split(":")
    const token = yield* Drive.readToken(userId).pipe(
      Effect.mapError(
        () =>
          new ThumbnailError({
            status: 401,
            message: "Reconnect Google Drive in settings.",
          })
      )
    )
    return yield* readThumbnail(
      yield* sizedThumbnailLink(driveId, token, 640),
      token
    )
  }),
})

// Google's own rendering of an image the browser can't display (HEIC, for
// one), as a JPEG at most 2048 px on its longest side. Not cached: it is
// asked for only when a person opens a photo that failed to load.
export const renderImage = Effect.fn("Media.renderImage")(function* (
  driveId: string,
  token: string
) {
  const url = yield* sizedThumbnailLink(driveId, token, 2048)
  return yield* readThumbnail(url, token, {
    maxBytes: MAX_RENDERED_BYTES,
    operation: "image.render",
  }).pipe(
    Effect.timeout("25 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new ThumbnailError({
          status: 504,
          message: "Preview request timed out. Try again.",
        })
      )
    )
  )
})
