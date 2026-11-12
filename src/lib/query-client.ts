import { QueryClient } from "@tanstack/react-query"

// NetworkError (src/effect/http.ts) carries user-facing messages such as
// "Sign in to continue.". It is matched by tag so this module, which is in the
// initial client bundle, does not import effect.
function isNetworkError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "NetworkError"
  )
}

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      // An error streamed from the server to the browser keeps its message
      // only when it is a NetworkError; anything else is redacted.
      dehydrate: {
        shouldRedactErrors: (error) => !isNetworkError(error),
      },
      mutations: {
        retry: false,
      },
      queries: {
        gcTime: 10 * 60_000,
        retry: 1,
        staleTime: 5_000,
        // libraryQuery turns this back on for itself.
        refetchOnWindowFocus: false,
      },
    },
  })
}
