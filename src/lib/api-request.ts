import { Effect } from "effect"
import { jsonRequest } from "@/effect/http"

// Loaded only when a browser request is needed, after the hydrated catalog.
export function requestLibrary<T>(options: {
  method?: "POST"
  body?: unknown
  signal?: AbortSignal
}): Promise<T> {
  options.signal?.throwIfAborted()
  return Effect.runPromise(
    jsonRequest<T>(new URL("/api/library", window.location.origin).href, {
      method: options.method,
      body: options.body,
      serverMessage: options.method === "POST",
      errorMessage: (status) =>
        status === 401
          ? "Sign in to continue."
          : options.method === "POST"
            ? "Could not save this change. Please retry."
            : "Could not load your library. Please retry.",
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error.status === 401) window.location.assign("/")
        })
      )
    ),
    { signal: options.signal }
  )
}
