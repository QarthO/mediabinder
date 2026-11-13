import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { routeTemplate } from "@/lib/browser-privacy"
import { currentBrowserTraceparent } from "@/lib/browser-telemetry-effect"

export class NetworkError extends Schema.TaggedError<NetworkError>()(
  "NetworkError",
  {
    message: Schema.String,
    status: Schema.Number,
  }
) {}

// JSON requests finish inside the Effect lifetime, including body decoding.
// No automatic retries: mutations and watch registrations may have succeeded.
//
// The span is `Library.request`: this is the library client's request, and
// its attributes are limited to the method, the route template and the
// caller's `attributes` (an action name, never its data). When browser
// telemetry is running, the request carries a `traceparent` so the server's
// span continues this trace. Effect's own client span and automatic
// propagation are off: that span would repeat the URL, and the header is
// sampled by `keepBrowserTrace` rather than by the span.
export const jsonRequest = Effect.fn("Library.request")(
  function* <T>(
    url: string,
    options: {
      method?: "GET" | "POST"
      headers?: Record<string, string>
      body?: unknown
      errorMessage: (status: number) => string
      serverMessage?: boolean
      attributes?: Record<string, string>
    }
  ) {
    const client = yield* HttpClient.HttpClient
    const method = options.method ?? "GET"
    yield* Effect.annotateCurrentSpan({
      ...options.attributes,
      "http.request.method": method,
      "url.path": routeTemplate(new URL(url).pathname),
    })
    const traceparent = yield* currentBrowserTraceparent
    let request = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.setHeaders({
        ...options.headers,
        ...(traceparent === undefined ? {} : { traceparent }),
      })
    )
    if (options.body !== undefined)
      request = yield* HttpClientRequest.bodyJson(request, options.body)
    const response = yield* client
      .execute(request)
      .pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true))
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
