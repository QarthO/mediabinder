import { Clock, Duration, Effect, Exit, Metric } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientRequest,
  type HttpClientResponse,
} from "effect/http"
import { DriveApiError } from "./errors"

// The one place MediaBinder talks to Google's HTTP APIs. Every Drive call, from
// a sync's page of files to a thumbnail lookup, goes through `driveRequest` or
// `driveJsonRequest`, so the request metrics are counted here and nowhere else.
//
// Requests are metrics, not spans: a sync makes one per page and a library one
// per thumbnail. The unit of work that makes them (the sync, the media
// request) owns the span. The client's own span is switched off too, and with
// it the trace headers it would send to Google.
//
// Nothing retries. Mutations and watch registrations may have succeeded when
// the connection dropped, so each caller decides whether repeating is safe.

export const DRIVE_API = "https://www.googleapis.com/drive/v3"

const requests = Metric.counter("mediabinder.drive.api.requests", {
  description: "Requests to Google's APIs, by Google method and status class",
  attributes: { unit: "{request}" },
  incremental: true,
})

const requestDuration = Metric.histogram(
  "mediabinder.drive.api.request.duration",
  {
    description:
      "Time to Google's answer: until the headers for a streamed download, until the body is read for the rest",
    attributes: { unit: "s" },
    boundaries: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30],
  }
)

/**
 * The Google method a request calls, such as `files.list`. These are the
 * operation names used in metrics and errors, so they never contain IDs, and
 * anything not listed is `other` to keep the set small.
 */
export function driveOperation(method: string, path: string) {
  // Drive paths alternate collection and ID: files/{id}/permissions/{id}.
  // Google's own `changes/startPageToken` and `changes/watch` fit the same shape.
  const template = path
    .split("/")
    .map((segment, index) => (index % 2 === 1 ? "{id}" : segment))
    .join("/")
  return OPERATIONS[`${method} ${template}`] ?? "other"
}
const OPERATIONS: Readonly<Record<string, string | undefined>> = {
  "GET files": "files.list",
  "GET files/{id}": "files.get",
  "POST files": "files.create",
  "POST files/{id}/permissions": "permissions.create",
  "DELETE files/{id}/permissions/{id}": "permissions.delete",
  "GET changes": "changes.list",
  "GET changes/{id}": "changes.getStartPageToken",
  "POST changes/{id}": "changes.watch",
  "POST channels/{id}": "channels.stop",
}

const statusClass = (exit: Exit.Exit<{ readonly status: number }, unknown>) =>
  Exit.isSuccess(exit)
    ? `${Math.floor(exit.value.status / 100)}xx`
    : Exit.hasInterrupts(exit)
      ? "aborted"
      : "error"

// Runs one request, counting it and timing it however it ends.
const tracked = <A extends { readonly status: number }>(
  operation: string,
  work: Effect.Effect<A, unknown, HttpClient.HttpClient>,
  timeout: Duration.Input | undefined
): Effect.Effect<A, DriveApiError> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    return yield* work.pipe(
      timeout === undefined ? (effect) => effect : Effect.timeout(timeout),
      Effect.mapError((cause) =>
        cause instanceof DriveApiError
          ? cause
          : new DriveApiError({ operation, cause })
      ),
      Effect.onExit((exit) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((finished) => {
            const attributes = { operation, status_class: statusClass(exit) }
            return Effect.all(
              [
                Metric.update(Metric.withAttributes(requests, attributes), 1),
                Metric.update(
                  Metric.withAttributes(requestDuration, attributes),
                  (finished - started) / 1000
                ),
              ],
              { discard: true }
            )
          })
        )
      )
    )
  }).pipe(
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    // Looked up on every request: the client would otherwise keep the first
    // `fetch` it sees for good, which a test that stubs `fetch` can't replace.
    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
      globalThis.fetch(input, init)
    ),
    Effect.provide(FetchHttpClient.layer)
  )

// A fetch whose response body is also cut off when `signal` aborts. The HTTP
// client only aborts a request when the effect running it is interrupted, so a
// download that outlives its effect needs the caller's signal on the fetch
// itself, as it had when MediaBinder called fetch directly.
const fetchAbortedBy =
  (signal: AbortSignal): typeof globalThis.fetch =>
  (input, init) =>
    globalThis.fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    })

/**
 * Sends a request and returns the response as soon as its headers arrive, for
 * bodies that are streamed on. The status is not checked: the caller decides
 * what a 404 or a 416 means. With `signal`, aborting it also cancels the body.
 */
export const driveRequest = (
  operation: string,
  request: HttpClientRequest.HttpClientRequest,
  options: { timeout?: Duration.Input; signal?: AbortSignal } = {}
): Effect.Effect<HttpClientResponse.HttpClientResponse, DriveApiError> =>
  tracked(
    operation,
    HttpClient.HttpClient.pipe(
      Effect.flatMap((client) => client.execute(request)),
      options.signal
        ? Effect.provideService(
            FetchHttpClient.Fetch,
            fetchAbortedBy(options.signal)
          )
        : (effect) => effect
    ),
    options.timeout
  )

/**
 * Sends a request and reads its JSON body. `body` is undefined for a 204 and
 * for an unreadable error body; a success status whose body isn't JSON fails.
 * The timeout covers the whole exchange, body included.
 */
export const driveJsonRequest = (
  operation: string,
  request: HttpClientRequest.HttpClientRequest,
  options: { timeout?: Duration.Input } = {}
): Effect.Effect<{ status: number; body: unknown }, DriveApiError> =>
  tracked(
    operation,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(request)
      const { status } = response
      if (status === 204) return { status, body: undefined }
      if (status < 200 || status >= 300)
        return {
          status,
          body: yield* response.json.pipe(
            Effect.catch(() => Effect.succeed(undefined))
          ),
        }
      const body = yield* response.json.pipe(
        Effect.mapError(
          (cause) => new DriveApiError({ operation, status, cause })
        )
      )
      return { status, body }
    }),
    options.timeout
  )
