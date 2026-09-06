import { Effect, Option, Schema } from "effect"

export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024
const PreviewType = Schema.Literals([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
])
export const isPreviewType = (value: string) =>
  Option.isSome(Schema.decodeUnknownOption(PreviewType)(value))

export class PreviewError extends Schema.TaggedError<PreviewError>()(
  "PreviewError",
  { message: Schema.String }
) {}

// Binary responses finish within this effect, so interruption owns both fetch
// and its reader. Large originals continue to use the native streaming proxy.
export const readMediaPreview = Effect.fn("media.preview")(
  function* (url: string) {
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(url, { signal, credentials: "same-origin" })
        const type = response.headers.get("content-type")?.split(";")[0] ?? ""
        if (
          !response.ok ||
          !isPreviewType(type) ||
          Number(response.headers.get("content-length")) > MAX_PREVIEW_BYTES
        ) {
          await response.body?.cancel()
          throw new PreviewError({ message: "Use the original media stream." })
        }
        const reader = response.body?.getReader()
        if (!reader)
          throw new PreviewError({ message: "Preview response was empty." })
        const chunks: Uint8Array<ArrayBuffer>[] = []
        let size = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_PREVIEW_BYTES)
              throw new PreviewError({ message: "Use the original media stream." })
            chunks.push(value)
          }
          return new Blob(chunks, { type })
        } finally {
          try {
            await reader.cancel()
          } finally {
            reader.releaseLock()
          }
        }
      },
      catch: () => new PreviewError({ message: "Use the original media stream." }),
    })
  },
  Effect.timeout("20 seconds")
)
