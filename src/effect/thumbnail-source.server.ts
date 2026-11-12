import { Effect, Layer, Schema } from "effect"
import { driveReadToken } from "@/lib/drive.server"
import { readThumbnail, ThumbnailError, ThumbnailSource } from "./thumbnails"

const FileThumbnail = Schema.Struct({
  thumbnailLink: Schema.optional(Schema.String),
})
export const ThumbnailSourceLive = Layer.succeed(ThumbnailSource, {
  load: Effect.fn("thumbnails.google")(function* (key: string) {
    const [userId, driveId] = key.split(":")
    const token = yield* Effect.tryPromise({
      try: () => driveReadToken(userId),
      catch: () =>
        new ThumbnailError({
          status: 401,
          message: "Reconnect Google Drive in settings.",
        }),
    }).pipe(Effect.withSpan("thumbnails.token"))
    const file = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveId)}?fields=thumbnailLink&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` }, signal }
        )
        if (!response.ok) {
          await response.body?.cancel()
          throw new ThumbnailError({
            status: response.status === 404 ? 404 : 502,
            message: "Google could not look up this thumbnail. Try again.",
          })
        }
        return Schema.decodeUnknownSync(FileThumbnail)(await response.json())
      },
      catch: (cause) =>
        cause instanceof ThumbnailError
          ? cause
          : new ThumbnailError({
              status: 502,
              message: "Thumbnail lookup failed. Try again.",
            }),
    }).pipe(Effect.withSpan("thumbnails.lookup"))
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
