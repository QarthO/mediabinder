import { Effect } from "effect"
import { jsonRequest } from "@/effect/http"
import { runBrowserEffect } from "./browser-telemetry-effect"

// Loaded only when a browser request is needed, after the hydrated catalog.
export function requestLibrary<T>(options: {
  method?: "POST"
  body?: unknown
  // The action's name, recorded on the request span. Never its data.
  action?: string
  signal?: AbortSignal
}): Promise<T> {
  options.signal?.throwIfAborted()
  return runBrowserEffect(
    jsonRequest<T>(new URL("/api/library", window.location.origin).href, {
      method: options.method,
      body: options.body,
      serverMessage: options.method === "POST",
      attributes: options.action
        ? { "mediabinder.action": options.action }
        : {},
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
