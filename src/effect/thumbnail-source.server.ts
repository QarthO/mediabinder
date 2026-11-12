import { Effect, Layer, Schema } from "effect"
import { HttpClientRequest } from "effect/http"
import * as Drive from "./drive-api.server"
import { DRIVE_API, driveJsonRequest } from "./drive-http.server"
import { readThumbnail, ThumbnailError, ThumbnailSource } from "./thumbnails"

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
    const file = yield* lookup(driveId, token)
    if (!file.thumbnailLink)
      return yield* new ThumbnailError({
        status: 404,
        message: "No thumbnail available.",
      })
    const url = yield* Effect.try({
      try: () => new URL(file.thumbnailLink!),
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
    return yield* readThumbnail(
      file.thumbnailLink.replace(/=s\d+$/, "=s640"),
      token
    )
  }),
})
