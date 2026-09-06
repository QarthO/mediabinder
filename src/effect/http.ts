import { Effect, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http"

export class NetworkError extends Schema.TaggedError<NetworkError>()(
  "NetworkError",
  {
    message: Schema.String,
    status: Schema.Number,
  }
) {}

// JSON requests finish inside the Effect lifetime, including body decoding.
// No automatic retries: mutations and watch registrations may have succeeded.
export const jsonRequest = Effect.fn("http.json")(
  function* <T>(
    url: string,
    options: {
      method?: "GET" | "POST"
      headers?: Record<string, string>
      body?: unknown
      errorMessage: (status: number) => string
      serverMessage?: boolean
    }
  ) {
    const client = yield* HttpClient.HttpClient
    let request = HttpClientRequest.make(options.method ?? "GET")(url).pipe(
      HttpClientRequest.setHeaders(options.headers ?? {})
    )
    if (options.body !== undefined)
      request = yield* HttpClientRequest.bodyJson(request, options.body)
    const response = yield* client.execute(request)
    yield* Effect.annotateCurrentSpan({
      "http.response.status_code": response.status,
    })
    if (response.status < 200 || response.status >= 300) {
      const payload = options.serverMessage
        ? yield* response.json.pipe(Effect.catch(() => Effect.succeed(null)))
        : null
      const decoded = Schema.decodeUnknownOption(
        Schema.Struct({ error: Schema.String })
      )(payload)
      return yield* new NetworkError({
        status: response.status,
        message:
          decoded._tag === "Some"
            ? decoded.value.error
            : options.errorMessage(response.status),
      })
    }
    if (response.status === 204) return undefined as T
    return (yield* response.json) as T
  },
  Effect.provide(FetchHttpClient.layer),
  Effect.timeout("30 seconds"),
  Effect.mapError((error) =>
    error instanceof NetworkError
      ? error
      : new NetworkError({
          status: 502,
          message: "Network request failed. Please retry.",
        })
  )
)
